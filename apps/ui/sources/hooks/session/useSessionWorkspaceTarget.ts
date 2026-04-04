import * as React from 'react';

import { useAllMachines, useAllSessions, useProjectForSession, useSession } from '@/sync/domains/state/storage';
import { resolveWorkspaceTargetForSession, type WorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';

export function useSessionWorkspaceTarget(sessionId: string | null): WorkspaceTargetForSession | null {
    const resolvedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const session = useSession(resolvedSessionId);
    const project = useProjectForSession(resolvedSessionId);
    const allMachines = useAllMachines();
    const allSessions = useAllSessions();

    return React.useMemo(() => {
        if (!resolvedSessionId) return null;
        return resolveWorkspaceTargetForSession(resolvedSessionId);
    }, [
        allMachines,
        allSessions,
        project?.key?.machineId,
        project?.key?.rootPath,
        project?.key?.serverId,
        resolvedSessionId,
        session?.metadata?.homeDir,
        session?.metadata?.host,
        session?.metadata?.machineId,
        session?.metadata?.path,
    ]);
}
