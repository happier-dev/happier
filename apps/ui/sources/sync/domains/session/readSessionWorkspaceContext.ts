type SessionWorkspaceContextState = Readonly<{
    sessions?: Record<string, {
        metadata?: {
            path?: string | null;
        } | null;
    }>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; path?: string | null } } | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function readSessionWorkspaceContext(
    state: SessionWorkspaceContextState,
    sessionId: string,
): Readonly<{
    workspacePath: string | null;
    projectPath: string | null;
    projectMachineId: string | null;
}> {
    const metadata = state.sessions?.[sessionId]?.metadata;
    const sessionPath = normalizeNonEmptyString(metadata?.path);
    const project = typeof state.getProjectForSession === 'function' ? state.getProjectForSession(sessionId) : null;
    const projectPath = normalizeNonEmptyString(project?.key?.path);
    const projectMachineId = normalizeNonEmptyString(project?.key?.machineId);
    return {
        workspacePath: sessionPath ?? projectPath,
        projectPath,
        projectMachineId,
    };
}
