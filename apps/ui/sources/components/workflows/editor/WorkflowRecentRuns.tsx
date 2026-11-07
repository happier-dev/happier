import * as React from 'react';
import { View } from 'react-native';

import { useWorkRelativeTime } from '@/components/sessions/agents/presentation/agentActivityClock';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWorkflowLibrarySummaries, type WorkflowLibraryRunSummary } from '../library/useWorkflowLibrarySummaries';
import { useWorkflowRunWindow } from '../library/workflowLibraryReads';
import { WorkflowRunWindowRow } from '../library/WorkflowRunWindowRow';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { exactWorkflowRunWindowId } from '@/sync/domains/workflows/workflowRunListActions';
import { t } from '@/text';

import { WorkflowInspectorGroup } from './workflowInspectorGroup';

/** The age observes the shared clock only while the closed group actually displays it. */
function RecentRunSummary(props: Readonly<{ run: NonNullable<WorkflowLibraryRunSummary['lastRun']> }>) {
    const age = useWorkRelativeTime(Date.parse(props.run.finishedAt ?? props.run.startedAt));
    return <>{readWorkflowRunWorkStatusFacts(props.run).word} · {age}</>;
}

/** Mounted only by the expanded disclosure; the shared exact window owns the Run records. */
function RecentRunRows(props: Readonly<{ runIds: readonly string[]; workflowName: string; testIDPrefix: string }>) {
    const read = useWorkflowRunWindow(exactWorkflowRunWindowId(props.runIds), { readMode: 'complete' });
    const serverId = read.serverId;
    return <View testID={`${props.testIDPrefix}-recent-runs`}>
        {read.status === 'failed' ? <SurfaceFreshnessLine tone="warning"
            reason={t('workflows.destination.history.loadFailedTitle')}
            action={{ label: t('workflows.retry'), onPress: read.retry }} /> : null}
        {read.rows.length === 0 && read.status !== 'failed' ? read.status === 'loading'
            ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
            : <EmptyState layout="line" title={t('workflows.page.inspector.noRunsYet')} /> : null}
        {serverId === null ? null : read.rows.map(row => <WorkflowRunWindowRow key={row.id}
            row={row} serverId={serverId} accountLifetime={read.accountLifetime}
            fallbackName={props.workflowName} testID={`${props.testIDPrefix}-recent-run:${row.id}`} />)}
    </View>;
}

/** A saved workflow's quiet run summary, sharing the library's push-driven source-summary owner. */
export function WorkflowRecentRuns(props: Readonly<{
    definitionId: string;
    workflowName: string;
    disclosure: ReadonlyMap<string, boolean>;
    onChangeDisclosure?: (groupId: string, expanded: boolean) => void;
    testIDPrefix: string;
}>) {
    const read = useWorkflowLibrarySummaries([props.definitionId]);
    const summary = read.summaries?.get(props.definitionId);
    return <WorkflowInspectorGroup groupId="recentRuns" title={t('workflows.page.inspector.recentRuns')}
        summary={summary?.lastRun ? <RecentRunSummary run={summary.lastRun} />
            : summary ? '' : t(read.failed ? 'workflows.contentUnavailable' : 'common.loading')}
        attention={false} valueSet={false} disclosure={props.disclosure}
        onChangeDisclosure={props.onChangeDisclosure} testID={`${props.testIDPrefix}-group-recent-runs`}>
        {read.failed ? <SurfaceFreshnessLine tone="warning" reason={t('workflows.destination.history.loadFailedTitle')}
            action={{ label: t('workflows.retry'), onPress: read.retry }} /> : null}
        {summary === undefined ? read.failed ? null : <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />
            : summary.recent.length === 0 ? <EmptyState layout="line" title={t('workflows.page.inspector.noRunsYet')} />
            : <RecentRunRows runIds={summary.recent.map(run => run.runId)} workflowName={props.workflowName} testIDPrefix={props.testIDPrefix} />}
    </WorkflowInspectorGroup>;
}
