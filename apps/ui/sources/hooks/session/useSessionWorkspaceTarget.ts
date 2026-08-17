import * as React from 'react';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useAllMachines, useAllSessions, useProjectForSession, useSession } from '@/sync/domains/state/storage';
import type { WorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { normalizeWorkspaceRootPath, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export function useSessionWorkspaceTarget(sessionId: string | null): WorkspaceTargetForSession | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const session = useSession(resolvedSessionId);
    const ownerMetadata = session
        ? readSessionOwnerMetadataView(session)
        : null;
    const project = useProjectForSession(resolvedSessionId);
    const allMachines = useAllMachines();
    const allSessions = useAllSessions();
    const fallbackServerId = React.useMemo(() => {
        const direct = (session as { serverId?: unknown } | null)?.serverId ?? project?.key?.serverId ?? null;
        return typeof direct === 'string' && direct.trim().length > 0 ? direct : null;
    }, [project?.key?.serverId, (session as { serverId?: unknown } | null)?.serverId]);
    const preferredServerId = usePreferredServerIdForSession(resolvedSessionId ?? '__none__', fallbackServerId);

    return React.useMemo(() => {
        if (!resolvedSessionId) return null;

        const machineTarget = readMachineTargetForSession(resolvedSessionId);
        if (!machineTarget) return null;

        const machineId = String(machineTarget.machineId ?? '').trim();
        const rootPath = normalizeWorkspaceRootPath(machineTarget.basePath) ?? String(machineTarget.basePath ?? '').trim();
        const serverId = String(preferredServerId ?? '').trim();
        if (!machineId || !rootPath || !serverId) return null;

        const workspaceCacheKey = tryBuildWorkspaceCacheKey({ serverId, machineId, rootPath });
        if (!workspaceCacheKey) return null;

        return {
            workspaceCacheKey,
            machineId,
            rootPath,
            serverId,
            ...(machineTarget.agentBasePath ? { agentRootPath: machineTarget.agentBasePath } : {}),
        };
    }, [
        allMachines,
        allSessions,
        project?.key?.machineId,
        project?.key?.rootPath,
        project?.key?.serverId,
        preferredServerId,
        resolvedSessionId,
        ownerMetadata?.homeDir,
        ownerMetadata?.host,
        ownerMetadata?.machineId,
        ownerMetadata?.path,
        ownerMetadata?.sessionWorkspaceLocationV1,
    ]);
}
