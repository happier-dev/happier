import { join } from 'node:path';

import type { ScmSourceControllerWorkspaceExportTransferEntry } from './workspaceExportArtifacts';

type DirentLike = Readonly<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}>;

export type ReadWorkspaceExportDirectory = (path: string) => Promise<readonly DirentLike[]>;

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

export function isIgnorableWorkspaceExportAccessError(error: unknown): error is NodeJS.ErrnoException {
    return Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && typeof (error as NodeJS.ErrnoException).code === 'string'
        && ['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''),
    );
}

export async function walkWorkspaceExportTree(params: Readonly<{
    root: string;
    prefix?: string;
    readDirectory: ReadWorkspaceExportDirectory;
}>): Promise<string[]> {
    const results: string[] = [];
    const pendingDirectories: string[] = [params.prefix ?? ''];

    while (pendingDirectories.length > 0) {
        const currentPrefix = pendingDirectories.pop() ?? '';
        const directory = currentPrefix ? join(params.root, currentPrefix) : params.root;
        let entries: readonly DirentLike[];
        try {
            entries = await params.readDirectory(directory);
        } catch (error) {
            if (isIgnorableWorkspaceExportAccessError(error)) {
                continue;
            }
            throw error;
        }

        const directoriesToVisit: string[] = [];
        for (const entry of entries) {
            const relativePath = normalizeRelativePath(currentPrefix ? join(currentPrefix, entry.name) : entry.name);
            if (!relativePath) continue;
            if (entry.isDirectory()) {
                directoriesToVisit.push(relativePath);
                continue;
            }
            if (entry.isFile() || entry.isSymbolicLink()) {
                results.push(relativePath);
            }
        }

        for (let index = directoriesToVisit.length - 1; index >= 0; index -= 1) {
            pendingDirectories.push(directoriesToVisit[index] ?? '');
        }
    }

    return results;
}

export async function listWorkspaceExportFallbackEntries(params: Readonly<{
    root: string;
    prefix?: string;
    readDirectory: ReadWorkspaceExportDirectory;
}>): Promise<readonly ScmSourceControllerWorkspaceExportTransferEntry[]> {
    return (await walkWorkspaceExportTree(params)).map((relativePath) => ({
        relativePath,
        sourcePath: join(params.root, relativePath),
    }));
}
