import { join } from 'node:path';

import type { ScmWorkspaceIntegrationWorkspaceExportTransferEntry } from './workspaceExportArtifacts';

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

export async function listWorkspaceExportFallbackEntries(params: Readonly<{
    root: string;
    prefix?: string;
    readDirectory: ReadWorkspaceExportDirectory;
}>): Promise<Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceExportTransferEntry[];
    unsupportedFilePaths: readonly string[];
}>> {
    const entries: ScmWorkspaceIntegrationWorkspaceExportTransferEntry[] = [];
    const unsupportedFilePaths: string[] = [];
    const pendingDirectories: string[] = [params.prefix ?? ''];

    while (pendingDirectories.length > 0) {
        const currentPrefix = pendingDirectories.pop() ?? '';
        const directory = currentPrefix ? join(params.root, currentPrefix) : params.root;
        let directoryEntries: readonly DirentLike[];
        try {
            directoryEntries = await params.readDirectory(directory);
        } catch (error) {
            if (isIgnorableWorkspaceExportAccessError(error)) {
                continue;
            }
            throw error;
        }

        const directoriesToVisit: string[] = [];
        for (const entry of directoryEntries) {
            const relativePath = normalizeRelativePath(currentPrefix ? join(currentPrefix, entry.name) : entry.name);
            if (!relativePath) continue;
            if (entry.isDirectory()) {
                directoriesToVisit.push(relativePath);
                continue;
            }
            if (entry.isFile() || entry.isSymbolicLink()) {
                entries.push({ relativePath, sourcePath: join(params.root, relativePath) });
            } else {
                unsupportedFilePaths.push(relativePath);
            }
        }

        for (let index = directoriesToVisit.length - 1; index >= 0; index -= 1) {
            pendingDirectories.push(directoriesToVisit[index] ?? '');
        }
    }

    return { entries, unsupportedFilePaths };
}
