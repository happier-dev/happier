import { readTranscriptPeerSenderV1 } from '@happier-dev/protocol/sessions/messages/transcriptPeerSenderV1';
import { readClaudeProviderIdentityValue, readClaudeTranscriptProviderSessionId } from '../../protocol/providerIdentity.js';
import { readSessionHookSidechainAgentId } from '../hooks/sidechain.js';
import {
  CLAUDE_NON_TRANSCRIPT_RECORD_TYPES,
  isClaudeInternalEventType,
} from './internalEventTypes.js';
import {
  resolveClaudeTranscriptMessageRole,
  type ClaudeTranscriptMessageRole,
} from './messageRole.js';
import { parseRawJsonLinesObject } from './parseRawJsonLines.js';
import type { RawJSONLines } from './rawJsonLines.js';
import { normalizeClaudeToolUseNamesInRawJsonLines } from './toolUseNames.js';
import { readClaudeCompactionMetadata } from './compactionMetadata.js';
import {
  isClaudeInternalTranscriptMessage,
  isClaudeLocalCommandCaveatTranscriptMessage,
  readClaudeVisibleCompactSummaryText,
  readClaudeVisibleLocalCommandOutputText,
  readClaudeVisibleSlashCommandText,
} from './visibility.js';

const STOP_HOOK_FEEDBACK_PREFIX = 'Stop hook feedback:\n';
const CLAUDE_SYNTHETIC_NO_RESPONSE_TEXT = 'No response requested.';

export type ClaudeNativeTranscriptContent =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'message'; text: string | null }>
  | Readonly<{ kind: 'peer_message'; text: string; peer: ClaudeNativePeerSender }>
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
  | Readonly<{ kind: 'shell_input'; text: string }>
  | Readonly<{ kind: 'shell_output' }>
  | Readonly<{ kind: 'local_command_caveat' }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'stop_hook_feedback' }>
  | Readonly<{ kind: 'synthetic_no_response' }>
  | Readonly<{ kind: 'assistant_api_error' }>
  | Readonly<{ kind: 'assistant_stop'; stopReason: string }>
  | Readonly<{ kind: 'idle_compaction_notice' }>
  | Readonly<{ kind: 'compact_boundary' } & ReturnType<typeof readClaudeCompactionMetadata>>;

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

/** Native lifecycle evidence preserves the envelope, but never transports image bytes. */
export function projectClaudeNativeTranscriptObservation(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.message) || !Array.isArray(value.message.content)) return value;
  const content = value.message.content;
  if (!content.some((part) => isRecord(part) && part.type === 'image')) return value;
  return {
    ...value,
    message: {
      ...value.message,
      // Images have only an unsupported-image meaning in the canonical classifier.
      content: content.map((part) => isRecord(part) && part.type === 'image' ? { type: 'image' } : part),
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Sender of a delivered teammate, cross-session or subagent hand-back message. */
export type ClaudeNativePeerSender = Readonly<{ name: string | null; handback: boolean }>;

export type ClaudeNativePeerMessage = Readonly<{ text: string; peer: ClaudeNativePeerSender }>;

function readTagAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes.set(match[1], match[2] ?? match[3]);
  }
  return attributes;
}

// Claude 2.1.296+ wraps teammate and subagent deliveries in <agent-message>, preceded by a
// delivery sentence and followed by harness guidance on user rows. Only native peer origin
// may admit this unanchored wrapper; copied text without that provenance stays ordinary input.
const AGENT_MESSAGE_WRAPPER = /<agent-message\b((?:"[^"]*"|'[^']*'|[^'">])*)>\n?([\s\S]*?)\n?<\/agent-message>/i;
const CROSS_SESSION_WRAPPER = /^\s*<cross-session-message\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/cross-session-message>\s*$/i;
const HANDBACK_FRAME = /^\[Subagent hand-back\][^\n]*\n/;

/** Hand-backs prefix a provenance frame and indent every report line; 2.1.304 also sends the bare report. */
function readHandbackReport(origin: Record<string, unknown>, body: string): string {
  const reportText = readString(origin.handbackReportText);
  if (reportText) return reportText;
  const frame = HANDBACK_FRAME.exec(body);
  if (!frame) return body;
  return body.slice(frame[0].length).split('\n')
    .map(line => line.startsWith('  ') ? line.slice(2) : line.trimEnd()).join('\n').trim();
}

/** Delivered native peer content only; copied human text and enqueue records are not delivery evidence. */
export function readClaudeNativePeerMessage(value: unknown): ClaudeNativePeerMessage | null {
  if (!isRecord(value)) return null;
  const attachment = value.type === 'attachment' && isRecord(value.attachment)
    && value.attachment.type === 'queued_command' ? value.attachment : null;
  const origin = isRecord(value.origin) ? value.origin
    : attachment && isRecord(attachment.origin) ? attachment.origin : null;
  if (attachment && origin && origin.kind !== 'peer') return null;
  const nativePeer = origin?.kind === 'peer' ? origin : null;
  const peerUser = value.type === 'user' && nativePeer !== null;
  if (!attachment && !peerUser) return null;
  const content = peerUser && isRecord(value.message) ? value.message.content : null;
  const text = attachment && typeof attachment.prompt === 'string' ? attachment.prompt
    : typeof content === 'string' ? content
    : Array.isArray(content) && content.length > 0
      && content.every((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
      ? content.map((part) => part.text).join('\n') : null;
  if (text === null) return null;
  const crossSession = CROSS_SESSION_WRAPPER.exec(text);
  const crossSessionAttributes = crossSession ? readTagAttributes(crossSession[1]) : null;
  const agentMessage = !crossSession && nativePeer ? AGENT_MESSAGE_WRAPPER.exec(text) : null;
  const wrapperFrom = crossSessionAttributes?.get('from') ?? (agentMessage ? readTagAttributes(agentMessage[1]).get('from') : undefined);
  // A queued attachment proves delivery only for a native wrapper naming its sender.
  if (!peerUser && !readString(wrapperFrom)) return null;
  // Native peer origin carries the delivered body without its wrapper or harness guidance.
  const delivered = readString(nativePeer?.body) ?? crossSession?.[2] ?? agentMessage?.[2] ?? text;
  const handback = nativePeer?.handback === true;
  const name = readString(nativePeer?.name) ?? readString(crossSessionAttributes?.get('from-name')) ?? null;
  return {
    text: handback && nativePeer ? readHandbackReport(nativePeer, delivered) : delivered,
    // A sender the transcript contract cannot carry is dropped; the delivered text still lands.
    peer: readTranscriptPeerSenderV1({ name, handback }) ?? { name: null, handback },
  };
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

/** Keep native result metadata with its report for every conversation codec. */
export function withClaudeNativeToolResultMetadata(content: unknown, row: unknown): unknown {
  // Image blocks have the same unsupported-image meaning inside tool results
  // as at the message level. Their bytes (also duplicated by native Read
  // metadata) are not display text and cannot enter a bounded transcript page.
  const projectedContent = Array.isArray(content)
    ? content.map(part => isRecord(part) && part.type === 'image' ? { type: 'image' } : part)
    : content;
  if (!isRecord(row)) return projectedContent;
  const metadata = row.toolUseResult ?? row.tool_use_result;
  let projectedMetadata = metadata;
  if (isRecord(metadata) && metadata.type === 'image' && isRecord(metadata.file)) {
    const { base64: _imageBytes, ...file } = metadata.file;
    projectedMetadata = { ...metadata, file };
  }
  return metadata === undefined ? projectedContent : { content: projectedContent, tool_use_result: projectedMetadata };
}

function readMessageContentParts(value: unknown, row: RawJSONLines): readonly ClaudeNativeTranscriptContentPart[] {
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
      const text = typeof valuePart.thinking === 'string' ? valuePart.thinking : null;
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
            output: withClaudeNativeToolResultMetadata(valuePart.content ?? '', row),
            ...(typeof valuePart.is_error === 'boolean' ? { isError: valuePart.is_error } : {}),
          });
      if (Array.isArray(valuePart.content) && valuePart.content.some(part => isRecord(part) && part.type === 'image')) {
        parts.push({ kind: 'unsupported', source: 'image' });
      }
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
    // deliberately hides. Everything else stays unsupported so the shared
    // projection publishes a visible fallback and safe diagnostic.
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

  const peerMessage = readClaudeNativePeerMessage(rawObject);
  const peerRow = peerMessage === null ? null : parseRawJsonLinesObject(rawObject);
  if (peerMessage !== null && peerRow) {
    return {
      ...createBaseClassification({ rawObject, rawType, row: peerRow, visibility: 'visible',
        messageRole: 'agent', content: { kind: 'peer_message', text: peerMessage.text, peer: peerMessage.peer } }),
      knownNonTranscriptRecord: false,
    };
  }

  if (isClaudeInternalEventType(rawType)) {
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
  const systemContent = row.content;
  // Claude Code 2.1.316 emits these native informational notices after applying
  // compaction. Only this characterized envelope gives idle meaning to its text.
  if (row.type === 'system' && row.subtype === 'informational' && row.level === 'notice'
    && typeof systemContent === 'string' && [
      'Compacted while idle, before the prompt cache expired',
      'Compacted using a summary written while you were away',
    ].some(prefix => systemContent === prefix || systemContent.startsWith(`${prefix} `))) {
    return {
      ...createBaseClassification({ rawObject, rawType, row, visibility: 'hidden',
        messageRole: 'event', content: { kind: 'none' } }),
      knownNonTranscriptRecord: true,
      lifecycle: { kind: 'idle_compaction_notice' },
    };
  }
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

  if (row.isMeta === true && isClaudeLocalCommandCaveatTranscriptMessage(row)) {
    return {
      ...createBaseClassification({ rawObject, rawType, row, visibility: 'hidden', messageRole: 'event', content: { kind: 'none' } }),
      lifecycle: { kind: 'local_command_caveat' },
    };
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
    semanticParts: readMessageContentParts(readMessageRecord(row)?.content, row),
  });

  if (row.type === 'system' && readString((row as Record<string, unknown>).subtype) === 'compact_boundary') {
    return {
      ...base,
      lifecycle: { kind: 'compact_boundary', ...readClaudeCompactionMetadata(row) },
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
    // Claude JSONL can split a message into content-block rows that each carry
    // its stop_reason. A thinking block can precede the final text row.
    const thinkingOnly = base.semanticParts.length > 0
      && base.semanticParts.every(part => part.kind === 'thinking');
    if (stopReason && !thinkingOnly) {
      return {
        ...base,
        lifecycle: { kind: 'assistant_stop', stopReason },
        nativeBoundary: { kind: 'assistant_stop', id: readNativeBoundaryId(row) },
      };
    }
    return base;
  }

  if (row.type !== 'user' || (isRecord(rawObject) && isRecord(rawObject.origin) && rawObject.origin.kind === 'peer')) return base;
  const text = readTextContentParts(readMessageRecord(row)?.content);
  if (!text) return base;
  if (row.isMeta === true) {
    return text.startsWith(STOP_HOOK_FEEDBACK_PREFIX)
      ? { ...base, lifecycle: { kind: 'stop_hook_feedback' } }
      : base;
  }
  // Claude Code 2.1.302: bash input retains the bytes after the leading `!`.
  // Display and lifecycle correlation share the same logical shell command.
  const shellInput = /^<bash-input>([\s\S]*)<\/bash-input>$/u.exec(text.trim());
  if (shellInput) {
    const commandText = `!${shellInput[1]}`;
    return {
      ...base,
      content: { kind: 'message', text: commandText },
      semanticParts: [{ kind: 'text', text: commandText }],
      lifecycle: { kind: 'shell_input', text: commandText },
    };
  }
  if (/^<bash-(?:stdout|stderr)>/u.test(text.trim())) {
    // Bash output carries literal stream bytes, unlike slash-command output's
    // XML-escaped presentation text. Preserve whitespace and entities verbatim.
    const combinedOutput = /^<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>$/u.exec(text.trim());
    const singleOutput = /^<bash-(stdout|stderr)>([\s\S]*)<\/bash-\1>$/u.exec(text.trim());
    const outputText = combinedOutput
      ? `${combinedOutput[1] ?? ''}${combinedOutput[2] ?? ''}`
      : singleOutput?.[2] ?? text;
    return {
      ...base,
      messageRole: 'agent',
      content: { kind: 'message', text: outputText },
      semanticParts: outputText.length > 0 ? [{ kind: 'text', text: outputText }] : [],
      lifecycle: { kind: 'shell_output' },
    };
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
  const providerSessionId = readClaudeProviderIdentityValue(params.payload.providerSessionId)
    ?? readClaudeProviderIdentityValue(params.payload.provider_session_id)
    ?? readClaudeTranscriptProviderSessionId(params.nestedPayload)
    ?? readClaudeProviderIdentityValue(params.payload.sessionId)
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
