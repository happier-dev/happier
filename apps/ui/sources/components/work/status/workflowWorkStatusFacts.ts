import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import type { WorkStatusInput } from './resolveWorkStatusTone';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';

export type WorkflowRunWorkStatusSummary = Pick<WorkflowRunSummaryV1,
    'state' | 'workflowCustodyState' | 'attentionRequired' | 'failureUnseen' | 'invocationAttentionRequired'>;
export type WorkflowRunWorkStatusFacts = Extract<WorkStatusInput, { kind: 'workflow_run' }>['facts'];

/** Normalize already-admitted Run facts; failure identity and attention stay with the Run owner. */
export function readWorkflowRunWorkStatusFacts(
    summary: WorkflowRunWorkStatusSummary,
    context: Pick<WorkflowRunWorkStatusFacts, 'machineReachable' | 'machineName' | 'machineStatus' | 'cancelRequested'> & Readonly<{ word?: string }> = {},
): WorkflowRunWorkStatusFacts {
    return {
        state: summary.state,
        workflowCustodyState: summary.workflowCustodyState,
        inAttentionWindow: summary.attentionRequired,
        failureUnseen: summary.failureUnseen,
        invocationAttentionRequired: summary.invocationAttentionRequired,
        ...context,
        word: describeWorkflowRunState(summary.state, {
            ...context, inAttentionWindow: summary.attentionRequired, workflowCustodyState: summary.workflowCustodyState,
        }).label,
    };
}
