import { isSessionStopConfirmed, SessionStopResultSchema } from '../../../sessions/control/contract.js';
import { readNonEmptyString, readRecord } from '../../../inputs/inputRecords.js';
import type { ActionExecuteFailure } from '../../actionExecutionResult.js';

/** Consumers retain the lifecycle owner's refusal; only its confirmation permits the next effect. */
export function readSessionStopConfirmationFailure(sessionId: string, result: unknown): ActionExecuteFailure | null {
  const stop = SessionStopResultSchema.safeParse(result);
  if (stop.success && stop.data.sessionId === sessionId && isSessionStopConfirmed(stop.data)) return null;
  const native = readRecord(result);
  const code = readNonEmptyString(native.code) ?? 'session_stop_unconfirmed';
  const recovery = readNonEmptyString(native.recovery);
  return { ok: false, errorCode: code, error: readNonEmptyString(native.message) ?? code,
    ...(recovery ? { details: { sessionId, recovery } } : {}) };
}
