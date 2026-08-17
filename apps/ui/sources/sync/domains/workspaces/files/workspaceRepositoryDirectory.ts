import { machineFilesystemListDirectory } from '@/sync/ops/machineFileBrowser';
import {
    sortRepositoryDirectoryEntries,
    type ListRepositoryDirectoryEntriesResult,
    type RepositoryDirectoryEntry,
} from '@/sync/domains/input/repositoryDirectoryEntries';
import { warmInFlight } from '@/sync/domains/input/warmInFlight';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
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

/**
 * The two functions below both **key** a cache entry and **route** an RPC. They therefore take
 * the workspace as ONE `scope` and derive the key from it here, rather than accepting a
 * `workspaceCacheKey` alongside a separate `machineId`/`rootPath`/`serverId` address: with two
 * independent arguments a caller can file the entry under one workspace while reading through
 * another, which is exactly the defect this module's sibling file-search owner shipped.
 *
 * The purely key-addressed functions above (`get`/`set`/`clearCached…`) keep taking a
 * `workspaceCacheKey`. They issue no RPC, so they name only one identity and cannot disagree
 * with anything.
 */
export async function warmWorkspaceRepositoryDirectoryCache(input: Readonly<{
    scope: WorkspaceScopeBase;
    directoryPath: string;
}>): Promise<ListRepositoryDirectoryEntriesResult> {
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(input.scope);
    if (!workspaceCacheKey) return { ok: false, error: 'unknown_error' };

    const cached = getCachedWorkspaceRepositoryDirectoryEntries({
        workspaceCacheKey,
        directoryPath: input.directoryPath,
    });
    if (cached) {
        return { ok: true, entries: cached };
    }

    const key = getCacheKey(workspaceCacheKey, input.directoryPath);
    return await warmInFlight(workspaceRepositoryDirectoryWarmInFlight, key, async () => (
        await listWorkspaceRepositoryDirectoryEntries(input)
    ));
}

export async function listWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    scope: WorkspaceScopeBase;
    directoryPath: string;
}>): Promise<ListRepositoryDirectoryEntriesResult> {
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(input.scope);
    if (!workspaceCacheKey) return { ok: false, error: 'unknown_error' };

    // The RAW scope path, never the normalized one: `normalizeFileSystemPath` lowercases
    // Windows drive and UNC paths, and this is the daemon's `path` argument.
    const absPath = joinPathAbsolute(input.scope.rootPath, input.directoryPath);
    const response = await machineFilesystemListDirectory(
        input.scope.machineId,
        {
            path: absPath,
            includeFiles: true,
        },
        { serverId: input.scope.serverId },
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
        workspaceCacheKey,
        directoryPath: input.directoryPath,
        entries: sorted,
    });
    return { ok: true, entries: sorted };
}
