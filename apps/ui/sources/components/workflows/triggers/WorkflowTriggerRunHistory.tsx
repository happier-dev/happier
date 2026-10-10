import * as React from 'react';
import { View } from 'react-native';

import { WorkflowRunItemBody } from '@/components/sessions/shell/row/WorkflowRunItemBody';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { t } from '@/text';

/** Mounted only for the expanded trigger; the shared Run window owns reads and pagination. */
export const WorkflowTriggerRunHistory = React.memo(function WorkflowTriggerRunHistory(props: Readonly<{ automationId: string }>) {
    const read = useWorkflowRunWindow(`automation:${props.automationId}`);
    const serverId = read.serverId;
    return <View testID={`session-work-trigger-history:${props.automationId}`}>
        {read.status === 'failed' ? <SurfaceFreshnessLine
            tone="warning" reason={t('workflows.destination.history.loadFailedTitle')}
            action={{ label: t('workflows.retry'), onPress: read.retry }} /> : null}
        {read.rows.length === 0 && read.status !== 'failed' ? <SurfaceStateCard
            size="line" kind={read.status === 'loading' ? 'loading' : 'empty'}
            title={t(read.status === 'loading' ? 'common.loading' : 'workflows.empty.runsTitle')} /> : null}
        {serverId !== null ? read.rows.map((row, index) => <WorkflowRunItemBody
            key={row.id} kind="workflow_run" runId={row.id} serverId={serverId}
            includeResult
            isFirst={index === 0} isLast={index === read.rows.length - 1} isSingle={read.rows.length === 1} />) : null}
        {read.hasMore ? <ToolbarButton testID={`session-work-trigger-history:${props.automationId}-loadMore`}
            label={t(read.loadMoreFailed ? 'workflows.retry' : 'workflows.destination.history.loadMore')}
            busy={read.loadingMore} disabled={read.loadingMore} onPress={read.loadMore} /> : null}
    </View>;
});
