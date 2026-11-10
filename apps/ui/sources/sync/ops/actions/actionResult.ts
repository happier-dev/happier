import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SESSION_COMPACT_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { SessionCompactResultV1 } from '@happier-dev/protocol/sessions/control';
import { HappyError } from '@/utils/errors/errors';

/** Retain typed refusal and pending custody instead of exposing either as a completed effect. */
export function requireActionSuccess(result: ActionExecuteResult, actionId?: ActionId): asserts result is Extract<ActionExecuteResult, { ok: true }> {
  if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode, details: result.details, failureCause: result.failureCause, effectAttempted: result.effectAttempted });
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
  if (approval.success) throw new HappyError(approval.data.kind, false, { code: approval.data.kind, details: approval.data });
  // The Action boundary already projects its declared output; this receipt can
  // refuse admission even when the RPC itself completed successfully.
  if (actionId === SESSION_COMPACT_ACTION_ID_V1 && (result.result as SessionCompactResultV1).status === 'unsupported') {
    throw new HappyError('unsupported_action:session.compact', false, { code: 'unsupported_action', details: result.result });
  }
}

/** The deferred approval {@link requireActionSuccess} threw, so a caller can wait on it instead of failing. */
export function readActionApprovalRequestCreatedError(error: unknown): Readonly<{ artifactId: string }> | null {
  if (!(error instanceof HappyError) || error.code !== 'approval_request_created') return null;
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(error.details);
  return approval.success ? { artifactId: approval.data.artifactId } : null;
}
