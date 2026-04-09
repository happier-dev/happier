import * as React from 'react';

import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { WorkspaceFileDetailsView } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';

import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { useProjectForSession, useSession } from '@/sync/domains/state/storage';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';

export type SessionFileDeepLinkAnchor = Readonly<{
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
}>;

export type SessionFileDetailsViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    filePath: string;
    deepLinkAnchor?: SessionFileDeepLinkAnchor | null;
    presentation?: 'screen' | 'panel';
    onStartEditingFile?: () => void;
}>;

export function SessionFileDetailsView(props: SessionFileDetailsViewProps) {
    const sessionId = props.sessionId;
    const project = useProjectForSession(sessionId);
    const session = useSession(sessionId);
    const preferredServerId = usePreferredServerIdForSession(sessionId);
    const machineTarget = readMachineTargetForSession(sessionId);

    const scope: WorkspaceScopeBase | null = React.useMemo(() => {
        const projectKey: any = project?.key ?? null;
        const serverId = String(projectKey?.serverId ?? preferredServerId ?? '').trim();

        if (machineTarget && serverId) {
            return {
                serverId,
                machineId: machineTarget.machineId,
                rootPath: machineTarget.basePath,
            };
        }

        const machineId = String(projectKey?.machineId ?? session?.metadata?.machineId ?? '').trim();
        const rootPath = String(projectKey?.rootPath ?? projectKey?.path ?? session?.metadata?.path ?? '').trim();
        if (!serverId || !machineId || !rootPath) {
            return null;
        }
        return { serverId, machineId, rootPath };
    }, [machineTarget, preferredServerId, project?.key, session?.metadata?.machineId, session?.metadata?.path, session?.serverId]);

    return (
        <WorkspaceFileDetailsView
            scopeId={props.scopeId}
            scope={scope}
            filePath={props.filePath}
            deepLinkAnchor={props.deepLinkAnchor ?? null}
            presentation={props.presentation}
            sessionIdForAugmentation={sessionId}
            onStartEditingFile={props.onStartEditingFile}
        />
    );
}
