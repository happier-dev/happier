import { redactBugReportSensitiveText } from '../../bugs/reports/redaction.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';

/** An unavailable requester Home before effects is unknown currentness, not a terminal receipt. */
export async function settleApprovalDecisionFailure<TResult>(args: Readonly<{
  error: unknown;
  effectMayHaveStarted: boolean;
  settle: (failure: ActionExecuteFailure, outcomeUnknown: boolean) => Promise<TResult>;
}>): Promise<TResult | ActionExecuteFailure> {
  const normalized = normalizeActionExecutorThrownError(args.error);
  const failure: ActionExecuteFailure = { ok: false, ...normalized,
    error: redactBugReportSensitiveText(normalized.error) };
  if (!args.effectMayHaveStarted && failure.errorCode === 'project_requester_home_unavailable') return failure;
  return await args.settle(failure, args.effectMayHaveStarted);
}
