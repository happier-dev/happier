import type { LocalTurnLifecycleEvent } from '@/agent/localControl/turnLifecycle';
import type { RawJSONLines } from '@/backends/claude/types';
import { isClaudeInternalTranscriptMessage } from '../utils/isClaudeInternalTranscriptMessage';
import { readClaudeControlCommandRowShape } from '../utils/controlCommandRows';
import { isClaudeRuntimeAuthFailureEvidence } from '../connectedServices/classifyClaudeConnectedServiceRuntimeAuthFailure';
import { isClaudeTranscriptTaskNotification } from './readClaudeTranscriptProviderActivity';

const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:\n';
const REQUEST_INTERRUPTED_TEXT = '[Request interrupted by user]';
const REQUEST_INTERRUPTED_FOR_TOOL_USE_TEXT = '[Request interrupted by user for tool use]';
const SYNTHETIC_NO_RESPONSE_TEXT = 'No response requested.';

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readBooleanFlag(value: unknown, key: string): boolean {
  return asRecord(value)?.[key] === true;
}

function readStringFlag(value: unknown, key: string): string {
  const raw = asRecord(value)?.[key];
  return typeof raw === 'string' ? raw : '';
}

function readMessageRecord(value: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(value)?.message);
}

function readNestedString(value: unknown, key: string): string {
  const raw = asRecord(value)?.[key];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function readCompactBoundaryTrigger(message: RawJSONLines): string {
  const record = asRecord(message);
  return readNestedString(record?.compactMetadata, 'trigger')
    || readNestedString(record?.compact_metadata, 'trigger');
}

function hasToolResultContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_result');
}

function containsRateLimitEvidence(value: unknown): boolean {
  if (typeof value === 'string') return /rate[ _-]?limit(?:ed)?/iu.test(value);
  if (Array.isArray(value)) return value.some(containsRateLimitEvidence);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return [
    record.error,
    record.code,
    record.type,
    record.kind,
    record.message,
    record.detail,
    record.details,
    record.description,
    record.content,
  ].some(containsRateLimitEvidence);
}

function isSyntheticNoResponseClosure(message: RawJSONLines, content: unknown): boolean {
  if (readStringFlag(message, 'model') !== '<synthetic>') return false;
  const text = firstTextContent(content);
  return typeof text === 'string' && text.trim() === SYNTHETIC_NO_RESPONSE_TEXT;
}

export function isClaudeSidechainTranscriptMessage(message: RawJSONLines): boolean {
  return readBooleanFlag(message, 'isSidechain');
}

export function isClaudeMainChainCompactBoundary(message: RawJSONLines): boolean {
  return !isClaudeSidechainTranscriptMessage(message)
    && message.type === 'system'
    && readStringFlag(message, 'subtype') === 'compact_boundary';
}

export function readClaudeTranscriptTurnSignal(message: RawJSONLines): LocalTurnLifecycleEvent | null {
  if (isClaudeSidechainTranscriptMessage(message)) return null;

  if (message.type === 'system') {
    if (isClaudeMainChainCompactBoundary(message)) {
      if (readCompactBoundaryTrigger(message) === 'auto') {
        return {
          type: 'continuation_detected',
          providerTurnId: null,
          source: 'claude_transcript_auto_compact_boundary',
        };
      }
      return {
        type: 'completion_candidate',
        providerTurnId: null,
        source: 'claude_transcript_compact_boundary',
      };
    }
    return null;
  }

  if (message.type === 'assistant') {
    if (readBooleanFlag(message, 'isApiErrorMessage') && isClaudeRuntimeAuthFailureEvidence(message)) {
      return {
        type: 'turn_terminal',
        providerTurnId: null,
        reason: 'failed',
        detail: 'authentication_failed',
        source: 'claude_transcript_api_error_authentication',
      };
    }
    if (readBooleanFlag(message, 'isApiErrorMessage') && containsRateLimitEvidence(message)) {
      return {
        type: 'turn_terminal',
        providerTurnId: null,
        reason: 'failed',
        detail: 'rate_limit',
        source: 'claude_transcript_api_error_rate_limit',
      };
    }
    if (readBooleanFlag(message, 'isApiErrorMessage')) {
      return {
        type: 'turn_terminal',
        providerTurnId: null,
        reason: 'failed',
        detail: 'api_error',
        source: 'claude_transcript_api_error',
      };
    }
    const messageRecord = readMessageRecord(message);
    const rawStopReason = messageRecord?.stop_reason;
    const stopReason = typeof rawStopReason === 'string' ? rawStopReason : '';
    if (stopReason === 'end_turn' && !isSyntheticNoResponseClosure(message, messageRecord?.content)) {
      return {
        type: 'completion_candidate',
        providerTurnId: null,
        source: 'claude_transcript_assistant_end_turn',
      };
    }
    return null;
  }

  if (message.type !== 'user') return null;
  if (isClaudeInternalTranscriptMessage(message)) return null;
  if (readClaudeControlCommandRowShape(message)?.kind === 'shell_output') return null;

  const content = readMessageRecord(message)?.content;
  const text = firstTextContent(content);

  if (text === REQUEST_INTERRUPTED_TEXT || text === REQUEST_INTERRUPTED_FOR_TOOL_USE_TEXT) {
    return {
      type: 'turn_terminal',
      providerTurnId: null,
      reason: 'aborted',
      source: 'claude_transcript_request_interrupted',
    };
  }

  if (readBooleanFlag(message, 'isMeta') && typeof text === 'string' && text.startsWith(STOP_HOOK_FEEDBACK_PREFIX)) {
    return {
      type: 'continuation_detected',
      providerTurnId: null,
      source: 'claude_transcript_stop_hook_feedback',
    };
  }

  if (readBooleanFlag(message, 'isMeta') || hasToolResultContent(content) || isClaudeTranscriptTaskNotification(message)) return null;
  if (typeof text === 'string' && text.trim().length > 0) {
    return {
      type: 'turn_started',
      providerTurnId: null,
      source: 'claude_transcript_user_prompt',
    };
  }

  return null;
}
