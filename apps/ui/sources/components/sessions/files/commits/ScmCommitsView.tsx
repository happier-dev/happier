import * as React from 'react';
import { View } from 'react-native';

import { ScmDiffSummaryModelPicker } from '@/components/settings/sourceControl/ScmDiffSummaryModelPicker';
import { t } from '@/text';

import { CommitProposalView, type CommitProposalViewLayout } from './CommitProposalView';
import type { useScmCommitPlan } from './useScmCommitPlan';

export type ScmCommitsViewProps = Readonly<{
    plan: ReturnType<typeof useScmCommitPlan>;
    /** The checked-out branch; null when HEAD is detached. */
    branch: string | null;
    layout: CommitProposalViewLayout;
    active?: boolean;
    /** The comparison bar, drawn by the review destination above every view. */
    renderBar: (proposalCount: number | null) => React.ReactNode;
    /** A commit to bring into view (the Git pane's Open on a selected proposal). */
    focusGroupId?: string | null;
    onShowInGit?: () => void;
}>;

/**
 * The Commits view of pending changes bound to its admitted host (lab WT4): the saved proposal, its structured edits
 * and the explicit accepted run, all through the comparison's one saved result. Proposing starts from captured
 * evidence the person already has (a walkthrough of the same changes) or a new run with their chosen model.
 */
export const ScmCommitsView = React.memo(function ScmCommitsView(props: ScmCommitsViewProps) {
    const plan = props.plan;
    const bound = plan.binding;
    const canStart = plan.supportedComparison && bound.canSend && bound.launch.canLaunchExecutionRuns;
    const addToSaved = plan.addToSaved;
    const start = React.useMemo(() => {
        if (!plan.supportedComparison) {
            return { onStart: () => {}, busy: false, disabled: true, reason: t('commitProposal.none.workingTreeOnly') };
        }
        if (addToSaved) {
            return { onStart: () => { if (bound.canControl) void addToSaved(); }, busy: false, disabled: !bound.canControl,
                reason: bound.error ?? (!bound.canControl ? t('walkthroughStart.unavailable') : null) };
        }
        const ready = canStart && bound.selected.success && bound.modelAvailable;
        return {
            onStart: () => { if (ready) void bound.onStart(['commitPlan']); },
            busy: bound.starting,
            disabled: !ready,
            reason: bound.error ?? (!ready ? t('walkthroughStart.unavailable') : null),
            modelPicker: (
                <ScmDiffSummaryModelPicker
                    value={bound.model}
                    onChange={bound.setModel}
                    onAvailabilityChange={bound.onModelAvailability}
                    machineId={bound.machine?.machineId}
                    serverId={bound.serverId}
                    testID="commit-proposal-model-choice"
                />
            ),
        };
    }, [addToSaved, bound, canStart, plan.supportedComparison]);
    const onShowInGit = props.onShowInGit;
    const actions = React.useMemo(() => (onShowInGit ? { ...plan.actions, onShowInGit } : plan.actions), [onShowInGit, plan.actions]);
    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            {props.renderBar(plan.proposal?.groups.length ?? null)}
            <CommitProposalView
                proposal={plan.proposal}
                phase={plan.phase}
                branch={props.branch}
                modelLabel={plan.modelLabel}
                layout={props.layout}
                actions={actions}
                start={start}
                focusGroupId={props.focusGroupId ?? null}
                busy={plan.busy}
                error={plan.phase === 'ready' ? plan.error : null}
                active={props.active}
                onUndoDiscard={plan.undoDiscard}
            />
        </View>
    );
});
