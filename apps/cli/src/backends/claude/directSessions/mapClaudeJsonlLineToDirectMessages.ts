import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { normalizeClaudeToolUseNamesInRawJsonLines } from '@/backends/claude/utils/normalizeClaudeToolUseNames';
import { parseRawJsonLinesObject } from '@/backends/claude/utils/parseRawJsonLines';

function extractEnvelopeTimestampMs(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const candidates = [
    (value as any).timestamp,
    (value as any).createdAt,
    (value as any).created_at,
    (value as any).time,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      const ms = Date.parse(candidate);
      if (Number.isFinite(ms) && ms >= 0) return Math.trunc(ms);
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      const num = Math.trunc(candidate);
      // Heuristic: treat seconds timestamps as < ~2001 in ms.
      return num < 1_000_000_000_000 ? num * 1000 : num;
    }
  }
  return 0;
}

function stableOffsetId(prefix: string, offset: number): string {
  const padded = Math.max(0, Math.trunc(offset)).toString().padStart(12, '0');
  return `${prefix}:${padded}`;
}

function ensureClaudeOutputMessageRole(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const typedValue = value as Record<string, unknown>;
  if (typedValue.type !== 'assistant' && typedValue.type !== 'user') return value;
  const message = typedValue.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return value;
  const typedMessage = message as Record<string, unknown>;
  if (typeof typedMessage.role === 'string' && typedMessage.role.trim().length > 0) {
    return value;
  }
  return {
    ...typedValue,
    message: {
      ...typedMessage,
      role: typedValue.type,
    },
  };
}

export function mapClaudeJsonlLineToDirectMessages(params: Readonly<{
  fileRelPath: string;
  lineStartOffsetBytes: number;
  lineValue: unknown;
}>): DirectTranscriptRawMessageV1[] {
  const createdAtMs = extractEnvelopeTimestampMs(params.lineValue);
  const idPrefix = `claude:${params.fileRelPath}`;
  const stableId = stableOffsetId(idPrefix, params.lineStartOffsetBytes);

  const rawObject = (() => {
    const value = params.lineValue;
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
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    return null;
  })();

  const rawType = (() => {
    if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) return null;
    const tag = (rawObject as any).type;
    return typeof tag === 'string' ? tag : null;
  })();

  // Drop noisy internal/non-transcript events before schema validation so we don't surface them as opaque schema mismatches.
  if (rawType && rawType !== 'user' && rawType !== 'assistant') {
    return [];
  }

  const parsed = parseRawJsonLinesObject(rawObject);
  if (!parsed) {
    return [
      {
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: {
            type: 'output',
            data: {
              type: 'opaque',
              reason: 'schema_mismatch',
              source: {
                fileRelPath: params.fileRelPath,
                lineStartOffsetBytes: params.lineStartOffsetBytes,
              },
              original: rawObject ?? params.lineValue,
            },
          },
        },
      },
    ];
  }

  const normalized = normalizeClaudeToolUseNamesInRawJsonLines(parsed);
  const normalizedForOutput = ensureClaudeOutputMessageRole(normalized);

  if (
    normalized.type === 'user' &&
    typeof (normalized as any).message?.content === 'string' &&
    (normalized as any).isSidechain !== true &&
    (normalized as any).isMeta !== true
  ) {
    return [
      {
        id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'user',
          content: { type: 'text', text: String((normalized as any).message.content) },
        },
      },
    ];
  }

  return [
    {
      id: stableId,
        localId: stableId,
        createdAtMs,
        raw: {
          role: 'agent',
          content: { type: 'output', data: normalizedForOutput },
        },
      },
  ];
}
