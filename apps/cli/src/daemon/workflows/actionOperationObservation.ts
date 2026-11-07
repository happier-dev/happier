import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows';

export const LOST_ACTION_OPERATION_CODE = 'action_operation_not_found';

export function hasRetainedWorkflowActionOperation(progress: WorkflowProgressEnvelopeV1): boolean {
  return progress.execution?.kind === 'action' && Boolean(progress.execution.awaitedOperations?.length);
}

/** Absence retires this observation, without proving that historical effects stopped. */
export function hasLostWorkflowActionOperation(progress: WorkflowProgressEnvelopeV1): boolean {
  return progress.reason?.code === LOST_ACTION_OPERATION_CODE && hasRetainedWorkflowActionOperation(progress);
}

/** Exact-owner absence and unreadable/misrouted evidence have different recovery semantics. */
export function readWorkflowActionOperationSnapshot(raw: unknown, target: ActionCompletionOperation,
  expected: Readonly<{ actionId: string; startupRequestId?: string }>): ActionOperationSnapshotV1 | null {
  const parsed = ActionOperationGetV1ResponseSchema.parse(raw);
  if (parsed.kind === 'not_found') return null;
  const operation = parsed.operation;
  if (operation.operationId !== target.operationId || operation.scope.machineId !== target.machineId
    || operation.actionId !== expected.actionId
    || expected.startupRequestId !== undefined && operation.requestId !== expected.startupRequestId) {
    throw new Error('action_operation_correspondence_mismatch');
  }
  return operation;
}
