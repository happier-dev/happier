import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { storage } from '@/sync/domains/state/storage';
import { useShallow } from 'zustand/react/shallow';
import type { StorageState } from '@/sync/store/types';

export function resolveWorkspaceScopeForSession(sessionId: string): WorkspaceScopeBase | null {
    return resolveWorkspaceTargetForSession(sessionId);
}

export function useWorkspaceScopeForSession(sessionId: string | null | undefined): WorkspaceScopeBase | null {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const selector = useShallow((state: StorageState): WorkspaceScopeBase | null => {
        if (!normalizedSessionId) return null;
        return resolveWorkspaceTargetForSessionFromState({
            sessions: state.sessions,
            sessionListRenderables: state.sessionListRenderables,
            machines: state.machines,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            getProjectForSession: state.getProjectForSession,
        }, normalizedSessionId);
    });
    const workspaceState = typeof storage === 'function'
        ? storage(selector)
        : (
            (storage as unknown as { getState?: () => StorageState }).getState
                ? selector((storage as unknown as { getState: () => StorageState }).getState())
                : null
        );
    return workspaceState;
}
