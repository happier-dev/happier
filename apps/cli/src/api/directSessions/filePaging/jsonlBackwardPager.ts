import { open, stat } from 'node:fs/promises';

import { tryParseJsonlLine } from './jsonlParse';
import { assertJsonlReadProgress, resolveJsonlReadBudget } from './jsonlReadBudget';

export type JsonlParsedLine = Readonly<{
  value: unknown;
  startOffsetBytes: number;
  endOffsetBytes: number;
}>;

export async function readJsonlFileBackwardPage(params: Readonly<{
  filePath: string;
  endOffsetBytes: number | null;
  maxBytes: number;
  maxItems: number;
  chunkBytes?: number;
  maxOversizeLineBytes?: number;
  /**
   * Cheap pre-parse test. Rejected lines are consumed without being parsed; the page's
   * terminal line is always parsed so tailOffsetBytes still excludes an incomplete record.
   */
  lineFilter?: (lineBytes: Buffer) => boolean;
}>): Promise<Readonly<{
  items: readonly JsonlParsedLine[];
  nextEndOffsetBytes: number;
  reachedStart: boolean;
  // The consumed boundary at this page's end, excluding any incomplete terminal line.
  // Null means the existing read budget could not locate that line's start.
  tailOffsetBytes: number | null;
}>> {
  const { maxBytes, maxItems, chunkBytes, maxOversizeLineBytes } = resolveJsonlReadBudget(params);

  let fileSize = 0;
  try {
    const s = await stat(params.filePath);
    fileSize = s.size;
  } catch {
    return { items: [], nextEndOffsetBytes: 0, reachedStart: true, tailOffsetBytes: 0 };
  }

  const initialEnd = (() => {
    if (typeof params.endOffsetBytes !== 'number' || !Number.isFinite(params.endOffsetBytes)) return fileSize;
    return Math.min(fileSize, Math.max(0, Math.trunc(params.endOffsetBytes)));
  })();

  if (initialEnd <= 0) {
    return { items: [], nextEndOffsetBytes: 0, reachedStart: true, tailOffsetBytes: 0 };
  }

  const collectedNewestFirst: JsonlParsedLine[] = [];
  let bytesReadTotal = 0;
  let end = initialEnd;
  let carry = Buffer.alloc(0);
  let tailOffsetBytes: number | null = null;
  let oldestConsumedStartOffsetBytes: number | null = null;
  let filteredLineCount = 0;

  const fh = await open(params.filePath, 'r');
  try {
    while (end > 0 && collectedNewestFirst.length < maxItems) {
      const remainingBytes = maxBytes - bytesReadTotal;
      const canContinueOversizeFirstLine =
        remainingBytes <= 0 &&
        collectedNewestFirst.length === 0 &&
        // A filtered line was complete, so the carry is not one oversized first record.
        filteredLineCount === 0 &&
        carry.length > 0 &&
        carry.length < maxOversizeLineBytes;
      if (remainingBytes <= 0 && !canContinueOversizeFirstLine) break;

      const oversizeRemainingBytes = maxOversizeLineBytes - carry.length;
      const readBudget = canContinueOversizeFirstLine ? oversizeRemainingBytes : remainingBytes;
      const readSize = Math.min(chunkBytes, end, readBudget);
      if (readSize <= 0) break;

      const start = end - readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const readRes = await fh.read(buffer, 0, readSize, start);
      const chunk = readRes.bytesRead > 0 ? buffer.subarray(0, readRes.bytesRead) : Buffer.alloc(0);
      bytesReadTotal += chunk.length;

      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      const combinedStartOffset = start;
      const carryStartOffset = end;

      let segmentEndIndex = combined.length;
      // Native newline search: a per-byte JS loop dominated full-file tail scans.
      for (
        let i = combined.lastIndexOf(0x0a, combined.length - 1); // '\n'
        i >= 0 && collectedNewestFirst.length < maxItems;
        i = i > 0 ? combined.lastIndexOf(0x0a, i - 1) : -1
      ) {
        const segmentStartIndex = i + 1;
        const segmentEndIndexExclusive = segmentEndIndex;
        const segment = combined.slice(segmentStartIndex, segmentEndIndexExclusive);
        segmentEndIndex = i;

        const startOffsetAbs =
          segmentStartIndex < chunk.length
            ? combinedStartOffset + segmentStartIndex
            : carryStartOffset + (segmentStartIndex - chunk.length);
        const skipped: boolean = tailOffsetBytes !== null && segment.length > 0
          && params.lineFilter !== undefined && !params.lineFilter(segment);
        if (skipped) filteredLineCount += 1;
        const parsed: unknown = skipped ? null : tryParseJsonlLine(segment);
        oldestConsumedStartOffsetBytes = oldestConsumedStartOffsetBytes === null
          ? startOffsetAbs
          : Math.min(oldestConsumedStartOffsetBytes, startOffsetAbs);
        if (tailOffsetBytes === null) {
          tailOffsetBytes = segment.length === 0 || parsed !== null ? initialEnd : startOffsetAbs;
        }
        if (parsed === null) continue;

        const endOffsetAbs =
          segmentEndIndexExclusive < chunk.length
            ? combinedStartOffset + segmentEndIndexExclusive
            : carryStartOffset + (segmentEndIndexExclusive - chunk.length);

        collectedNewestFirst.push({ value: parsed, startOffsetBytes: startOffsetAbs, endOffsetBytes: endOffsetAbs });
      }

      carry = combined.slice(0, segmentEndIndex);
      end = start;

      if (end === 0 && carry.length > 0 && collectedNewestFirst.length < maxItems) {
        const skipped: boolean = tailOffsetBytes !== null && params.lineFilter !== undefined && !params.lineFilter(carry);
        const parsed: unknown = skipped ? null : tryParseJsonlLine(carry);
        oldestConsumedStartOffsetBytes = 0;
        if (tailOffsetBytes === null) tailOffsetBytes = parsed !== null ? initialEnd : 0;
        if (parsed !== null) {
          collectedNewestFirst.push({ value: parsed, startOffsetBytes: 0, endOffsetBytes: carry.length });
          carry = Buffer.alloc(0);
        } else if (skipped) {
          carry = Buffer.alloc(0);
        }
      }
    }
  } finally {
    await fh.close();
  }

  const items = collectedNewestFirst.reverse();
  // Filtered lines older than the oldest kept item are consumed too; do not reread them.
  const nextEndOffsetBytes = items.length > 0 && params.lineFilter === undefined
    ? items[0].startOffsetBytes
    : (oldestConsumedStartOffsetBytes ?? initialEnd);
  assertJsonlReadProgress({ consumedBytes: initialEnd - nextEndOffsetBytes, remainingSourceBytes: end,
    pendingLineBytes: carry.length, maxLineBytes: maxOversizeLineBytes, direction: 'backward', offsetBytes: initialEnd });
  const reachedStart = nextEndOffsetBytes <= 0;
  return { items, nextEndOffsetBytes, reachedStart, tailOffsetBytes };
}
