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
