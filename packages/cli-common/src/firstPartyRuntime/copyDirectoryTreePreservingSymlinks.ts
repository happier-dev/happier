import { copyFile, lstat, mkdir, readlink, readdir, stat, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

type SymlinkType = 'dir' | 'file' | 'junction' | undefined;

async function resolveSymlinkType(sourcePath: string, linkTarget: string): Promise<SymlinkType> {
    if (process.platform !== 'win32') {
        return undefined;
    }

    const targetInfo = await stat(resolve(dirname(sourcePath), linkTarget)).catch(() => null);
    return targetInfo?.isDirectory() ? 'junction' : 'file';
}

async function copyDirectoryEntry(params: Readonly<{
    rootDir: string;
    sourcePath: string;
    destinationPath: string;
    shouldSkipRelativePath?: (relativePath: string) => boolean;
}>): Promise<void> {
    const relativePath = relative(params.rootDir, params.sourcePath) || '.';
    if (relativePath !== '.' && params.shouldSkipRelativePath?.(relativePath) === true) {
        return;
    }

    const info = await lstat(params.sourcePath).catch(() => null);
    if (!info) {
        return;
    }

    if (info.isSymbolicLink()) {
        const linkTarget = await readlink(params.sourcePath);
        await mkdir(dirname(params.destinationPath), { recursive: true });
        await symlink(linkTarget, params.destinationPath, await resolveSymlinkType(params.sourcePath, linkTarget));
        return;
    }

    if (info.isDirectory()) {
        await mkdir(params.destinationPath, { recursive: true });
        const entries = await readdir(params.sourcePath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.name || entry.name === '.' || entry.name === '..') {
                continue;
            }
            await copyDirectoryEntry({
                rootDir: params.rootDir,
                sourcePath: join(params.sourcePath, entry.name),
                destinationPath: join(params.destinationPath, entry.name),
                shouldSkipRelativePath: params.shouldSkipRelativePath,
            });
        }
        return;
    }

    if (!info.isFile()) {
        return;
    }

    await mkdir(dirname(params.destinationPath), { recursive: true });
    await copyFile(params.sourcePath, params.destinationPath);
}

export async function copyDirectoryTreePreservingSymlinks(params: Readonly<{
    sourceDir: string;
    destinationDir: string;
    shouldSkipRelativePath?: (relativePath: string) => boolean;
}>): Promise<void> {
    await copyDirectoryEntry({
        rootDir: params.sourceDir,
        sourcePath: params.sourceDir,
        destinationPath: params.destinationDir,
        shouldSkipRelativePath: params.shouldSkipRelativePath,
    });
}
