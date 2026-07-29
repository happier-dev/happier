import { machineFilesystemListDirectory } from '@/sync/ops/machineFileBrowser';
import {
    sortRepositoryDirectoryEntries,
    type ListRepositoryDirectoryEntriesResult,
    type RepositoryDirectoryEntry,
} from '@/sync/domains/input/repositoryDirectoryEntries';
import { warmInFlight } from '@/sync/domains/input/warmInFlight';
import { markWorkspaceRepositoryDirectoryChanged } from './workspaceRepositoryDirectoryRevision';

function joinPathAbsolute(rootPath: string, directoryPath: string): string {
    const root = rootPath.trim().replace(/\/+$/g, '');
    const rel = directoryPath.trim().replace(/^\/+/g, '');
    if (!root) return rel;
    if (!rel) return root;
    return `${root}/${rel}`;
}

function getCacheKey(workspaceCacheKey: string, directoryPath: string): string {
    return `${workspaceCacheKey}:${directoryPath}`;
}

const workspaceRepositoryDirectoryCache = new Map<string, RepositoryDirectoryEntry[]>();
const workspaceRepositoryDirectoryWarmInFlight = new Map<string, Promise<ListRepositoryDirectoryEntriesResult>>();

export function getCachedWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    workspaceCacheKey: string;
    directoryPath: string;
}>): RepositoryDirectoryEntry[] | null {
    const key = getCacheKey(input.workspaceCacheKey, input.directoryPath);
    const cached = workspaceRepositoryDirectoryCache.get(key);
    return cached ? cached.slice() : null;
}

export function setCachedWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    workspaceCacheKey: string;
    directoryPath: string;
    entries: RepositoryDirectoryEntry[];
}>): void {
    const key = getCacheKey(input.workspaceCacheKey, input.directoryPath);
    workspaceRepositoryDirectoryCache.set(key, input.entries.slice());
}

export function clearCachedWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    workspaceCacheKey: string;
    directoryPath?: string | null;
}>): void {
    const workspacePrefix = `${input.workspaceCacheKey}:`;
    const directoryPath = typeof input.directoryPath === 'string' ? input.directoryPath : null;
    if (directoryPath != null) {
        const key = getCacheKey(input.workspaceCacheKey, directoryPath);
        workspaceRepositoryDirectoryCache.delete(key);
        workspaceRepositoryDirectoryWarmInFlight.delete(key);
        markWorkspaceRepositoryDirectoryChanged(input.workspaceCacheKey);
        return;
    }

    for (const key of workspaceRepositoryDirectoryCache.keys()) {
        if (key.startsWith(workspacePrefix)) {
            workspaceRepositoryDirectoryCache.delete(key);
        }
    }
    for (const key of workspaceRepositoryDirectoryWarmInFlight.keys()) {
        if (key.startsWith(workspacePrefix)) {
            workspaceRepositoryDirectoryWarmInFlight.delete(key);
        }
    }
    markWorkspaceRepositoryDirectoryChanged(input.workspaceCacheKey);
}

export async function warmWorkspaceRepositoryDirectoryCache(input: Readonly<{
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    directoryPath: string;
    serverId?: string | null;
}>): Promise<ListRepositoryDirectoryEntriesResult> {
    const cached = getCachedWorkspaceRepositoryDirectoryEntries({
        workspaceCacheKey: input.workspaceCacheKey,
        directoryPath: input.directoryPath,
    });
    if (cached) {
        return { ok: true, entries: cached };
    }

    const key = getCacheKey(input.workspaceCacheKey, input.directoryPath);
    return await warmInFlight(workspaceRepositoryDirectoryWarmInFlight, key, async () => (
        await listWorkspaceRepositoryDirectoryEntries(input)
    ));
}

export async function listWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    directoryPath: string;
    serverId?: string | null;
}>): Promise<ListRepositoryDirectoryEntriesResult> {
    const absPath = joinPathAbsolute(input.rootPath, input.directoryPath);
    const response = await machineFilesystemListDirectory(
        input.machineId,
        {
            path: absPath,
            includeFiles: true,
        },
        { serverId: input.serverId },
    );
    if (!response.ok) {
        return { ok: false, error: response.error || 'unknown_error' };
    }

    const entries: RepositoryDirectoryEntry[] = [];
    for (const entry of response.entries) {
        if (!entry || typeof entry.name !== 'string') continue;
        const name = entry.name.trim();
        if (!name) continue;
        if (entry.type !== 'file' && entry.type !== 'directory') continue;
        const sizeBytes = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0
            ? Math.floor(entry.size)
            : undefined;
        const modifiedMs = typeof entry.modified === 'number' && Number.isFinite(entry.modified) && entry.modified >= 0
            ? Math.floor(entry.modified)
            : undefined;
        entries.push({ name, type: entry.type, sizeBytes, modifiedMs });
    }

    const sorted = sortRepositoryDirectoryEntries(entries);
    setCachedWorkspaceRepositoryDirectoryEntries({
        workspaceCacheKey: input.workspaceCacheKey,
        directoryPath: input.directoryPath,
        entries: sorted,
    });
    return { ok: true, entries: sorted };
}
