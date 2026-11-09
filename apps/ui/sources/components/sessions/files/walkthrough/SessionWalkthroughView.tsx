import * as React from 'react';
import { useSessionScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useSessionScmDiffSummaryBinding';
import { useSessionMachineDisplayIdentity } from '@/components/sessions/model/useSessionMachineTarget';
import { ScmWalkthroughView, type ScmWalkthroughViewProps } from './ScmWalkthroughView';
import type { ScmWalkthroughRestorationProps } from './useSessionScmWalkthrough';

export type SessionWalkthroughViewProps = Omit<ScmWalkthroughViewProps, 'bound' | 'displayMachineId' | 'sessionId' | 'onAskStop'> & Readonly<{
    sessionId: string; onOpenComposer: () => void;
    scopeId?: string;
}> & ScmWalkthroughRestorationProps;

/** Session supplies its real authority; saved editing and reading are shared with Projects. */
export const SessionWalkthroughView = React.memo(function SessionWalkthroughView(props: SessionWalkthroughViewProps) {
    const bound = useSessionScmDiffSummaryBinding({ sessionId: props.sessionId, serverId: props.serverId, comparison: props.comparison, output: 'walkthrough', paneScopeId: props.scopeId,
        restoration: props.restoreState === undefined ? undefined : {
            restoreState: props.restoreState, retryRestore: props.retryRestore, machineReachability: props.machineReachability,
        } });
    const display = useSessionMachineDisplayIdentity(props.sessionId, props.serverId);
    return <ScmWalkthroughView {...props} bound={bound} displayMachineId={display.machineId} />;
});
