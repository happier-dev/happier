import type { SessionServerLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import {
    resolveSessionListLookupSessionServerScopeFromState,
    resolveSessionListPreferredServerIdFromState,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { SessionMachineTargetState } from '@/sync/ops/sessionMachineTargetFromState';
import { resolveMachineTargetForSessionFromState } from '@/sync/ops/sessionMachineTargetFromState';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { normalizeWorkspaceRootPath, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

export type WorkspaceTargetForSession = WorkspaceScopeBase & Readonly<{
    workspaceCacheKey: string;
}>;

export type WorkspaceTargetForSessionState = SessionMachineTargetState & SessionServerLookupStateLike;

export function resolveWorkspaceTargetForSessionFromState(
    state: WorkspaceTargetForSessionState,
    sessionId: string,
): WorkspaceTargetForSession | null {
    const machineTarget = resolveMachineTargetForSessionFromState(state, sessionId);
    if (!machineTarget) return null;

    const machineId = String(machineTarget.machineId ?? '').trim();
    const rootPath = normalizeWorkspaceRootPath(machineTarget.basePath) ?? String(machineTarget.basePath ?? '').trim();
    if (!machineId || !rootPath) return null;

    const cachedScope = resolveSessionListLookupSessionServerScopeFromState(state, sessionId);
    const hasRenderableSession = Boolean(state?.sessionListRenderables?.[sessionId]);
    if (!cachedScope?.serverId && !hasRenderableSession) {
        return null;
    }

    const serverId = resolveSessionListPreferredServerIdFromState(
        state,
        sessionId,
        getActiveServerSnapshot().serverId,
    );
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
