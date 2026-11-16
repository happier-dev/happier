import * as React from 'react';
import { View } from 'react-native';

import { ScmDiffSummaryFailureNotice } from '@/components/sessions/files/comparison/ScmDiffSummaryFailureNotice';
import { LlmTaskRunnerPicker } from '@/components/settings/llmTasks/LlmTaskRunnerPicker';
import { ScmDiffSummaryStartOptions, scmDiffSummaryPrerequisiteOf, scmDiffSummaryStartOptionsOf, useOpenExplainChangesSetting, useSummaryModelChoice } from '@/components/sessions/files/comparison/ScmDiffSummaryStartOptions';
import { RunWorkNotifications } from '@/components/sessions/work/RunWorkNotifications';
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
    const openExplainSetting = useOpenExplainChangesSetting();
    const modelChoice = useSummaryModelChoice();
    const canStart = plan.supportedComparison && bound.canSend && bound.launch.canLaunchExecutionRuns;
    const addToSaved = plan.addToSaved;
    const start = React.useMemo(() => {
        if (!plan.supportedComparison) {
            return { onStart: () => {}, busy: false, disabled: true, reason: t('commitProposal.none.workingTreeOnly'), options: null };
        }
        if (addToSaved) {
            return { onStart: () => { if (bound.canControl) void addToSaved(); }, busy: false, disabled: !bound.canControl, reason: null,
                options: <ScmDiffSummaryStartOptions {...scmDiffSummaryStartOptionsOf(bound, { testID: 'commit-proposal-start-options',
                    prerequisite: !bound.canControl ? t('walkthroughStart.unavailable') : null, onEnableExplain: openExplainSetting })} /> };
        }
        const ready = canStart && !bound.startBlocker;
        return {
            onStart: () => { if (ready) void bound.onStart(['commitPlan']); },
            busy: bound.starting,
            disabled: !ready,
            reason: null,
            options: <ScmDiffSummaryStartOptions {...scmDiffSummaryStartOptionsOf(bound, { testID: 'commit-proposal-start-options', modelTestID: 'commit-proposal-model-choice',
                prerequisite: scmDiffSummaryPrerequisiteOf(bound), onEnableExplain: openExplainSetting })} />,
        };
    }, [addToSaved, bound, canStart, openExplainSetting, plan.supportedComparison]);
    // The proposal's own Run and saved result: the offer says only that the proposal has an update, never that a commit landed.
    const { viewModel, machine } = bound;
    const runId = viewModel?.executionRunId ?? null;
    const notifySource = runId ? bound.host.sessionId ? { kind: 'execution_run' as const, sessionId: bound.host.sessionId, runId }
        : machine?.machineId ? { kind: 'execution_run' as const, machineId: machine.machineId, runId } : null : null;
    const notify = notifySource && viewModel?.comparison && viewModel.resultId
        ? <RunWorkNotifications serverId={bound.serverId}
            source={notifySource}
            selectedOutput={{ output: 'commitPlan', comparisonId: viewModel.comparison.id, resultId: viewModel.resultId }} /> : null;
    const onShowInGit = props.onShowInGit;
    const actions = React.useMemo(() => (onShowInGit ? { ...plan.actions, onShowInGit } : plan.actions), [onShowInGit, plan.actions]);
    const failureNotice = plan.phase === 'ready' && bound.generationFailure ? (
        <ScmDiffSummaryFailureNotice testID="commit-proposal" failure={bound.generationFailure}
            onChooseModel={modelChoice.choose} onEnableExplain={openExplainSetting}
            onRetry={canStart ? () => { void bound.onStart(['commitPlan']); } : undefined} />
    ) : null;
    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            {props.renderBar(plan.proposal?.groups.length ?? null)}
            {modelChoice.choosing ? <LlmTaskRunnerPicker task="scm_diff_summary" presentation="chips" engineFieldTitle={null} value={bound.model} onChange={bound.setModel}
                machineId={bound.machine?.machineId ?? null} serverId={bound.serverId ?? null} sessionAgentTargetKey={bound.sessionAgentTargetKey}
                testIDPrefix="commit-proposal-model-choice" /> : null}
            <CommitProposalView
                proposal={plan.proposal}
                phase={plan.phase}
                onRetryRestore={bound.retryRestore}
                isGenerating={plan.isGenerating}
                branch={props.branch}
                modelLabel={plan.modelLabel}
                layout={props.layout}
                actions={actions}
                start={start}
                notify={notify}
                focusGroupId={props.focusGroupId ?? null}
                busy={plan.busy}
                error={plan.phase === 'unavailable' ? bound.restoreFailure?.error ?? null : plan.phase === 'ready' ? plan.error : null}
                failureNotice={failureNotice}
                active={props.active}
                onUndoDiscard={plan.undoDiscard}
            />
        </View>
    );
});
