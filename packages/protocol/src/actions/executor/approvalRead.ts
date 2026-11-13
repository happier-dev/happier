import { ApprovalRequestConflict } from '../../approvals/creation.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';
import type { ActionExecuteFailure } from './types.js';

/** Keep subject-admission refusals distinct from unavailable approval storage. */
export function approvalReadFailure(error?: unknown): ActionExecuteFailure {
  if (error instanceof ApprovalRequestConflict) {
    return { ok: false, ...normalizeActionExecutorThrownError(error) };
  }
  const errorCode = 'approval_context_unavailable';
  return { ok: false, errorCode, error: errorCode };
}
