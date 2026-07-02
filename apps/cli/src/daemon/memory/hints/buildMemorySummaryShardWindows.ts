import type { MemoryIndexableTranscriptItem } from '../transcript/indexableItem';

export type MemorySummaryShardWindow = Readonly<{
  items: readonly MemoryIndexableTranscriptItem[];
  seqFrom: number;
  seqTo: number;
  createdAtFromMs: number;
  createdAtToMs: number;
}>;

export function buildMemorySummaryShardWindows(params: Readonly<{
  items: readonly MemoryIndexableTranscriptItem[];
  targetShardMessages: number;
  minShardMessages: number;
  targetShardChars: number;
  maxShardChars: number;
}>): MemorySummaryShardWindow[] {
  const minMessages = Math.max(1, Math.trunc(params.minShardMessages));
  const targetMessages = Math.max(minMessages, Math.trunc(params.targetShardMessages));
  const maxChars = Math.max(1, Math.trunc(params.maxShardChars));
  const targetChars = Math.min(maxChars, Math.max(1, Math.trunc(params.targetShardChars)));
  const items = params.items
    .filter((item) => item.text.trim().length > 0)
    .slice()
    .sort((left, right) => left.seq - right.seq);
  const windows: MemorySummaryShardWindow[] = [];
  let buffer: MemoryIndexableTranscriptItem[] = [];
  let bufferChars = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    windows.push({
      items: buffer,
      seqFrom: buffer[0]!.seq,
      seqTo: buffer[buffer.length - 1]!.seq,
      createdAtFromMs: buffer[0]!.createdAtMs,
      createdAtToMs: buffer[buffer.length - 1]!.createdAtMs,
    });
    buffer = [];
    bufferChars = 0;
  };

  for (const item of items) {
    const nextChars = bufferChars + item.textChars;
    const wouldExceedHardChars = buffer.length > 0 && nextChars > maxChars;
    const wouldExceedSoftChars = buffer.length >= minMessages && buffer.length > 0 && nextChars > targetChars;
    const wouldExceedMessages = buffer.length >= targetMessages;
    if (wouldExceedHardChars || wouldExceedSoftChars || wouldExceedMessages) flush();
    buffer.push(item);
    bufferChars += item.textChars;
  }
  flush();

  return windows;
}
