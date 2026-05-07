import type { LocalTurnLifecycleEvent } from '@/agent/localControl/turnLifecycle';
import type { RawJSONLines } from '@/backends/claude/types';

const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:\n';
const REQUEST_INTERRUPTED_TEXT = '[Request interrupted by user]';

function firstTextContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
  }
  return null;
}

function hasToolResultContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_result');
}

export function readClaudeTranscriptTurnSignal(message: RawJSONLines): LocalTurnLifecycleEvent | null {
  if ((message as any).isSidechain === true) return null;

  if (message.type === 'assistant') {
    const stopReason = typeof (message as any)?.message?.stop_reason === 'string'
      ? String((message as any).message.stop_reason)
      : '';
    if (stopReason === 'end_turn') {
      return {
        type: 'completion_candidate',
        providerTurnId: null,
        source: 'claude_transcript_assistant_end_turn',
      };
    }
    return null;
  }

  if (message.type !== 'user') return null;

  const content = (message as any)?.message?.content;
  const text = firstTextContent(content);

  if (text === REQUEST_INTERRUPTED_TEXT) {
    return {
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'aborted',
      source: 'claude_transcript_request_interrupted',
    };
  }

  if ((message as any).isMeta === true && typeof text === 'string' && text.startsWith(STOP_HOOK_FEEDBACK_PREFIX)) {
    return {
      type: 'continuation_detected',
      providerTurnId: null,
      source: 'claude_transcript_stop_hook_feedback',
    };
  }

  if ((message as any).isMeta === true || hasToolResultContent(content)) return null;
  if (typeof text === 'string' && text.trim().length > 0) {
    return {
      type: 'turn_started',
      providerTurnId: null,
      source: 'claude_transcript_user_prompt',
    };
  }

  return null;
}
