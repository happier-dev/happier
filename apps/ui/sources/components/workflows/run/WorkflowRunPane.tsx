import * as React from 'react';

import {
    DestinationInstanceHost,
    type DestinationNavigation,
} from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { WorkflowRunScreen } from '@/components/workflows/screens/WorkflowRunScreen';

/**
 * A Run shown inside another surface's pane (the Inbox's detail, a lead's Work peek): the Run page's
 * own body, hosted as a destination so it reads its Run from destination params, drawn on the pane's
 * surface. The host decides where the Run's navigation goes; `visible` false keeps the body mounted but
 * not actively viewed, so it holds no live reads and its step's conversation mounts no active child.
 */
export const WorkflowRunPane = React.memo(function WorkflowRunPane(props: Readonly<{
    tabId: string;
    runId: string;
    serverId: string | null;
    invocationId?: string | null;
    pathname: string;
    visible: boolean;
    acknowledgeFailure?: boolean;
    navigation: DestinationNavigation;
}>) {
    const { runId, invocationId, serverId } = props;
    const ref = React.useMemo(
        () => ({ kind: 'workflowRun', params: { runId, ...(serverId ? { serverId } : {}), ...(invocationId ? { invocationId } : {}) } }),
        [invocationId, runId, serverId],
    );
    return (
        <DestinationInstanceHost
            tabId={props.tabId}
            ref={ref}
            pathname={props.pathname}
            focused={props.visible}
            visible={props.visible}
            navigation={props.navigation}
        >
            <WorkflowsGate>
                <WorkflowRunScreen embedded acknowledgeFailure={props.acknowledgeFailure} />
            </WorkflowsGate>
        </DestinationInstanceHost>
    );
});
