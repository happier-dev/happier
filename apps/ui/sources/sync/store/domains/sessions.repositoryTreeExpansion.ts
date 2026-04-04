import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

type WorkspaceTargetResolver = (sessionId: string) => Readonly<{ workspaceCacheKey: string }> | null;

export type SessionRepositoryTreeExpansionState = Readonly<{
    sessionRepositoryTreeExpandedPathsBySessionId: Record<string, string[]>;
    workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: Record<string, string[]>;
}>;

export function createInitialSessionRepositoryTreeExpansionState(): SessionRepositoryTreeExpansionState {
    return {
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {},
    };
}

export function getSessionRepositoryTreeExpandedPathsForState(
    state: SessionRepositoryTreeExpansionState,
    sessionId: string,
    resolveWorkspaceTargetForSession: WorkspaceTargetResolver,
): string[] {
    const workspaceTarget = resolveWorkspaceTargetForSession(sessionId);
    if (workspaceTarget) {
        const workspacePaths = state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey[workspaceTarget.workspaceCacheKey];
        if (workspacePaths) return workspacePaths;
    }
    return state.sessionRepositoryTreeExpandedPathsBySessionId[sessionId] ?? [];
}

export function setSessionRepositoryTreeExpandedPathsForState(
    state: SessionRepositoryTreeExpansionState,
    sessionId: string,
    paths: string[],
    resolveWorkspaceTargetForSession: WorkspaceTargetResolver,
): SessionRepositoryTreeExpansionState {
    const workspaceTarget = resolveWorkspaceTargetForSession(sessionId);
    if (workspaceTarget) {
        const nextWorkspace = {
            ...state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
            [workspaceTarget.workspaceCacheKey]: paths,
        };
        const { [sessionId]: _removed, ...nextSession } = state.sessionRepositoryTreeExpandedPathsBySessionId;
        return {
            sessionRepositoryTreeExpandedPathsBySessionId: nextSession,
            workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: nextWorkspace,
        };
    }

    return {
        ...state,
        sessionRepositoryTreeExpandedPathsBySessionId: {
            ...state.sessionRepositoryTreeExpandedPathsBySessionId,
            [sessionId]: paths,
        },
    };
}

export function clearSessionRepositoryTreeExpandedPathsForState(
    state: SessionRepositoryTreeExpansionState,
    sessionId: string,
    resolveWorkspaceTargetForSession: WorkspaceTargetResolver,
): SessionRepositoryTreeExpansionState {
    const workspaceTarget = resolveWorkspaceTargetForSession(sessionId);
    if (workspaceTarget) {
        const workspaceKey = workspaceTarget.workspaceCacheKey;
        const hasWorkspace = workspaceKey in state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
        const hasSession = sessionId in state.sessionRepositoryTreeExpandedPathsBySessionId;
        if (!hasWorkspace && !hasSession) return state;
        const { [workspaceKey]: _removedWorkspace, ...nextWorkspace } = state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
        const { [sessionId]: _removedSession, ...nextSession } = state.sessionRepositoryTreeExpandedPathsBySessionId;
        return {
            sessionRepositoryTreeExpandedPathsBySessionId: nextSession,
            workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: nextWorkspace,
        };
    }

    if (!(sessionId in state.sessionRepositoryTreeExpandedPathsBySessionId)) return state;
    const { [sessionId]: _removed, ...rest } = state.sessionRepositoryTreeExpandedPathsBySessionId;
    return {
        ...state,
        sessionRepositoryTreeExpandedPathsBySessionId: rest,
    };
}

export function getWorkspaceRepositoryTreeExpandedPathsForState(
    state: SessionRepositoryTreeExpansionState,
    scope: WorkspaceScopeBase,
): string[] {
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(scope);
    if (!workspaceCacheKey) return [];
    return state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey[workspaceCacheKey] ?? [];
}

export function setWorkspaceRepositoryTreeExpandedPathsForState(
    state: SessionRepositoryTreeExpansionState,
    scope: WorkspaceScopeBase,
    paths: string[],
): SessionRepositoryTreeExpansionState {
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(scope);
    if (!workspaceCacheKey) return state;
    return {
        ...state,
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: {
            ...state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
            [workspaceCacheKey]: paths,
        },
    };
}

export function clearWorkspaceRepositoryTreeExpandedPathsForState(
    state: SessionRepositoryTreeExpansionState,
    scope: WorkspaceScopeBase,
): SessionRepositoryTreeExpansionState {
    const workspaceCacheKey = tryBuildWorkspaceCacheKey(scope);
    if (!workspaceCacheKey) return state;
    if (!(workspaceCacheKey in state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey)) return state;
    const { [workspaceCacheKey]: _removed, ...rest } = state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey;
    return {
        ...state,
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: rest,
    };
}

export function deleteSessionRepositoryTreeExpansionForState(
    state: SessionRepositoryTreeExpansionState,
    sessionId: string,
): SessionRepositoryTreeExpansionState {
    const { [sessionId]: _deletedTreeState, ...remainingTreeState } = state.sessionRepositoryTreeExpandedPathsBySessionId;
    return {
        sessionRepositoryTreeExpandedPathsBySessionId: remainingTreeState,
        workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey: state.workspaceRepositoryTreeExpandedPathsByWorkspaceCacheKey,
    };
}
