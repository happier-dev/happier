import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { WorkflowExecutionCorrespondenceV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

/** A lost inline Account read has no native operation or retained result to observe. */
export function isWorkflowInlineAccountReadWithoutResult(execution: WorkflowExecutionCorrespondenceV1): boolean {
  if (execution.kind !== 'action' || execution.output !== undefined
    || execution.awaitedOperations?.length || execution.awaitedRuns?.length || execution.awaitedWorkflows?.length) {
    return false;
  }
  return isWorkflowInlineAccountReadAction(execution.actionId);
}

export function isWorkflowInlineAccountReadAction(id: string): boolean {
  const actionId = ActionIdSchema.safeParse(id);
  if (!actionId.success) return false;
  const spec = getActionSpec(actionId.data);
  return spec.sideEffectClass === 'read' && spec.executionPlacement === 'account'
    && !spec.executionPlacementForInput && !spec.operation && !spec.completion;
}
