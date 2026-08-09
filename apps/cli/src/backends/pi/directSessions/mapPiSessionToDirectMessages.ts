import type { DirectTranscriptRawMessageV1, SessionMessageRole } from '@happier-dev/protocol';

import { buildContextEntries, type PiSessionEntry } from './piEntryContext';

/**
 * Map a parsed pi session (full entry list) into direct-transcript items, resolving the active
 * branch via `buildContextEntries` and projecting each context entry the same way pi's own
 * `sessionEntryToContextMessages` does. Unlike the Claude line-by-line mapper, pi needs the whole
 * file because the active branch is a tree walk, not a linear scan.
 */
export function mapPiSessionToDirectMessages(params: Readonly<{
  entries: readonly PiSessionEntry[];
  fileRelPath: string;
  leafId?: string | null;
}>): DirectTranscriptRawMessageV1[] {
  const contextEntries = buildContextEntries(params.entries, params.leafId);
  const items: DirectTranscriptRawMessageV1[] = [];

  for (const entry of contextEntries) {
    const message = projectPiEntryToMessage(entry);
    if (!message) continue;

    const role = typeof (message as { role?: unknown }).role === 'string'
      ? ((message as { role: string }).role)
      : undefined;
    const id = `pi:${params.fileRelPath}:${entry.id}`;

    items.push({
      id,
      localId: id,
      createdAtMs: resolvePiEntryTimestampMs(entry, message),
      messageRole: resolvePiMessageRole(role),
      raw: message,
    });
  }

  return items;
}

/**
 * Port of pi's `sessionEntryToContextMessages`: project one selected entry into its pi AgentMessage
 * form, or `null` when the entry does not participate in LLM context (model_change,
 * thinking_level_change, label, plain custom). Message entries with null/missing content are
 * normalized to an empty content array, matching pi's defensive parsing.
 */
function projectPiEntryToMessage(entry: PiSessionEntry): Record<string, unknown> | null {
  if (entry.type === 'message') {
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const msg = message as Record<string, unknown> & { content?: unknown };
    if (msg.content == null) {
      return { ...msg, content: [] };
    }
    return { ...msg };
  }
  if (entry.type === 'custom_message') {
    return {
      role: 'custom',
      customType: (entry as { customType?: unknown }).customType,
      content: (entry as { content?: unknown }).content ?? [],
      display: (entry as { display?: unknown }).display,
      details: (entry as { details?: unknown }).details,
      timestamp: entry.timestamp,
    };
  }
  if (entry.type === 'branch_summary') {
    const summary = (entry as { summary?: unknown }).summary;
    if (!summary) return null;
    return {
      role: 'branchSummary',
      summary,
      fromId: (entry as { fromId?: unknown }).fromId,
      timestamp: entry.timestamp,
    };
  }
  if (entry.type === 'compaction') {
    return {
      role: 'compactionSummary',
      summary: (entry as { summary?: unknown }).summary,
      tokensBefore: (entry as { tokensBefore?: unknown }).tokensBefore,
      timestamp: entry.timestamp,
    };
  }
  return null;
}

function resolvePiMessageRole(role: string | undefined): SessionMessageRole {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'agent';
  // toolResult, bashExecution, custom, custom_message-inferred, branchSummary, compactionSummary
  return 'event';
}

function resolvePiEntryTimestampMs(entry: PiSessionEntry, message: Record<string, unknown>): number {
  const fromEntry = timestampToMs(entry.timestamp);
  if (fromEntry > 0) return fromEntry;
  return timestampToMs(message.timestamp);
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
