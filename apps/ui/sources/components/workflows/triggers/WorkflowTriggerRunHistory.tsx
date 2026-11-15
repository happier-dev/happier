import * as React from 'react';
import { View } from 'react-native';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { WorkflowRunWindowRow } from '../library/WorkflowRunWindowRow';
import { Item } from '@/components/ui/lists/Item';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatNextScheduledRun, formatNextScheduledRunAccessibilityLabel, formatNextScheduledRunTime, readNextScheduledRunRefreshAtMs } from './formatTriggerSummary';
import { readOnceScheduleState, formatOnceScheduleStateLabel, type OnceScheduleSource } from './triggerSchedule';

import { useReportTriggerHistoryRuns } from './SessionTriggerHistoryScope';
import { AutomationHistoryGapRecoveryAction } from '@/components/automations/screens/AutomationHistoryGapRecoveryAction';
import { useAutomation } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { formatAutomationTriggerObservationWarning } from '@/components/automations/list/automationListFormatting';

/** Mounted only for the expanded trigger; the shared Run window owns reads and pagination. */
export const WorkflowTriggerRunHistory = React.memo(function WorkflowTriggerRunHistory(props: Readonly<{
    automationId: string;
    triggerId: string;
    accountLifetime?: ServerAccountScopeLifetime | null;
    /** The trigger's name: it names a Run whose own title cannot be read. */
    triggerName?: string;
    /** Exact saved scheduler occurrence for this trigger, absent on older summaries. */
    nextRunAt?: number | null;
    /** The saved trigger: a spent one-time schedule heads its History with Completed, or Missed from its Run. */
    trigger?: OnceScheduleSource;
}>) {
    const read = useWorkflowRunWindow(`trigger:${props.triggerId}`, { accountLifetime: props.accountLifetime });
    const automation = useAutomation(props.automationId, { serverId: props.accountLifetime?.scope.serverId });
    const observationWarning = formatAutomationTriggerObservationWarning(
        automation?.triggers.find(trigger => trigger.id === props.triggerId), automation?.enabled,
    );
    const isCurrentRoute = useEventCallback(() => read.accountLifetime?.isCurrent() === true);
    useReportTriggerHistoryRuns(props.automationId, read.runIds);
    const serverId = read.serverId;
    const nextRunAt = props.nextRunAt ?? null;
    const readNextRefresh = React.useCallback((nowMs: number) => readNextScheduledRunRefreshAtMs(nextRunAt, nowMs), [nextRunAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, nextRunAt !== null);
    const once = props.trigger ? readOnceScheduleState(props.trigger, read.rows[0]?.summary?.state) : null;
    const empty = read.rows.length === 0 && read.status !== 'failed';
    // An empty History with a future occurrence says both in one sentence (07 S4), so the next run isn't said twice.
    const emptyWithNext = empty && read.status !== 'loading' && nextRunAt !== null && nextRunAt > nowMs;
    return <View testID={`session-work-trigger-history:${props.automationId}`}>
        {automation ? <AutomationHistoryGapRecoveryAction automation={automation} triggerId={props.triggerId}
            isCurrentRoute={isCurrentRoute} rereadAutomationStatus={sync.refreshAutomations} /> : null}
        {observationWarning ? <SurfaceFreshnessLine testID={`session-work-trigger-history:${props.automationId}-observation`}
            tone="warning" reason={observationWarning} /> : null}
        {nextRunAt !== null && !emptyWithNext ? <Item title={formatNextScheduledRun(nextRunAt, true, nowMs)} mode="info"
            accessibilityLabel={formatNextScheduledRunAccessibilityLabel(nextRunAt, true, nowMs)} /> : null}
        {once === 'done' || once === 'missed' ? <Item testID={`session-work-trigger-history:${props.automationId}-once`} mode="info"
            title={formatOnceScheduleStateLabel(once)!} /> : null}
        {read.status === 'failed' ? <SurfaceFreshnessLine
            tone="warning" reason={t('workflows.destination.history.loadFailedTitle')}
            action={{ label: t('workflows.retry'), onPress: read.retry }} /> : null}
        {empty ? <SurfaceStateCard
            size="line" kind={read.status === 'loading' ? 'loading' : 'empty'}
            title={read.status === 'loading' ? t('common.loading') : emptyWithNext
                ? t('workflows.destination.history.triggerEmpty', { when: formatNextScheduledRunTime(nextRunAt, true, nowMs) })
                : t('workflows.empty.runsTitle')} /> : null}
        {serverId !== null ? read.rows.map(row => <WorkflowRunWindowRow
            key={row.id} row={row} serverId={serverId} accountLifetime={read.accountLifetime}
            fallbackName={props.triggerName} inTriggerHistory testID={`session-work-trigger-history-row:${row.id}`} />) : null}
        {read.hasMore ? <ToolbarButton testID={`session-work-trigger-history:${props.automationId}-loadMore`}
            label={t(read.loadMoreFailed ? 'workflows.retry' : 'workflows.destination.history.loadMore')}
            busy={read.loadingMore} disabled={read.loadingMore} onPress={read.loadMore} /> : null}
    </View>;
});
