import { machineFilesystemListDirectory } from '@/sync/ops/machineFileBrowser';
import { readHomeAccountDepartures, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    sortRepositoryDirectoryEntries,
    type ListRepositoryDirectoryEntriesResult,
    type RepositoryDirectoryEntry,
} from '@/sync/domains/input/repositoryDirectoryEntries';
import { warmInFlight, type WarmInFlightRequest } from '@/sync/domains/input/warmInFlight';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { markWorkspaceRepositoryDirectoryChanged } from './workspaceRepositoryDirectoryRevision';
import {
    clearWorkspaceRepositoryDirectoryCacheEntries,
    getCachedWorkspaceRepositoryDirectoryEntries,
    getCachedWorkspaceRepositoryDirectoryMetadata,
    getCachedWorkspaceRepositoryGitIgnoreAvailable,
    setCachedWorkspaceRepositoryDirectoryEntries,
} from './workspaceRepositoryDirectoryCache';
export {
    getCachedWorkspaceRepositoryDirectoryEntries,
    getCachedWorkspaceRepositoryDirectoryMetadata,
    getCachedWorkspaceRepositoryGitIgnoreAvailable,
    setCachedWorkspaceRepositoryDirectoryEntries,
} from './workspaceRepositoryDirectoryCache';

function joinPathAbsolute(rootPath: string, directoryPath: string): string {
    const root = rootPath.replace(/\/+$/g, '');
    const rel = directoryPath.replace(/^\/+/g, '');
    if (!root) return rel;
    if (!rel) return root;
    return `${root}/${rel}`;
}

function getCacheKey(workspaceCacheKey: string, directoryPath: string): string {
    return `${workspaceCacheKey}:${directoryPath}`;
}

const workspaceRepositoryDirectoryWarmInFlight = new Map<string, WarmInFlightRequest<ListRepositoryDirectoryEntriesResult>>();

let accountRetirementSubscribed = false;
function captureDirectoryReadDepartures(serverId: string | null | undefined): number {
    if (!accountRetirementSubscribed) {
        accountRetirementSubscribed = true;
        subscribeHomeCredentialChange((_event, { accountLeft }) => {
            if (accountLeft) workspaceRepositoryDirectoryWarmInFlight.clear();
        });
    }
    return readHomeAccountDepartures(serverId);
}

export function clearCachedWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    workspaceCacheKey: string;
    directoryPath?: string | null;
}>): void {
    const workspacePrefix = `${input.workspaceCacheKey}:`;
    const directoryPath = typeof input.directoryPath === 'string' ? input.directoryPath : null;
    clearWorkspaceRepositoryDirectoryCacheEntries(input);
    if (directoryPath != null) {
        const key = getCacheKey(input.workspaceCacheKey, directoryPath);
        workspaceRepositoryDirectoryWarmInFlight.delete(key);
        markWorkspaceRepositoryDirectoryChanged(input.workspaceCacheKey);
        return;
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
    signal?: AbortSignal;
}>): Promise<ListRepositoryDirectoryEntriesResult> {
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(input.scope);
    if (!workspaceCacheKey) return { ok: false, error: 'unknown_error' };

    const cached = getCachedWorkspaceRepositoryDirectoryEntries({
        workspaceCacheKey,
        directoryPath: input.directoryPath,
    });
    if (cached) {
        return { ok: true, entries: cached,
            truncated: getCachedWorkspaceRepositoryDirectoryMetadata({ workspaceCacheKey, directoryPath: input.directoryPath })?.truncated,
            gitIgnoreAvailable: getCachedWorkspaceRepositoryGitIgnoreAvailable({ workspaceCacheKey, directoryPath: input.directoryPath }) };
    }

    const key = getCacheKey(workspaceCacheKey, input.directoryPath);
    return await warmInFlight(workspaceRepositoryDirectoryWarmInFlight, key, signal => (
        listWorkspaceRepositoryDirectoryEntries({ ...input, signal })
    ), input.signal);
}

export async function listWorkspaceRepositoryDirectoryEntries(input: Readonly<{
    scope: WorkspaceScopeBase;
    directoryPath: string;
    signal?: AbortSignal;
}>): Promise<ListRepositoryDirectoryEntriesResult> {
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(input.scope);
    if (!workspaceCacheKey) return { ok: false, error: 'unknown_error' };

    // The RAW scope path, never the normalized one: `normalizeFileSystemPath` lowercases
    // Windows drive and UNC paths, and this is the daemon's `path` argument.
    const absPath = joinPathAbsolute(input.scope.rootPath, input.directoryPath);
    const departures = captureDirectoryReadDepartures(input.scope.serverId);
    const response = await machineFilesystemListDirectory(
        input.scope.machineId,
        {
            path: absPath,
            includeFiles: true,
            includeGitIgnore: true,
        },
        { serverId: input.scope.serverId, signal: input.signal },
    );
    input.signal?.throwIfAborted();
    if (departures !== readHomeAccountDepartures(input.scope.serverId)) return { ok: false, error: 'unknown_error' };
    if (!response.ok) {
        return { ok: false, error: response.error || 'unknown_error' };
    }

    const entries: RepositoryDirectoryEntry[] = [];
    for (const entry of response.entries) {
        if (!entry || typeof entry.name !== 'string') continue;
        const name = entry.name;
        if (!name) continue;
        if (entry.type !== 'file' && entry.type !== 'directory') continue;
        const sizeBytes = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0
            ? Math.floor(entry.size)
            : undefined;
        const modifiedMs = typeof entry.modified === 'number' && Number.isFinite(entry.modified) && entry.modified >= 0
            ? Math.floor(entry.modified)
            : undefined;
        entries.push({ name, type: entry.type, sizeBytes, modifiedMs,
            ...(response.gitIgnoreAvailable === true && typeof entry.gitIgnored === 'boolean' ? { gitIgnored: entry.gitIgnored } : {}),
        });
    }

    const sorted = sortRepositoryDirectoryEntries(entries);
    setCachedWorkspaceRepositoryDirectoryEntries({
        workspaceCacheKey,
        directoryPath: input.directoryPath,
        entries: sorted,
        gitIgnoreAvailable: response.gitIgnoreAvailable === true,
        truncated: response.truncated,
    });
    return { ok: true, entries: sorted, gitIgnoreAvailable: response.gitIgnoreAvailable === true, truncated: response.truncated };
}
