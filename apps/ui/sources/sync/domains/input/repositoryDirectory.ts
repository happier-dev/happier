import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import {
    clearCachedWorkspaceRepositoryDirectoryEntries,
    getCachedWorkspaceRepositoryDirectoryEntries,
    listWorkspaceRepositoryDirectoryEntries,
    setCachedWorkspaceRepositoryDirectoryEntries,
    warmWorkspaceRepositoryDirectoryCache,
} from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';

import type { ListRepositoryDirectoryEntriesResult, RepositoryDirectoryEntry } from './repositoryDirectoryEntries';
import { sortRepositoryDirectoryEntries } from './repositoryDirectoryEntries';

export function getCachedRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
}): RepositoryDirectoryEntry[] | null {
    const target = resolveWorkspaceTargetForSession(input.sessionId);
    if (!target) return null;
    return getCachedWorkspaceRepositoryDirectoryEntries({
        workspaceCacheKey: target.workspaceCacheKey,
        directoryPath: input.directoryPath,
    });
}

export function setCachedRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
    entries: RepositoryDirectoryEntry[];
}): void {
    const target = resolveWorkspaceTargetForSession(input.sessionId);
    if (!target) return;
    setCachedWorkspaceRepositoryDirectoryEntries({
        workspaceCacheKey: target.workspaceCacheKey,
        directoryPath: input.directoryPath,
        entries: input.entries,
    });
}

export function clearCachedRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath?: string | null;
}): void {
    const target = resolveWorkspaceTargetForSession(input.sessionId);
    if (!target) return;
    clearCachedWorkspaceRepositoryDirectoryEntries({
        workspaceCacheKey: target.workspaceCacheKey,
        directoryPath: input.directoryPath,
    });
}

export async function warmRepositoryDirectoryCache(input: {
    sessionId: string;
    directoryPath: string;
}): Promise<ListRepositoryDirectoryEntriesResult> {
    const target = resolveWorkspaceTargetForSession(input.sessionId);
    if (!target) {
        return { ok: false, error: 'unknown_error' };
    }
    return await warmWorkspaceRepositoryDirectoryCache({
        scope: { serverId: target.serverId, machineId: target.machineId, rootPath: target.rootPath },
        directoryPath: input.directoryPath,
    });
}

export async function listRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
}): Promise<ListRepositoryDirectoryEntriesResult> {
    const target = resolveWorkspaceTargetForSession(input.sessionId);
    if (!target) {
        return { ok: false, error: 'unknown_error' };
    }
    return await listWorkspaceRepositoryDirectoryEntries({
        scope: { serverId: target.serverId, machineId: target.machineId, rootPath: target.rootPath },
        directoryPath: input.directoryPath,
    });
}

export type { ListRepositoryDirectoryEntriesResult, RepositoryDirectoryEntry };
export { sortRepositoryDirectoryEntries };
