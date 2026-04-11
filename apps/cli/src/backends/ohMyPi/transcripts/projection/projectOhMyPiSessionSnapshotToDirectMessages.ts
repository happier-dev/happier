import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

type SessionHeader = Readonly<{
  type: 'session';
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  title?: unknown;
}>;

type SessionEntry = Readonly<{
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: unknown;
  summary?: unknown;
}>;

type ProjectedSnapshot = Readonly<{
  items: readonly DirectTranscriptRawMessageV1[];
  title: string | null;
  workingDirectory: string | null;
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 0;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const truncated = Math.trunc(value);
    return truncated < 1_000_000_000_000 ? truncated * 1000 : truncated;
  }
  return 0;
}

function buildStableId(sessionFilePath: string, entryId: string, suffix?: string): string {
  return suffix
    ? `omp:${sessionFilePath}:${entryId}:${suffix}`
    : `omp:${sessionFilePath}:${entryId}`;
}

function projectSummaryMessage(params: Readonly<{
  sessionFilePath: string;
  entryId: string;
  createdAtMs: number;
  summary: string;
  compact: boolean;
}>): DirectTranscriptRawMessageV1 {
  return {
    id: buildStableId(params.sessionFilePath, params.entryId, params.compact ? 'compaction' : 'branch_summary'),
    localId: buildStableId(params.sessionFilePath, params.entryId, params.compact ? 'compaction' : 'branch_summary'),
    createdAtMs: params.createdAtMs,
    raw: {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'summary',
          summary: params.summary,
          ...(params.compact ? { isCompactSummary: true } : {}),
          uuid: params.entryId,
        },
      },
    },
  };
}

function projectUserMessage(params: Readonly<{
  sessionFilePath: string;
  entryId: string;
  createdAtMs: number;
  message: Record<string, unknown>;
}>): DirectTranscriptRawMessageV1[] {
  const content = params.message.content;
  if (typeof content === 'string') {
    return [{
      id: buildStableId(params.sessionFilePath, params.entryId),
      localId: buildStableId(params.sessionFilePath, params.entryId),
      createdAtMs: params.createdAtMs,
      raw: {
        role: 'user',
        content: {
          type: 'text',
          text: content,
        },
      },
    }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const text = content
    .map((item) => {
      const rec = asRecord(item);
      return rec?.type === 'text' && typeof rec.text === 'string' ? rec.text : '';
    })
    .filter((value) => value.length > 0)
    .join('');

  if (!text) return [];

  return [{
    id: buildStableId(params.sessionFilePath, params.entryId),
    localId: buildStableId(params.sessionFilePath, params.entryId),
    createdAtMs: params.createdAtMs,
    raw: {
      role: 'user',
      content: {
        type: 'text',
        text,
      },
    },
  }];
}

function projectAssistantMessage(params: Readonly<{
  sessionFilePath: string;
  entryId: string;
  createdAtMs: number;
  message: Record<string, unknown>;
}>): DirectTranscriptRawMessageV1[] {
  const content = params.message.content;
  const usage = asRecord(params.message.usage) ?? undefined;
  if (typeof content === 'string') {
    return [{
      id: buildStableId(params.sessionFilePath, params.entryId, 'text:0'),
      localId: buildStableId(params.sessionFilePath, params.entryId, 'text:0'),
      createdAtMs: params.createdAtMs,
      raw: {
        role: 'agent',
        content: {
          type: 'acp',
          provider: 'ohMyPi',
          data: {
            type: 'message',
            message: content,
            ...(usage ? { usage } : {}),
          },
        },
      },
    }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const out: DirectTranscriptRawMessageV1[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = asRecord(content[index]);
    if (!block) continue;
    const blockType = asString(block.type);
    if (!blockType) continue;
    const stableId = buildStableId(params.sessionFilePath, params.entryId, `${blockType}:${index}`);

    if (blockType === 'text' && typeof block.text === 'string') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs: params.createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'acp',
            provider: 'ohMyPi',
            data: {
              type: 'message',
              message: block.text,
              ...(usage ? { usage } : {}),
            },
          },
        },
      });
      continue;
    }

    if (blockType === 'thinking' && typeof block.thinking === 'string') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs: params.createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'acp',
            provider: 'ohMyPi',
            data: {
              type: 'thinking',
              text: block.thinking,
            },
          },
        },
      });
      continue;
    }

    if (blockType === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs: params.createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'acp',
            provider: 'ohMyPi',
            data: {
              type: 'tool-call',
              callId: block.id,
              id: stableId,
              name: block.name,
              input: block.input ?? {},
            },
          },
        },
      });
      continue;
    }

    if (blockType === 'tool_result' && typeof block.tool_use_id === 'string') {
      out.push({
        id: stableId,
        localId: stableId,
        createdAtMs: params.createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'acp',
            provider: 'ohMyPi',
            data: {
              type: 'tool-result',
              callId: block.tool_use_id,
              id: stableId,
              output: block.content ?? '',
              ...(typeof block.is_error === 'boolean' ? { isError: block.is_error } : {}),
            },
          },
        },
      });
    }
  }
  return out;
}

export function projectOhMyPiSessionSnapshotToDirectMessages(params: Readonly<{
  sessionFilePath: string;
  sessionId: string;
  lines: readonly unknown[];
}>): ProjectedSnapshot {
  const header = (asRecord(params.lines[0]) ?? null) as SessionHeader | null;
  const title = asString(header?.title) ?? null;
  const workingDirectory = asString(header?.cwd) ?? null;
  const createdAtMs = parseTimestampMs(header?.timestamp);

  const entries: SessionEntry[] = params.lines
    .slice(1)
    .map((line) => (asRecord(line) ?? {}) as SessionEntry)
    .filter((line) => typeof line.type === 'string' && typeof line.id === 'string');
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    byId.set(String(entry.id), entry);
  }

  const leaf = entries.at(-1) ?? null;
  const visibleEntries: SessionEntry[] = [];
  const seen = new Set<string>();
  let cursor = leaf;
  while (cursor && typeof cursor.id === 'string' && !seen.has(cursor.id)) {
    visibleEntries.push(cursor);
    seen.add(cursor.id);
    const parentId = asString(cursor.parentId);
    cursor = parentId ? byId.get(parentId) ?? null : null;
  }
  visibleEntries.reverse();

  const items: DirectTranscriptRawMessageV1[] = [];
  let lastActivityAtMs = parseTimestampMs(header?.timestamp);
  for (const entry of visibleEntries) {
    const entryId = String(entry.id);
    const createdAtMs = parseTimestampMs(entry.timestamp);
    if (createdAtMs > lastActivityAtMs) {
      lastActivityAtMs = createdAtMs;
    }

    if (entry.type === 'message') {
      const message = asRecord(entry.message);
      const role = asString(message?.role);
      if (!message || !role) continue;
      if (role === 'user') {
        items.push(...projectUserMessage({
          sessionFilePath: params.sessionFilePath,
          entryId,
          createdAtMs,
          message,
        }));
        continue;
      }
      if (role === 'assistant') {
        items.push(...projectAssistantMessage({
          sessionFilePath: params.sessionFilePath,
          entryId,
          createdAtMs,
          message,
        }));
      }
      continue;
    }

    if (entry.type === 'compaction' && typeof entry.summary === 'string') {
      items.push(projectSummaryMessage({
        sessionFilePath: params.sessionFilePath,
        entryId,
        createdAtMs,
        summary: entry.summary,
        compact: true,
      }));
      continue;
    }

    if (entry.type === 'branch_summary' && typeof entry.summary === 'string') {
      items.push(projectSummaryMessage({
        sessionFilePath: params.sessionFilePath,
        entryId,
        createdAtMs,
        summary: entry.summary,
        compact: false,
      }));
    }
  }

  return {
    items,
    title,
    workingDirectory,
    createdAtMs: createdAtMs > 0 ? createdAtMs : null,
    lastActivityAtMs: lastActivityAtMs > 0 ? lastActivityAtMs : null,
  };
}
