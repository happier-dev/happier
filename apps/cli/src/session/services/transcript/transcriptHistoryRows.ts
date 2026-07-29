import {
  hasCanonicalTurnDiffEvidence,
  isCanonicalTurnDiffPayload,
  readEmptyCanonicalTurnDiffToolCallId,
  type ConversationTurnOriginV1,
} from '@happier-dev/protocol';

import { decodeBase64, decrypt } from '@/api/encryption';
import { SessionMessageContentSchema } from '@/api/types';

import { decodeTranscriptBody } from './transcriptBodyDecoder';

export type CompactHistoryRow = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  role: string;
  kind: string;
  text: string;
  origin?: ConversationTurnOriginV1;
  structuredKind?: string;
}>;

export type RawHistoryRow = Readonly<{
  id: string;
  seq?: number;
  createdAt: number;
  role: string;
  raw: Record<string, unknown>;
}>;

export type NormalizedHistoryResult = Readonly<{
  sessionId: string;
  format: 'compact' | 'raw';
  messages: readonly unknown[];
}>;

export type NormalizeHistoryOptions = Readonly<{
  includeMeta: boolean;
  includeStructuredPayload: boolean;
}>;

export type TranscriptHistoryNormalizationSequenceState = Readonly<{
  suppressedEmptyCanonicalTurnDiffCallIds: Set<string>;
}>;

const MAX_SUPPRESSED_EMPTY_TURN_DIFF_CALL_IDS = 256;

export function createTranscriptHistoryNormalizationSequenceState(): TranscriptHistoryNormalizationSequenceState {
  return {
    suppressedEmptyCanonicalTurnDiffCallIds: new Set<string>(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringField(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = readNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function readTranscriptToolData(decrypted: unknown): Record<string, unknown> | null {
  const record = asRecord(decrypted);
  const content = asRecord(record?.content);
  if (!content || (content.type !== 'acp' && content.type !== 'codex')) return null;
  return asRecord(content.data);
}

function readToolResultCallIdAndOutput(decrypted: unknown): Readonly<{
  callId: string;
  output: unknown;
}> | null {
  const data = readTranscriptToolData(decrypted);
  if (data?.type !== 'tool-result' && data?.type !== 'tool-call-result') return null;
  const callId = readStringField(data, ['callId', 'call_id']);
  return callId ? { callId, output: data.output } : null;
}

function rememberSuppressedEmptyTurnDiffCallId(
  state: TranscriptHistoryNormalizationSequenceState,
  callId: string,
): void {
  const callIds = state.suppressedEmptyCanonicalTurnDiffCallIds;
  callIds.add(callId);
  while (callIds.size > MAX_SUPPRESSED_EMPTY_TURN_DIFF_CALL_IDS) {
    const oldest = callIds.values().next().value;
    if (typeof oldest !== 'string') break;
    callIds.delete(oldest);
  }
}

export function shouldSuppressTranscriptItemForEmptyCanonicalTurnDiff(
  decrypted: unknown,
  state: TranscriptHistoryNormalizationSequenceState,
): boolean {
  const emptyCallId = readEmptyCanonicalTurnDiffToolCallId(decrypted);
  if (emptyCallId) {
    rememberSuppressedEmptyTurnDiffCallId(state, emptyCallId);
    return true;
  }

  const result = readToolResultCallIdAndOutput(decrypted);
  if (!result) {
    return false;
  }
  if (isCanonicalTurnDiffPayload(result.output)) {
    return !hasCanonicalTurnDiffEvidence(result.output);
  }
  if (!state.suppressedEmptyCanonicalTurnDiffCallIds.has(result.callId)) {
    return false;
  }

  state.suppressedEmptyCanonicalTurnDiffCallIds.delete(result.callId);
  return !hasCanonicalTurnDiffEvidence(result.output);
}

export function isMemoryArtifactDecryptedRow(value: unknown): boolean {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!obj) return false;
  const meta = obj.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return false;
  const kind = (happier as Record<string, unknown>).kind;
  return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

export function tryResolveDecryptedTranscriptPayload(params: Readonly<{
  content: unknown;
  ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
}>): unknown | null {
  const parsed = SessionMessageContentSchema.safeParse(params.content);
  if (!parsed.success) return null;
  if (parsed.data.t === 'plain') return parsed.data.v;
  try {
    return decrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, decodeBase64(parsed.data.c, 'base64'));
  } catch {
    return null;
  }
}

export function extractCompactRow(params: Readonly<{
  decrypted: unknown;
  seq?: number;
  createdAt: number;
  fallbackId: string;
}>): CompactHistoryRow | null {
  const obj = params.decrypted && typeof params.decrypted === 'object' && !Array.isArray(params.decrypted) ? (params.decrypted as any) : null;
  const role = typeof obj?.role === 'string' ? String(obj.role) : 'unknown';
  const happierKind = typeof obj?.meta?.happier?.kind === 'string' ? String(obj.meta.happier.kind) : undefined;

  const body = obj?.content;
  const kind = typeof body?.type === 'string' ? String(body.type) : 'unknown';
  const text = decodeTranscriptBody(params.decrypted)?.text ?? '';

  return {
    id: params.fallbackId,
    ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
    createdAt: params.createdAt,
    role,
    kind,
    text,
    ...(happierKind ? { structuredKind: happierKind } : {}),
  };
}

export function extractRawRow(params: Readonly<{
  decrypted: unknown;
  seq?: number;
  createdAt: number;
  fallbackId: string;
  includeMeta: boolean;
  includeStructuredPayload: boolean;
}>): RawHistoryRow | null {
  const obj = params.decrypted && typeof params.decrypted === 'object' && !Array.isArray(params.decrypted) ? (params.decrypted as any) : null;
  if (!obj) return null;
  const role = typeof obj.role === 'string' ? String(obj.role) : 'unknown';

  const raw: Record<string, unknown> = {};
  if (typeof obj.role === 'string') raw.role = obj.role;
  if (obj.content !== undefined) raw.content = obj.content;

  if (params.includeMeta) {
    const meta = obj.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const metaOut: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
      if (!params.includeStructuredPayload) {
        const happier = metaOut.happier;
        if (happier && typeof happier === 'object' && !Array.isArray(happier) && 'payload' in happier) {
          delete (happier as Record<string, unknown>).payload;
        }
      }
      raw.meta = metaOut;
    }
  }

  return {
    id: params.fallbackId,
    ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
    createdAt: params.createdAt,
    role,
    raw,
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readRowCreatedAt(row: Record<string, unknown>): number {
  return typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0;
}

function readRowSeq(row: Record<string, unknown>): number | undefined {
  return typeof row.seq === 'number' && Number.isFinite(row.seq) ? Math.trunc(row.seq) : undefined;
}

function readRowId(row: Record<string, unknown>): string {
  return typeof row.id === 'string' ? row.id : '';
}

function applySemanticCompactFallback(
  row: Record<string, unknown>,
  compactRow: ReturnType<typeof extractCompactRow>,
): ReturnType<typeof extractCompactRow> {
  if (!compactRow || compactRow.text.trim().length > 0) return compactRow;

  const semanticText = readNonEmptyString(row.text) ?? readNonEmptyString(row.summary);

  return {
    ...compactRow,
    role: readNonEmptyString(row.role) ?? readNonEmptyString(row.semanticRole) ?? compactRow.role,
    kind: readNonEmptyString(row.kind) ?? compactRow.kind,
    ...(semanticText ? { text: semanticText } : {}),
  };
}

function normalizeHistoryItem(
  item: unknown,
  format: 'compact' | 'raw',
  options: NormalizeHistoryOptions,
  sequenceState: TranscriptHistoryNormalizationSequenceState,
): unknown | null {
  const row = readObject(item) ?? {};
  if ('raw' in row) {
    if (shouldSuppressTranscriptItemForEmptyCanonicalTurnDiff(row.raw, sequenceState)) {
      return null;
    }

    if (format === 'raw') {
      const rawRow = extractRawRow({
        decrypted: row.raw,
        seq: readRowSeq(row),
        createdAt: readRowCreatedAt(row),
        fallbackId: readRowId(row),
        includeMeta: options.includeMeta,
        includeStructuredPayload: options.includeStructuredPayload,
      });
      if (rawRow) return rawRow;
    } else {
      const compactRow = extractCompactRow({
        decrypted: row.raw,
        seq: readRowSeq(row),
        createdAt: readRowCreatedAt(row),
        fallbackId: readRowId(row),
      });
      if (compactRow) return applySemanticCompactFallback(row, compactRow);
    }
  }

  const role = typeof row.storedMessageRole === 'string'
    ? row.storedMessageRole
    : typeof row.role === 'string'
      ? row.role
      : row.semanticRole;
  if (format === 'raw') {
    const raw = readObject(row.raw) ?? { value: row.raw };
    return {
      id: row.id,
      ...(typeof row.seq === 'number' && Number.isFinite(row.seq) ? { seq: Math.trunc(row.seq) } : {}),
      createdAt: row.createdAt,
      role,
      raw,
    };
  }
  return {
    id: row.id,
    ...(typeof row.seq === 'number' && Number.isFinite(row.seq) ? { seq: Math.trunc(row.seq) } : {}),
    createdAt: row.createdAt,
    role,
    kind: row.kind,
    text: row.text ?? row.summary ?? '',
  };
}

export function normalizeTranscriptHistoryResult(
  value: unknown,
  format: 'compact' | 'raw',
  options: NormalizeHistoryOptions,
): NormalizedHistoryResult {
  const result = readObject(value);
  const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : '';
  const resultFormat = result?.format === 'raw' || result?.format === 'compact' ? result.format : format;
  if (Array.isArray(result?.messages)) {
    return { sessionId, format: resultFormat, messages: result.messages };
  }

  const sequenceState = createTranscriptHistoryNormalizationSequenceState();
  const items = Array.isArray(result?.items) ? result.items : [];
  const messages = items.flatMap((item) => {
    const normalized = normalizeHistoryItem(item, resultFormat, options, sequenceState);
    return normalized === null ? [] : [normalized];
  });
  return { sessionId, format: resultFormat, messages };
}
