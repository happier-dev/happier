import * as React from 'react';
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceFileDetailsView } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { normalizeWorkspaceScopeBase, tryBuildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { readCapturedFileReviewContext } from '@/utils/url/sessionFileDeepLink';

/** The ordinary File viewer, opened on immutable Machine-owned evidence rather than a live checkout. */
export function WorkspaceRouteBody() {
    const params = useLocalSearchParams();
    const target = parseSessionPaneUrlState({ ...params, details: 'file' })?.details;
    const scope = typeof params.serverId === 'string' && typeof params.machineId === 'string' && typeof params.rootPath === 'string'
        ? normalizeWorkspaceScopeBase({ serverId: params.serverId, machineId: params.machineId, rootPath: params.rootPath }) : null;
    if (!scope || target?.kind !== 'file' || !target.changes?.comparisonId) {
        return <SurfaceStateCard kind="error" title={t('common.unavailable')} />;
    }
    return <WorkspaceFileDetailsView scopeId={`captured-file:${tryBuildWorkspaceCacheKey(scope)}:${target.changes.comparisonId}`}
        scope={scope} filePath={target.path} initialChanges={target.changes}
        initialView={{ view: 'changes' }} evidenceOnly presentation="screen" review={readCapturedFileReviewContext(params)}
        sessionIdForAugmentation={typeof params.evidenceSessionId === 'string' ? params.evidenceSessionId : undefined} />;
}

export default function CapturedFileRoute() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
