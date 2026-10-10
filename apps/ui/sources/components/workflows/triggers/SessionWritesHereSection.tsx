import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkSection } from '@/components/sessions/work/WorkSection';
import { ManagedRunMiniMap, useWorkRowOnScreen } from '@/components/sessions/work/WorkItemRow';
import { WorkflowRunItemBody } from '@/components/sessions/shell/row/WorkflowRunItemBody';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { useActiveServerAccountScope, useWorkflowRun } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { ScheduledWorkflowRows, useScheduledWorkflowRows } from './ScheduledWorkflowSection';

/**
 * Destination is the accepted graph relation, not the Run's initiating Session.
 *
 * The section exists only while something writes into this Session: a run that did, a scheduled one
 * that will, or a read that failed and must say so. With nothing to show it draws nothing — no bare
 * heading, and no placeholder while it reads, since a section that may not exist would only collapse
 * and move the sections under it.
 */
export const SessionWritesHereSection = React.memo(function SessionWritesHereSection(props: Readonly<{
    sessionId: string; serverId?: string | null;
}>) {
    const scope = useActiveServerAccountScope();
    const inScope = scope !== null && (!props.serverId || areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId));
    // Another Home's Session reads nothing here: the reads mount only inside the active Account.
    return inScope ? <WritesHere sessionId={props.sessionId} serverId={scope.serverId} /> : null;
});

const WritesHere = React.memo(function WritesHere(props: Readonly<{ sessionId: string; serverId: string }>) {
    const read = useWorkflowRunWindow(`destination:${props.sessionId}`);
    const scheduled = useScheduledWorkflowRows(props.sessionId);
    const readFailed = read.status === 'failed' || read.loadMoreFailed;
    const hasScheduled = scheduled.available && (scheduled.rows.length > 0 || scheduled.status === 'failed');
    if (read.runIds.length === 0 && !readFailed && !hasScheduled) return null;
    return <WorkSection testID="session-work-writes-here" anatomy="page" title={t('sessionWork.scheduled.writesHere')}
        count={read.runIds.length}>
        {read.runIds.map((runId, index) => <DestinationRun key={runId} runId={runId} serverId={props.serverId}
            sessionId={props.sessionId}
            first={index === 0} last={index === read.runIds.length - 1} />)}
        {readFailed ? <SurfaceFreshnessLine testID="session-work-writes-here-failed"
            tone="warning" reason={t('workflows.triggers.section.loadFailed')}
            action={{ label: t('workflows.retry'), onPress: read.loadMoreFailed ? read.loadMore : read.retry }} /> : null}
        {read.hasMore ? <ToolbarButton testID="session-work-writes-here-more" label={t('workflows.destination.history.loadMore')}
            disabled={read.loadingMore} onPress={read.loadMore} /> : null}
        {hasScheduled ? <ScheduledWorkflowRows read={scheduled} sessionId={props.sessionId} /> : null}
    </WorkSection>;
});

const DestinationRun = React.memo(function DestinationRun(props: Readonly<{
    runId: string; serverId: string; sessionId: string; first: boolean; last: boolean;
}>) {
    const rowRef = React.useRef<View>(null);
    const visible = useWorkRowOnScreen(rowRef);
    const row = useWorkflowRun(props.runId);
    const router = useRouter();
    const open = React.useCallback(() => router.push(createWorkflowRunRoute(props.runId) as never), [router, props.runId]);
    const working = row?.summary && describeWorkflowRunState(row.summary.state).marker.kind === 'activity';
    return <View ref={rowRef} collapsable={false}>
        <WorkflowRunItemBody kind="workflow_run" runId={props.runId} serverId={props.serverId}
            destinationSessionId={props.sessionId}
            isFirst={props.first} isLast={props.last} presentation="work" />
        {visible && working ? <ManagedRunMiniMap runId={props.runId} serverId={props.serverId}
            testIDPrefix={`session-work-writes-here-flow:${props.runId}`} onOpen={open} /> : null}
    </View>;
});
