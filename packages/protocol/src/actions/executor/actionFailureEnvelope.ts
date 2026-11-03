import { SpawnSessionErrorCodeSchema } from '../../sessions/spawnSession.js';
import { SessionGoalControlFailureV1Schema } from '../../sessions/work/state/sessionWorkStateRpc.js';
import type { ActionExecuteFailure } from './types.js';
import { RpcError } from '../../rpc/errors.js';

/**
 * Admit the RpcHandlerManager's serialized exception before an Action adapter
 * parses its success payload. Explicit domain results (ok/success/status, etc.)
 * remain the domain owner's, including their strict success/failure schemas.
 */
export function readMachineActionRpcResult<T>(result: T): T {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Readonly<Record<string, unknown>>;
  if (typeof record.error !== 'string'
    || Object.keys(record).some(key => key !== 'error' && key !== 'errorCode' && key !== 'details' && key !== 'effectAttempted')) return result;
  if ('effectAttempted' in record && typeof record.effectAttempted !== 'boolean') return result;
  if ('errorCode' in record && (typeof record.errorCode !== 'string' || !record.errorCode.trim())) return result;
  // cli-v0.2.16 serializes untyped handler exceptions as { error } only.
  const failure = readActionFailureEnvelope({ ...record, ok: false, errorCode: record.errorCode ?? 'action_failed' })!;
  // Throw at this boundary so a typed adapter cannot parse the refusal as its
  // successful payload. The Action executor already preserves RpcError codes.
  throw Object.assign(new RpcError(failure.error, failure.errorCode),
    failure.details === undefined ? {} : { details: failure.details },
    failure.effectAttempted === false ? { effectAttempted: false } : {});
}

export function readFailureEnvelopeDetails(record: Readonly<Record<string, unknown>>): unknown | undefined {
  if (Object.prototype.hasOwnProperty.call(record, 'details')) return record.details;
  const details: Record<string, unknown> = {};
  for (const key of ['field', 'surface'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value !== undefined) details[key] = value;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

/** The executor's canonical returned-failure classifier, shared by typed adapters. */
export function readActionFailureEnvelope(
  result: unknown,
  options: Readonly<{ treatReturnedErrorEnvelopeAsFailure?: boolean }> = {},
): ActionExecuteFailure | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Readonly<Record<string, unknown>>;
  if (typeof record.errorCode !== 'string') return null;
  const errorCode = record.errorCode.trim();
  if (!errorCode) return null;
  if (record.ok !== false) {
    if (options.treatReturnedErrorEnvelopeAsFailure !== true
      && (record.type !== 'error' || !SpawnSessionErrorCodeSchema.safeParse(errorCode).success)) return null;
  }
  const rawError = typeof record.error === 'string' ? record.error.trim() : '';
  const rawFallbackMessage = typeof record.errorMessage === 'string' && record.errorMessage.trim().length > 0
    ? record.errorMessage.trim()
    : typeof record.message === 'string' && record.message.trim().length > 0 ? record.message.trim() : '';
  const error = rawError && rawError !== errorCode ? rawError : rawFallbackMessage || rawError || errorCode;
  const details = readFailureEnvelopeDetails(record);
  const goalControlFailure = SessionGoalControlFailureV1Schema.safeParse(record.goalControlFailure);
  return { ok: false, errorCode, error, ...(details !== undefined ? { details } : {}),
    ...(typeof record.effectAttempted === 'boolean' ? { effectAttempted: record.effectAttempted } : {}),
    ...(goalControlFailure.success ? { goalControlFailure: goalControlFailure.data } : {}) };
}
