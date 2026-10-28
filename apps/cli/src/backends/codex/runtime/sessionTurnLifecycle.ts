import {
  emitReadyIfIdle as emitReadyIfIdleShared,
  type EmitReadyIfIdleOptions,
} from '@/agent/runtime/emitReadyIfIdle';
import type { CodexToolResponse } from '../types';

export type ReadyEventOptions = EmitReadyIfIdleOptions;

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
  return emitReadyIfIdleShared({ pending, queueSize, shouldExit, sendReady, notify });
}

export function extractCodexToolErrorText(response: CodexToolResponse): string | null {
  if (!response?.isError) {
    return null;
  }
  const text = (response.content || [])
    .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || 'Codex error';
}

export function extractMcpToolCallResultOutput(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'Ok')) {
      return (record as any).Ok;
    }
    if (Object.prototype.hasOwnProperty.call(record, 'Err')) {
      return (record as any).Err;
    }
    if (Object.prototype.hasOwnProperty.call(record, 'output')) {
      return (record as any).output;
    }
    if (Object.prototype.hasOwnProperty.call(record, 'result')) {
      return (record as any).result;
    }
  }
  return result;
}

export function nextStoredSessionIdForResumeAfterAttempt(
  storedSessionIdForResume: string | null,
  attempt: { attempted: boolean; success: boolean },
): string | null {
  if (!attempt.attempted) {
    return storedSessionIdForResume;
  }
  return attempt.success ? null : storedSessionIdForResume;
}

const settledCodexTurnFailures = new WeakSet<object>();

/**
 * Records that a Codex runtime owner has already settled the session turn for this exact
 * failure (failed it with a classified issue, or interrupted it). The runner's prompt-loop
 * catch must then not surface the same failure as another failed turn. The marker is scoped
 * to the error instance, so a later, separate failure still surfaces its own turn.
 */
export function markCodexTurnFailureSettled(error: unknown): void {
  if (error !== null && typeof error === 'object') settledCodexTurnFailures.add(error);
}

export function isCodexTurnFailureSettled(error: unknown): boolean {
  return error !== null && typeof error === 'object' && settledCodexTurnFailures.has(error);
}
