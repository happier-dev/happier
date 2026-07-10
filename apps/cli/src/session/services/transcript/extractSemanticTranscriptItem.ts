import {
  type TranscriptHistoryNormalizationSequenceState,
  isMemoryArtifactDecryptedRow,
  shouldSuppressTranscriptItemForEmptyCanonicalTurnDiff,
  tryResolveDecryptedTranscriptPayload,
} from './transcriptHistoryRows';
import type {
  SemanticTranscriptItem,
  StoredTranscriptRole,
  TranscriptMode,
  TranscriptRawRow,
} from './semanticTranscriptItem';
import { decodeTranscriptBody, type DecodedTranscriptBody } from './transcriptBodyDecoder';

type ExtractionOptions = Readonly<{
  mode: TranscriptMode;
  transcriptRoles?: readonly ('user' | 'assistant')[];
  includeTools?: boolean;
  includeReasoning?: boolean;
  includeEvents?: boolean;
  includeRaw?: boolean;
  includeStructuredPayload?: boolean;
  maxTextChars?: number | null;
  maxPayloadChars?: number;
}>;

export type SemanticTranscriptExtraction = Readonly<{
  item: SemanticTranscriptItem | null;
  payloadBytes: number;
  payloadTruncated: boolean;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function truncateText(text: string, maxChars: number | null | undefined): Readonly<{ text: string; truncated: boolean }> {
  if (maxChars === null || maxChars === undefined) return { text, truncated: false };
  const max = Math.max(0, Math.floor(maxChars));
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

function normalizeStoredRole(value: unknown): StoredTranscriptRole | undefined {
  return value === 'user' || value === 'agent' || value === 'event' || value === 'unknown' ? value : undefined;
}

function normalizeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function shouldIncludeClassifiedPayload(classified: DecodedTranscriptBody, options: ExtractionOptions): boolean {
  if (options.mode === 'events') return classified.semanticRole !== 'user' && classified.semanticRole !== 'assistant';
  if (classified.semanticRole === 'user' || classified.semanticRole === 'assistant') {
    return (options.transcriptRoles ?? ['user', 'assistant']).includes(classified.semanticRole);
  }
  if (classified.semanticRole === 'tool') return options.includeTools === true;
  if (classified.semanticRole === 'reasoning') return options.includeReasoning === true;
  if (classified.semanticRole === 'event') return options.includeEvents === true;
  return false;
}

function shapeRawPayload(value: unknown, maxPayloadChars: number | undefined): Readonly<{ raw?: unknown; bytes: number; truncated: boolean }> {
  const max = Math.max(1, Math.floor(maxPayloadChars ?? 8192));
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { raw: '[unserializable]', bytes: 16, truncated: true };
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= max) return { raw: value, bytes, truncated: false };
  return { raw: serialized.slice(0, max), bytes: max, truncated: true };
}

export function extractSemanticTranscriptItem(params: Readonly<{
  row: TranscriptRawRow;
  index: number;
  ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
  options: ExtractionOptions;
  sequenceState?: TranscriptHistoryNormalizationSequenceState;
}>): SemanticTranscriptExtraction {
  const decrypted = tryResolveDecryptedTranscriptPayload({ content: params.row.content, ctx: params.ctx });
  return extractSemanticTranscriptItemFromDecryptedPayload({
    decrypted,
    row: params.row,
    index: params.index,
    options: params.options,
    ...(params.sequenceState ? { sequenceState: params.sequenceState } : {}),
  });
}

export function extractSemanticTranscriptItemFromDecryptedPayload(params: Readonly<{
  decrypted: unknown;
  row: Omit<TranscriptRawRow, 'content'>;
  index: number;
  options: ExtractionOptions;
  sequenceState?: TranscriptHistoryNormalizationSequenceState;
}>): SemanticTranscriptExtraction {
  if (!params.decrypted || isMemoryArtifactDecryptedRow(params.decrypted)) {
    return { item: null, payloadBytes: 0, payloadTruncated: false };
  }
  if (
    params.sequenceState
    && shouldSuppressTranscriptItemForEmptyCanonicalTurnDiff(params.decrypted, params.sequenceState)
  ) {
    return { item: null, payloadBytes: 0, payloadTruncated: false };
  }

  const classified = decodeTranscriptBody(params.decrypted);
  if (!classified || !shouldIncludeClassifiedPayload(classified, params.options)) {
    return { item: null, payloadBytes: 0, payloadTruncated: false };
  }

  const seq = normalizeSeq(params.row.seq);
  const createdAt = typeof params.row.createdAt === 'number' && Number.isFinite(params.row.createdAt) ? params.row.createdAt : 0;
  const id = typeof params.row.id === 'string' ? params.row.id : seq !== undefined ? String(seq) : String(params.index);
  const storedMessageRole = normalizeStoredRole(params.row.messageRole);
  const text = classified.text ? truncateText(classified.text, params.options.maxTextChars) : null;
  const summary = classified.summary ? truncateText(classified.summary, params.options.maxTextChars) : null;
  const includeRaw = params.options.includeRaw === true || params.options.includeStructuredPayload === true;
  const rawPayload = includeRaw ? shapeRawPayload(params.decrypted, params.options.maxPayloadChars) : null;

  return {
    item: {
      id,
      ...(seq !== undefined ? { seq } : {}),
      createdAt,
      ...(storedMessageRole ? { storedMessageRole } : {}),
      semanticRole: classified.semanticRole,
      role: classified.semanticRole,
      kind: classified.kind,
      ...(classified.provider ? { provider: classified.provider } : {}),
      ...(text ? { text: text.text, ...(text.truncated ? { truncated: true } : {}) } : {}),
      ...(summary ? { summary: summary.text, ...(summary.truncated ? { truncated: true } : {}) } : {}),
      ...(classified.toolName ? { toolName: classified.toolName } : {}),
      ...(classified.callId ? { callId: classified.callId } : {}),
      ...(rawPayload?.raw !== undefined ? { raw: rawPayload.raw } : {}),
      ...(rawPayload?.truncated ? { rawTruncated: true } : {}),
    },
    payloadBytes: rawPayload?.bytes ?? 0,
    payloadTruncated: rawPayload?.truncated === true,
  };
}
