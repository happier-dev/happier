import * as React from 'react';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { ScmCommitsView, type ScmCommitsViewProps } from '@/components/sessions/files/commits/ScmCommitsView';
import { useScmCommitPlan } from '@/components/sessions/files/commits/useScmCommitPlan';
import type { ScmWalkthroughRestorationProps } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';

import { useWorkspaceScmDiffSummaryBinding } from './useWorkspaceScmDiffSummaryBinding';

export type WorkspaceCommitsViewProps = Omit<ScmCommitsViewProps, 'plan'> & Readonly<{
    scope: Readonly<{ serverId: string; machineId: string; rootPath: string }>;
    comparison: SessionScmReviewComparison | null;
    scopeId?: string;
}> & ScmWalkthroughRestorationProps;

/** The exact checkout binds the same saved commit-plan owner without borrowing a Session. */
export const WorkspaceCommitsView = React.memo(function WorkspaceCommitsView(props: WorkspaceCommitsViewProps) {
    const enabled = props.active !== false;
    const comparison = enabled ? props.comparison : null;
    const bound = useWorkspaceScmDiffSummaryBinding({ ...props.scope, paneScopeId: props.scopeId, comparison, output: 'commitPlan',
        restoration: props.restoreState === undefined ? undefined : {
            restoreState: props.restoreState, restoreFailure: props.restoreFailure, retryRestore: props.retryRestore, machineReachability: props.machineReachability,
        } });
    const plan = useScmCommitPlan({ bound });
    return <ScmCommitsView {...props} plan={plan} />;
});
