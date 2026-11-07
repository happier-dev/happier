import * as React from 'react';
import { View } from 'react-native';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { WorkflowRunWindowRow } from '../library/WorkflowRunWindowRow';

import { useReportTriggerHistoryRuns } from './SessionTriggerHistoryScope';

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
        {serverId !== null ? read.rows.map(row => <WorkflowRunWindowRow
            key={row.id} row={row} serverId={serverId} accountLifetime={read.accountLifetime}
            fallbackName={props.triggerName} inTriggerHistory testID={`session-work-trigger-history-row:${row.id}`} />) : null}
        {read.hasMore ? <ToolbarButton testID={`session-work-trigger-history:${props.automationId}-loadMore`}
            label={t(read.loadMoreFailed ? 'workflows.retry' : 'workflows.destination.history.loadMore')}
            busy={read.loadingMore} disabled={read.loadingMore} onPress={read.loadMore} /> : null}
    </View>;
});
