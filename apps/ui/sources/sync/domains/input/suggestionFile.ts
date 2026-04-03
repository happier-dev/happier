import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { normalizeWorkspaceRootPath, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { searchWorkspaceFiles, workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

export type FileItem = FileSearchItem;

export type SearchOptions = Readonly<{
    limit?: number;
    threshold?: number;
}>;

function resolveWorkspaceSearchTargetForSession(sessionId: string): Readonly<{
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

export const fileSearchCache = {
    clearCache(sessionId?: string) {
        if (typeof sessionId === 'string' && sessionId.trim()) {
            const target = resolveWorkspaceSearchTargetForSession(sessionId);
            if (!target) return;
            workspaceFileSearchCache.clearCache(target.workspaceCacheKey);
            return;
        }
        workspaceFileSearchCache.clearCache();
    },
};

export async function searchFiles(
    sessionId: string,
    query: string,
    options: SearchOptions = {},
): Promise<FileItem[]> {
    const target = resolveWorkspaceSearchTargetForSession(sessionId);
    if (!target) return [];

    return await searchWorkspaceFiles({
        workspaceCacheKey: target.workspaceCacheKey,
        machineId: target.machineId,
        rootPath: target.rootPath,
        serverId: target.serverId,
        query,
        limit: options.limit,
        threshold: options.threshold,
    });
}
