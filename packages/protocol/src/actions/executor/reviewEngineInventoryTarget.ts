import type { ActionExecutorContext } from './types.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import { readNonEmptyString, readRecord } from '../../inputs/inputRecords.js';

/** Discovery and the engine picker share one explicit detached target decision. */
export function resolveReviewEngineInventoryTarget(
  input: unknown,
  context: ActionExecutorContext,
  resolveSessionId: (input: unknown, context: ActionExecutorContext) => string | null,
): Extract<ActionExecuteResult, { ok: false }> | Readonly<{
  ok: true; target: Readonly<{ sessionId: string | null; machineId?: string }>;
}> {
  const record = readRecord(input);
  if (record.sessionId !== null) {
    const sessionId = resolveSessionId(input, context);
    return sessionId ? { ok: true, target: { sessionId } }
      : { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
  }
  const admittedMachineId = context.externalActionTarget?.kind === 'machine'
    ? readNonEmptyString(context.externalActionTarget.machineId) : readNonEmptyString(context.executionRunTargetMachineId);
  const machineId = readNonEmptyString(record.machineId) ?? admittedMachineId;
  if (!machineId) return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
  if (admittedMachineId && admittedMachineId !== machineId) {
    return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  }
  return { ok: true, target: { sessionId: null, machineId } };
}
