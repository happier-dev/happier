import {
  asOpenCodeProjectionRecord,
  hasOpenCodeInternalFlag,
  normalizeOpenCodeProjectionLowerString,
  normalizeOpenCodeProjectionString,
  readOpenCodeBooleanLike,
  readOpenCodeNestedRecord,
  readOpenCodeTimestampMs,
} from './parsing.js';
import type {
  OpenCodeMessageProjection,
  OpenCodeTranscriptRole,
} from './types.js';

function readMessageInfo(messageOrInfo: unknown): Record<string, unknown> | null {
  const record = asOpenCodeProjectionRecord(messageOrInfo);
  if (!record) return null;
  return readOpenCodeNestedRecord(record, 'info') ?? record;
}

function normalizeRole(value: unknown): OpenCodeTranscriptRole | null {
  const role = normalizeOpenCodeProjectionLowerString(value);
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return null;
}

function readCreatedAtMs(info: Record<string, unknown> | null): number {
  if (!info) return 0;

  const directCreatedAtMs = readOpenCodeTimestampMs(info.createdAtMs, { allowSecondsNumber: false });
  if (directCreatedAtMs !== null) return directCreatedAtMs;

  const directCreatedAt = readOpenCodeTimestampMs(info.createdAt, { allowSecondsNumber: true });
  if (directCreatedAt !== null) return directCreatedAt;

  const directCreatedAtSnake = readOpenCodeTimestampMs(info.created_at, { allowSecondsNumber: true });
  if (directCreatedAtSnake !== null) return directCreatedAtSnake;

  const time = readOpenCodeNestedRecord(info, 'time');
  const timeCreated = readOpenCodeTimestampMs(time?.created, { allowSecondsNumber: true });
  if (timeCreated !== null) return timeCreated;

  const timeCompleted = readOpenCodeTimestampMs(time?.completed, { allowSecondsNumber: false });
  return timeCompleted ?? 0;
}

function isAssistantCompactionInternal(
  info: Record<string, unknown>,
  role: OpenCodeTranscriptRole | null,
): boolean {
  if (role !== 'assistant') return false;
  if (readOpenCodeBooleanLike(info.summary)) return true;

  const mode = normalizeOpenCodeProjectionLowerString(info.mode);
  const agent = normalizeOpenCodeProjectionLowerString(info.agent);
  return mode === 'compaction' && agent === 'compaction';
}

export function classifyOpenCodeMessageForProjection(messageOrInfo: unknown): OpenCodeMessageProjection {
  const info = readMessageInfo(messageOrInfo);
  const role = normalizeRole(info?.role);
  const messageId = normalizeOpenCodeProjectionString(info?.id).trim();
  const createdAtMs = readCreatedAtMs(info);

  if (!info || !role) {
    return { kind: 'unknown', role: null, messageId, createdAtMs, info };
  }

  if (isAssistantCompactionInternal(info, role)) {
    return { kind: 'compaction_internal', role, messageId, createdAtMs, info };
  }

  if (hasOpenCodeInternalFlag(info)) {
    return { kind: 'ignored_internal', role, messageId, createdAtMs, info };
  }

  return {
    kind: role === 'user' ? 'user_transcript' : 'assistant_transcript',
    role,
    messageId,
    createdAtMs,
    info,
  };
}
