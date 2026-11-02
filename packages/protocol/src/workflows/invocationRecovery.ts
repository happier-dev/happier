import type { WorkflowInvocationLifecycleV1 } from './workflowProgressV1.js';

/** Exact recovery census; result review remains with its human decision owner. */
export const WORKFLOW_RECOVERABLE_INVOCATION_LIFECYCLES_V1 = [
  'pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval',
  'needs_attention', 'cancel_requested', 'outcome_uncertain',
] as const satisfies readonly WorkflowInvocationLifecycleV1[];

/** Lifecycle eligibility only; the decrypted host proves exact loss and preserves prior uncertain effects. */
export function canObserveLostWorkflowActionOperationV1(lifecycle: WorkflowInvocationLifecycleV1): boolean {
  return WORKFLOW_RECOVERABLE_INVOCATION_LIFECYCLES_V1.some(candidate => candidate === lifecycle);
}
