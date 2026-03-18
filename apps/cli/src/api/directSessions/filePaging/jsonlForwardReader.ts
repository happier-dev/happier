import { open, stat } from 'node:fs/promises';

import { tryParseJsonlLine } from './jsonlParse';
import type { JsonlParsedLine } from './jsonlBackwardPager';

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_OVERSIZE_LINE_BYTES = 8 * 1024 * 1024;

export async function readJsonlFileForward(params: Readonly<{
  filePath: string;
  offsetBytes: number;
  maxBytes: number;
  maxItems: number;
  chunkBytes?: number;
  maxOversizeLineBytes?: number;
}>): Promise<Readonly<{
  items: readonly JsonlParsedLine[];
  nextOffsetBytes: number;
  truncated: boolean;
  reachedEnd: boolean;
}>> {
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const chunkBytes = Math.max(1024, Math.trunc(params.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const maxOversizeLineBytes = Math.max(
    maxBytes,
    Math.trunc(params.maxOversizeLineBytes ?? DEFAULT_MAX_OVERSIZE_LINE_BYTES),
  );

  let fileSize = 0;
  try {
    const s = await stat(params.filePath);
    fileSize = s.size;
  } catch {
    return { items: [], nextOffsetBytes: 0, truncated: true, reachedEnd: true };
  }

  const offsetBytes = Math.max(0, Math.trunc(params.offsetBytes));
  if (offsetBytes > fileSize) {
    return { items: [], nextOffsetBytes: 0, truncated: true, reachedEnd: true };
  }

  const fh = await open(params.filePath, 'r');
  const items: JsonlParsedLine[] = [];
  let bytesReadTotal = 0;

  // Carry bytes (after the last newline encountered so far).
  let carry = Buffer.alloc(0);
  let carryStartOffset = offsetBytes;
  let nextReadOffset = offsetBytes;

  try {
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

      const buffer = Buffer.allocUnsafe(readSize);
      const res = await fh.read(buffer, 0, readSize, nextReadOffset);
      const chunk = res.bytesRead > 0 ? buffer.subarray(0, res.bytesRead) : Buffer.alloc(0);
      bytesReadTotal += chunk.length;
      nextReadOffset += chunk.length;

      const combinedStartOffset = carryStartOffset;
      const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;

      let lineStartIndex = 0;
      for (let i = 0; i < combined.length && items.length < maxItems; i++) {
        if (combined[i] !== 0x0a) continue; // '\n'

        const line = combined.slice(lineStartIndex, i);
        const parsed = tryParseJsonlLine(line);
        if (parsed !== null) {
          const startOffsetAbs = combinedStartOffset + lineStartIndex;
          const endOffsetAbs = combinedStartOffset + i;
          items.push({ value: parsed, startOffsetBytes: startOffsetAbs, endOffsetBytes: endOffsetAbs });
        }

        lineStartIndex = i + 1;
      }

      carry = combined.slice(lineStartIndex);
      carryStartOffset = combinedStartOffset + lineStartIndex;
    }

    // Best-effort: parse a trailing line without newline if it appears valid.
    // This helps for completed transcripts that don't end in \n.
    if (items.length < maxItems && nextReadOffset >= fileSize && carry.length > 0) {
      const parsed = tryParseJsonlLine(carry);
      if (parsed !== null) {
        items.push({ value: parsed, startOffsetBytes: carryStartOffset, endOffsetBytes: carryStartOffset + carry.length });
        carry = Buffer.alloc(0);
        carryStartOffset = fileSize;
      }
    }
  } finally {
    await fh.close();
  }

  const reachedEnd = carry.length === 0 && nextReadOffset >= fileSize;
  return { items, nextOffsetBytes: carryStartOffset, truncated: false, reachedEnd };
}
