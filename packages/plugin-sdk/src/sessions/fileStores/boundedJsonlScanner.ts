/** @moduleRealm daemon */
import { open, stat as nodeStat } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { PluginError } from '../../errors.js';
import { readSessionInputPromptUserTextV1 } from '../promptDisplay.js';

import { parseDefaultSessionHeader } from './records.js';
import {
  extractUserMessageText,
  isRecord,
  parseJsonLine,
  parseTimestampMs,
  readString,
} from './records.js';

const DEFAULT_HEAD_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_FULL_SCAN_LINE_LIMIT = 2_000;

export type JsonlScanBoundsV1 = Readonly<{
  headBytes?: number;
  tailBytes?: number;
  fullScanLineLimit?: number;
  fileSystem?: JsonlScannerFileSystemV1;
}>;

export type JsonlScannerFileSystemV1 = Readonly<{
  stat(filePath: string): Promise<Readonly<{ size: number; mtimeMs: number }>>;
  read(filePath: string, position: number, length: number): Promise<Buffer>;
}>;

export type JsonlSessionFileDescriptorV1 = Readonly<{
  filePath: string;
  sessionId: string;
  cwd: string | null;
  createdAtMs: number | null;
  title: string | null;
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastActivityAtMs: number;
}>;

export type JsonlByteCursorV1 = Readonly<{ v: 1; kind: 'byteOffset'; offset: number }>;

export type JsonlParsedLineV1 = Readonly<{
  value: unknown;
  startOffsetBytes: number;
  endOffsetBytes: number;
}>;

export type JsonlForwardLineV1 = Readonly<{
  rawLine: string;
  value: unknown | null;
  startOffsetBytes: number;
  endOffsetBytes: number;
}>;

export type JsonlSourceDiagnosticV1 = Readonly<{
  code: 'malformed_source_utf8';
  count: number;
  positions: readonly number[];
}>;

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_OVERSIZE_LINE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_DIAGNOSTIC_POSITIONS = 200;

const defaultFileSystem: JsonlScannerFileSystemV1 = {
  async stat(filePath) {
    return await nodeStat(filePath);
  },
  async read(filePath, position, length) {
    if (length <= 0) return Buffer.alloc(0);
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

/** Keep native descriptor custody inside one scan, including callback yields. */
async function withJsonlReadFile<T>(
  params: Readonly<{ filePath: string; fileSystem?: JsonlScannerFileSystemV1; signal?: AbortSignal }>,
  scan: (fileSystem: JsonlScannerFileSystemV1) => Promise<T>,
): Promise<T> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const fileSystem: JsonlScannerFileSystemV1 = params.fileSystem ?? {
    stat: defaultFileSystem.stat,
    async read(filePath, position, length) {
      if (length <= 0) return Buffer.alloc(0);
      handle ??= await open(filePath, 'r');
      params.signal?.throwIfAborted();
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    },
  };
  try {
    params.signal?.throwIfAborted();
    return await scan({
      stat: (filePath) => fileSystem.stat(filePath),
      async read(filePath, position, length) {
        params.signal?.throwIfAborted();
        const bytes = await fileSystem.read(filePath, position, length);
        params.signal?.throwIfAborted();
        return bytes;
      },
    });
  } finally {
    await handle?.close();
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function findMalformedUtf8Offset(buffer: Buffer): number | null {
  for (let index = 0; index < buffer.length;) {
    const first = buffer[index]!;
    if (first <= 0x7f) {
      index += 1;
      continue;
    }
    const continuation = (offset: number): number | null => {
      const value = buffer[index + offset];
      return value !== undefined && value >= 0x80 && value <= 0xbf ? value : null;
    };
    if (first >= 0xc2 && first <= 0xdf) {
      if (continuation(1) === null) return index;
      index += 2;
      continue;
    }
    if (first >= 0xe0 && first <= 0xef) {
      const second = continuation(1);
      if (
        second === null
        || continuation(2) === null
        || (first === 0xe0 && second < 0xa0)
        || (first === 0xed && second > 0x9f)
      ) {
        return index;
      }
      index += 3;
      continue;
    }
    if (first >= 0xf0 && first <= 0xf4) {
      const second = continuation(1);
      if (
        second === null
        || continuation(2) === null
        || continuation(3) === null
        || (first === 0xf0 && second < 0x90)
        || (first === 0xf4 && second > 0x8f)
      ) {
        return index;
      }
      index += 4;
      continue;
    }
    return index;
  }
  return null;
}

function decodeSourceLine(buffer: Buffer): Readonly<
  | { ok: true; value: string }
  | { ok: false; malformedOffsetBytes: number }
> {
  // Native validation handles valid records without a JavaScript visit per byte.
  // Only malformed input needs the diagnostic walk for its exact source offset.
  if (isUtf8(buffer)) return { ok: true, value: buffer.toString('utf8') };
  const malformedOffsetBytes = findMalformedUtf8Offset(buffer);
  return malformedOffsetBytes === null
    ? { ok: true, value: buffer.toString('utf8') }
    : { ok: false, malformedOffsetBytes };
}

function buildMalformedSourceDiagnostics(
  count: number,
  positions: readonly number[],
): readonly JsonlSourceDiagnosticV1[] | undefined {
  return count === 0
    ? undefined
    : [{ code: 'malformed_source_utf8', count, positions }];
}

function splitLines(buffer: Buffer): string[] {
  return splitCompleteLineBuffers(buffer, true).flatMap((line) => {
    const decoded = decodeSourceLine(line.value);
    if (!decoded.ok) return [];
    const trimmed = decoded.value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
}

function splitCompleteLineBuffers(
  buffer: Buffer,
  reachedEof: boolean,
): readonly Readonly<{
  value: Buffer;
  startOffsetBytes: number;
  endOffsetBytes: number;
}>[] {
  const lines: Array<Readonly<{
    value: Buffer;
    startOffsetBytes: number;
    endOffsetBytes: number;
  }>> = [];
  let startOffsetBytes = 0;
  for (let index = 0; index < buffer.byteLength; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    lines.push({
      value: buffer.subarray(startOffsetBytes, index),
      startOffsetBytes,
      endOffsetBytes: index + 1,
    });
    startOffsetBytes = index + 1;
  }
  if (reachedEof && startOffsetBytes < buffer.byteLength) {
    lines.push({
      value: buffer.subarray(startOffsetBytes),
      startOffsetBytes,
      endOffsetBytes: buffer.byteLength,
    });
  }
  return lines;
}

function findTitleFromTail(records: readonly unknown[], fallback: string | null): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!isRecord(record)) continue;
    if (record.type === 'session_info') {
      const title = readString(record.name);
      if (title) return title;
    }
  }
  return fallback;
}

function findTitleFromHead(records: readonly unknown[], fallback: string | null): string | null {
  for (const record of records) {
    if (!isRecord(record) || record.type !== 'title') continue;
    const title = readString(record.title);
    if (title) return title;
  }
  return fallback;
}

function findLastUserMessage(records: readonly unknown[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const text = extractUserMessageText(records[index]);
    if (text) return text;
  }
  return null;
}

function findLastTimestampMs(records: readonly unknown[]): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!isRecord(record)) continue;
    const timestamp = parseTimestampMs(record.timestamp);
    if (timestamp != null) return timestamp;
  }
  return null;
}

function findFirstUserMessage(lines: readonly string[], limit: number): string | null {
  for (const line of lines.slice(0, limit)) {
    const text = extractUserMessageText(parseJsonLine(line));
    if (text) {
      const userText = readSessionInputPromptUserTextV1(text);
      if (userText.trim()) return userText;
    }
  }
  return null;
}

export async function scanJsonlSessionFile(
  filePath: string,
  bounds: JsonlScanBoundsV1 = {},
): Promise<JsonlSessionFileDescriptorV1 | null> {
  const fileSystem = bounds.fileSystem ?? defaultFileSystem;
  try {
    const fileStat = await fileSystem.stat(filePath);
    const headBytes = normalizePositiveInteger(bounds.headBytes, DEFAULT_HEAD_BYTES);
    const tailBytes = normalizePositiveInteger(bounds.tailBytes, DEFAULT_TAIL_BYTES);
    const fullScanLineLimit = normalizePositiveInteger(bounds.fullScanLineLimit, DEFAULT_FULL_SCAN_LINE_LIMIT);
    const head = await fileSystem.read(filePath, 0, Math.min(headBytes, fileStat.size));
    const headLines = splitLines(head);
    const headRecords = headLines.map(parseJsonLine).filter((record): record is unknown => record !== null);
    const header = headRecords
      .map(parseDefaultSessionHeader)
      .find((candidate) => candidate !== null) ?? null;
    if (!header) return null;

    const tailStart = Math.max(0, fileStat.size - tailBytes);
    const tail = await fileSystem.read(filePath, tailStart, Math.min(tailBytes, fileStat.size - tailStart));
    const tailRecords = splitLines(tail).map(parseJsonLine).filter((record): record is unknown => record !== null);
    const lastTimestampMs = findLastTimestampMs(tailRecords);
    const fallbackActivity = header.createdAtMs ?? Math.max(0, Math.trunc(fileStat.mtimeMs));

    return {
      filePath,
      sessionId: header.sessionId,
      cwd: header.cwd,
      createdAtMs: header.createdAtMs,
      title: findTitleFromHead(headRecords, null) ?? findTitleFromTail(tailRecords, header.title),
      firstUserMessage: findFirstUserMessage(headLines, fullScanLineLimit),
      lastUserMessage: findLastUserMessage(tailRecords),
      lastActivityAtMs: lastTimestampMs ?? fallbackActivity,
    };
  } catch {
    return null;
  }
}

export function encodeJsonlByteCursor(cursor: JsonlByteCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeJsonlByteCursor(raw: string | null | undefined): JsonlByteCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      isRecord(parsed)
      && parsed.v === 1
      && parsed.kind === 'byteOffset'
      && typeof parsed.offset === 'number'
      && Number.isFinite(parsed.offset)
      && parsed.offset >= 0
    ) {
      return { v: 1, kind: 'byteOffset', offset: Math.trunc(parsed.offset) };
    }
  } catch {
    return null;
  }
  return null;
}

/** Bounded framing must either consume source or explain why continuation cannot advance. */
function assertJsonlReadProgress(params: Readonly<{
  consumedBytes: number;
  remainingSourceBytes: number;
  pendingLineBytes: number;
  maxLineBytes: number;
  direction: 'backward' | 'forward';
  offsetBytes: number;
}>): void {
  if (params.consumedBytes !== 0 || params.remainingSourceBytes <= 0 || params.pendingLineBytes < params.maxLineBytes) return;
  const { maxLineBytes, direction, offsetBytes } = params;
  throw new PluginError({
    code: 'JSONL_RECORD_TOO_LARGE',
    message: `JSONL record cannot complete within the ${maxLineBytes}-byte read allowance at ${direction} offset ${offsetBytes}. Increase the read allowance to read the record intact.`,
    retryable: false,
    details: { maxLineBytes, direction, offsetBytes },
  });
}

export async function readJsonlAfterCursor(params: Readonly<{
  filePath: string;
  cursor: JsonlByteCursorV1 | null;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  lines: readonly string[];
  lineStartOffsets: readonly number[];
  diagnostics?: readonly JsonlSourceDiagnosticV1[];
  nextCursor: JsonlByteCursorV1;
  truncated: boolean;
}>> {
  const fileStat = await defaultFileSystem.stat(params.filePath);
  const startOffset = Math.min(Math.max(0, Math.trunc(params.cursor?.offset ?? 0)), fileStat.size);
  const maxBytes = normalizePositiveInteger(params.maxBytes, DEFAULT_TAIL_BYTES);
  const maxItems = normalizePositiveInteger(params.maxItems, 100);
  const bytesToRead = Math.min(maxBytes, fileStat.size - startOffset);
  const buffer = await defaultFileSystem.read(params.filePath, startOffset, bytesToRead);
  const reachedEof = startOffset + buffer.byteLength >= fileStat.size;
  const split = splitCompleteLineBuffers(buffer, reachedEof);

  const lines: string[] = [];
  const lineStartOffsets: number[] = [];
  const malformedPositions: number[] = [];
  let malformedCount = 0;
  let consumedBytes = 0;
  for (const line of split) {
    const decoded = decodeSourceLine(line.value);
    if (!decoded.ok) {
      malformedCount += 1;
      if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
        malformedPositions.push(startOffset + line.startOffsetBytes + decoded.malformedOffsetBytes);
      }
      consumedBytes = line.endOffsetBytes;
      continue;
    }
    const rawLine = decoded.value;
    if (rawLine.length === 0) {
      consumedBytes = line.endOffsetBytes;
      continue;
    }
    if (lines.length >= maxItems) break;
    lines.push(rawLine);
    lineStartOffsets.push(startOffset + line.startOffsetBytes);
    consumedBytes = line.endOffsetBytes;
  }

  assertJsonlReadProgress({ consumedBytes, remainingSourceBytes: fileStat.size - startOffset - buffer.byteLength,
    pendingLineBytes: buffer.byteLength, maxLineBytes: maxBytes, direction: 'forward', offsetBytes: startOffset });
  const nextOffset = Math.min(fileStat.size, startOffset + consumedBytes);
  const diagnostics = buildMalformedSourceDiagnostics(malformedCount, malformedPositions);
  return {
    lines,
    lineStartOffsets,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    nextCursor: { v: 1, kind: 'byteOffset', offset: nextOffset },
    truncated: nextOffset < fileStat.size,
  };
}

export async function readJsonlRange(params: Readonly<{
  filePath: string;
  startOffset: number;
  maxBytes: number;
}>): Promise<Readonly<{
  lines: readonly string[];
  diagnostics?: readonly JsonlSourceDiagnosticV1[];
  nextOffset: number;
  eof: boolean;
}>> {
  const fileStat = await defaultFileSystem.stat(params.filePath);
  const startOffset = Math.min(Math.max(0, Math.trunc(params.startOffset)), fileStat.size);
  const maxBytes = normalizePositiveInteger(params.maxBytes, DEFAULT_TAIL_BYTES);
  const buffer = await defaultFileSystem.read(params.filePath, startOffset, Math.min(maxBytes, fileStat.size - startOffset));
  const reachedEof = startOffset + buffer.byteLength >= fileStat.size;
  const split = splitCompleteLineBuffers(buffer, reachedEof);
  const lines: string[] = [];
  const malformedPositions: number[] = [];
  let malformedCount = 0;
  let consumedBytes = 0;
  for (const line of split) {
    consumedBytes = line.endOffsetBytes;
    const decoded = decodeSourceLine(line.value);
    if (!decoded.ok) {
      malformedCount += 1;
      if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
        malformedPositions.push(startOffset + line.startOffsetBytes + decoded.malformedOffsetBytes);
      }
      continue;
    }
    const rawLine = decoded.value;
    if (rawLine.trim().length > 0) lines.push(rawLine);
  }
  assertJsonlReadProgress({ consumedBytes, remainingSourceBytes: fileStat.size - startOffset - buffer.byteLength,
    pendingLineBytes: buffer.byteLength, maxLineBytes: maxBytes, direction: 'forward', offsetBytes: startOffset });
  const nextOffset = Math.min(fileStat.size, startOffset + consumedBytes);
  const diagnostics = buildMalformedSourceDiagnostics(malformedCount, malformedPositions);
  return {
    lines,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    nextOffset,
    eof: nextOffset >= fileStat.size,
  };
}

export async function readJsonlFileBackwardPage(params: Readonly<{
  filePath: string;
  endOffsetBytes: number | null;
  maxBytes: number;
  maxItems: number;
  chunkBytes?: number;
  maxOversizeLineBytes?: number;
  fileSystem?: JsonlScannerFileSystemV1;
  signal?: AbortSignal;
  /** Retain complete nonblank malformed records as null for a visible transcript fallback. */
  includeMalformedRecords?: boolean;
  /** Consume parsed lines newest first, preserving progress before a read yields. */
  onLine?: (line: JsonlParsedLineV1, tailOffsetBytes: number | null) => void;
  /** Query-local byte admission; excluded rows consume boundaries without decoding or diagnostics. */
  shouldParseLine?: (startOffsetBytes: number, endOffsetBytes: number) => boolean;
  onSkippedLine?: (startOffsetBytes: number, endOffsetBytes: number, tailOffsetBytes: number | null) => void;
  /** Proven candidate row starts from the shared prefilter, sorted oldest first. */
  candidateByteOffsets?: readonly number[];
  /** Sparse admission can exclude a whole byte range without counting its rows. */
  onSkippedRange?: (startOffsetBytes: number, endOffsetBytes: number, tailOffsetBytes: number | null) => void;
  onDiagnostic?: (diagnostic: JsonlSourceDiagnosticV1) => void;
}>): Promise<Readonly<{
  items: readonly JsonlParsedLineV1[];
  diagnostics?: readonly JsonlSourceDiagnosticV1[];
  nextEndOffsetBytes: number;
  reachedStart: boolean;
  /** Consumed end of this page; null until a terminal line boundary is established. */
  tailOffsetBytes: number | null;
}>> {
  return await withJsonlReadFile(params, async (fileSystem) => {
    if (params.candidateByteOffsets) {
      const size = (await fileSystem.stat(params.filePath)).size;
      const end = Math.min(size, params.endOffsetBytes ?? size);
      const maxBytes = normalizePositiveInteger(params.maxBytes, DEFAULT_TAIL_BYTES);
      const chunkBytes = Math.max(1024, Math.trunc(params.chunkBytes ?? DEFAULT_CHUNK_BYTES));
      // Seeking is an I/O optimization, not a new page bound. Dense admission
      // and bounded transcript pages retain the sequential scanner.
      if (maxBytes >= end && params.candidateByteOffsets.length * chunkBytes < maxBytes) {
        return await scanSparseJsonlBackwardPage({ ...params, fileSystem }, end);
      }
    }
    return await scanJsonlBackwardPage({ ...params, fileSystem });
  });
}

async function scanSparseJsonlBackwardPage(
  params: Parameters<typeof readJsonlFileBackwardPage>[0] & { fileSystem: JsonlScannerFileSystemV1 },
  initialEnd: number,
): ReturnType<typeof readJsonlFileBackwardPage> {
  const offsets = [...new Set(params.candidateByteOffsets)].filter(offset => offset < initialEnd).sort((a, b) => b - a);
  const maxBytes = normalizePositiveInteger(params.maxBytes, DEFAULT_TAIL_BYTES);
  const maxItems = normalizePositiveInteger(params.maxItems, 100);
  let bytesRead = 0;
  const fileSystem: JsonlScannerFileSystemV1 = {
    stat: async path => {
      const metadata = await params.fileSystem.stat(path);
      return { ...metadata, size: Math.min(metadata.size, initialEnd) };
    },
    read: async (path, position, length) => {
      const bytes = await params.fileSystem.read(path, position, length);
      if (length > 0 && bytes.length === 0) throw new Error('JSONL source became unreadable during sparse scanning');
      bytesRead += bytes.length;
      return bytes;
    },
  };
  const items: JsonlParsedLineV1[] = [];
  let itemCount = 0;
  let nextEndOffsetBytes = initialEnd;
  let tailOffsetBytes = initialEnd;
  let malformedCount = 0;
  const malformedPositions: number[] = [];
  const damagedRow = new Error('Admitted row has invalid UTF-8');
  let offsetIndex = 0;
  for (; offsetIndex < offsets.length && itemCount < maxItems && bytesRead < maxBytes; offsetIndex++) {
    const offset = offsets[offsetIndex]!;
    let selected: JsonlForwardLineV1 | undefined;
    try {
      // Reuse the canonical forward framing, UTF-8 validation and JSON parser.
      // The outer scan retains one descriptor across all selected rows.
      await readJsonlFileForwardLines({ ...params, fileSystem, offsetBytes: offset,
        maxBytes: maxBytes - bytesRead, maxItems: 1,
        onLine: line => { selected = line; },
        onDiagnostic: diagnostic => {
          malformedCount += diagnostic.count;
          malformedPositions.push(...diagnostic.positions.slice(0, MAX_SOURCE_DIAGNOSTIC_POSITIONS - malformedPositions.length));
          params.onDiagnostic?.(diagnostic);
          throw damagedRow;
        },
      });
    } catch (error) { if (error !== damagedRow) throw error; }
    const line: JsonlForwardLineV1 | undefined = selected;
    if (line && line.startOffsetBytes !== offset) throw new Error('Candidate JSONL row boundary changed');
    const incompleteTail = line?.endOffsetBytes === initialEnd && line.value === null && line.rawLine !== 'null';
    if (incompleteTail) tailOffsetBytes = offset;
    if (line && !incompleteTail) {
      const afterLine = Math.min(initialEnd, line.endOffsetBytes + 1);
      if (afterLine < nextEndOffsetBytes) params.onSkippedRange?.(afterLine, nextEndOffsetBytes, tailOffsetBytes);
      if (line.value !== null || params.includeMalformedRecords) {
        const parsedLine = { value: line.value, startOffsetBytes: line.startOffsetBytes, endOffsetBytes: line.endOffsetBytes };
        itemCount++;
        if (params.onLine) params.onLine(parsedLine, tailOffsetBytes);
        else items.push(parsedLine);
      }
    }
    nextEndOffsetBytes = offset;
    // Also commits diagnosed/empty rows without inventing a decoded item.
    params.onSkippedRange?.(offset, offset, tailOffsetBytes);
  }
  if (offsetIndex === offsets.length) {
    if (nextEndOffsetBytes > 0) params.onSkippedRange?.(0, nextEndOffsetBytes, tailOffsetBytes);
    nextEndOffsetBytes = 0;
  }
  const diagnostics = buildMalformedSourceDiagnostics(malformedCount, malformedPositions);
  return { items: items.reverse(), ...(diagnostics ? { diagnostics } : {}), nextEndOffsetBytes,
    reachedStart: nextEndOffsetBytes === 0, tailOffsetBytes };
}

async function scanJsonlBackwardPage(
  params: Parameters<typeof readJsonlFileBackwardPage>[0],
): ReturnType<typeof readJsonlFileBackwardPage> {
  const fileSystem = params.fileSystem ?? defaultFileSystem;
  const maxBytes = normalizePositiveInteger(params.maxBytes, DEFAULT_TAIL_BYTES);
  const maxItems = normalizePositiveInteger(params.maxItems, 100);
  const chunkBytes = Math.max(1024, Math.trunc(params.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const maxOversizeLineBytes = Math.max(
    maxBytes,
    Math.trunc(params.maxOversizeLineBytes ?? DEFAULT_MAX_OVERSIZE_LINE_BYTES),
  );

  let fileSize = 0;
  try {
    fileSize = Math.max(0, Math.trunc((await fileSystem.stat(params.filePath)).size));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { items: [], nextEndOffsetBytes: 0, reachedStart: true, tailOffsetBytes: 0 };
  }

  const initialEnd = (() => {
    if (typeof params.endOffsetBytes !== 'number' || !Number.isFinite(params.endOffsetBytes)) return fileSize;
    return Math.min(fileSize, Math.max(0, Math.trunc(params.endOffsetBytes)));
  })();
  if (initialEnd <= 0) {
    return { items: [], nextEndOffsetBytes: 0, reachedStart: true, tailOffsetBytes: 0 };
  }

  const collectedNewestFirst: JsonlParsedLineV1[] = [];
  let itemCount = 0;
  let oldestConsumedOffsetBytes: number | undefined;
  const acceptLine = (line: JsonlParsedLineV1) => {
    itemCount += 1;
    if (params.onLine) params.onLine(line, tailOffsetBytes);
    else collectedNewestFirst.push(line);
    oldestConsumedOffsetBytes = line.startOffsetBytes;
  };
  const malformedPositions: number[] = [];
  let malformedCount = 0;
  let bytesReadTotal = 0;
  let end = initialEnd;
  // Pending line fragments are retained newest first. Scan each read chunk
  // once and assemble the line only after finding its boundary.
  let carryChunks: Buffer[] = [];
  let carryLength = 0;
  let tailOffsetBytes: number | null = null;

  while (end > 0 && itemCount < maxItems) {
    const remainingBytes = maxBytes - bytesReadTotal;
    const canContinueOversizeFirstLine =
      remainingBytes <= 0 &&
      itemCount === 0 &&
      carryLength > 0 &&
      carryLength < maxOversizeLineBytes;
    if (remainingBytes <= 0 && !canContinueOversizeFirstLine) break;

    const oversizeRemainingBytes = maxOversizeLineBytes - carryLength;
    const readBudget = canContinueOversizeFirstLine ? oversizeRemainingBytes : remainingBytes;
    const readSize = Math.min(chunkBytes, end, readBudget);
    if (readSize <= 0) break;

    const start = end - readSize;
    const chunk = await fileSystem.read(params.filePath, start, readSize);
    bytesReadTotal += chunk.length;

    let segmentEndIndex = chunk.length;
    for (let index = chunk.lastIndexOf(0x0a); index >= 0 && itemCount < maxItems;
      index = index > 0 ? chunk.lastIndexOf(0x0a, index - 1) : -1) {
      const segmentStartIndex = index + 1;
      const prefix = chunk.subarray(segmentStartIndex, segmentEndIndex);
      // Carry belongs to the requested end boundary even if this read is short.
      const startOffsetAbs = segmentStartIndex < chunk.length ? start + segmentStartIndex : end;
      const endOffsetAbs = segmentEndIndex < chunk.length ? start + segmentEndIndex : end + carryLength;
      const admitted = params.shouldParseLine?.(startOffsetAbs, endOffsetAbs) !== false;
      if (!admitted) {
        carryChunks = [];
        carryLength = 0;
        segmentEndIndex = index;
        oldestConsumedOffsetBytes = startOffsetAbs;
        // Admission proves this query cannot match even a damaged EOF row.
        // Ordinary transcript readers omit admission and retain tail checks.
        tailOffsetBytes ??= initialEnd;
        if (endOffsetAbs > startOffsetAbs) params.onSkippedLine?.(startOffsetAbs, endOffsetAbs, tailOffsetBytes);
        continue;
      }
      const segment = carryLength > 0
        ? Buffer.concat([prefix, ...carryChunks.reverse()], prefix.length + carryLength)
        : prefix;
      carryChunks = [];
      carryLength = 0;
      segmentEndIndex = index;
      oldestConsumedOffsetBytes = startOffsetAbs;
      const decoded = decodeSourceLine(segment);
      const parsed: unknown = decoded.ok ? parseJsonLine(decoded.value) : null;
      if (tailOffsetBytes === null) {
        tailOffsetBytes = segment.length === 0 || parsed !== null || (decoded.ok && decoded.value.trim() === 'null')
          ? initialEnd
          : startOffsetAbs;
      }
      if (!decoded.ok) {
        malformedCount += 1;
        params.onDiagnostic?.({ code: 'malformed_source_utf8', count: 1, positions: [startOffsetAbs + decoded.malformedOffsetBytes] });
        if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
          malformedPositions.push(startOffsetAbs + decoded.malformedOffsetBytes);
        }
        continue;
      }
      if (parsed === null && (!params.includeMalformedRecords || decoded.value.trim().length === 0
        || (endOffsetAbs === initialEnd && decoded.value.trim() !== 'null'))) continue;
      acceptLine({ value: parsed, startOffsetBytes: startOffsetAbs, endOffsetBytes: endOffsetAbs });
    }

    if (segmentEndIndex > 0) {
      carryChunks.push(chunk.subarray(0, segmentEndIndex));
      carryLength += segmentEndIndex;
    }
    end = start;

    if (end === 0 && carryLength > 0 && itemCount < maxItems) {
      oldestConsumedOffsetBytes = 0;
      if (params.shouldParseLine?.(0, carryLength) === false) {
        tailOffsetBytes ??= initialEnd;
        params.onSkippedLine?.(0, carryLength, tailOffsetBytes);
        break;
      }
      const carry = carryChunks.length === 1
        ? carryChunks[0]!
        : Buffer.concat(carryChunks.reverse(), carryLength);
      const decoded = decodeSourceLine(carry);
      if (!decoded.ok) {
        malformedCount += 1;
        params.onDiagnostic?.({ code: 'malformed_source_utf8', count: 1, positions: [decoded.malformedOffsetBytes] });
        if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
          malformedPositions.push(decoded.malformedOffsetBytes);
        }
      } else {
        const parsed: unknown = parseJsonLine(decoded.value);
        if (tailOffsetBytes === null) {
          tailOffsetBytes = parsed !== null || decoded.value.trim() === 'null' ? initialEnd : 0;
        }
        if (parsed !== null || (params.includeMalformedRecords && decoded.value.trim().length > 0
          && (carry.length < initialEnd || decoded.value.trim() === 'null'))) {
          acceptLine({ value: parsed, startOffsetBytes: 0, endOffsetBytes: carry.length });
        }
      }
    }
  }

  const items = collectedNewestFirst.reverse();
  // Only complete lines establish a continuation. The read limit may leave
  // `end` inside a native row (even inside a UTF-8 scalar); publishing that
  // offset would turn a valid source into a malformed one on the next page.
  const nextEndOffsetBytes = oldestConsumedOffsetBytes ?? initialEnd;
  assertJsonlReadProgress({ consumedBytes: initialEnd - nextEndOffsetBytes, remainingSourceBytes: end,
    pendingLineBytes: carryLength, maxLineBytes: maxOversizeLineBytes, direction: 'backward', offsetBytes: initialEnd });
  const diagnostics = buildMalformedSourceDiagnostics(malformedCount, malformedPositions);
  return {
    items,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    nextEndOffsetBytes,
    reachedStart: nextEndOffsetBytes <= 0,
    tailOffsetBytes,
  };
}

export async function readJsonlFileForwardLines(params: Readonly<{
  filePath: string;
  offsetBytes: number;
  maxBytes: number;
  maxItems: number;
  chunkBytes?: number;
  maxOversizeLineBytes?: number;
  fileSystem?: JsonlScannerFileSystemV1;
  signal?: AbortSignal;
  /** Consume each parsed line immediately without retaining source bodies. */
  onLine?: (line: JsonlForwardLineV1) => void;
  onDiagnostic?: (diagnostic: JsonlSourceDiagnosticV1) => void;
}>): Promise<Readonly<{
  items: readonly JsonlForwardLineV1[];
  diagnostics?: readonly JsonlSourceDiagnosticV1[];
  nextOffsetBytes: number;
  truncated: boolean;
  reachedEnd: boolean;
  hitPageLimit: boolean;
}>> {
  return await withJsonlReadFile(params, (fileSystem) => scanJsonlForwardLines({ ...params, fileSystem }));
}

async function scanJsonlForwardLines(
  params: Parameters<typeof readJsonlFileForwardLines>[0],
): ReturnType<typeof readJsonlFileForwardLines> {
  const fileSystem = params.fileSystem ?? defaultFileSystem;
  const maxBytes = normalizePositiveInteger(params.maxBytes, DEFAULT_TAIL_BYTES);
  const maxItems = normalizePositiveInteger(params.maxItems, 100);
  const chunkBytes = Math.max(1024, Math.trunc(params.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const maxOversizeLineBytes = Math.max(
    maxBytes,
    Math.trunc(params.maxOversizeLineBytes ?? DEFAULT_MAX_OVERSIZE_LINE_BYTES),
  );

  let fileSize = 0;
  try {
    fileSize = Math.max(0, Math.trunc((await fileSystem.stat(params.filePath)).size));
  } catch {
    return { items: [], nextOffsetBytes: 0, truncated: true, reachedEnd: true, hitPageLimit: false };
  }

  const offsetBytes = Math.max(0, Math.trunc(params.offsetBytes));
  if (offsetBytes > fileSize) {
    return { items: [], nextOffsetBytes: 0, truncated: true, reachedEnd: true, hitPageLimit: false };
  }

  const items: JsonlForwardLineV1[] = [];
  let itemCount = 0;
  const acceptLine = (line: JsonlForwardLineV1) => {
    itemCount += 1;
    if (params.onLine) params.onLine(line);
    else items.push(line);
  };
  const malformedPositions: number[] = [];
  let malformedCount = 0;
  let bytesReadTotal = 0;
  // Keep unfinished record fragments without recopying the entire growing
  // record on every chunk. Assemble only when its line boundary is known.
  let carryChunks: Buffer[] = [];
  let carryLength = 0;
  let carryStartOffset = offsetBytes;
  let nextReadOffset = offsetBytes;

  while (nextReadOffset < fileSize && itemCount < maxItems) {
    const remainingBytes = maxBytes - bytesReadTotal;
    const canContinueOversizeFirstLine =
      remainingBytes <= 0 &&
      itemCount === 0 &&
      carryLength > 0 &&
      carryLength < maxOversizeLineBytes;
    if (remainingBytes <= 0 && !canContinueOversizeFirstLine) break;

    const oversizeRemainingBytes = maxOversizeLineBytes - carryLength;
    const readBudget = canContinueOversizeFirstLine ? oversizeRemainingBytes : remainingBytes;
    const readSize = Math.min(chunkBytes, fileSize - nextReadOffset, readBudget);
    if (readSize <= 0) break;

    const chunkStartOffset = nextReadOffset;
    const chunk = await fileSystem.read(params.filePath, nextReadOffset, readSize);
    bytesReadTotal += chunk.length;
    nextReadOffset += chunk.length;

    let lineStartIndex = 0;
    for (let index = chunk.indexOf(0x0a); index >= 0 && itemCount < maxItems;
      index = chunk.indexOf(0x0a, index + 1)) {

      const suffix = chunk.subarray(lineStartIndex, index);
      const line = carryLength > 0
        ? Buffer.concat([...carryChunks, suffix], carryLength + suffix.length)
        : suffix;
      const lineOffset = carryStartOffset;
      carryChunks = [];
      carryLength = 0;
      carryStartOffset = chunkStartOffset + index + 1;
      const decoded = decodeSourceLine(line);
      if (!decoded.ok) {
        malformedCount += 1;
        if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
          malformedPositions.push(lineOffset + decoded.malformedOffsetBytes);
        }
        params.onDiagnostic?.({ code: 'malformed_source_utf8', count: 1,
          positions: [lineOffset + decoded.malformedOffsetBytes] });
        lineStartIndex = index + 1;
        continue;
      }
      const rawLine = decoded.value.trim();
      if (rawLine.length > 0) {
        acceptLine({
          rawLine,
          value: parseJsonLine(rawLine),
          startOffsetBytes: lineOffset,
          endOffsetBytes: chunkStartOffset + index,
        });
      }
      lineStartIndex = index + 1;
    }

    if (lineStartIndex < chunk.length) {
      const remainder = chunk.subarray(lineStartIndex);
      carryChunks.push(remainder);
      carryLength += remainder.length;
    }
  }

  if (itemCount < maxItems && nextReadOffset >= fileSize && carryLength > 0) {
    const carry = carryChunks.length === 1 ? carryChunks[0]! : Buffer.concat(carryChunks, carryLength);
    const decoded = decodeSourceLine(carry);
    if (!decoded.ok) {
      malformedCount += 1;
      if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
        malformedPositions.push(carryStartOffset + decoded.malformedOffsetBytes);
      }
      params.onDiagnostic?.({ code: 'malformed_source_utf8', count: 1,
        positions: [carryStartOffset + decoded.malformedOffsetBytes] });
      carryChunks = [];
      carryLength = 0;
      carryStartOffset = fileSize;
    } else {
      const rawLine = decoded.value.trim();
      if (rawLine.length > 0) {
        acceptLine({
          rawLine,
          value: parseJsonLine(rawLine),
          startOffsetBytes: carryStartOffset,
          endOffsetBytes: carryStartOffset + carry.length,
        });
        carryChunks = [];
        carryLength = 0;
        carryStartOffset = fileSize;
      }
    }
  }

  const reachedEnd = carryLength === 0 && nextReadOffset >= fileSize;
  assertJsonlReadProgress({ consumedBytes: carryStartOffset - offsetBytes, remainingSourceBytes: fileSize - nextReadOffset,
    pendingLineBytes: carryLength, maxLineBytes: maxOversizeLineBytes, direction: 'forward', offsetBytes });
  const diagnostics = buildMalformedSourceDiagnostics(malformedCount, malformedPositions);
  return {
    items,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    nextOffsetBytes: carryStartOffset,
    truncated: false,
    reachedEnd,
    hitPageLimit: !reachedEnd && (itemCount >= maxItems || nextReadOffset < fileSize),
  };
}

export async function readJsonlFileForward(params: Readonly<{
  filePath: string;
  offsetBytes: number;
  maxBytes: number;
  maxItems: number;
  chunkBytes?: number;
  maxOversizeLineBytes?: number;
  fileSystem?: JsonlScannerFileSystemV1;
  signal?: AbortSignal;
  /** Retain complete malformed records as null; an incomplete tail remains retryable. */
  includeMalformedRecords?: boolean;
}>): Promise<Readonly<{
  items: readonly JsonlParsedLineV1[];
  diagnostics?: readonly JsonlSourceDiagnosticV1[];
  nextOffsetBytes: number;
  truncated: boolean;
  reachedEnd: boolean;
  hitPageLimit: boolean;
}>> {
  const page = await readJsonlFileForwardLines(params);
  const lastLine = page.items.at(-1);
  // Raw consumers still receive incomplete text. Parsed consumers must retry
  // an unterminated invalid line when its writer completes it on a later read.
  const incompleteTail = lastLine?.value === null
    && lastLine.rawLine !== 'null'
    && lastLine.endOffsetBytes === page.nextOffsetBytes;
  return {
    items: page.items.flatMap((line) =>
      line.value === null && (!params.includeMalformedRecords || (incompleteTail && line === lastLine))
        ? []
        : [{
          value: line.value,
          startOffsetBytes: line.startOffsetBytes,
          endOffsetBytes: line.endOffsetBytes,
        }],
    ),
    ...(page.diagnostics === undefined ? {} : { diagnostics: page.diagnostics }),
    nextOffsetBytes: incompleteTail ? lastLine.startOffsetBytes : page.nextOffsetBytes,
    truncated: page.truncated,
    reachedEnd: !incompleteTail && page.reachedEnd,
    hitPageLimit: page.hitPageLimit,
  };
}
