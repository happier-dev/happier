import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { t } from '@/text';
import { isTerminalWorkflowRunState, type WorkStatusInput } from './resolveWorkStatusTone';

export type WorkflowRunWorkStatusSummary = Pick<WorkflowRunSummaryV1,
    'state' | 'workflowCustodyState' | 'attentionRequired' | 'failureUnseen' | 'invocationAttentionRequired'>;
type WorkflowRunPresentationSource = Pick<WorkflowRunWorkStatusSummary, 'state'> & Partial<WorkflowRunWorkStatusSummary>;
export type WorkflowRunWorkStatusFacts = Extract<WorkStatusInput, { kind: 'workflow_run' }>['facts'];

export type WorkflowRunWorkStatusContext = Pick<WorkflowRunWorkStatusFacts,
    'machineReachable' | 'machineName' | 'machineStatus' | 'cancelRequested' | 'inAttentionWindow' | 'outcome' | 'workflowCustodyState'>
    & Readonly<{ word?: string }>;

/** Normalize already-admitted Run facts; failure identity and attention stay with the Run owner. */
export function readWorkflowRunWorkStatusFacts(
    summary: WorkflowRunPresentationSource,
    context: WorkflowRunWorkStatusContext = {},
): WorkflowRunWorkStatusFacts {
    const { state } = summary;
    const inAttentionWindow = context.inAttentionWindow ?? summary.attentionRequired;
    // Running work in the attention window names the hold. Terminal and explicitly
    // interrupted Runs keep the outcome word, even when there is still a decision.
    const needsYou = state === 'waiting_for_review' || (inAttentionWindow === true && !isTerminalWorkflowRunState(state)
        && state !== 'interrupted' && state !== 'paused' && state !== 'pause_requested');
    return {
        workflowCustodyState: summary.workflowCustodyState,
        ...context,
        state,
        failureUnseen: summary.failureUnseen,
        invocationAttentionRequired: summary.invocationAttentionRequired,
        inAttentionWindow,
        word: context.word ?? (needsYou ? t('workStatus.buckets.needs_you') : t(`workflows.runState.${state}`)),
    };
}
