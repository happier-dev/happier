import * as React from 'react';
import { useReportSessionInfoSectionSummary } from '@/components/sessions/info/sessionInfoSectionSummaries';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPageSheetGroup } from '@happier-dev/plugin-ui/presentation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { ManagedRunMiniMap, useWorkRowOnScreen } from '@/components/sessions/work/WorkItemRow';
import { WorkflowRunItemBody } from '@/components/sessions/shell/row/WorkflowRunItemBody';
import type { WorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { useActiveServerAccountScope, useWorkflowRun } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { ScheduledWorkflowRows, type ScheduledWorkflowRowsRead } from './ScheduledWorkflowSection';
import { useRunsListedInTriggerHistory } from './SessionTriggerHistoryScope';

/**
 * Destination is the accepted graph relation, not the Run's initiating Session.
 *
 * One group of the Session's Triggers section (lab P1-I: what starts from here, and what writes into
 * it). The group exists only while something writes into this Session: a run that did, a scheduled one
 * that will. The Habits owner presents read failures once. With nothing to show it draws nothing — no bare
 * heading, and no placeholder while it reads, since a section that may not exist would only collapse
 * and move the sections under it.
 */
export const SessionWritesHereSection = React.memo(function SessionWritesHereSection(props: Readonly<{
    sessionId: string; serverId?: string | null; scheduled: ScheduledWorkflowRowsRead; read: WorkflowRunWindow;
}>) {
    const scope = useActiveServerAccountScope();
    const inScope = scope !== null && (!props.serverId || areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId));
    // Another Home's Session reads nothing here: the reads mount only inside the active Account.
    return inScope ? <WritesHere sessionId={props.sessionId} serverId={scope.serverId} scheduled={props.scheduled} read={props.read} /> : null;
});

const WritesHere = React.memo(function WritesHere(props: Readonly<{ sessionId: string; serverId: string; scheduled: ScheduledWorkflowRowsRead; read: WorkflowRunWindow }>) {
    const { theme } = useUnistyles();
    const read = props.read;
    const scheduled = props.scheduled;
    const hasScheduled = scheduled.available && scheduled.rows.length > 0;
    // A Run an open trigger History already lists is shown there, once.
    const listedUnderTrigger = useRunsListedInTriggerHistory();
    const runIds = React.useMemo(() => read.runIds.filter((runId) => !listedUnderTrigger.has(runId)), [listedUnderTrigger, read.runIds]);
    // Session Info folds an empty Habits from this read too: what writes here, scheduled work included.
    const summaryScope = useActiveServerAccountScope(props.serverId);
    const scheduledStatus = scheduled.available ? scheduled.status : 'ready';
    const heldCount = read.runIds.length + (scheduled.available ? scheduled.rows.length : 0);
    useReportSessionInfoSectionSummary('habits.writesHere', summaryScope ? {
        scope: summaryScope,
        sessionId: props.sessionId,
        status: read.status === 'failed' || scheduledStatus === 'failed' ? 'error'
            : read.status === 'loaded' && scheduledStatus === 'ready' ? 'ready' : 'loading',
        coverage: heldCount === 0 && read.hasMore ? 'partial' : 'complete',
        count: heldCount,
    } : null);
    if (runIds.length === 0 && !hasScheduled) return null;
    const count = runIds.length + (hasScheduled ? scheduled.rows.length : 0);
    // What is next leads, then what already wrote here, newest first; Load more closes the Runs it extends.
    return <HappierPageSheetGroup testID="session-work-writes-here" header={(
        <CollectionListGroupLabel testID="session-work-writes-here-label" title={t('sessionWork.scheduled.writesHere')}
            count={count > 1 ? count : undefined}
            mark={<Icon name="sign-in" size={16} color={theme.colors.text.secondary} />} />
    )}>
        {hasScheduled ? <ScheduledWorkflowRows read={scheduled} sessionId={props.sessionId} /> : null}
        {runIds.map((runId) => <DestinationRun key={runId} runId={runId} serverId={props.serverId}
            sessionId={props.sessionId} />)}
        {/* A full-width button between rows: the rows above and below own the space around it. */}
        {read.hasMore ? <ToolbarButton testID="session-work-writes-here-more" label={t('workflows.destination.history.loadMore')}
            hitReach={0} disabled={read.loadingMore} onPress={read.loadMore} /> : null}
    </HappierPageSheetGroup>;
});

const DestinationRun = React.memo(function DestinationRun(props: Readonly<{
    runId: string; serverId: string; sessionId: string;
}>) {
    const rowRef = React.useRef<View>(null);
    const visible = useWorkRowOnScreen(rowRef);
    const row = useWorkflowRun(props.runId);
    const router = useRouter();
    const open = React.useCallback(() => router.push(createWorkflowRunRoute(props.runId, props.serverId) as never), [router, props.runId, props.serverId]);
    const working = row?.summary && describeWorkflowRunState(row.summary.state).marker.kind === 'activity';
    return <View ref={rowRef} collapsable={false}>
        <WorkflowRunItemBody kind="workflow_run" runId={props.runId} serverId={props.serverId}
            destinationSessionId={props.sessionId}
            presentation="work" />
        {visible && working ? <ManagedRunMiniMap runId={props.runId} serverId={props.serverId}
            testIDPrefix={`session-work-writes-here-flow:${props.runId}`} onOpen={open} /> : null}
    </View>;
});
