import * as React from 'react';
import { View } from 'react-native';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

import { WorkflowRunItemBody } from '@/components/sessions/shell/row/WorkflowRunItemBody';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { useWorkflowSourcePeople } from '../useWorkflowSourcePeople';

import { useReportTriggerHistoryRuns } from './SessionTriggerHistoryScope';

/** People and result consumers exist only while this body is admitted by the physical page. */
function HistoryRunBody(props: Readonly<{ row: WorkflowRunRow; serverId: string; accountLifetime: ServerAccountScopeLifetime | null; triggerName?: string }>) {
    const sourcePeople = useWorkflowSourcePeople([props.row.summary?.sourceSavedBy], props.accountLifetime);
    return <WorkflowRunItemBody kind="workflow_run" runId={props.row.id} serverId={props.serverId}
        accountLifetime={props.accountLifetime}
        sourceProfile={sourcePeople.profiles.get(props.row.summary?.sourceSavedBy?.accountId ?? '')?.profile ?? null}
        includeResult inTriggerHistory fallbackName={props.triggerName} />;
}

/** Retain geometry in the same scroller; paging never replaces or repositions that scroller. */
const HistoryRunWindow = React.memo(function HistoryRunWindow(props: React.ComponentProps<typeof HistoryRunBody>) {
    const tracker = useOptionalPluginUiScrollActivityTracker();
    const node = React.useRef<View>(null);
    const { near, measure } = useMeasuredNearViewport(tracker, node, true, props.row.id);
    const [height, setHeight] = React.useState<number | null>(null);
    return <View ref={node} collapsable={false} testID={`session-work-trigger-history-row:${props.row.id}`}
        style={near ? undefined : { height: height ?? HAPPIER_COLLECTION_ROW_METRICS.height.comfortable }}
        onLayout={event => {
            if (near) setHeight(event.nativeEvent.layout.height);
            measure();
        }}>
        {near ? <HistoryRunBody {...props} /> : null}
    </View>;
});

/** Mounted only for the expanded trigger; the shared Run window owns reads and pagination. */
export const WorkflowTriggerRunHistory = React.memo(function WorkflowTriggerRunHistory(props: Readonly<{
    automationId: string;
    triggerId: string;
    accountLifetime?: ServerAccountScopeLifetime | null;
    /** The trigger's name: it names a Run whose own title cannot be read. */
    triggerName?: string;
}>) {
    const read = useWorkflowRunWindow(`trigger:${props.triggerId}`, { accountLifetime: props.accountLifetime });
    useReportTriggerHistoryRuns(props.automationId, read.runIds);
    const serverId = read.serverId;
    return <View testID={`session-work-trigger-history:${props.automationId}`}>
        {read.status === 'failed' ? <SurfaceFreshnessLine
            tone="warning" reason={t('workflows.destination.history.loadFailedTitle')}
            action={{ label: t('workflows.retry'), onPress: read.retry }} /> : null}
        {read.rows.length === 0 && read.status !== 'failed' ? <SurfaceStateCard
            size="line" kind={read.status === 'loading' ? 'loading' : 'empty'}
            title={t(read.status === 'loading' ? 'common.loading' : 'workflows.empty.runsTitle')} /> : null}
        {serverId !== null ? read.rows.map(row => <HistoryRunWindow
            key={row.id} row={row} serverId={serverId} accountLifetime={read.accountLifetime} triggerName={props.triggerName} />) : null}
        {read.hasMore ? <ToolbarButton testID={`session-work-trigger-history:${props.automationId}-loadMore`}
            label={t(read.loadMoreFailed ? 'workflows.retry' : 'workflows.destination.history.loadMore')}
            busy={read.loadingMore} disabled={read.loadingMore} onPress={read.loadMore} /> : null}
    </View>;
});
