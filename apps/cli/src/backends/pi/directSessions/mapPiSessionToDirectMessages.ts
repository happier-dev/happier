import type { DirectTranscriptRawMessageV1, SessionMessageRole } from '@happier-dev/protocol';

import { resolveAcpSessionMessageRole } from '@/api/session/messageRole/resolveAcpSessionMessageRole';

import { buildSessionPath, type PiSessionEntry } from './piEntryContext';

type ProjectedPiRow = Readonly<{
  idSuffix?: string;
  messageRole: SessionMessageRole;
  raw: Record<string, unknown>;
}>;

/**
 * Map a parsed pi session into the active branch's direct-transcript rows. A durable
 * Pi entry may project to more than one row (notably a shell execution's call/result).
 * Compaction changes runtime context but never removes older user-visible history.
 */
export function mapPiSessionToDirectMessages(params: Readonly<{
  entries: readonly PiSessionEntry[];
  fileRelPath: string;
  leafId?: string | null;
}>): DirectTranscriptRawMessageV1[] {
  const contextEntries = buildSessionPath(params.entries, params.leafId);
  const items: DirectTranscriptRawMessageV1[] = [];

  for (const entry of contextEntries) {
    const baseId = `pi:${params.fileRelPath}:${entry.id}`;
    const rows = projectPiEntryToRows(entry, baseId);
    for (const row of rows) {
      const id = row.idSuffix ? `${baseId}:${row.idSuffix}` : baseId;
      items.push({
        id,
        localId: id,
        createdAtMs: resolvePiEntryTimestampMs(entry),
        messageRole: row.messageRole,
        raw: row.raw,
      });
    }
  }

  return items;
}

function projectPiEntryToRows(entry: PiSessionEntry, baseId: string): readonly ProjectedPiRow[] {
  if (entry.type === 'message') {
    const message = (entry as { message?: unknown }).message;
    if (!isRecord(message)) return [];
    return projectPiMessageRows(message, baseId);
  }

  if (entry.type === 'custom_message') {
    const record = entry as { content?: unknown; display?: unknown };
    if (record.display === false) return [];
    const text = projectPiUserContentText(record.content);
    return text === null ? [] : [{
      messageRole: 'user',
      raw: { role: 'user', content: { type: 'text', text } },
    }];
  }

  if (entry.type === 'branch_summary') {
    const summary = readNonEmptyString((entry as { summary?: unknown }).summary);
    return summary ? [acpRow({ type: 'message', message: summary })] : [];
  }

  if (entry.type === 'compaction') {
    const tokensBefore = readFiniteNumber((entry as { tokensBefore?: unknown }).tokensBefore);
    return [{
      messageRole: 'event',
      raw: {
        role: 'agent',
        content: {
          type: 'event',
          id: baseId,
          data: {
            type: 'context-compaction',
            phase: 'completed',
            lifecycleId: baseId,
            provider: 'pi',
            source: 'runtime',
            trigger: 'unknown',
            ...(tokensBefore === null ? {} : { tokenCountBefore: tokensBefore }),
          },
        },
      },
    }];
  }

  return [];
}

function projectPiMessageRows(message: Record<string, unknown>, baseId: string): readonly ProjectedPiRow[] {
  const content = message.content;

  if (message.role === 'user') {
    const text = projectPiUserContentText(content);
    return text === null ? [] : [{
      messageRole: 'user',
      raw: { role: 'user', content: { type: 'text', text } },
    }];
  }

  if (message.role === 'assistant') {
    const normalized = normalizePiAssistantContentBlocks(content);
    if (isEmptyPiAssistantContent(normalized)) return [];
    return [{
      messageRole: 'agent',
      raw: {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'assistant',
            message: {
              role: 'assistant',
              ...(typeof message.model === 'string' ? { model: message.model } : {}),
              ...(isRecord(message.usage) ? { usage: message.usage } : {}),
              content: normalized,
            },
          },
        },
      },
    }];
  }

  if (message.role === 'toolResult') {
    return [{
      messageRole: 'event',
      raw: {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'user',
            message: {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
                content: sanitizePiToolResultContent(content),
                is_error: message.isError === true,
              }],
            },
          },
        },
      },
    }];
  }

  if (message.role === 'bashExecution') {
    const command = readNonEmptyString(message.command);
    const output = typeof message.output === 'string' ? message.output : '';
    const exitCode = readFiniteNumber(message.exitCode);
    if (!command) return [];
    const cancelled = message.cancelled === true;
    const truncated = message.truncated === true;
    return [
      acpRow({
        type: 'tool-call', callId: baseId, name: 'bash', id: `${baseId}:bash-call`, input: { command },
      }, 'bash-call'),
      acpRow({
        type: 'tool-result', callId: baseId, id: `${baseId}:bash-result`,
        output: { output, exitCode, cancelled, truncated },
        isError: cancelled || (exitCode !== null && exitCode !== 0),
      }, 'bash-result'),
    ];
  }

  return [];
}

function acpRow(data: Record<string, unknown>, idSuffix?: string): ProjectedPiRow {
  return {
    ...(idSuffix ? { idSuffix } : {}),
    messageRole: resolveAcpSessionMessageRole(data),
    raw: { role: 'agent', content: { type: 'acp', provider: 'pi', data } },
  };
}

/** Pi direct transcripts are text-only today; retain image position/type, never inline bytes. */
function projectPiUserContentText(content: unknown): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  let previousWasText = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      if (previousWasText) parts.push('\n');
      parts.push(block.text);
      previousWasText = true;
      continue;
    }
    if (block.type === 'image') {
      const mimeType = readNonEmptyString(block.mimeType) ?? 'unknown';
      parts.push(`\n[Pi image content (${mimeType})]\n`);
      previousWasText = false;
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function sanitizePiToolResultContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!isRecord(block) || block.type !== 'image') return block;
    const mimeType = readNonEmptyString(block.mimeType) ?? 'unknown';
    return { type: 'text', text: `[Pi tool result image (${mimeType})]` };
  });
}

/** Normalize Pi's tool-call spelling and discard empty signed/redacted display blocks. */
function normalizePiAssistantContentBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const normalized: unknown[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      normalized.push(block);
      continue;
    }
    if (block.type === 'text' && (typeof block.text !== 'string' || block.text.length === 0)) continue;
    if (block.type === 'thinking' && (typeof block.thinking !== 'string' || block.thinking.length === 0)) continue;
    if (block.type === 'toolCall') {
      normalized.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments });
      continue;
    }
    normalized.push(block);
  }
  return normalized;
}

function isEmptyPiAssistantContent(content: unknown): boolean {
  return content == null || content === '' || (Array.isArray(content) && content.length === 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolvePiEntryTimestampMs(entry: PiSessionEntry): number {
  const fromEntry = timestampToMs(entry.timestamp);
  return fromEntry > 0 ? fromEntry : timestampToMs(entry.message?.timestamp);
}

function timestampToMs(value: unknown): number {
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= 0) return Math.trunc(ms);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  return 0;
}
