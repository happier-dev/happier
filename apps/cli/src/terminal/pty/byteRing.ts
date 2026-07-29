import { Buffer } from 'node:buffer';

export type TerminalByteRingChunk = Readonly<{
  seq: number;
  byteOffset: number;
  byteLength: number;
  timestampMs: number;
  bytes: Buffer;
}>;

export type TerminalByteRingGap = Readonly<{
  droppedBeforeByteOffset: number;
  nextAvailableByteOffset: number;
  reason: 'ring_overflow' | 'consumer_too_slow';
}>;

export type TerminalByteRingReadResult = Readonly<{
  chunks: readonly TerminalByteRingChunk[];
  nextByteOffset: number;
  availableByteOffset: number;
  droppedBeforeByteOffset: number;
  totalBytesWritten: number;
  gap?: TerminalByteRingGap;
}>;

export type TerminalByteRing = Readonly<{
  write: (bytes: Uint8Array | Buffer) => TerminalByteRingChunk | null;
  read: (input: Readonly<{ byteOffset: number; maxBytes: number; maxChunks: number }>) => TerminalByteRingReadResult;
  clear: () => void;
  bounds: () => Readonly<{
    availableByteOffset: number;
    totalBytesWritten: number;
    droppedBeforeByteOffset: number;
    chunkCount: number;
    retainedBytes: number;
  }>;
}>;

type StoredChunk = {
  seq: number;
  byteOffset: number;
  bytes: Buffer;
  timestampMs: number;
};

export function createTerminalByteRing(params: Readonly<{
  maxBytes: number;
  maxChunks: number;
  maxAgeMs?: number;
  now?: () => number;
}>): TerminalByteRing {
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxChunks = Math.max(1, Math.trunc(params.maxChunks));
  const maxAgeMs =
    typeof params.maxAgeMs === 'number' && Number.isFinite(params.maxAgeMs)
      ? Math.max(1, Math.trunc(params.maxAgeMs))
      : Number.POSITIVE_INFINITY;
  const now = params.now ?? (() => Date.now());

  let chunks: StoredChunk[] = [];
  let retainedBytes = 0;
  let nextSeq = 0;
  let nextByteOffset = 0;
  let droppedBeforeByteOffset = 0;

  const dropOldest = () => {
    const removed = chunks.shift();
    if (!removed) return false;
    retainedBytes -= removed.bytes.length;
    droppedBeforeByteOffset = Math.max(droppedBeforeByteOffset, removed.byteOffset + removed.bytes.length);
    return true;
  };

  const trim = (currentTimeMs: number) => {
    while (chunks.length && currentTimeMs - chunks[0]!.timestampMs > maxAgeMs) {
      if (!dropOldest()) break;
    }
    while (chunks.length > maxChunks || retainedBytes > maxBytes) {
      if (!dropOldest()) break;
    }
  };

  const write = (input: Uint8Array | Buffer): TerminalByteRingChunk | null => {
    const original = Buffer.from(input);
    if (!original.length) return null;

    const writeOffset = nextByteOffset;
    nextByteOffset += original.length;

    const dropFromChunk = Math.max(0, original.length - maxBytes);
    const bytes = dropFromChunk > 0 ? original.subarray(dropFromChunk) : original;
    const byteOffset = writeOffset + dropFromChunk;
    if (dropFromChunk > 0) {
      droppedBeforeByteOffset = Math.max(droppedBeforeByteOffset, byteOffset);
    }

    const timestampMs = now();
    const stored: StoredChunk = {
      seq: nextSeq,
      byteOffset,
      bytes: Buffer.from(bytes),
      timestampMs,
    };
    nextSeq += 1;
    chunks.push(stored);
    retainedBytes += stored.bytes.length;
    trim(timestampMs);

    return {
      seq: stored.seq,
      byteOffset: stored.byteOffset,
      byteLength: stored.bytes.length,
      timestampMs: stored.timestampMs,
      bytes: Buffer.from(stored.bytes),
    };
  };

  const read = (input: Readonly<{ byteOffset: number; maxBytes: number; maxChunks: number }>): TerminalByteRingReadResult => {
    trim(now());
    const requestedByteOffset = Math.max(0, Math.trunc(input.byteOffset));
    const boundedRequestedByteOffset = Math.min(requestedByteOffset, nextByteOffset);
    const effectiveByteOffset = Math.max(boundedRequestedByteOffset, droppedBeforeByteOffset);
    const boundedMaxBytes = Math.max(1, Math.trunc(input.maxBytes));
    const boundedMaxChunks = Math.max(1, Math.trunc(input.maxChunks));

    const out: TerminalByteRingChunk[] = [];
    let returnedBytes = 0;
    let readToOffset = effectiveByteOffset;

    for (const chunk of chunks) {
      const chunkEnd = chunk.byteOffset + chunk.bytes.length;
      if (chunkEnd <= effectiveByteOffset) continue;
      if (out.length >= boundedMaxChunks) break;

      const startInChunk = Math.max(0, effectiveByteOffset - chunk.byteOffset);
      const remainingBudget = boundedMaxBytes - returnedBytes;
      if (remainingBudget <= 0) break;
      const slice = chunk.bytes.subarray(startInChunk, startInChunk + remainingBudget);
      if (!slice.length) continue;

      const byteOffset = chunk.byteOffset + startInChunk;
      out.push({
        seq: chunk.seq,
        byteOffset,
        byteLength: slice.length,
        timestampMs: chunk.timestampMs,
        bytes: Buffer.from(slice),
      });
      returnedBytes += slice.length;
      readToOffset = byteOffset + slice.length;
      if (returnedBytes >= boundedMaxBytes) break;
    }

    const result: TerminalByteRingReadResult = {
      chunks: out,
      nextByteOffset: out.length ? readToOffset : effectiveByteOffset,
      availableByteOffset: nextByteOffset,
      droppedBeforeByteOffset,
      totalBytesWritten: nextByteOffset,
      ...(requestedByteOffset < droppedBeforeByteOffset
        ? {
            gap: {
              droppedBeforeByteOffset,
              nextAvailableByteOffset: droppedBeforeByteOffset,
              reason: 'ring_overflow' as const,
            },
          }
        : {}),
    };
    return result;
  };

  return {
    write,
    read,
    clear: () => {
      chunks = [];
      retainedBytes = 0;
      droppedBeforeByteOffset = nextByteOffset;
    },
    bounds: () => {
      trim(now());
      return {
        availableByteOffset: nextByteOffset,
        totalBytesWritten: nextByteOffset,
        droppedBeforeByteOffset,
        chunkCount: chunks.length,
        retainedBytes,
      };
    },
  };
}
