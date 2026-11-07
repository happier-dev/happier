import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';
import { SPAWN_SESSION_ERROR_CODES, SessionLaunchRetiredV1Schema } from '@happier-dev/protocol/spawnSession';
import { isDefiniteSpawnPreAdmissionRejection } from '@/session/services/spawnPreAdmissionRejection';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { WorkflowSessionCompositionError } from './workflowConversation';

/** Only the creator's typed response settles a definite startup refusal. */
export function rethrowWorkflowSessionStartupFailure(error: unknown, spawnNonce?: string): never {
  if (error instanceof Error && 'code' in error && error.code === SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED
    && 'details' in error && error.details && typeof error.details === 'object') {
    const details = error.details;
    const response = 'spawnResponse' in details ? details.spawnResponse : undefined;
    const retired = SessionLaunchRetiredV1Schema.safeParse('errorDetail' in details ? details.errorDetail
      : response && typeof response === 'object' && 'errorDetail' in response ? response.errorDetail : undefined);
    if (retired.success && retired.data.spawnNonce === spawnNonce) {
      throw new WorkflowSessionCompositionError(error.code, error.message, undefined, retired.data);
    }
    // Project the creator's redacted native cause before the strict Action
    // operation retains it; Workflow's existing sink carries code and message.
    const failure = projectSessionSpawnFailure({ errorCode: error.code, errorMessage: error.message,
      errorDetail: 'errorDetail' in details ? details.errorDetail
        : response && typeof response === 'object' && 'errorDetail' in response ? response.errorDetail : undefined });
    if (failure.code === 'spawn_failed' && failure.launchError && failure.launchError.code !== error.code) {
      throw new WorkflowSessionCompositionError(failure.launchError.code, failure.launchError.message);
    }
  }
  // Transport loss and nonce observation remain unresolved; a definite daemon
  // refusal retains its code through the Workflow's existing failure presenter.
  if (error instanceof Error && 'code' in error && 'details' in error
    && typeof error.code === 'string' && isDefiniteSpawnPreAdmissionRejection(error.code)) {
    const response = error.details;
    if (response && typeof response === 'object' && 'type' in response && response.type === 'error'
      && 'errorCode' in response && response.errorCode === error.code) {
      throw new WorkflowSessionCompositionError(error.code, error.message);
    }
  }
  throw error;
}

/** Terminal startup failure remains a fact after its process-local owner retires. */
export function readRetainedWorkflowSessionStartupFailure(
  snapshot: unknown, address: ActionCompletionOperation, creationKey: string,
): ActionOperationSnapshotV1 | undefined {
  const parsed = ActionOperationSnapshotV1Schema.safeParse(snapshot);
  return parsed.success && parsed.data.state === 'failed' && parsed.data.operationId === address.operationId
    && parsed.data.actionId === 'session.spawn_new' && parsed.data.scope.machineId === address.machineId
    && parsed.data.requestId === creationKey ? parsed.data : undefined;
}
