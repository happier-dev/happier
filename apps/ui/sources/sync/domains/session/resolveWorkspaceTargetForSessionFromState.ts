import type { SessionServerLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import {
    resolveSessionListLookupSessionServerScopeFromState,
    resolveSessionListPreferredServerIdFromState,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    resolveMachineTargetForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { normalizeWorkspaceRootPath, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

export type WorkspaceTargetForSession = WorkspaceScopeBase & Readonly<{
    workspaceCacheKey: string;
    agentRootPath?: string;
}>;

export type WorkspaceTargetForSessionState = SessionMachineTargetState & SessionServerLookupStateLike;

export type ResolveWorkspaceTargetForSessionFromStateOptions = Readonly<{
    fallbackServerId?: string | null;
}>;

export function resolveWorkspaceTargetForSessionFromState(
    state: WorkspaceTargetForSessionState,
    sessionId: string,
    options?: ResolveWorkspaceTargetForSessionFromStateOptions,
): WorkspaceTargetForSession | null {
    const machineTarget = resolveMachineTargetForSessionFromState(state, sessionId);
    if (!machineTarget) return null;

    const machineId = String(machineTarget.machineId ?? '').trim();
    const rootPath = normalizeWorkspaceRootPath(machineTarget.basePath) ?? String(machineTarget.basePath ?? '').trim();
    if (!machineId || !rootPath) return null;

    const fallbackServerId = String(options?.fallbackServerId ?? getActiveServerSnapshot().serverId ?? '').trim();
    const cachedScope = resolveSessionListLookupSessionServerScopeFromState(state, sessionId);
    const hasRenderableSession = Boolean(state?.sessionListRenderables?.[sessionId]);
    if (!cachedScope?.serverId && !hasRenderableSession && !fallbackServerId) {
        return null;
    }

    const serverId = resolveSessionListPreferredServerIdFromState(
        state,
        sessionId,
        fallbackServerId,
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
        ...(machineTarget.agentBasePath ? { agentRootPath: machineTarget.agentBasePath } : {}),
    };
}
