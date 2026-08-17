import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';

import {
  readJsonlFileBackwardPage,
  readJsonlFileForwardLines,
  type JsonlScannerFileSystem,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

export type AntigravityTranscriptJsonRecord = Readonly<Record<string, unknown>>;

export type AntigravityTranscriptTailCursor = Readonly<{
  offset: number;
  seenIds: readonly string[];
  seenFingerprints?: readonly string[];
  fileIdentity?: string;
  tailFingerprint?: string;
}>;

export type AntigravityTranscriptTailResult = Readonly<{
  records: readonly AntigravityTranscriptJsonRecord[];
  cursor: AntigravityTranscriptTailCursor;
  missing?: boolean;
}>;

export type AntigravityTranscriptSourceSnapshot = Readonly<{
  sourceRevision: string;
  sizeBytes: number;
  mtimeMs: number;
}>;

export type AntigravityTranscriptRecordWithOffsets = Readonly<{
  record: AntigravityTranscriptJsonRecord;
  startOffsetBytes: number;
  endOffsetBytes: number;
}>;

type AntigravityBackwardCursorV2 = Readonly<{
  v: 2;
  kind: 'antigravityBackward';
  conversationId: string;
  sourceRevision: string;
  endOffsetBytes: number;
  tailFingerprint: string;
}>;

type AntigravityForwardCursorV1 = Readonly<{
  v: 1;
  kind: 'antigravityForward';
  conversationId: string;
  sourceRevision: string;
  offsetBytes: number;
  tailFingerprint: string;
}>;

export type AntigravityTranscriptPageLinesOutcome =
  | Readonly<{
      kind: 'page';
      records: readonly AntigravityTranscriptRecordWithOffsets[];
      correlationLookbackRecords: readonly AntigravityTranscriptRecordWithOffsets[];
      tailCorrelationLookbackRecords: readonly AntigravityTranscriptRecordWithOffsets[];
      nextCursor: string | null;
      tailCursor: string;
      hasMore: boolean;
      sourceRevision: string;
    }>
  | Readonly<{ kind: 'gap_or_cursor_expired'; tailCursor: string; sourceRevision: string }>
  | Readonly<{ kind: 'source_replaced'; sourceRevision: string }>
  | Readonly<{ kind: 'source_unavailable' }>
  | Readonly<{ kind: 'read_failed'; error: string }>;

export type AntigravityTranscriptAfterLinesOutcome =
  | Readonly<{ kind: 'already_current'; cursor: string; sourceRevision: string }>
  | Readonly<{
      kind: 'advanced';
      records: readonly AntigravityTranscriptRecordWithOffsets[];
      correlationLookbackRecords?: readonly AntigravityTranscriptRecordWithOffsets[];
      sourceDiagnostics?: readonly Readonly<{
        code: 'malformed_source_utf8';
        count: number;
        positions: readonly number[];
      }>[];
      nextCursor: string;
      hasMore: boolean;
      sourceRevision: string;
    }>
  | Readonly<{ kind: 'gap_or_cursor_expired'; sourceRevision?: string }>
  | Readonly<{ kind: 'source_replaced'; sourceRevision: string }>
  | Readonly<{ kind: 'source_unavailable' }>
  | Readonly<{ kind: 'read_failed'; error: string }>;

function isRecord(value: unknown): value is AntigravityTranscriptJsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableRecordId(record: AntigravityTranscriptJsonRecord): string | null {
  for (const key of ['id', 'stepId', 'step_id', 'uuid']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function stableRecordFingerprint(record: AntigravityTranscriptJsonRecord): string {
  return JSON.stringify(record);
}

function readFileIdentity(stats: Readonly<{
  dev: number | bigint;
  ino: number | bigint;
}>): string {
  return `${stats.dev}:${stats.ino}`;
}

export function formatAntigravityTranscriptSourceRevision(stats: Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
}>): string {
  return createHash('sha256')
    .update(readFileIdentity(stats))
    .update(':')
    .update(String(stats.birthtimeMs))
    .digest('base64url');
}

const TAIL_FINGERPRINT_CHARS = 4096;
const CURSOR_FINGERPRINT_BYTES = 4096;
/**
 * Native transcript pages are stateless at the SDK boundary. This fixed source
 * window supplies only the immediately preceding tool-call context required to
 * map an id-less result; ongoing read-after state stays in that leaf's cursor.
 */
const ANTIGRAVITY_TRANSCRIPT_CORRELATION_LOOKBACK_MAX_ITEMS = 32;

function readTailFingerprint(content: string): string {
  return content.slice(Math.max(0, content.length - TAIL_FINGERPRINT_CHARS));
}

function readCompleteTailWindow(content: string, offset: number): Readonly<{
  input: string;
  nextOffset: number;
}> {
  const input = content.slice(offset);
  if (!input || input.endsWith('\n')) {
    return { input, nextOffset: content.length };
  }

  const lastLineStart = input.lastIndexOf('\n') + 1;
  const lastLine = input.slice(lastLineStart);
  try {
    if (isRecord(JSON.parse(lastLine) as unknown)) {
      return { input, nextOffset: content.length };
    }
  } catch {
    // A split final record remains unread until a later append completes it.
  }

  return {
    input: input.slice(0, lastLineStart),
    nextOffset: offset + lastLineStart,
  };
}

function shouldResetTailOffset(params: Readonly<{
  content: string;
  previousOffset: number;
  cursor?: AntigravityTranscriptTailCursor;
  fileIdentity: string;
}>): boolean {
  if (params.content.length < params.previousOffset) return true;
  if (!params.cursor || params.previousOffset === 0) return false;
  if (params.cursor.fileIdentity && params.cursor.fileIdentity !== params.fileIdentity) return true;
  const previousTail = params.cursor.tailFingerprint;
  if (!previousTail) return false;
  const start = Math.max(0, params.previousOffset - previousTail.length);
  return params.content.slice(start, params.previousOffset) !== previousTail;
}

export function parseAntigravityTranscriptJsonl(
  input: string,
  options: Readonly<{ allowPartialLastLine?: boolean }> = {},
): readonly AntigravityTranscriptJsonRecord[] {
  const lines = input.split('\n');
  const records: AntigravityTranscriptJsonRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        throw new Error('line is not a JSON object');
      }
      records.push(parsed);
    } catch (error) {
      const isLastLine = index === lines.length - 1;
      if (options.allowPartialLastLine && isLastLine && !input.endsWith('\n')) continue;
      throw new Error(`Malformed Antigravity transcript JSONL at line ${index + 1}: ${error instanceof Error ? error.message : 'parse failed'}`);
    }
  }
  return records;
}

export async function readAntigravityTranscriptTail(params: Readonly<{
  path: string;
  cursor?: AntigravityTranscriptTailCursor;
}>): Promise<AntigravityTranscriptTailResult> {
  let content: string;
  let fileIdentity: string;
  try {
    fileIdentity = readFileIdentity(await stat(params.path));
    content = await readFile(params.path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        records: [],
        cursor: params.cursor ?? { offset: 0, seenIds: [], seenFingerprints: [] },
        missing: true,
      };
    }
    throw error;
  }

  const previousOffset = params.cursor?.offset ?? 0;
  const offset = shouldResetTailOffset({
    content,
    previousOffset,
    cursor: params.cursor,
    fileIdentity,
  }) ? 0 : previousOffset;
  const window = readCompleteTailWindow(content, offset);
  const seen = new Set(params.cursor?.seenIds ?? []);
  const seenFingerprints = new Set(params.cursor?.seenFingerprints ?? []);
  const rawRecords = parseAntigravityTranscriptJsonl(window.input);
  const records: AntigravityTranscriptJsonRecord[] = [];
  for (const record of rawRecords) {
    const id = stableRecordId(record);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    } else {
      const fingerprint = stableRecordFingerprint(record);
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
    }
    records.push(record);
  }
  return {
    records,
    cursor: {
      offset: window.nextOffset,
      seenIds: [...seen].sort(),
      seenFingerprints: [...seenFingerprints].sort(),
      fileIdentity,
      tailFingerprint: readTailFingerprint(content.slice(0, window.nextOffset)),
    },
  };
}

function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function readFileRange(path: string, position: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function snapshotAntigravityTranscriptSource(
  path: string,
): Promise<AntigravityTranscriptSourceSnapshot | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    return {
      sourceRevision: formatAntigravityTranscriptSourceRevision(stats),
      sizeBytes: Math.max(0, Math.trunc(stats.size)),
      mtimeMs: Math.max(0, Math.trunc(stats.mtimeMs)),
    };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

/** Byte ceiling for the single head chunk read when deriving a conversation title. */
export const ANTIGRAVITY_TRANSCRIPT_HEAD_MAX_BYTES = 32 * 1024;

/**
 * Reads the first complete JSONL record of a transcript within one bounded head chunk.
 * A missing file, an unreadable head, or a first line longer than the ceiling yields null.
 */
export async function readAntigravityTranscriptHeadRecord(params: Readonly<{
  path: string;
  fileSystem?: JsonlScannerFileSystem;
}>): Promise<AntigravityTranscriptJsonRecord | null> {
  const page = await readJsonlFileForwardLines({
    filePath: params.path,
    offsetBytes: 0,
    maxBytes: ANTIGRAVITY_TRANSCRIPT_HEAD_MAX_BYTES,
    maxItems: 1,
    maxOversizeLineBytes: ANTIGRAVITY_TRANSCRIPT_HEAD_MAX_BYTES,
    ...(params.fileSystem ? { fileSystem: params.fileSystem } : {}),
  });
  const value = page.items[0]?.value;
  return isRecord(value) ? value : null;
}

function encodeCursor(cursor: AntigravityBackwardCursorV2 | AntigravityForwardCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursorRecord(raw: string | null | undefined): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function decodeBackwardCursor(raw: string | null | undefined): AntigravityBackwardCursorV2 | null {
  const value = decodeCursorRecord(raw);
  if (
    value?.v !== 2
    || value.kind !== 'antigravityBackward'
    || typeof value.conversationId !== 'string'
    || typeof value.sourceRevision !== 'string'
    || typeof value.endOffsetBytes !== 'number'
    || !Number.isFinite(value.endOffsetBytes)
    || value.endOffsetBytes < 0
    || typeof value.tailFingerprint !== 'string'
  ) return null;
  return {
    v: 2,
    kind: 'antigravityBackward',
    conversationId: value.conversationId,
    sourceRevision: value.sourceRevision,
    endOffsetBytes: Math.trunc(value.endOffsetBytes),
    tailFingerprint: value.tailFingerprint,
  };
}

function decodeForwardCursor(raw: string | null | undefined): AntigravityForwardCursorV1 | null {
  const value = decodeCursorRecord(raw);
  if (
    value?.v !== 1
    || value.kind !== 'antigravityForward'
    || typeof value.conversationId !== 'string'
    || typeof value.sourceRevision !== 'string'
    || typeof value.offsetBytes !== 'number'
    || !Number.isFinite(value.offsetBytes)
    || value.offsetBytes < 0
    || typeof value.tailFingerprint !== 'string'
  ) return null;
  return {
    v: 1,
    kind: 'antigravityForward',
    conversationId: value.conversationId,
    sourceRevision: value.sourceRevision,
    offsetBytes: Math.trunc(value.offsetBytes),
    tailFingerprint: value.tailFingerprint,
  };
}

async function readCursorFingerprint(path: string, offsetBytes: number): Promise<string> {
  const start = Math.max(0, offsetBytes - CURSOR_FINGERPRINT_BYTES);
  const content = await readFileRange(path, start, offsetBytes - start);
  return createHash('sha256').update(content).digest('base64url');
}

async function encodeForwardCursor(params: Readonly<{
  path: string;
  conversationId: string;
  sourceRevision: string;
  offsetBytes: number;
}>): Promise<string> {
  return encodeCursor({
    v: 1,
    kind: 'antigravityForward',
    conversationId: params.conversationId,
    sourceRevision: params.sourceRevision,
    offsetBytes: params.offsetBytes,
    tailFingerprint: await readCursorFingerprint(params.path, params.offsetBytes),
  });
}

async function advancePastFollowingNewline(
  path: string,
  offsetBytes: number,
  fileSize: number,
): Promise<number> {
  if (offsetBytes >= fileSize) return fileSize;
  const next = await readFileRange(path, offsetBytes, 1);
  return next[0] === 0x0a ? offsetBytes + 1 : offsetBytes;
}

async function readCurrentTailOffset(params: Readonly<{
  path: string;
  fileSize: number;
  maxBytes: number;
}>): Promise<number> {
  if (params.fileSize <= 0) return 0;
  const tail = await readJsonlFileBackwardPage({
    filePath: params.path,
    endOffsetBytes: params.fileSize,
    maxBytes: params.maxBytes,
    maxItems: 1,
  });
  const newest = tail.items[tail.items.length - 1];
  if (!newest) return 0;
  return await advancePastFollowingNewline(params.path, newest.endOffsetBytes, params.fileSize);
}

function toOffsetRecords(
  values: ReadonlyArray<Readonly<{
    value: unknown;
    startOffsetBytes: number;
    endOffsetBytes: number;
  }>>,
): readonly AntigravityTranscriptRecordWithOffsets[] {
  return values.flatMap((entry) => isRecord(entry.value)
    ? [{
        record: entry.value,
        startOffsetBytes: entry.startOffsetBytes,
        endOffsetBytes: entry.endOffsetBytes,
      }]
    : []);
}

async function readCorrelationLookback(params: Readonly<{
  path: string;
  endOffsetBytes: number;
  maxBytes: number;
}>): Promise<readonly AntigravityTranscriptRecordWithOffsets[]> {
  if (params.endOffsetBytes <= 0) return [];
  const page = await readJsonlFileBackwardPage({
    filePath: params.path,
    endOffsetBytes: params.endOffsetBytes,
    maxBytes: params.maxBytes,
    maxItems: ANTIGRAVITY_TRANSCRIPT_CORRELATION_LOOKBACK_MAX_ITEMS,
  });
  return toOffsetRecords(page.items);
}

export async function pageAntigravityTranscriptLines(params: Readonly<{
  path: string;
  conversationId: string;
  sourceRevision: string;
  cursor?: string;
  maxItems: number;
  maxBytes: number;
}>): Promise<AntigravityTranscriptPageLinesOutcome> {
  try {
    const before = await snapshotAntigravityTranscriptSource(params.path);
    if (!before) return { kind: 'source_unavailable' };
    if (before.sourceRevision !== params.sourceRevision) {
      return { kind: 'source_replaced', sourceRevision: before.sourceRevision };
    }
    const decoded = params.cursor ? decodeBackwardCursor(params.cursor) : null;
    const tailOffset = await readCurrentTailOffset({
      path: params.path,
      fileSize: before.sizeBytes,
      maxBytes: params.maxBytes,
    });
    const tailCursor = await encodeForwardCursor({
      path: params.path,
      conversationId: params.conversationId,
      sourceRevision: before.sourceRevision,
      offsetBytes: tailOffset,
    });
    if (params.cursor && !decoded) {
      return { kind: 'gap_or_cursor_expired', tailCursor, sourceRevision: before.sourceRevision };
    }
    if (
      decoded
      && (
        decoded.conversationId !== params.conversationId
        || decoded.sourceRevision !== before.sourceRevision
        || decoded.endOffsetBytes > before.sizeBytes
      )
    ) {
      return decoded.sourceRevision !== before.sourceRevision
        ? { kind: 'source_replaced', sourceRevision: before.sourceRevision }
        : { kind: 'gap_or_cursor_expired', tailCursor, sourceRevision: before.sourceRevision };
    }
    if (
      decoded
      && await readCursorFingerprint(params.path, decoded.endOffsetBytes)
        !== decoded.tailFingerprint
    ) {
      return { kind: 'source_replaced', sourceRevision: before.sourceRevision };
    }
    const endOffsetBytes = decoded?.endOffsetBytes ?? before.sizeBytes;
    const page = await readJsonlFileBackwardPage({
      filePath: params.path,
      endOffsetBytes,
      maxBytes: params.maxBytes,
      maxItems: params.maxItems,
    });
    if (page.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
      return { kind: 'read_failed', error: 'Malformed Antigravity transcript UTF-8.' };
    }
    const firstPageRecord = page.items[0];
    const correlationLookbackRecords = await readCorrelationLookback({
      path: params.path,
      endOffsetBytes: firstPageRecord?.startOffsetBytes ?? endOffsetBytes,
      maxBytes: params.maxBytes,
    });
    const tailCorrelationLookbackRecords = await readCorrelationLookback({
      path: params.path,
      endOffsetBytes: tailOffset,
      maxBytes: params.maxBytes,
    });
    const after = await snapshotAntigravityTranscriptSource(params.path);
    if (!after) return { kind: 'source_unavailable' };
    if (after.sourceRevision !== before.sourceRevision || after.sizeBytes < before.sizeBytes) {
      return { kind: 'source_replaced', sourceRevision: after.sourceRevision };
    }
    const hasMore = !page.reachedStart;
    return {
      kind: 'page',
      records: toOffsetRecords(page.items),
      correlationLookbackRecords,
      tailCorrelationLookbackRecords,
      nextCursor: hasMore
        ? encodeCursor({
            v: 2,
            kind: 'antigravityBackward',
            conversationId: params.conversationId,
            sourceRevision: before.sourceRevision,
            endOffsetBytes: page.nextEndOffsetBytes,
            tailFingerprint: await readCursorFingerprint(
              params.path,
              page.nextEndOffsetBytes,
            ),
          })
        : null,
      tailCursor,
      hasMore,
      sourceRevision: before.sourceRevision,
    };
  } catch (error) {
    return { kind: 'read_failed', error: error instanceof Error ? error.message : 'read failed' };
  }
}

export async function readAntigravityTranscriptLinesAfter(params: Readonly<{
  path: string;
  conversationId: string;
  sourceRevision: string;
  cursor: string;
  maxItems: number;
  maxBytes: number;
  includeCorrelationLookback?: boolean;
}>): Promise<AntigravityTranscriptAfterLinesOutcome> {
  try {
    const decoded = decodeForwardCursor(params.cursor);
    if (!decoded || decoded.conversationId !== params.conversationId) {
      return { kind: 'gap_or_cursor_expired' };
    }
    const before = await snapshotAntigravityTranscriptSource(params.path);
    if (!before) return { kind: 'source_unavailable' };
    if (
      before.sourceRevision !== params.sourceRevision
      || decoded.sourceRevision !== params.sourceRevision
    ) {
      return { kind: 'source_replaced', sourceRevision: before.sourceRevision };
    }
    if (decoded.offsetBytes > before.sizeBytes) {
      return { kind: 'gap_or_cursor_expired', sourceRevision: before.sourceRevision };
    }
    if (await readCursorFingerprint(params.path, decoded.offsetBytes) !== decoded.tailFingerprint) {
      return { kind: 'source_replaced', sourceRevision: before.sourceRevision };
    }
    const correlationLookbackRecords = params.includeCorrelationLookback
      ? await readCorrelationLookback({
          path: params.path,
          endOffsetBytes: decoded.offsetBytes,
          maxBytes: params.maxBytes,
        })
      : undefined;

    const page = await readJsonlFileForwardLines({
      filePath: params.path,
      offsetBytes: decoded.offsetBytes,
      maxBytes: params.maxBytes,
      maxItems: params.maxItems,
    });
    const records: AntigravityTranscriptRecordWithOffsets[] = [];
    let nextOffsetBytes = page.nextOffsetBytes;
    let heldPartialTail = false;
    for (const line of page.items) {
      if (isRecord(line.value)) {
        records.push({
          record: line.value,
          startOffsetBytes: line.startOffsetBytes,
          endOffsetBytes: line.endOffsetBytes,
        });
        continue;
      }
      const lastByte = before.sizeBytes > 0
        ? (await readFileRange(params.path, before.sizeBytes - 1, 1))[0]
        : undefined;
      if (line.endOffsetBytes === before.sizeBytes && lastByte !== 0x0a) {
        nextOffsetBytes = line.startOffsetBytes;
        heldPartialTail = true;
        continue;
      }
      return { kind: 'read_failed', error: 'Malformed Antigravity transcript JSONL.' };
    }
    const after = await snapshotAntigravityTranscriptSource(params.path);
    if (!after) return { kind: 'source_unavailable' };
    if (after.sourceRevision !== before.sourceRevision || after.sizeBytes < before.sizeBytes) {
      return { kind: 'source_replaced', sourceRevision: after.sourceRevision };
    }
    if (records.length === 0 && page.diagnostics === undefined) {
      return {
        kind: 'already_current',
        cursor: params.cursor,
        sourceRevision: before.sourceRevision,
      };
    }
    return {
      kind: 'advanced',
      records,
      ...(correlationLookbackRecords === undefined ? {} : { correlationLookbackRecords }),
      ...(page.diagnostics === undefined ? {} : { sourceDiagnostics: page.diagnostics }),
      nextCursor: await encodeForwardCursor({
        path: params.path,
        conversationId: params.conversationId,
        sourceRevision: before.sourceRevision,
        offsetBytes: nextOffsetBytes,
      }),
      hasMore: !page.reachedEnd && !heldPartialTail,
      sourceRevision: before.sourceRevision,
    };
  } catch (error) {
    return { kind: 'read_failed', error: error instanceof Error ? error.message : 'read failed' };
  }
}
