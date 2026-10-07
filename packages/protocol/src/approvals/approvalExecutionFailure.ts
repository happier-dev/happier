import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import {
  parseSessionBoardActionPortResultV1,
  parseStoredSessionBoardActionFailureV1,
} from '../sessions/board/actions.js';
import { SessionBoardActionIdV1Schema } from '../sessions/board/actionIds.js';
import type {
  ApprovalExecutionV2,
  ApprovalRequest,
  ApprovalRequestV2,
} from './approvalRequestV1.js';

function parseStrictApprovalFailure(input: Readonly<{
  request: ApprovalRequestV2;
  failure: ActionExecuteFailure;
}>, storedRead = false): ActionExecuteFailure | null {
  const actionId = SessionBoardActionIdV1Schema.safeParse(input.request.actionId);
  if (!actionId.success) return null;
  const parsed = (storedRead ? parseStoredSessionBoardActionFailureV1 : parseSessionBoardActionPortResultV1)(
    actionId.data,
    input.request.actionArgs,
    input.failure,
    {
      ...(input.request.executionOriginV1.sessionId
        ? { expectedSessionId: input.request.executionOriginV1.sessionId }
        : {}),
      expectedServerId: input.request.executionOriginV1.serverId,
    },
  );
  return parsed.success && parsed.kind === 'failure' ? parsed.data : null;
}

/**
 * Project one failed execution into durable approval history. Only details
 * accepted by the exact Action family's strict, request-bound parser survive.
 * Arbitrary errors and opaque detail bags remain live-only.
 */
export function projectApprovalExecutionFailureV2(input: Readonly<{
  request: ApprovalRequestV2;
  failure: ActionExecuteFailure;
  executedAtMs: number;
}>): ApprovalExecutionV2 {
  const strictFailure = parseStrictApprovalFailure(input);
  return {
    executedAtMs: input.executedAtMs,
    ok: false,
    errorCode: input.failure.errorCode,
    error: input.failure.error,
    ...(strictFailure?.details !== undefined ? { details: strictFailure.details } : {}),
  };
}

/** Read terminal history without trusting legacy or unvalidated opaque fields. */
export function readApprovalExecutionFailure(
  request: ApprovalRequest,
): ActionExecuteFailure | null {
  const execution = request.execution;
  if (!execution || execution.ok !== false) return null;
  const errorCode = typeof execution.errorCode === 'string' && execution.errorCode.trim().length > 0
    ? execution.errorCode
    : 'approval_execution_failed';
  const error = typeof execution.error === 'string' && execution.error.trim().length > 0
    ? execution.error
    : errorCode;
  const failure: ActionExecuteFailure = { ok: false, errorCode, error };
  if (request.v !== 2 || execution.details === undefined) return failure;
  return parseStrictApprovalFailure({
    request,
    failure: { ...failure, details: execution.details },
  }, true) ?? failure;
}
