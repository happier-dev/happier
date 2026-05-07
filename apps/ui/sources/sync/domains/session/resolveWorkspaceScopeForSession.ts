import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import * as React from 'react';
import { storage } from '@/sync/domains/state/storage';
import { resolveMachineTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { useShallow } from 'zustand/react/shallow';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { normalizeWorkspaceRootPath, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import type { StorageState } from '@/sync/store/types';

type WorkspaceScopeState = Pick<
    StorageState,
    'sessions' | 'machines' | 'sessionListViewDataByServerId' | 'getProjectForSession'
>;

export function resolveWorkspaceScopeForSessionFromState(
    state: WorkspaceScopeState,
    sessionId: string,
    activeServerId: unknown = getActiveServerSnapshot().serverId,
): WorkspaceScopeBase | null {
    const machineTarget = resolveMachineTargetForSessionFromState(state, sessionId);
    if (!machineTarget) return null;

    const machineId = String(machineTarget.machineId ?? '').trim();
    const rootPath = normalizeWorkspaceRootPath(machineTarget.basePath);
    if (!machineId || !rootPath) return null;

    const serverId = resolveServerIdForSessionIdFromLocalState({
        sessions: state.sessions,
        sessionListViewDataByServerId: state.sessionListViewDataByServerId,
    }, sessionId) ?? String(activeServerId ?? '').trim();
    if (!serverId) return null;

    const scope = { serverId, machineId, rootPath };
    return tryBuildWorkspaceCacheKey(scope) ? scope : null;
}

export function resolveWorkspaceScopeForSession(sessionId: string): WorkspaceScopeBase | null {
    return resolveWorkspaceScopeForSessionFromState(storage.getState(), sessionId);
}

export function useWorkspaceScopeForSession(sessionId: string | null | undefined): WorkspaceScopeBase | null {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const selector = useShallow((state: StorageState): WorkspaceScopeState => ({
        sessions: state.sessions,
        machines: state.machines,
        sessionListViewDataByServerId: state.sessionListViewDataByServerId,
        getProjectForSession: state.getProjectForSession,
    }));
    const workspaceState = typeof storage === 'function'
        ? storage(selector)
        : (
            (storage as unknown as { getState?: () => StorageState }).getState?.() ?? null
        );

    return React.useMemo(() => {
        if (!workspaceState || !normalizedSessionId) return null;
        return resolveWorkspaceScopeForSessionFromState(workspaceState, normalizedSessionId);
    }, [normalizedSessionId, workspaceState]);
}
