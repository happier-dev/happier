import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { normalizeWorkspaceRootPath, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import {
    clearCachedWorkspaceRepositoryDirectoryEntries,
    getCachedWorkspaceRepositoryDirectoryEntries,
    listWorkspaceRepositoryDirectoryEntries,
    setCachedWorkspaceRepositoryDirectoryEntries,
    warmWorkspaceRepositoryDirectoryCache,
} from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';

import type { ListRepositoryDirectoryEntriesResult, RepositoryDirectoryEntry } from './repositoryDirectoryEntries';
import { sortRepositoryDirectoryEntries } from './repositoryDirectoryEntries';

function resolveWorkspaceTargetForSession(sessionId: string): Readonly<{
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId?: string | null;
}> | null {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) return null;
    const machineId = String(machineTarget.machineId ?? '').trim();
    const rootPath = normalizeWorkspaceRootPath(machineTarget.basePath) ?? String(machineTarget.basePath ?? '').trim();
    if (!machineId || !rootPath) return null;
    const serverId = resolvePreferredServerIdForSessionId(sessionId);

    const workspaceCacheKey =
        tryBuildWorkspaceCacheKey({ serverId: String(serverId ?? ''), machineId, rootPath })
        ?? `${machineId}:${rootPath}`;

    return {
        workspaceCacheKey,
        machineId,
        rootPath,
        serverId,
    };
}

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
        workspaceCacheKey: target.workspaceCacheKey,
        machineId: target.machineId,
        rootPath: target.rootPath,
        directoryPath: input.directoryPath,
        serverId: target.serverId,
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
        workspaceCacheKey: target.workspaceCacheKey,
        machineId: target.machineId,
        rootPath: target.rootPath,
        directoryPath: input.directoryPath,
        serverId: target.serverId,
    });
}

export type { ListRepositoryDirectoryEntriesResult, RepositoryDirectoryEntry };
export { sortRepositoryDirectoryEntries };
