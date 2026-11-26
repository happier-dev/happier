/** @moduleRealm daemon */
import { lstat as localLstat, readFile as localReadFile, readlink as localReadlink } from 'node:fs/promises';
import { join } from 'node:path';

import { readCurrentBackendRuntimeServices } from './backendRuntimeServices.js';

const UNTRACKED_STATS_MAX_FILES = 512;
const UNTRACKED_STATS_MAX_BYTES = 5_000_000;
const UNTRACKED_STATS_CONCURRENCY = 16;

type UntrackedFileReader = Readonly<{
    lstat(path: string): Promise<Readonly<{
        size?: number;
        isFile?(): boolean;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
    }>>;
    readFile(path: string): Promise<Uint8Array>;
    readlink?(path: string): Promise<Uint8Array>;
}>;

const standaloneUntrackedFileReader: UntrackedFileReader = {
    lstat: localLstat,
    readFile: localReadFile,
    readlink: (path) => localReadlink(path, { encoding: 'buffer' }),
};

function resolveUntrackedFileReader(): UntrackedFileReader {
    const services = readCurrentBackendRuntimeServices();
    if (!services) return standaloneUntrackedFileReader;
    const remoteFs = services.repositoryFileSystem;
    if (!remoteFs) {
        throw Object.assign(new Error('SCM workspace filesystem is unavailable'), {
            code: 'BACKEND_UNAVAILABLE',
        });
    }
    return {
        lstat: (path) => remoteFs.lstat(path),
        readFile: (path) => remoteFs.readFile(path),
        ...(remoteFs.readlink
            ? { readlink: async (path: string) => Buffer.from(await remoteFs.readlink!(path), 'utf8') }
            : {}),
    };
}

/** Bounded best-effort statistics for paths supplied by the repository backend. */
export async function readUntrackedFileStats(
    repoRoot: string,
    relativePaths: readonly string[],
): Promise<Record<string, { pendingAdded: number; isBinary: boolean }>> {
    const candidates = relativePaths
        .filter((path) => path.length > 0 && path !== '.')
        .slice(0, UNTRACKED_STATS_MAX_FILES);
    if (candidates.length === 0) return {};

    const reader = resolveUntrackedFileReader();
    const statsByPath: Record<string, { pendingAdded: number; isBinary: boolean }> = {};
    let nextIndex = 0;
    const workerCount = Math.min(candidates.length, UNTRACKED_STATS_CONCURRENCY);

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < candidates.length) {
            const relativePath = candidates[nextIndex++]!;
            try {
                const absolutePath = join(repoRoot, relativePath);
                const info = await reader.lstat(absolutePath);
                const isSymbolicLink = info.isSymbolicLink();
                const isFile = typeof info.isFile === 'function'
                    ? info.isFile()
                    : (!info.isDirectory() && !isSymbolicLink);
                // A skipped file has no measured statistics; its size is not binary evidence.
                if (
                    (!isFile && !isSymbolicLink)
                    || (typeof info.size === 'number' && info.size > UNTRACKED_STATS_MAX_BYTES)
                ) {
                    continue;
                }
                if (isSymbolicLink && !reader.readlink) {
                    continue;
                }
                const buffer = isSymbolicLink
                    ? await reader.readlink!(absolutePath)
                    : await reader.readFile(absolutePath);
                const isBinary = buffer.includes(0);
                let pendingAdded = 0;
                if (!isBinary && buffer.length > 0) {
                    for (const byte of buffer) {
                        if (byte === 10) pendingAdded += 1;
                    }
                    if (buffer[buffer.length - 1] !== 10) pendingAdded += 1;
                }
                statsByPath[relativePath] = { pendingAdded, isBinary };
            } catch {
                // Files can disappear or become unreadable between status and this optional enrichment.
            }
        }
    }));

    return statsByPath;
}
