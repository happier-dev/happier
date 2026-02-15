/**
 * Termination classification helpers.
 */

import type { TerminationEvent } from './types';

export function normalizeExitCodeOrFallback(code: number | null, fallback: number): number {
  if (typeof code === 'number' && Number.isFinite(code)) return Math.trunc(code);
  return fallback;
}

export function classifyChildExit(params: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>): TerminationEvent {
  if (params.signal) return { type: 'signaled', signal: params.signal };
  return { type: 'exited', code: normalizeExitCodeOrFallback(params.code, 1) };
}

export function classifySpawnError(error: unknown): TerminationEvent {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const name =
    record && typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : 'Error';
  const message =
    record && typeof record.message === 'string' && record.message.trim().length > 0 ? record.message.trim() : String(error);
  return { type: 'spawn_error', errorName: name, errorMessage: message };
}

export function isExpectedTermination(event: TerminationEvent): boolean {
  if (event.type === 'exited') return event.code === 0;
  if (event.type === 'signaled') return event.signal === 'SIGTERM' || event.signal === 'SIGINT';
  return false;
}

export function isUnexpectedTermination(event: TerminationEvent): boolean {
  return !isExpectedTermination(event);
}

