import { z } from 'zod';

import type { HolderReplayPosition, HolderReplayRange } from '@/subprocess/supervision/sessionHolderReplayPosition';

export type CommittedHolderReplayRow = Readonly<{ meta?: unknown; seq?: unknown }>;

export const HOLDER_REPLAY_METADATA_KEY = 'happierHolderReplayV1';

const position = z.object({
  sequence: z.number().int().positive(),
  byteOffset: z.number().int().nonnegative(),
});
const replayMetadata = z.object({
  v: z.literal(1),
  ranges: z.array(z.object({
    holderInstanceId: z.string().min(1),
    start: position,
    end: position,
  })),
});

function comparePosition(left: HolderReplayPosition, right: HolderReplayPosition): number {
  return left.sequence - right.sequence || left.byteOffset - right.byteOffset;
}

export function appendHolderReplayRange(ranges: HolderReplayRange[], range: HolderReplayRange): void {
  const last = ranges.at(-1);
  if (last?.holderInstanceId === range.holderInstanceId && comparePosition(last.end, range.start) === 0) {
    ranges[ranges.length - 1] = { ...last, end: range.end };
  } else {
    ranges.push(range);
  }
}

/** Coverage comes from the existing committed transcript rows at adoption. */
export function readCommittedHolderReplayCoverage(rows: readonly CommittedHolderReplayRow[]) {
  const byHolder = new Map<string, Array<Readonly<{ range: HolderReplayRange; seq?: number }>>>();
  for (const row of rows) {
    if (typeof row.meta !== 'object' || row.meta === null || !(HOLDER_REPLAY_METADATA_KEY in row.meta)) continue;
    const parsed = replayMetadata.safeParse(row.meta[HOLDER_REPLAY_METADATA_KEY]);
    if (!parsed.success) continue;
    for (const range of parsed.data.ranges) {
      if (comparePosition(range.start, range.end) >= 0) continue;
      const ranges = byHolder.get(range.holderInstanceId);
      const committed = { range, ...(typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq >= 0 ? { seq: row.seq } : {}) };
      if (ranges) ranges.push(committed);
      else byHolder.set(range.holderInstanceId, [committed]);
    }
  }

  return (range: HolderReplayRange) => byHolder.get(range.holderInstanceId)?.find(
    committed => comparePosition(committed.range.start, range.start) <= 0
      && comparePosition(committed.range.end, range.end) >= 0,
  );
}
