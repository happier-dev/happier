import type { DirectTranscriptRawMessageV1, SessionMessageRole } from '@happier-dev/protocol';

import { buildSessionPath, type PiSessionEntry } from './piEntryContext';

/**
 * Map a parsed pi session (full entry list) into direct-transcript items, resolving the active
 * active branch and projecting its historical entries. Compaction changes the model's runtime
 * context, but it does not delete older records from the user-visible session history.
 */
export function mapPiSessionToDirectMessages(params: Readonly<{
  entries: readonly PiSessionEntry[];
  fileRelPath: string;
  leafId?: string | null;
}>): DirectTranscriptRawMessageV1[] {
  const contextEntries = buildSessionPath(params.entries, params.leafId);
  const items: DirectTranscriptRawMessageV1[] = [];

  for (const entry of contextEntries) {
    const piRole = readPiEntryRole(entry);
    const message = projectPiEntryToMessage(entry);
    if (!message) continue;

    const id = `pi:${params.fileRelPath}:${entry.id}`;

    items.push({
      id,
      localId: id,
      createdAtMs: resolvePiEntryTimestampMs(entry),
      messageRole: resolvePiMessageRole(piRole),
      raw: message,
    });
  }

  return items;
}

/**
 * Port of pi's `sessionEntryToContextMessages`, projected into the protocol transcript envelope
 * (`role: 'agent' | 'user'`, mirroring the Claude direct-session mapper) so the UI's
 * `TranscriptRawRecordV1` schema accepts every emitted record. Message entries with
 * null/missing content are normalized to an empty content array, matching pi's defensive
 * parsing. Non-assistant pi roles (user-with-blocks, toolResult, bashExecution) ride `user`
 * rows, the claude convention for non-assistant content.
 */
function projectPiEntryToMessage(entry: PiSessionEntry): Record<string, unknown> | null {
  if (entry.type === 'message') {
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const msg = message as Record<string, unknown> & { content?: unknown };
    const content = msg.content == null ? [] : msg.content;
    if (msg.role === 'user') {
      const text = typeof content === 'string' ? content : joinPiTextBlocks(content);
      // The semantic transcript classifier only recognizes user prompts as protocol
      // user text records (role:'user' + content.type:'text'); real pi sessions store
      // user prompts as content block arrays, so join their text blocks. User messages
      // without text blocks fall through to the agent-output 'user' row (attachment /
      // tool convention) instead of being dropped.
      if (text !== null) {
        return { role: 'user', content: { type: 'text', text } };
      }
    }
    if (msg.role === 'assistant') {
      return {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'assistant',
            message: {
              role: 'assistant',
              ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
              ...(msg.usage && typeof msg.usage === 'object' ? { usage: msg.usage } : {}),
              content: normalizePiAssistantContentBlocks(content),
            },
          },
        },
      };
    }
    if (msg.role === 'toolResult') {
      // The UI transcript normalizer renders Claude-convention tool_result blocks; pi stores
      // standalone toolResult messages, so project the whole message as one tool_result block.
      return {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'user',
            message: {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: typeof (msg as { toolCallId?: unknown }).toolCallId === 'string'
                  ? (msg as { toolCallId: string }).toolCallId
                  : '',
                content,
                is_error: (msg as { isError?: unknown }).isError === true,
              }],
            },
          },
        },
      };
    }
    return {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'user',
          message: {
            role: 'user',
            ...(typeof (msg as { toolCallId?: unknown }).toolCallId === 'string'
              ? { toolCallId: (msg as { toolCallId: string }).toolCallId }
              : {}),
            content,
          },
        },
      },
    };
  }
  if (entry.type === 'custom_message') {
    return {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'piCustomMessage',
          customType: (entry as { customType?: unknown }).customType,
          content: (entry as { content?: unknown }).content ?? [],
          display: (entry as { display?: unknown }).display,
          details: (entry as { details?: unknown }).details,
        },
      },
    };
  }
  if (entry.type === 'branch_summary') {
    const summary = (entry as { summary?: unknown }).summary;
    if (!summary) return null;
    return {
      role: 'agent',
      content: { type: 'output', data: { type: 'summary', summary: String(summary) } },
    };
  }
  if (entry.type === 'compaction') {
    return {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'summary',
          summary: String((entry as { summary?: unknown }).summary ?? ''),
          tokensBefore: (entry as { tokensBefore?: unknown }).tokensBefore,
        },
      },
    };
  }
  return null;
}

/**
 * Normalize pi assistant content blocks to the Claude transcript convention the UI renders:
 * `{ type: 'toolCall', id, name, arguments }` -> `{ type: 'tool_use', id, name, input }`.
 * All other block shapes (text, thinking, …) pass through unchanged.
 */
function normalizePiAssistantContentBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const record = block as Record<string, unknown>;
    if (record.type !== 'toolCall') return block;
    return {
      type: 'tool_use',
      id: record.id,
      name: record.name,
      input: record.arguments,
    };
  });
}

/**
 * Join the `{ type: 'text' }` blocks of a pi content block array into one string.
 * Returns null for non-arrays and for arrays without any non-empty text blocks.
 */
function joinPiTextBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'text' || typeof record.text !== 'string') continue;
    if (record.text.length > 0) parts.push(record.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function readPiEntryRole(entry: PiSessionEntry): string | undefined {
  if (entry.type === 'message') {
    const role = (entry as { message?: { role?: unknown } }).message?.role;
    return typeof role === 'string' ? role : undefined;
  }
  if (entry.type === 'custom_message') return 'custom';
  if (entry.type === 'branch_summary') return 'branchSummary';
  if (entry.type === 'compaction') return 'compactionSummary';
  return undefined;
}

function resolvePiMessageRole(role: string | undefined): SessionMessageRole {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'agent';
  // toolResult, bashExecution, custom, custom_message-inferred, branchSummary, compactionSummary
  return 'event';
}

function resolvePiEntryTimestampMs(entry: PiSessionEntry): number {
  const fromEntry = timestampToMs(entry.timestamp);
  if (fromEntry > 0) return fromEntry;
  // The projected envelope carries no timestamp; fall back to the pi message's own
  // epoch field on the entry (entries that have neither resolve to 0, same as before).
  return timestampToMs(entry.message?.timestamp);
}

function timestampToMs(value: unknown): number {
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= 0) return Math.trunc(ms);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    // Heuristic: seconds vs milliseconds (same rule as the Claude mapper).
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  return 0;
}
