import { WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1, type WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { t } from '@/text';
import { isTerminalWorkflowRunState, type WorkStatusInput } from './resolveWorkStatusTone';

export type WorkflowRunWorkStatusSummary = Pick<WorkflowRunSummaryV1, 'state'> & Partial<Pick<WorkflowRunSummaryV1,
    'workflowCustodyState' | 'attentionRequired' | 'failureUnseen' | 'invocationAttentionRequired' | 'startWaitReason'>>;
export type WorkflowRunWorkStatusFacts = Extract<WorkStatusInput, { kind: 'workflow_run' }>['facts'];

export type WorkflowRunWorkStatusContext = Pick<WorkflowRunWorkStatusFacts,
    'machineReachable' | 'machineName' | 'machineStatus' | 'cancelRequested' | 'inAttentionWindow' | 'outcome' | 'workflowCustodyState'>
    & Readonly<{ word?: string }>;

/** Render a worker-reported capacity wait or the queued Run's known offline Machine. */
export function presentWorkflowRunMachineWait(state: WorkflowRunWorkStatusSummary['state'],
    machine: Readonly<{ reachable?: boolean; name?: string | null }>,
    startWaitReason?: WorkflowRunSummaryV1['startWaitReason']): string | null {
    if (state === 'running' && startWaitReason === WORKFLOW_RUN_MACHINE_START_CAPACITY_WAIT_V1 && machine.name) {
        return t('workflows.run.waitsForMachineStartSlot', { machine: machine.name });
    }
    return state === 'queued' && machine.reachable === false && machine.name
        ? t('workflows.run.waitsForMachineOnline', { machine: machine.name }) : null;
}

/** Normalize already-admitted Run facts; failure identity and attention stay with the Run owner. */
export function readWorkflowRunWorkStatusFacts(
    summary: WorkflowRunWorkStatusSummary,
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
            : presentWorkflowRunMachineWait(state, { reachable: context.machineReachable, name: context.machineName }, summary.startWaitReason)
                ?? t(`workflows.runState.${state}`)),
    };
}
