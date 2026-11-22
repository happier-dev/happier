import type { RawJSONLines } from '../types';
import { isClaudeLocalCommandTranscriptMessage } from './isClaudeLocalCommandTranscriptMessage';
import { isCompactHookLocalCommandStdout } from './isCompactHookLocalCommandStdout';
import { isClaudeInternalUserTextMessage } from './readClaudeUserMessageText';

function readBooleanFlag(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)[key] === true);
}

export function isClaudeInternalTranscriptMessage(message: RawJSONLines): boolean {
  if (message.type === 'attachment') {
    return true;
  }
  if (message.type === 'user') {
    if (
      readBooleanFlag(message, 'isCompactSummary')
      || readBooleanFlag(message, 'isVisibleInTranscriptOnly')
      || isClaudeLocalCommandTranscriptMessage(message)
    ) {
      return true;
    }
  }
  return isCompactHookLocalCommandStdout(message);
}

/** Apply when publishing conversation rows, keeping lifecycle observations available. */
export function isClaudeHiddenTranscriptMessage(message: RawJSONLines): boolean {
  return isClaudeInternalTranscriptMessage(message) || isClaudeInternalUserTextMessage(message);
}
