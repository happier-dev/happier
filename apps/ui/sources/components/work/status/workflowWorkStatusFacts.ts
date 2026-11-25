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

/**
 * Why a queued Run has not started, from two owner facts side by side (R12 M3, FIN ruling): the Run is still queued on
 * its assigned Machine (Run projection) and that Machine's presence owner says it is offline. Unknown presence (a
 * Machine this viewer cannot see) or an online Machine is the neutral queued state; the server decides no wait reason,
 * so this never guesses one.
 */
export function presentWorkflowRunMachineWait(state: WorkflowRunPresentationSource['state'],
    machine: Readonly<{ reachable?: boolean; name?: string | null }>): string | null {
    return state === 'queued' && machine.reachable === false && machine.name
        ? t('workflows.run.waitsForMachineOnline', { machine: machine.name }) : null;
}

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
        word: context.word ?? (needsYou ? t('workStatus.buckets.needs_you')
            : presentWorkflowRunMachineWait(state, { reachable: context.machineReachable, name: context.machineName })
                ?? t(`workflows.runState.${state}`)),
    };
}
