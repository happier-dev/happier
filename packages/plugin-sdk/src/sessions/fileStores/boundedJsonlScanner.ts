/** @moduleRealm daemon */
import { open, stat as nodeStat } from 'node:fs/promises';

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
    if (text) return text;
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
}>): Promise<Readonly<{
  items: readonly JsonlParsedLineV1[];
  diagnostics?: readonly JsonlSourceDiagnosticV1[];
  nextEndOffsetBytes: number;
  reachedStart: boolean;
}>> {
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
    return { items: [], nextEndOffsetBytes: 0, reachedStart: true };
  }

  const initialEnd = (() => {
    if (typeof params.endOffsetBytes !== 'number' || !Number.isFinite(params.endOffsetBytes)) return fileSize;
    return Math.min(fileSize, Math.max(0, Math.trunc(params.endOffsetBytes)));
  })();
  if (initialEnd <= 0) {
    return { items: [], nextEndOffsetBytes: 0, reachedStart: true };
  }

  const collectedNewestFirst: JsonlParsedLineV1[] = [];
  const malformedPositions: number[] = [];
  let malformedCount = 0;
  let bytesReadTotal = 0;
  let end = initialEnd;
  let carry = Buffer.alloc(0);

  while (end > 0 && collectedNewestFirst.length < maxItems) {
    const remainingBytes = maxBytes - bytesReadTotal;
    const canContinueOversizeFirstLine =
      remainingBytes <= 0 &&
      collectedNewestFirst.length === 0 &&
      carry.length > 0 &&
      carry.length < maxOversizeLineBytes;
    if (remainingBytes <= 0 && !canContinueOversizeFirstLine) break;

    const oversizeRemainingBytes = maxOversizeLineBytes - carry.length;
    const readBudget = canContinueOversizeFirstLine ? oversizeRemainingBytes : remainingBytes;
    const readSize = Math.min(chunkBytes, end, readBudget);
    if (readSize <= 0) break;

    const start = end - readSize;
    const chunk = await fileSystem.read(params.filePath, start, readSize);
    bytesReadTotal += chunk.length;

    const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
    const combinedStartOffset = start;
    const carryStartOffset = end;

    let segmentEndIndex = combined.length;
    for (let index = combined.length - 1; index >= 0 && collectedNewestFirst.length < maxItems; index -= 1) {
      if (combined[index] !== 0x0a) continue;
      const segmentStartIndex = index + 1;
      const segmentEndIndexExclusive = segmentEndIndex;
      const segment = combined.slice(segmentStartIndex, segmentEndIndexExclusive);
      segmentEndIndex = index;

      const startOffsetAbs =
        segmentStartIndex < chunk.length
          ? combinedStartOffset + segmentStartIndex
          : carryStartOffset + (segmentStartIndex - chunk.length);
      const endOffsetAbs =
        segmentEndIndexExclusive < chunk.length
          ? combinedStartOffset + segmentEndIndexExclusive
          : carryStartOffset + (segmentEndIndexExclusive - chunk.length);
      const decoded = decodeSourceLine(segment);
      if (!decoded.ok) {
        malformedCount += 1;
        if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
          malformedPositions.push(startOffsetAbs + decoded.malformedOffsetBytes);
        }
        continue;
      }
      const parsed = parseJsonLine(decoded.value);
      if (parsed === null) continue;
      collectedNewestFirst.push({ value: parsed, startOffsetBytes: startOffsetAbs, endOffsetBytes: endOffsetAbs });
    }

    carry = combined.slice(0, segmentEndIndex);
    end = start;

    if (end === 0 && carry.length > 0 && collectedNewestFirst.length < maxItems) {
      const decoded = decodeSourceLine(carry);
      if (!decoded.ok) {
        malformedCount += 1;
        if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
          malformedPositions.push(decoded.malformedOffsetBytes);
        }
        carry = Buffer.alloc(0);
      } else {
        const parsed = parseJsonLine(decoded.value);
        if (parsed !== null) {
          collectedNewestFirst.push({ value: parsed, startOffsetBytes: 0, endOffsetBytes: carry.length });
          carry = Buffer.alloc(0);
        }
      }
    }
  }

  const items = collectedNewestFirst.reverse();
  // A malformed-only page must still consume the bytes that were inspected.
  // Returning initialEnd here would hand the caller the same cursor forever.
  const nextEndOffsetBytes = items.length > 0 ? items[0]!.startOffsetBytes : end;
  const diagnostics = buildMalformedSourceDiagnostics(malformedCount, malformedPositions);
  return {
    items,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    nextEndOffsetBytes,
    reachedStart: nextEndOffsetBytes <= 0,
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
}>): Promise<Readonly<{
  items: readonly JsonlForwardLineV1[];
  diagnostics?: readonly JsonlSourceDiagnosticV1[];
  nextOffsetBytes: number;
  truncated: boolean;
  reachedEnd: boolean;
}>> {
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
    return { items: [], nextOffsetBytes: 0, truncated: true, reachedEnd: true };
  }

  const offsetBytes = Math.max(0, Math.trunc(params.offsetBytes));
  if (offsetBytes > fileSize) {
    return { items: [], nextOffsetBytes: 0, truncated: true, reachedEnd: true };
  }

  const items: JsonlForwardLineV1[] = [];
  const malformedPositions: number[] = [];
  let malformedCount = 0;
  let bytesReadTotal = 0;
  let carry = Buffer.alloc(0);
  let carryStartOffset = offsetBytes;
  let nextReadOffset = offsetBytes;

  while (nextReadOffset < fileSize && items.length < maxItems) {
    const remainingBytes = maxBytes - bytesReadTotal;
    const canContinueOversizeFirstLine =
      remainingBytes <= 0 &&
      items.length === 0 &&
      carry.length > 0 &&
      carry.length < maxOversizeLineBytes;
    if (remainingBytes <= 0 && !canContinueOversizeFirstLine) break;

    const oversizeRemainingBytes = maxOversizeLineBytes - carry.length;
    const readBudget = canContinueOversizeFirstLine ? oversizeRemainingBytes : remainingBytes;
    const readSize = Math.min(chunkBytes, fileSize - nextReadOffset, readBudget);
    if (readSize <= 0) break;

    const chunk = await fileSystem.read(params.filePath, nextReadOffset, readSize);
    bytesReadTotal += chunk.length;
    nextReadOffset += chunk.length;

    const combinedStartOffset = carryStartOffset;
    const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let lineStartIndex = 0;
    for (let index = 0; index < combined.length && items.length < maxItems; index += 1) {
      if (combined[index] !== 0x0a) continue;

      const line = combined.slice(lineStartIndex, index);
      const decoded = decodeSourceLine(line);
      if (!decoded.ok) {
        malformedCount += 1;
        if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
          malformedPositions.push(combinedStartOffset + lineStartIndex + decoded.malformedOffsetBytes);
        }
        lineStartIndex = index + 1;
        continue;
      }
      const rawLine = decoded.value.trim();
      if (rawLine.length > 0) {
        items.push({
          rawLine,
          value: parseJsonLine(rawLine),
          startOffsetBytes: combinedStartOffset + lineStartIndex,
          endOffsetBytes: combinedStartOffset + index,
        });
      }
      lineStartIndex = index + 1;
    }

    carry = combined.slice(lineStartIndex);
    carryStartOffset = combinedStartOffset + lineStartIndex;
  }

  if (items.length < maxItems && nextReadOffset >= fileSize && carry.length > 0) {
    const decoded = decodeSourceLine(carry);
    if (!decoded.ok) {
      malformedCount += 1;
      if (malformedPositions.length < MAX_SOURCE_DIAGNOSTIC_POSITIONS) {
        malformedPositions.push(carryStartOffset + decoded.malformedOffsetBytes);
      }
      carry = Buffer.alloc(0);
      carryStartOffset = fileSize;
    } else {
      const rawLine = decoded.value.trim();
      if (rawLine.length > 0) {
        items.push({
          rawLine,
          value: parseJsonLine(rawLine),
          startOffsetBytes: carryStartOffset,
          endOffsetBytes: carryStartOffset + carry.length,
        });
        carry = Buffer.alloc(0);
        carryStartOffset = fileSize;
      }
    }
  }

  const reachedEnd = carry.length === 0 && nextReadOffset >= fileSize;
  const diagnostics = buildMalformedSourceDiagnostics(malformedCount, malformedPositions);
  return {
    items,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    nextOffsetBytes: carryStartOffset,
    truncated: false,
    reachedEnd,
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
}>): Promise<Readonly<{
  items: readonly JsonlParsedLineV1[];
  diagnostics?: readonly JsonlSourceDiagnosticV1[];
  nextOffsetBytes: number;
  truncated: boolean;
  reachedEnd: boolean;
}>> {
  const page = await readJsonlFileForwardLines(params);
  return {
    items: page.items.flatMap((line) =>
      line.value === null
        ? []
        : [{
          value: line.value,
          startOffsetBytes: line.startOffsetBytes,
          endOffsetBytes: line.endOffsetBytes,
        }],
    ),
    ...(page.diagnostics === undefined ? {} : { diagnostics: page.diagnostics }),
    nextOffsetBytes: page.nextOffsetBytes,
    truncated: page.truncated,
    reachedEnd: page.reachedEnd,
  };
}
