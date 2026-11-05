import type { ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';

export type ForgeCiLogAttributionV1 = Readonly<{
  kind: 'step' | 'ambiguous' | 'unattributed';
  stepIds: readonly string[];
}>;
export type ForgeCiLogStepWindowV1 = Pick<ForgeCiStepV1, 'id' | 'startedAtMs' | 'completedAtMs' | 'timestampPrecision'>;
const UNATTRIBUTED: ForgeCiLogAttributionV1 = Object.freeze({ kind: 'unattributed', stepIds: [] });

/** Native timestamps and their declared precision establish candidates; names and order never do. */
export function segmentForgeCiLogTimestampsV1(
  timestamps: readonly (number | null)[],
  steps: readonly ForgeCiLogStepWindowV1[],
): ReadonlyMap<number, ForgeCiLogAttributionV1> {
  const windows = steps.flatMap((step, order) => {
    if (step.startedAtMs === undefined || step.completedAtMs === undefined || !(step.completedAtMs >= step.startedAtMs)) return [];
    const resolution = step.timestampPrecision === 'second' ? 1000 : 1;
    return [{ id: step.id, start: Math.floor(step.startedAtMs / resolution) * resolution,
      end: (Math.floor(step.completedAtMs / resolution) + 1) * resolution - 1, order }];
  });
  const starts = [...windows].sort((a, b) => a.start - b.start);
  const ends = [...windows].sort((a, b) => a.end - b.end);
  const active = new Map<string, typeof windows[number]>();
  const result = new Map<number, ForgeCiLogAttributionV1>();
  let start = 0;
  let end = 0;
  for (const timestamp of [...new Set(timestamps.filter((value): value is number => value !== null))].sort((a, b) => a - b)) {
    while (start < starts.length && starts[start]!.start <= timestamp) {
      const window = starts[start++]!;
      active.set(window.id, window);
    }
    while (end < ends.length && ends[end]!.end < timestamp) active.delete(ends[end++]!.id);
    const ids = [...active.values()].sort((a, b) => a.order - b.order).map(window => window.id);
    result.set(timestamp, ids.length === 0 ? UNATTRIBUTED : { kind: ids.length === 1 ? 'step' : 'ambiguous', stepIds: ids });
  }
  return result;
}

export function readForgeCiLogAttributionV1(timestampMs: number | null, attributions: ReadonlyMap<number, ForgeCiLogAttributionV1>): ForgeCiLogAttributionV1 {
  return timestampMs === null ? UNATTRIBUTED : attributions.get(timestampMs) ?? UNATTRIBUTED;
}
