import { asRecord } from './openCodeParsing.js';
import { classifyOpenCodeAssistantCompletion } from './transcript/projection/index.js';

export type OpenCodeNativeChildStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** Released V2 persists Idle.outcome; V1 persists a settled assistant result. */
export function readOpenCodeNativeChildOutcome(messages: readonly unknown[]): Exclude<OpenCodeNativeChildStatus, 'running'> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(messages[index]);
    const info = asRecord(entry?.info) ?? entry;
    if (!info) continue;
    if (info.type === 'idle' || info.role === 'idle') {
      if (info.outcome === 'succeeded') return 'completed';
      if (info.outcome === 'failed') return 'failed';
      if (info.outcome === 'interrupted') return 'aborted';
      return null;
    }
    // A new prompt invalidates an earlier execution's outcome.
    if (info.role === 'user' || info.type === 'user') return null;
    if (info.role !== 'assistant' && info.type !== 'assistant') continue;
    if (asRecord(info.time)?.completed === undefined) return null;
    if (info.error) {
      const error = asRecord(info.error);
      return error?.name === 'MessageAbortedError' || error?.name === 'AbortError' ? 'aborted' : 'failed';
    }
    return classifyOpenCodeAssistantCompletion(info).kind === 'terminal_success' ? 'completed' : null;
  }
  return null;
}
