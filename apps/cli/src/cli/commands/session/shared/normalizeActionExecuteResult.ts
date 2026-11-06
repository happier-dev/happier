import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol';
import { ActionFailureCauseV1Schema, projectActionExecuteFailure, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
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
}>;

/** Retain the owning failure intact until the command's single output boundary. */
export function throwCliActionFailure(failure: ActionExecuteFailure): never {
  throw Object.assign(new Error(failure.error), { actionFailure: failure });
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

export function normalizeActionExecuteResult(result: ActionExecuteResult): NormalizedCliActionExecuteResult {
  if (!result.ok) {
    const goalControlFailure = SessionGoalControlFailureV1Schema.safeParse(result.goalControlFailure);
    const failureCause = ActionFailureCauseV1Schema.safeParse(result.failureCause);
    return {
      ok: false,
      errorCode: result.errorCode,
      ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      ...(result.error ? { errorMessage: result.error } : {}),
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
    const errorMessage = normalizeErrorMessage(dataObj.error)
      ?? normalizeErrorMessage(dataObj.errorMessage)
      ?? normalizeErrorMessage(dataObj.message)
      ?? undefined;
    const candidates = Array.isArray(dataObj.candidates) ? (dataObj.candidates.map((v) => String(v)) as string[]) : undefined;
    const details = dataObj.details;
    const goalControlFailure = SessionGoalControlFailureV1Schema.safeParse(dataObj.goalControlFailure);
    const failureCause = ActionFailureCauseV1Schema.safeParse(dataObj.failureCause);
    return {
      ok: false,
      errorCode,
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
  const projected = projectActionExecuteFailure({ ok: false, ...failure,
    error: failure.errorMessage ?? failure.errorCode }, requestId);
  return {
    code: failure.errorCode,
    ...(projected.requestId === undefined ? {} : { requestId: projected.requestId }),
    ...(failure.errorMessage ? { message: failure.errorMessage } : {}),
    ...(failure.candidates ? { candidates: failure.candidates } : {}),
    ...(failure.details !== undefined ? { details: failure.details } : {}),
    ...(failure.failureCause ? { failureCause: failure.failureCause } : {}),
    ...(failure.effectAttempted !== undefined ? { effectAttempted: failure.effectAttempted } : {}),
    ...(failure.goalControlFailure ? { goalControlFailure: failure.goalControlFailure } : {}),
  };
}

/** Every thrown Action failure consumes the Protocol owner's typed carrier. */
export function normalizeCliActionThrownError(error: unknown): Readonly<{ failure: CliActionFailure; unexpected: boolean }> {
  const failure = normalizeActionExecutorThrownError(error);
  if (failure.errorCode !== 'action_failed' || failure.failureCause.errorCode !== null) {
    return { failure: { errorCode: failure.errorCode, errorMessage: failure.error,
      failureCause: failure.failureCause,
      ...(failure.details === undefined ? {} : { details: failure.details }),
      ...(failure.effectAttempted !== undefined ? { effectAttempted: failure.effectAttempted } : {}) }, unexpected: false };
  }
  const mapped = mapUnknownErrorToControlError(error);
  return { failure: { errorCode: mapped.code, ...(mapped.message ? { errorMessage: mapped.message } : {}) }, unexpected: mapped.unexpected };
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
