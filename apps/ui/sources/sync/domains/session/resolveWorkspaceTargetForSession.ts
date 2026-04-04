import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { normalizeWorkspaceRootPath, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

export type WorkspaceTargetForSession = WorkspaceScopeBase & Readonly<{
    workspaceCacheKey: string;
}>;

export function resolveWorkspaceTargetForSession(sessionId: string): WorkspaceTargetForSession | null {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) return null;

    const machineId = String(machineTarget.machineId ?? '').trim();
    const rootPath = normalizeWorkspaceRootPath(machineTarget.basePath) ?? String(machineTarget.basePath ?? '').trim();
    if (!machineId || !rootPath) return null;

    const serverId = resolvePreferredServerIdForSessionId(sessionId);
    if (!serverId) return null;
    const workspaceCacheKey =
        tryBuildWorkspaceCacheKey({ serverId: String(serverId ?? ''), machineId, rootPath });
    if (!workspaceCacheKey) return null;

    return {
        workspaceCacheKey,
        machineId,
        rootPath,
        serverId,
    };
}
