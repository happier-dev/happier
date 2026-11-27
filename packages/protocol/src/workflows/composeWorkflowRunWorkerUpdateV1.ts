import { classifyWorkerUpdateEventV1, composeWorkflowRunWorkerUpdateHeadlineV1, resolveWorkerUpdateWakeV1, WorkerUpdateV1Schema, type WorkerUpdateV1 } from '../sessions/relations/workerUpdateV1.js';
import type { WorkflowFinalResultV1, WorkflowProgressEnvelopeV1, WorkflowReviewV1, WorkflowRunSummaryV1 } from './workflowProgressV1.js';
import { EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH } from '../execution/runs/completionInputV1.js';
import type { WorkflowRunFollowEventV1 } from '../sessions/follow/sessionFollowInputV1.js';

/** One projection of the current retained revision; hints and admission use the same source facts. */
export function resolveWorkflowRunFollowEventV1(run: Pick<WorkflowRunSummaryV1, 'state' | 'attentionRequired'>): WorkflowRunFollowEventV1 | null {
  if (run.state === 'succeeded') return { kind: 'finished' };
  const kind = classifyWorkerUpdateEventV1({ workerKind: 'workflow_run', ownerState: run.state,
    ...(run.attentionRequired ? { wake: 'needs_you' } : {}) });
  if (kind === 'finished' || kind === 'failed_or_stopped') return { kind };
  // This is the source's ordinary human-attention projection. Only a real
  // permission request may produce approval; summary attention never fabricates one.
  if (kind === 'needs_you' || run.state === 'waiting_for_review') return { kind: 'needs_you', type: 'decision' };
  return run.state === 'running' && run.attentionRequired === false ? { kind: 'update_posted' } : null;
}

/** One current-state projection; delivery transports never reconstruct a history of holds. */
export function composeWorkflowRunWorkerUpdateV1(input: Readonly<{
  run: Pick<WorkflowRunSummaryV1, 'id' | 'state' | 'attentionRequired'>;
  finalResult?: WorkflowFinalResultV1;
  finalProducerReview?: WorkflowReviewV1;
  failure?: Readonly<{ recordId: string; reason: NonNullable<WorkflowProgressEnvelopeV1['reason']> }>;
}>): WorkerUpdateV1 | null {
  const event = classifyWorkerUpdateEventV1({ workerKind: 'workflow_run', ownerState: input.run.state,
    ...(input.run.attentionRequired ? { wake: 'needs_you' } : {}) });
  if (!event) return null;
  const selected = input.finalResult?.result;
  const failure = event === 'failed_or_stopped' || event === 'needs_you' ? input.failure : undefined;
  const text = selected?.kind === 'json' ? JSON.stringify(selected.value) : selected?.value
    ?? failure?.reason.runtimeIssueV1?.sanitizedPreview ?? failure?.reason.message ?? failure?.reason.code;
  const decision = input.finalProducerReview?.decision;
  const followUp = decision?.kind === 'use_result' ? decision.followUp : undefined;
  const followUpText = followUp?.kind === 'run_started'
    ? `Follow-up already started: ${followUp.runId}. Do not start it again.`
    : followUp?.kind === 'editing' ? 'Follow-up: editing. No follow-up Run has been started.' : '';
  const suffix = followUpText ? `\n\n${followUpText}` : '';
  const result = text === undefined && !suffix ? undefined : `${text ?? ''}${suffix}`;
  const maxResultLength = EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH;
  const truncated = result !== undefined && result.length > maxResultLength;
  return WorkerUpdateV1Schema.parse({
    v: 1, workerKind: 'workflow_run', workerId: input.run.id, ownerState: input.run.state,
    wake: resolveWorkerUpdateWakeV1(event),
    ...(failure?.reason.runtimeIssueV1 ? { runtimeIssueV1: failure.reason.runtimeIssueV1 } : {}),
    // The optional allowance truncates result text, never this exact follow-up fact.
    headline: `${composeWorkflowRunWorkerUpdateHeadlineV1({ ownerState: input.run.state,
      ...(input.run.attentionRequired ? { wake: 'needs_you' as const } : {}) })}${followUpText ? ` · ${followUpText}` : ''}`,
    ...(result === undefined ? {} : { result: truncated
      ? `${(text ?? '').slice(0, maxResultLength - suffix.length)}${suffix}` : result }),
    ...(truncated ? { truncated: true } : {}),
    transcriptPointer: { kind: 'workflow_run', runId: input.run.id,
      ...(failure ? { invocationRecordId: failure.recordId }
        : input.finalResult ? { invocationRecordId: input.finalResult.producerInvocation.recordId } : {}) },
    canInspect: true,
  });
}
