import { redactBugReportSensitiveText } from '../../bugs/reports/redaction.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import { normalizeActionExecutorThrownError } from './resultProjection.js';
import { StoredApprovalRequestSchema, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import { buildActionExecuteResultFromRecordedApprovalExecution } from './approvalResults.js';

/** A lost inter-process reply transfers no claim or settlement authority. */
export async function observeApprovalReplayOutcome<TResult>(args: Readonly<{
  readRequest(): Promise<unknown>;
  failure: ActionExecuteFailure;
  observe(request: ApprovalRequest, execution: ActionExecuteResult): Promise<TResult>;
}>): Promise<TResult | ActionExecuteFailure> {
  let raw: unknown;
  try { raw = await args.readRequest(); }
  catch { return args.failure; }
  const parsed = StoredApprovalRequestSchema.safeParse(raw);
  if (!parsed.success) return args.failure;
  const request = parsed.data;
  const execution = buildActionExecuteResultFromRecordedApprovalExecution(request);
  if (execution) return args.observe(request, execution);
  if (request.v === 2 && request.status === 'executing') return args.observe(request, args.failure);
  // Admission can still be preparing before the daemon's first claim. Keep
  // approved inputs available to that executor; uncertainty is a caller result.
  return args.failure;
}

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
