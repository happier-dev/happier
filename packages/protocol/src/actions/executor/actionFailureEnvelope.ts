import { SpawnSessionErrorCodeSchema } from '../../sessions/spawnSession.js';
import type { ActionExecuteFailure } from './types.js';

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
    if (record.type !== 'error' || (options.treatReturnedErrorEnvelopeAsFailure !== true
      && !SpawnSessionErrorCodeSchema.safeParse(errorCode).success)) return null;
  }
  const rawError = typeof record.error === 'string' ? record.error.trim() : '';
  const rawFallbackMessage = typeof record.errorMessage === 'string' && record.errorMessage.trim().length > 0
    ? record.errorMessage.trim()
    : typeof record.message === 'string' && record.message.trim().length > 0 ? record.message.trim() : '';
  const error = rawError && rawError !== errorCode ? rawError : rawFallbackMessage || rawError || errorCode;
  const details = readFailureEnvelopeDetails(record);
  return { ok: false, errorCode, error, ...(details !== undefined ? { details } : {}) };
}
