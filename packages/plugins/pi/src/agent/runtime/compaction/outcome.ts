import type { PiCompactionTurnOutcome, PiCompactionTurnState } from './types.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readTerminalPhase(end: NonNullable<PiCompactionTurnState['lastCompactionEnd']>): string | null {
  return readString(end.phase) ?? (isRecord(end.payload) ? readString(end.payload.phase) : null);
}

function readTerminalErrorCode(end: NonNullable<PiCompactionTurnState['lastCompactionEnd']>): string | null {
  return readString(end.errorCode) ?? (isRecord(end.payload) ? readString(end.payload.errorCode) : null);
}

function isTerminalCompactionFailure(end: NonNullable<PiCompactionTurnState['lastCompactionEnd']>): boolean {
  const phase = readTerminalPhase(end);
  return phase === 'failed'
    || phase === 'cancelled'
    || readTerminalErrorCode(end) !== null
    || Boolean(end.errorMessage);
}

export function resolvePiCompactionTurnOutcome(state: PiCompactionTurnState): PiCompactionTurnOutcome {
  const end = state.lastCompactionEnd;

  if (end?.willRetry === false && state.lastAssistantStopReason === 'stop') {
    return 'completed_post_final';
  }

  if (end !== null && !end.willRetry && isTerminalCompactionFailure(end)) {
    return 'terminal_failure';
  }

  return 'pause';
}
