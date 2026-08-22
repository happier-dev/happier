import { readSessionHookSidechainAgentId } from '../hooks/sidechain.js';
import {
  CLAUDE_NON_TRANSCRIPT_RECORD_TYPES,
  INTERNAL_CLAUDE_EVENT_TYPES,
} from './internalEventTypes.js';
import {
  resolveClaudeTranscriptMessageRole,
  type ClaudeTranscriptMessageRole,
} from './messageRole.js';
import { parseRawJsonLinesObject } from './parseRawJsonLines.js';
import type { RawJSONLines } from './rawJsonLines.js';
import { normalizeClaudeToolUseNamesInRawJsonLines } from './toolUseNames.js';
import {
  isClaudeInternalTranscriptMessage,
  readClaudeVisibleCompactSummaryText,
  readClaudeVisibleLocalCommandOutputText,
  readClaudeVisibleSlashCommandText,
} from './visibility.js';

const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:\n';
const CLAUDE_SYNTHETIC_NO_RESPONSE_TEXT = 'No response requested.';

export type ClaudeNativeTranscriptContent =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'message'; text: string | null }>
  | Readonly<{ kind: 'compact_summary'; text: string }>
  | Readonly<{ kind: 'slash_command'; text: string }>
  | Readonly<{ kind: 'local_command_output'; text: string }>
  | Readonly<{ kind: 'opaque'; original: unknown }>;

/**
 * Recipient-safe Claude message semantics. The native envelope stays private;
 * only these canonical fields may leave the Claude projection owner.
 */
export type ClaudeNativeTranscriptContentPart =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'thinking'; text: string }>
  | Readonly<{
      kind: 'tool_use';
      callId: string;
      name: string;
      input: unknown;
    }>
  | Readonly<{
      kind: 'tool_result';
      callId: string;
      output: unknown;
      isError?: boolean;
    }>
  | Readonly<{
      kind: 'unsupported';
      source: 'content' | 'image' | 'thinking' | 'tool_result' | 'tool_use';
    }>;

export type ClaudeNativeTranscriptLifecycleMeaning =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'stop_hook_feedback' }>
  | Readonly<{ kind: 'synthetic_no_response' }>
  | Readonly<{ kind: 'assistant_api_error' }>
  | Readonly<{ kind: 'assistant_stop'; stopReason: string }>
  | Readonly<{ kind: 'compact_boundary' }>;

export type ClaudeNativeTranscriptBoundary = Readonly<{
  kind: 'assistant_api_error' | 'assistant_stop' | 'compact_boundary';
  id: string | null;
}>;

export type ClaudeNativeTranscriptRowClassification = Readonly<{
  rawObject: unknown | null;
  rawType: string | null;
  row: RawJSONLines | null;
  knownNonTranscriptRecord: boolean;
  visibility: 'visible' | 'sanitized' | 'hidden' | 'opaque';
  messageRole: ClaudeTranscriptMessageRole;
  sidechain: boolean;
  content: ClaudeNativeTranscriptContent;
  semanticParts: readonly ClaudeNativeTranscriptContentPart[];
  lifecycle: ClaudeNativeTranscriptLifecycleMeaning;
  nativeBoundary: ClaudeNativeTranscriptBoundary | null;
}>;

export type ClaudeNativeHookLifecycleClassification =
  | Readonly<{ kind: 'primary'; sidechainAgentId: string | null }>
  | Readonly<{ kind: 'sidechain_activity'; sidechainAgentId: string }>
  | Readonly<{ kind: 'sidechain_terminal'; sidechainAgentId: string }>
  | Readonly<{ kind: 'ignored'; sidechainAgentId: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonlLineValue(value: unknown): unknown | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function readMessageRecord(row: RawJSONLines): Record<string, unknown> | null {
  return isRecord(row.message) ? row.message : null;
}

function readTextContent(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readTextContentParts(value: unknown): string | null {
  const directText = readTextContent(value);
  if (directText !== null) return directText;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = readTextContent(item.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

function readMessageContentParts(value: unknown): readonly ClaudeNativeTranscriptContentPart[] {
  const directText = readTextContent(value);
  if (directText !== null) return [{ kind: 'text', text: directText }];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [{ kind: 'unsupported', source: 'content' }];

  const parts: ClaudeNativeTranscriptContentPart[] = [];
  const textParts: string[] = [];
  const flushText = () => {
    if (textParts.length === 0) return;
    parts.push({ kind: 'text', text: textParts.join('') });
    textParts.length = 0;
  };

  for (const valuePart of value) {
    if (!isRecord(valuePart)) {
      flushText();
      parts.push({ kind: 'unsupported', source: 'content' });
      continue;
    }
    const type = typeof valuePart.type === 'string' ? valuePart.type : null;
    if (type === 'text') {
      const text = readTextContent(valuePart.text);
      if (text !== null) {
        textParts.push(text);
        continue;
      }
      flushText();
      parts.push({ kind: 'unsupported', source: 'content' });
      continue;
    }

    flushText();
    if (type === 'thinking') {
      const text = readTextContent(valuePart.thinking);
      parts.push(text === null
        ? { kind: 'unsupported', source: 'thinking' }
        : { kind: 'thinking', text });
      continue;
    }
    if (type === 'tool_use') {
      const callId = readString(valuePart.id);
      const name = readString(valuePart.name);
      parts.push(callId === null || name === null
        ? { kind: 'unsupported', source: 'tool_use' }
        : {
            kind: 'tool_use',
            callId,
            name,
            input: valuePart.input ?? {},
          });
      continue;
    }
    if (type === 'tool_result') {
      const callId = readString(valuePart.tool_use_id);
      parts.push(callId === null
        ? { kind: 'unsupported', source: 'tool_result' }
        : {
            kind: 'tool_result',
            callId,
            output: valuePart.content ?? '',
            ...(typeof valuePart.is_error === 'boolean' ? { isError: valuePart.is_error } : {}),
          });
      continue;
    }
    parts.push({ kind: 'unsupported', source: type === 'image' ? 'image' : 'content' });
  }
  flushText();
  return parts;
}

function readSingleTextContentBlock(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const block = value[0];
  if (!isRecord(block) || block.type !== 'text') return null;
  return typeof block.text === 'string' ? block.text : null;
}

function isClaudeSyntheticNoResponseRow(row: RawJSONLines): boolean {
  if (row.type !== 'assistant') return false;
  if (readString((row as Record<string, unknown>).model) !== '<synthetic>') return false;
  const message = readMessageRecord(row);
  if (!message) return false;
  return readSingleTextContentBlock(message.content)?.trim() === CLAUDE_SYNTHETIC_NO_RESPONSE_TEXT;
}

function readNativeBoundaryId(row: RawJSONLines): string | null {
  return readString((row as Record<string, unknown>).uuid);
}

function createBaseClassification(params: Readonly<{
  rawObject: unknown | null;
  rawType: string | null;
  row: RawJSONLines | null;
  visibility: ClaudeNativeTranscriptRowClassification['visibility'];
  messageRole: ClaudeTranscriptMessageRole;
  content: ClaudeNativeTranscriptContent;
  semanticParts?: readonly ClaudeNativeTranscriptContentPart[];
}>): ClaudeNativeTranscriptRowClassification {
  return {
    ...params,
    // A record is a safe skip only when the pinned CLI ratifies it as
    // non-transcript, or when it is a conversation row this projection
    // deliberately hides. Everything else stays unsupported so the paging
    // owner reports the loss instead of advancing past user data.
    knownNonTranscriptRecord:
      (params.rawType !== null && CLAUDE_NON_TRANSCRIPT_RECORD_TYPES.has(params.rawType))
      || ((params.rawType === 'user' || params.rawType === 'assistant')
        && params.visibility === 'hidden'),
    sidechain: params.row?.isSidechain === true,
    semanticParts: params.semanticParts ?? [],
    lifecycle: { kind: 'none' },
    nativeBoundary: null,
  };
}

/**
 * Canonical Claude-native JSONL semantic classifier.
 *
 * It owns meaning shared by transcript surfaces. Callers remain thin adapters:
 * external sessions render raw/sanitized messages, while the hosted terminal
 * runtime publishes only lifecycle-bearing provider transcript evidence.
 */
export function classifyClaudeNativeTranscriptRow(
  lineValue: unknown,
): ClaudeNativeTranscriptRowClassification {
  const rawObject = parseJsonlLineValue(lineValue);
  const rawTypeValue = isRecord(rawObject) ? rawObject.type : null;
  const rawType = typeof rawTypeValue === 'string' ? rawTypeValue : null;

  if (rawType && INTERNAL_CLAUDE_EVENT_TYPES.has(rawType)) {
    return createBaseClassification({
      rawObject,
      rawType,
      row: null,
      visibility: 'hidden',
      messageRole: 'event',
      content: { kind: 'none' },
    });
  }

  const parsed = parseRawJsonLinesObject(rawObject);
  if (!parsed) {
    return createBaseClassification({
      rawObject,
      rawType,
      row: null,
      visibility: rawType && rawType !== 'user' && rawType !== 'assistant' ? 'hidden' : 'opaque',
      // Classify from the raw body: a row we cannot parse still gets the role treatment every other
      // path applies, rather than reaching the transcript as unclassified agent content.
      messageRole: resolveClaudeTranscriptMessageRole(rawObject),
      content: rawType && rawType !== 'user' && rawType !== 'assistant'
        ? { kind: 'none' }
        : { kind: 'opaque', original: rawObject ?? lineValue },
    });
  }

  const row = normalizeClaudeToolUseNamesInRawJsonLines(parsed);
  const compactSummary = readClaudeVisibleCompactSummaryText(row);
  if (compactSummary) {
    return createBaseClassification({
      rawObject,
      rawType,
      row,
      visibility: 'sanitized',
      messageRole: 'agent',
      content: { kind: 'compact_summary', text: compactSummary },
    });
  }

  const slashCommand = readClaudeVisibleSlashCommandText(row);
  if (slashCommand) {
    return createBaseClassification({
      rawObject,
      rawType,
      row,
      visibility: 'sanitized',
      messageRole: 'user',
      content: { kind: 'slash_command', text: slashCommand },
    });
  }

  const localCommandOutput = readClaudeVisibleLocalCommandOutputText(row);
  if (localCommandOutput) {
    return createBaseClassification({
      rawObject,
      rawType,
      row,
      visibility: 'sanitized',
      messageRole: 'agent',
      content: { kind: 'local_command_output', text: localCommandOutput },
    });
  }

  if (isClaudeInternalTranscriptMessage(row)) {
    return createBaseClassification({
      rawObject,
      rawType,
      row,
      visibility: 'hidden',
      messageRole: 'event',
      content: { kind: 'none' },
    });
  }

  const base = createBaseClassification({
    rawObject,
    rawType,
    row,
    visibility: 'visible',
    messageRole: resolveClaudeTranscriptMessageRole(row),
    content: { kind: 'message', text: readTextContentParts(readMessageRecord(row)?.content) },
    semanticParts: readMessageContentParts(readMessageRecord(row)?.content),
  });

  if (row.type === 'system' && readString((row as Record<string, unknown>).subtype) === 'compact_boundary') {
    return {
      ...base,
      lifecycle: { kind: 'compact_boundary' },
      nativeBoundary: { kind: 'compact_boundary', id: readNativeBoundaryId(row) },
    };
  }

  if (row.type === 'assistant') {
    if (isClaudeSyntheticNoResponseRow(row)) {
      return { ...base, lifecycle: { kind: 'synthetic_no_response' } };
    }
    if ((row as Readonly<Record<string, unknown>>).isApiErrorMessage === true) {
      return {
        ...base,
        lifecycle: { kind: 'assistant_api_error' },
        nativeBoundary: { kind: 'assistant_api_error', id: readNativeBoundaryId(row) },
      };
    }
    const stopReason = readString(readMessageRecord(row)?.stop_reason);
    if (stopReason) {
      return {
        ...base,
        lifecycle: { kind: 'assistant_stop', stopReason },
        nativeBoundary: { kind: 'assistant_stop', id: readNativeBoundaryId(row) },
      };
    }
    return base;
  }

  if (row.type !== 'user') return base;
  const text = readTextContentParts(readMessageRecord(row)?.content);
  if (!text) return base;
  if (row.isMeta === true) {
    return text.startsWith(STOP_HOOK_FEEDBACK_PREFIX)
      ? { ...base, lifecycle: { kind: 'stop_hook_feedback' } }
      : base;
  }
  return { ...base, lifecycle: { kind: 'text', text } };
}

export function classifyClaudeNativeHookLifecycle(params: Readonly<{
  eventName: string;
  payload: Readonly<Record<string, unknown>>;
  primaryAgentId: string;
}>): ClaudeNativeHookLifecycleClassification {
  const rawSidechainAgentId = readSessionHookSidechainAgentId(params.payload);
  const sidechainAgentId = rawSidechainAgentId === params.primaryAgentId
    ? null
    : rawSidechainAgentId;
  if (!sidechainAgentId || params.eventName === 'StopFailure') {
    return { kind: 'primary', sidechainAgentId };
  }
  if (
    params.eventName === 'PreToolUse'
    || params.eventName === 'PostToolUse'
    || params.eventName === 'UserPromptSubmit'
    || params.eventName === 'Notification'
  ) {
    return { kind: 'sidechain_activity', sidechainAgentId };
  }
  if (params.eventName === 'Stop' || params.eventName === 'SessionEnd') {
    return { kind: 'sidechain_terminal', sidechainAgentId };
  }
  return { kind: 'ignored', sidechainAgentId };
}

export function createClaudeCompactBoundaryEventId(params: Readonly<{
  providerSessionId: string;
  nativeBoundaryId: string | null;
  observedAtMs: number | null;
}>): string | null {
  if (params.nativeBoundaryId) {
    return `claude:compact_boundary:${params.providerSessionId}:${params.nativeBoundaryId}`;
  }
  return params.observedAtMs === null
    ? null
    : `claude:compact_boundary:${params.providerSessionId}:ts-${params.observedAtMs}`;
}

export function readClaudeCompactBoundaryEventId(params: Readonly<{
  payload: Readonly<Record<string, unknown>>;
  nestedPayload: Readonly<Record<string, unknown>>;
  fallbackSessionId: string;
}>): string | null {
  const providerSessionId = readString(params.payload.providerSessionId)
    ?? readString(params.payload.provider_session_id)
    ?? readString(params.nestedPayload.session_id)
    ?? readString(params.nestedPayload.sessionId)
    ?? readString(params.payload.sessionId)
    ?? params.fallbackSessionId;
  const nativeBoundaryId = readString(params.nestedPayload.uuid)
    ?? readString(params.nestedPayload.id)
    ?? readString(params.payload.uuid)
    ?? readString(params.payload.id)
    ?? readString(params.payload.turnId)
    ?? readString(params.nestedPayload.turnId);
  const observedAtMs = readTimestampMs(params.nestedPayload.timestamp)
    ?? readTimestampMs(params.nestedPayload.observedAtMs)
    ?? readTimestampMs(params.nestedPayload.observed_at_ms)
    ?? readTimestampMs(params.payload.timestamp)
    ?? readTimestampMs(params.payload.observedAtMs)
    ?? readTimestampMs(params.payload.observed_at_ms);
  return createClaudeCompactBoundaryEventId({
    providerSessionId,
    nativeBoundaryId,
    observedAtMs,
  });
}
