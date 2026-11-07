import * as React from 'react';
import { View } from 'react-native';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

import { WorkflowRunItemBody } from '@/components/sessions/shell/row/WorkflowRunItemBody';
import { useMeasuredNearViewport } from '@/components/widgets/nearViewport';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowSourcePeople } from '../useWorkflowSourcePeople';

type WorkflowRunWindowRowProps = Readonly<{
    row: WorkflowRunRow;
    serverId: string;
    accountLifetime: ServerAccountScopeLifetime | null;
    fallbackName?: string;
    inTriggerHistory?: boolean;
    testID: string;
}>;

/** People and result consumers exist only while the physical page admits the row. */
function WorkflowRunWindowRowBody(props: WorkflowRunWindowRowProps) {
    const sourcePeople = useWorkflowSourcePeople([props.row.summary?.sourceSavedBy], props.accountLifetime);
    return <WorkflowRunItemBody kind="workflow_run" runId={props.row.id} serverId={props.serverId}
        accountLifetime={props.accountLifetime}
        sourceProfile={sourcePeople.profiles.get(props.row.summary?.sourceSavedBy?.accountId ?? '')?.profile ?? null}
        includeResult inTriggerHistory={props.inTriggerHistory} fallbackName={props.fallbackName} />;
}

/** History and Recent runs retain geometry in their containing scroller. */
export const WorkflowRunWindowRow = React.memo(function WorkflowRunWindowRow(props: WorkflowRunWindowRowProps) {
    const tracker = useOptionalPluginUiScrollActivityTracker();
    const node = React.useRef<View>(null);
    const { near, measure } = useMeasuredNearViewport(tracker, node, true, props.row.id);
    const [height, setHeight] = React.useState<number | null>(null);
    return <View ref={node} collapsable={false} testID={props.testID}
        style={near ? undefined : { height: height ?? HAPPIER_COLLECTION_ROW_METRICS.height.comfortable }}
        onLayout={event => {
            if (near) setHeight(event.nativeEvent.layout.height);
            measure();
        }}>
        {near ? <WorkflowRunWindowRowBody {...props} /> : null}
    </View>;
});
