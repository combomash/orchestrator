import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import {v4 as uuidv4} from 'uuid';
import {input, number, select, confirm} from '@inquirer/prompts';
import {Connection, Client} from '@temporalio/client';
import {DEV_TEMPORAL_ADDRESS} from '../constants';
import {exploreSeeds, renderFrames, renderSequences} from '../workflows';
import {doesDirectoryExist, getDirectoryDateString, isValidURL, makeHashStringUsingPRNG} from '../common/helpers';
import seedrandom from 'seedrandom';
import {ScriptConfig} from '../interfaces';
import {isValidScriptConfig} from '../event-scripts/validate-config';
import {QueueManager} from '../managers/queue.manager';

dotenv.config();

async function run() {
    const isProduction = process.env.NODE_ENV === 'production';

    const connection = await Connection.connect({
        address: isProduction ? process.env.TEMPORAL_ADDRESS : DEV_TEMPORAL_ADDRESS,
    });

    const client = new Client({connection});

    let goal!: string;
    let type!: string;

    const determineWorkflow = async () => {
        goal = await select({
            message: 'What do you want to do?',
            choices: [
                {
                    name: 'explore',
                    value: 'explore',
                    description: 'Generate random seeds to render',
                },
                {
                    name: 'render',
                    value: 'render',
                    description: 'Render a specific configuration',
                },
            ],
        });

        if (goal === 'render') {
            type = await select({
                message: 'What type of render?',
                choices: [
                    {
                        name: 'frame(s)',
                        value: 'Frames',
                        description: 'Render single seeded frame(s)',
                    },
                    {
                        name: 'sequence(s)',
                        value: 'Sequences',
                        description: 'Render sequence(s) of seeded frame(s)',
                    },
                ],
            });
            return `render${type}`;
        }

        if (goal === 'explore') {
            return 'exploreSeeds';
        }

        return;
    };

    const workflow = await determineWorkflow();

    if (!workflow) {
        console.error('no matching workflow, exiting...');
        return;
    }

    const uuid = uuidv4();

    const params: {[key: string]: any} = {};

    params['url'] = await input({
        message: 'URL:',
        required: true,
        validate: url => isValidURL(url),
    });

    params['outDir'] = await input({
        message: 'Output directory path:',
        default: isProduction ? path.dirname(__dirname) : `${path.join(path.dirname(__dirname), '..', 'out')}`,
        validate: path => doesDirectoryExist(path),
    });

    const useSubDirectory = await confirm({
        message: 'Put outputs in dated sub-directory?',
        default: true,
    });

    if (useSubDirectory) {
        let mkDirName = getDirectoryDateString();

        const label = await input({
            message: 'Label for sub-directory (optional):',
            default: '',
            required: false,
            validate: label => label === '' || /^[a-zA-Z0-9-]+$/.test(label),
        });

        if (label !== '') {
            mkDirName += `__${label}`;
        }

        mkDirName += `__${uuid}`;

        params['mkDirName'] = mkDirName;
    }

    if (goal === 'render') {
        params['seeds'] = await input({
            message: 'Seed(s):',
            required: true,
            default: makeHashStringUsingPRNG(seedrandom(uuid.toString())),
            validate: seeds => /^\w+(,\w+)*$/.test(seeds),
        });
        params.seeds = params.seeds.split(',');
        console.log('\n', params.seeds, '\n');
    } else if (goal === 'explore') {
        params['count'] = await number({
            message: 'How many do you want? (1...N):',
            required: true,
            default: 1,
            min: 1,
        });
    }

    params['width'] = await number({
        message: 'Width (px):',
        required: true,
        default: 1000,
        min: 1,
    });

    params['height'] = await number({
        message: 'Height (px):',
        required: true,
        default: 1000,
        min: 1,
    });

    params['devicePixelRatio'] = await number({
        message: 'Pixel Ratio:',
        required: true,
        default: 1,
    });

    // 24 hours (minus 1 minute) to trigger before "startToCloseTimeout"
    params['timeout'] = 24 * 60 * 60 * 1000 - 1000 * 60;

    if (workflow === 'renderSequences') {
        const frameRange = await input({
            message: 'Frame range(s):',
            required: true,
            default: '0',
            validate: input => /^(\d+(-\d+)?)(,(\d+(-\d+)?))*$/.test(input),
        });

        params['frameRanges'] = [];

        let low = Infinity;
        let high = -Infinity;

        const ranges = frameRange.split(',');
        for (const range of ranges) {
            const frames = range.split('-');
            if (frames.length > 2) throw new Error(`Frame Range "${range}" is not supported`);

            const frameRange = {
                start: parseInt(frames[0]),
                end: parseInt(frames[frames.length === 2 ? 1 : 0]),
            };

            if (frameRange.start > frameRange.end) throw new Error(`Frame Range "${range}" cannot have start greater than end`);
            if (frameRange.start < 0 || frameRange.end < 0) throw new Error(`Frame Range "${range} cannot be less than zero`);

            params['frameRanges'].push(frameRange);

            low = Math.min(low, frameRange.start);
            high = Math.max(high, frameRange.end);
        }

        params['padding'] = await number({
            message: 'Frame padding:',
            required: true,
            default: String(high - low).length,
            min: String(high - low).length,
        });

        params['framerate'] = await number({
            message: 'Framerate (FPS):',
            required: true,
            default: 30,
            min: 1,
        });
    }

    const useScriptConfig = await confirm({
        message: 'Run pre/post event scripts?',
        default: false,
    });

    function getConfig(configPath: string) {
        try {
            const data = fs.readFileSync(configPath, 'utf-8');
            return JSON.parse(data) as ScriptConfig;
        } catch (error) {
            return {error}; // will throw in validation
        }
    }

    if (useScriptConfig) {
        const configPath = await input({
            message: 'Path to JSON config file:',
            validate: configPath => isValidScriptConfig(getConfig(configPath)),
        });
        params['scriptConfig'] = getConfig(configPath);
    }

    const ok = await confirm({
        message: 'Confirm to submit:',
    });

    if (!ok) return;

    switch (workflow) {
        case 'renderFrames':
            await client.workflow.start(renderFrames, {
                args: [
                    {
                        uuid,
                        url: params.url,
                        seeds: params.seeds,
                        width: params.width,
                        height: params.height,
                        devicePixelRatio: params.devicePixelRatio,
                        timeout: params.timeout,
                        outDir: params.outDir,
                        mkDir: params.mkDirName,
                        scriptConfig: params.scriptConfig,
                    },
                ],
                taskQueue: QueueManager.queue,
                workflowId: `${uuid}-${QueueManager.queue}`,
            });
            break;
        case 'renderSequences':
            await client.workflow.start(renderSequences, {
                args: [
                    {
                        uuid,
                        url: params.url,
                        seeds: params.seeds,
                        width: params.width,
                        height: params.height,
                        devicePixelRatio: params.devicePixelRatio,
                        timeout: params.timeout,
                        outDir: params.outDir,
                        sequence: {
                            fps: params.framerate,
                            padding: params.padding,
                            ranges: params.frameRanges,
                        },
                        mkDir: params.mkDirName,
                        scriptConfig: params.scriptConfig,
                    },
                ],
                taskQueue: QueueManager.queue,
                workflowId: `${uuid}-${QueueManager.queue}`,
            });
            break;
        case 'exploreSeeds':
            await client.workflow.start(exploreSeeds, {
                args: [
                    {
                        uuid,
                        url: params.url,
                        width: params.width,
                        height: params.height,
                        devicePixelRatio: params.devicePixelRatio,
                        outDir: params.outDir,
                        timeout: params.timeout,
                        count: params.count,
                        mkDir: params.mkDirName,
                        scriptConfig: params.scriptConfig,
                    },
                ],
                taskQueue: QueueManager.queue,
                workflowId: `${uuid}-${QueueManager.queue}`,
            });
            break;
    }

    console.log(`\nWorkflow Submitted - ${uuid}\n`);
    return;
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
