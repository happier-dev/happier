import { storage } from '@/sync/domains/state/storage';
import { readSessionWorkspaceContext } from '@/sync/domains/session/readSessionWorkspaceContext';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';
import { resolveProjectMachineScopeId } from '@/sync/runtime/orchestration/projectManager';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveRepoScmSessionRequest(input: Readonly<{
    sessionId: string;
}>): Readonly<{
    sessionId: string;
    machineId: string | null;
    resolvedPath: string;
    repoIdentityKey: string;
}> | null {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
        return null;
    }

    const state = storage.getState();
    const session = state.sessions?.[sessionId];
    if (!session) {
        return null;
    }

    const workspaceContext = readSessionWorkspaceContext(state, sessionId);
    const machineTarget = readMachineTargetForSession(sessionId);
    const sessionWorkspacePath = normalizeNonEmptyString(workspaceContext.workspacePath);
    const projectPath = normalizeNonEmptyString(workspaceContext.projectPath);
    const normalizedRepoPath =
        normalizeNonEmptyString(machineTarget?.basePath)
        ?? (
            session.active === true
                ? sessionWorkspacePath ?? projectPath
                : projectPath ?? sessionWorkspacePath
        );
    if (!normalizedRepoPath) {
        return null;
    }

    const reachableMachineId = machineTarget?.machineId ?? null;
    const sessionMachineId = resolveSessionMachineId(session.metadata);
    const projectMachineId = normalizeNonEmptyString(workspaceContext.projectMachineId);
    const machineId =
        reachableMachineId
        ?? sessionMachineId
        ?? projectMachineId
        ?? resolveProjectMachineScopeId(session.metadata ?? {});

    const machineHomeDir =
        machineId && machineId !== 'unknown'
            ? state.machines?.[machineId]?.metadata?.homeDir
            : undefined;
    const resolvedPath = resolveAbsolutePath(
        normalizedRepoPath,
        session.metadata?.homeDir ?? machineHomeDir
    );

    return {
        sessionId,
        machineId: machineId && machineId !== 'unknown' ? machineId : null,
        resolvedPath,
        repoIdentityKey: `${machineId}:${resolvedPath}`,
    };
}
