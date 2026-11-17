import type { CaptureEvent } from './capture.js';

export type CaptureCoverage = Readonly<{ lostObservations: number; reason: string | null }>;
/** One persistence batch, no replay queue and no awaited store call on the wire relay. */
export function createCaptureIngest(write: (events: readonly CaptureEvent[]) => Promise<void>, publish: (coverage: CaptureCoverage, partitions: readonly string[]) => void = () => {}) {
 let pending: Promise<void> | null = null;
 let failure: string | null = null;
 let lostObservations = 0;
 let reason: string | null = null;
 const partitions = new Map<string, CaptureCoverage>();
 const dirtyPartitions = new Set<string>();
 const coverage = (partition?: string): CaptureCoverage => partition === undefined
  ? { lostObservations, reason }
  : { ...partitions.get(partition) ?? { lostObservations: 0, reason: null } };
 function lose(counts: ReadonlyMap<string, number>, cause: string) {
  for (const [partition, count] of counts) {
   lostObservations += count;
   partitions.set(partition, { lostObservations: (partitions.get(partition)?.lostObservations ?? 0) + count, reason: cause });
   dirtyPartitions.add(partition);
  }
  reason = cause;
  publish(coverage(), [...counts.keys()]);
 }
 function loseEvents(events: readonly CaptureEvent[], cause: string) {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.worktree, (counts.get(event.worktree) ?? 0) + 1);
  lose(counts, cause);
 }
 async function persist(events: readonly CaptureEvent[]): Promise<{ accepted: true } | { accepted: false; code: string }> {
  if (!events.length) return { accepted: true };
  if (failure) { loseEvents(events, failure); return { accepted: false, code: failure }; }
  const snapshots = [...dirtyPartitions].map(partition => ({ partition, snapshot: partitions.get(partition)! }));
  const at = Date.now();
  const markers: CaptureEvent[] = snapshots.map(({ partition, snapshot }) => ({ id: 'coverage', worktree: partition, kind: 'coverage', source: 'capture', at, detail: snapshot }));
  try {
   await write(markers.length ? [...events, ...markers] : events);
   // A loss arriving while this batch commits belongs to the next snapshot.
   for (const { partition, snapshot } of snapshots) if (partitions.get(partition) === snapshot) dirtyPartitions.delete(partition);
   return { accepted: true };
  } catch (error: unknown) {
   const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed';
   failure = code;
   loseEvents(events, code);
   return { accepted: false, code };
  }
 }
 return {
  /** Called inside exclusive admission; local observation offers use the same persistence owner. */
  write: persist,
  offer(events: readonly CaptureEvent[]): boolean {
   if (!events.length) return true;
   if (pending || failure) { loseEvents(events, failure ?? 'store_busy'); return false; }
   pending = Promise.resolve().then(() => persist(events)).then(() => {}).finally(() => { pending = null; });
   return true;
  },
  coverage,
  recordLoss(partition: string, cause: string, count = 1) { lose(new Map([[partition, count]]), cause); },
  /** Called after the owner's successful scoped clear, with its pre-clear snapshot. */
  clearCoverage(partition: string, previousLostCount: number) {
   const current = partitions.get(partition);
   if (!current || !previousLostCount) return;
   const remaining = current.lostObservations - previousLostCount;
   lostObservations -= previousLostCount;
   if (remaining) {
    partitions.set(partition, { lostObservations: remaining, reason: current.reason });
    dirtyPartitions.add(partition);
   } else {
    partitions.delete(partition);
    dirtyPartitions.delete(partition);
   }
   if (!lostObservations) reason = null;
   publish(coverage(), [partition]);
  },
  settled(): Promise<void> { return pending ?? Promise.resolve(); },
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
   while (pending) await pending;
   const operationResult = Promise.resolve().then(operation);
   pending = operationResult.then(() => {}, () => {}).finally(() => { pending = null; });
   return operationResult;
  },
  retry() {
   failure = null;
   reason = lostObservations ? 'incomplete_interval' : null;
   const changed: string[] = [];
   for (const [partition, previous] of partitions) {
    if (previous.reason === 'incomplete_interval') continue;
    partitions.set(partition, { ...previous, reason: 'incomplete_interval' });
    dirtyPartitions.add(partition);
    changed.push(partition);
   }
   publish(coverage(), changed);
  },
 };
}
