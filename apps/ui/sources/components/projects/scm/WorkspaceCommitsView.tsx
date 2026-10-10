import * as React from 'react';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { ScmCommitsView, type ScmCommitsViewProps } from '@/components/sessions/files/commits/ScmCommitsView';
import { useScmCommitPlan } from '@/components/sessions/files/commits/useScmCommitPlan';

import { useWorkspaceScmDiffSummaryBinding } from './useWorkspaceScmDiffSummaryBinding';

export type WorkspaceCommitsViewProps = Omit<ScmCommitsViewProps, 'plan'> & Readonly<{
    scope: Readonly<{ serverId: string; machineId: string; rootPath: string }>;
    comparison: SessionScmReviewComparison | null;
}>;

/** The exact checkout binds the same saved commit-plan owner without borrowing a Session. */
export const WorkspaceCommitsView = React.memo(function WorkspaceCommitsView(props: WorkspaceCommitsViewProps) {
    const enabled = props.active !== false;
    const comparison = enabled ? props.comparison : null;
    const bound = useWorkspaceScmDiffSummaryBinding({ ...props.scope, comparison, output: 'commitPlan' });
    const plan = useScmCommitPlan({ bound });
    return <ScmCommitsView {...props} plan={plan} />;
});
