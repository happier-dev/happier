import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { ActionOperationFailureV1Schema, type ActionOperationFailureV1 } from '@happier-dev/protocol/actions/operations/v1';

/** Retain the Action owner's safe diagnostic without serializing the exception. */
export function projectActionOperationFailure(error: unknown, fallback: string, phase?: string): ActionExecuteFailure & ActionOperationFailureV1 {
  const errorCode = readRpcErrorCode(error)
    ?? (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : fallback);
  const projected = normalizeActionExecutorThrownError(error, phase);
  const diagnostic = ActionOperationFailureV1Schema.safeParse({ errorCode, error: projected.error,
    failureCause: projected.failureCause, ...(projected.details === undefined ? {} : { details: projected.details }) });
  return { ok: false, ...(diagnostic.success ? diagnostic.data : { errorCode, failureCause: projected.failureCause,
    error: errorCode === 'workspace_sync_prepare_failed' ? 'Workspace preparation failed; the diagnostic exceeds the operation error format' : errorCode }) };
}
