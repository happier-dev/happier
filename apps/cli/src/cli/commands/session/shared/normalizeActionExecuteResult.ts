import { stripVTControlCharacters } from 'node:util';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol';
import { ActionFailureCauseV1Schema, parseActionExecuteFailure, projectActionExecuteFailure, projectActionFailureForAgentV1, readActionErrorCodeV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { projectSessionHandoffFailureDetails } from '@happier-dev/protocol/actions/specs/session/lifecycle';
import { readDeploymentInstallationReplacementRefusalV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { SessionGoalControlFailureV1Schema, type SessionGoalControlFailureV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';

export type CliActionFailure = Readonly<{
  errorCode: string;
  errorMessage?: string;
  requestId?: string;
  candidates?: readonly string[];
  details?: unknown;
  failureCause?: ActionFailureCauseV1;
  effectAttempted?: boolean;
  goalControlFailure?: SessionGoalControlFailureV1;
  automationNotices?: ActionExecuteResult['automationNotices'];
}>;

class CliActionFailureError extends Error {
  constructor(readonly actionFailure: ActionExecuteFailure, message: string) {
    super(message);
  }
}

/** Retain the owning failure intact until the command's single output boundary. */
export function throwCliActionFailure(failure: ActionExecuteFailure, message = failure.error): never {
  throw new CliActionFailureError(failure, message);
}

export type NormalizedCliActionExecuteResult =
  | Readonly<{
    ok: true;
    data: unknown;
  }>
  | (CliActionFailure & Readonly<{ ok: false }>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeErrorCode(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw : null;
}

function normalizeErrorMessage(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw : null;
}

function resolveActionFailureMessage(
  message: string | undefined,
  failureCause?: ActionFailureCauseV1,
  errorCode?: string,
  details?: unknown,
): string | undefined {
  if (errorCode === 'present_user_required') {
    return 'Review and approve this Action in the Happier app.';
  }
  if (failureCause?.errorCode === 'machine_manage_required') {
    return 'This Action needs Manage on this Machine.';
  }
  if ((!message || message === errorCode) && errorCode === 'approval_execution_outcome_unknown'
    && isRecord(details) && details.reasonCode === 'credential_scope_denied') {
    return 'Approve this request in the Happier app. A terminal credential cannot approve its own request.';
  }
  const replacement = readDeploymentInstallationReplacementRefusalV1(errorCode, details);
  return replacement && (!message || message === errorCode) ? replacement.remedy : message;
}

export function normalizeActionExecuteResult(result: ActionExecuteResult): NormalizedCliActionExecuteResult {
  if (!result.ok) {
    result = projectActionFailureForAgentV1(result);
    const goalControlFailure = SessionGoalControlFailureV1Schema.safeParse(result.goalControlFailure);
    const failureCause = ActionFailureCauseV1Schema.safeParse(result.failureCause);
    const errorMessage = resolveActionFailureMessage(result.error, failureCause.success ? failureCause.data : undefined, result.errorCode, result.details);
    return {
      ok: false,
      errorCode: result.errorCode,
      ...(result.automationNotices ? { automationNotices: result.automationNotices } : {}),
      ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      ...(errorMessage ? { errorMessage } : {}),
      ...(result.details !== undefined ? { details: result.details } : {}),
      ...(failureCause.success ? { failureCause: failureCause.data } : {}),
      ...(typeof result.effectAttempted === 'boolean' ? { effectAttempted: result.effectAttempted } : {}),
      ...(goalControlFailure.success ? { goalControlFailure: goalControlFailure.data } : {}),
    };
  }

  const data = result.result;
  const dataObj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (dataObj && dataObj.ok === false) {
    const errorCode = normalizeErrorCode(dataObj.errorCode) ?? normalizeErrorCode(dataObj.code) ?? 'action_failed';
    const message = normalizeErrorMessage(dataObj.error)
      ?? normalizeErrorMessage(dataObj.errorMessage)
      ?? normalizeErrorMessage(dataObj.message)
      ?? undefined;
    const candidates = Array.isArray(dataObj.candidates) ? (dataObj.candidates.map((v) => String(v)) as string[]) : undefined;
    const projected = projectActionFailureForAgentV1({ ok: false, errorCode,
      error: message ?? errorCode, ...(dataObj.details === undefined ? {} : { details: dataObj.details }) });
    const details = projected.details;
    const goalControlFailure = SessionGoalControlFailureV1Schema.safeParse(dataObj.goalControlFailure);
    const failureCause = ActionFailureCauseV1Schema.safeParse(dataObj.failureCause);
    const errorMessage = resolveActionFailureMessage(message === undefined && projected.error === errorCode ? undefined : projected.error,
      failureCause.success ? failureCause.data : undefined, errorCode, details);
    return {
      ok: false,
      errorCode,
      ...(typeof dataObj.requestId === 'string' ? { requestId: dataObj.requestId } : {}),
      ...(result.automationNotices ? { automationNotices: result.automationNotices } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      ...(candidates && candidates.length > 0 ? { candidates } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(failureCause.success ? { failureCause: failureCause.data } : {}),
      ...(typeof dataObj.effectAttempted === 'boolean' ? { effectAttempted: dataObj.effectAttempted } : {}),
      ...(goalControlFailure.success ? { goalControlFailure: goalControlFailure.data } : {}),
    };
  }

  return { ok: true, data };
}

/** One output projection for generic and compiled Action commands. */
export function projectCliActionFailure(failure: CliActionFailure, requestId?: string): Omit<CliActionFailure, 'errorCode' | 'errorMessage'> & Readonly<{ code: string; message?: string }> {
  const errorMessage = resolveActionFailureMessage(failure.errorMessage, failure.failureCause, failure.errorCode, failure.details);
  const projected = projectActionFailureForAgentV1(projectActionExecuteFailure({ ok: false, ...failure,
    error: errorMessage ?? failure.errorCode }, requestId));
  return {
    code: failure.errorCode,
    ...(projected.requestId === undefined ? {} : { requestId: projected.requestId }),
    ...(errorMessage || projected.error !== failure.errorCode ? { message: projected.error } : {}),
    ...(failure.candidates ? { candidates: failure.candidates } : {}),
    ...(projected.details !== undefined ? { details: projected.details } : {}),
    ...(projected.failureCause ? { failureCause: projected.failureCause } : {}),
    ...(projected.effectAttempted !== undefined ? { effectAttempted: projected.effectAttempted } : {}),
    ...(failure.goalControlFailure ? { goalControlFailure: failure.goalControlFailure } : {}),
  };
}

export function formatCliActionFailureText(
  message: string | undefined,
  failure: CliActionFailure,
  options?: Readonly<{ actionId?: string; requestId?: string; suffix?: string | null }>,
): string {
  const projected = projectCliActionFailure(failure, options?.requestId);
  const heading = message ?? projected.message ?? projected.code;
  const summary = options?.suffix ? `${heading} ${options.suffix}` : heading;
  const cause = projected.failureCause;
  const handoff = projectSessionHandoffFailureDetails(options?.actionId ?? '', {
    errorCode: projected.code, details: projected.details,
  });
  const terminalField = (value: string) => stripVTControlCharacters(value).replace(/\p{Cc}/gu, ' ');
  const diagnostics = [
    cause && heading !== projected.code ? `Code: ${terminalField(projected.code)}` : null,
    cause ? `Phase: ${cause.phase}` : null,
    cause?.errorCode && cause.errorCode !== projected.code ? `Cause: ${cause.errorCode}` : null,
    cause && cause.httpStatus !== null ? `HTTP ${cause.httpStatus}` : null,
    cause && 'nativeErrorCode' in cause && cause.nativeErrorCode ? `Native code: ${cause.nativeErrorCode}` : null,
    cause && 'nativeErrorReason' in cause && cause.nativeErrorReason ? `Reason: ${cause.nativeErrorReason}` : null,
    ...(handoff && 'diagnostics' in handoff ? handoff.diagnostics.map(({ code, details }) =>
      `Handoff diagnostic: ${code} (${details.pathKind})`) : []),
    projected.requestId ? `requestId: ${terminalField(projected.requestId)}` : null,
    projected.effectAttempted === false ? 'No effect attempted' : null,
    projected.effectAttempted === true ? 'Effect attempted' : null,
  ].filter(part => part !== null).join('; ');
  return diagnostics ? `${summary}\n${diagnostics}` : summary;
}

/** Every thrown Action failure consumes the Protocol owner's typed carrier. */
export function normalizeCliActionThrownError(error: unknown): Readonly<{ failure: CliActionFailure; unexpected: boolean }> {
  if (error instanceof CliActionFailureError) {
    const normalized = normalizeActionExecuteResult(error.actionFailure);
    if (!normalized.ok) return { failure: normalized, unexpected: false };
  }
  const failure = normalizeActionExecutorThrownError(error);
  let hasTypedFailure = parseActionExecuteFailure(error) !== null;
  let cause: unknown;
  if (!hasTypedFailure && error instanceof Error) {
    try {
      cause = error.cause;
      hasTypedFailure = parseActionExecuteFailure(cause) !== null;
    } catch { /* A private cause accessor cannot replace the original failure. */ }
  }
  // A raw code can suppress text inference even when the closed Protocol
  // projection withholds it. Only typed CLI refusals or CLI parser syntax can
  // refine a failure that Protocol could not classify.
  if (!hasTypedFailure && failure.errorCode === 'action_failed' && failure.failureCause.errorCode === null) {
    const mapped = mapUnknownErrorToControlError(error, readActionErrorCodeV1(cause) !== null ? 'none' : 'cli_arguments');
    if (!mapped.unexpected) {
      return { failure: { errorCode: mapped.code, errorMessage: failure.error }, unexpected: false };
    }
  }
  return { failure: { errorCode: failure.errorCode,
    errorMessage: resolveActionFailureMessage(failure.error, failure.failureCause, failure.errorCode, failure.details),
    failureCause: failure.failureCause,
    ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
    ...(failure.details === undefined ? {} : { details: failure.details }),
    ...(failure.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }) },
    unexpected: !hasTypedFailure && failure.errorCode === 'action_failed' && failure.failureCause.errorCode === null };
}

export function unwrapCliActionSuccessPayload(data: unknown): unknown {
  if (!isRecord(data) || data.ok !== true) {
    return data;
  }

  if (Object.hasOwn(data, 'data')) {
    return data.data;
  }

  const { ok: _ok, ...payload } = data;
  return payload;
}
