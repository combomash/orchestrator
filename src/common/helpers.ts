import fs from 'fs';
import JSZip from 'jszip';
import seedrandom from 'seedrandom';

export function isValidURL(url: string): boolean {
    const urlRegex = /^(http|https):\/\/[^ "]+$/;
    return urlRegex.test(url);
}

export function addOrUpdateQueryParams(url: string, paramName: string, paramValue: string): string {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    params.set(paramName, paramValue);
    urlObj.search = params.toString();
    return urlObj.toString();
}

export function makeHashStringUsingPRNG(prng: seedrandom.PRNG): string {
    const chars = '0123456789abcdef';
    let hash: string = '0x';
    for (let i = 64; i > 0; --i) hash += chars[Math.floor(prng() * chars.length)];
    return hash;
}

export function doesFileExist(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

export function doesDirectoryExist(dirPath: string): boolean {
    return fs.existsSync(dirPath) && fs.lstatSync(dirPath).isDirectory();
}

export function getDirectoryDateString(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const day = today.getDate().toString().padStart(2, '0');
    return `${year}_${month}_${day}`;
}

export async function createZipArchive(filePaths: Array<string>, zipFilePath: string) {
    const zip = new JSZip();

    for (const filePath of filePaths) {
        const fileContent = fs.readFileSync(filePath);
        const fileName: string = filePath.split('/').pop() ?? 'error';
        zip.file(fileName, fileContent);
        fs.unlinkSync(filePath);
    }

    const content = await zip.generateAsync({type: 'nodebuffer'});

    fs.writeFileSync(zipFilePath, content);
}

export function delay(time: number) {
    return new Promise(resolve => setTimeout(resolve, time));
}

export function throwIfUndefined<T>(x: T | undefined): asserts x is T {
    if (typeof x === 'undefined') throw new Error(`${x} is undefined!!`);
}
