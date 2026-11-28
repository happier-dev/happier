import type { CaptureEvent } from './capture.js';

export type CaptureCoverage = Readonly<{ lostObservations: number; reason: string | null }>;
type WorktreeIdentity = Pick<CaptureEvent, 'physicalRootIdentity'>;
type PartitionCoverage = Readonly<{ coverage: CaptureCoverage }> & WorktreeIdentity;
type ObservationLoss = Readonly<{ count: number }> & WorktreeIdentity;
type RejectedTelemetry = ObservationLoss & Readonly<{ partition: string }>;
type CaptureWriteResult = { accepted: true; changedTraceIds: readonly string[] } | { accepted: false; code: string };
/** One persistence batch at a time. Only request-bound work can wait for the writer. */
export function createCaptureIngest(
 write: (events: readonly CaptureEvent[], changedCoveragePartition?: string) => Promise<readonly string[]>,
 publish: (coverage: CaptureCoverage, partitions: readonly string[]) => void = () => {},
) {
 let pending: Promise<void> | null = null;
 let failure: string | null = null;
 let lostObservations = 0;
 let reason: string | null = null;
 const partitions = new Map<string, PartitionCoverage>();
 const dirtyPartitions = new Set<string>();
 const coverage = (partition?: string): CaptureCoverage => partition === undefined
  ? { lostObservations, reason }
  : { ...partitions.get(partition)?.coverage ?? { lostObservations: 0, reason: null } };
 function addLoss(counts: ReadonlyMap<string, ObservationLoss>, cause: string) {
  for (const [partition, { count, physicalRootIdentity }] of counts) {
   const previous = partitions.get(partition);
   lostObservations += count;
   partitions.set(partition, { physicalRootIdentity: physicalRootIdentity ?? previous?.physicalRootIdentity,
    coverage: { lostObservations: (previous?.coverage.lostObservations ?? 0) + count, reason: cause } });
   dirtyPartitions.add(partition);
  }
  reason = cause;
 }
 function loseEvents(events: readonly CaptureEvent[], cause: string) {
  const counts = new Map<string, ObservationLoss>();
  for (const event of events) {
   const previous = counts.get(event.worktree);
   counts.set(event.worktree, { count: (previous?.count ?? 0) + 1,
    physicalRootIdentity: event.physicalRootIdentity ?? previous?.physicalRootIdentity });
  }
  addLoss(counts, cause);
  publish(coverage(), [...counts.keys()]);
 }
 async function persist(events: readonly CaptureEvent[], rejected?: RejectedTelemetry): Promise<CaptureWriteResult> {
  if (rejected) addLoss(new Map([[rejected.partition, rejected]]), 'invalid_telemetry');
  if (!events.length) {
   if (rejected) publish(coverage(), [rejected.partition]);
   return { accepted: true, changedTraceIds: [] };
  }
  // Accepted and rejected records share the admitted OTLP partition. On failure,
  // loseEvents publishes the loss for that same partition.
  if (failure) { loseEvents(events, failure); return { accepted: false, code: failure }; }
  const snapshots = [...dirtyPartitions].map(partition => ({ partition, snapshot: partitions.get(partition)! }));
  const at = Date.now();
  const markers: CaptureEvent[] = snapshots.map(({ partition, snapshot }) => ({ id: 'coverage', worktree: partition, kind: 'coverage', source: 'capture', at,
   physicalRootIdentity: snapshot.physicalRootIdentity, detail: snapshot.coverage }));
  try {
   const changedTraceIds = await write(markers.length ? [...events, ...markers] : events, rejected?.partition);
   // A loss arriving while this batch commits belongs to the next snapshot.
   for (const { partition, snapshot } of snapshots) if (partitions.get(partition) === snapshot) dirtyPartitions.delete(partition);
   return { accepted: true, changedTraceIds };
  } catch (error: unknown) {
   const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'action_failed';
   failure = code;
   loseEvents(events, code);
   return { accepted: false, code };
  }
 }
 function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = (pending ?? Promise.resolve()).then(operation).finally(() => {
   if (pending === settled) pending = null;
  });
  const settled = result.then(() => {}, () => {});
  pending = settled;
  return result;
 }
 return {
  /** Called inside exclusive admission. */
  write: persist,
  /** The wire relay offers only when idle and never waits for persistence. */
  offer(events: readonly CaptureEvent[]): boolean {
   if (!events.length) return true;
   if (failure) { loseEvents(events, failure); return false; }
   if (pending) { loseEvents(events, 'store_busy'); return false; }
   void exclusive(() => persist(events));
   return true;
  },
  coverage,
  recordLoss(partition: string, cause: string, count = 1, physicalRootIdentity?: string) {
   addLoss(new Map([[partition, { count, physicalRootIdentity }]]), cause);
   publish(coverage(), [partition]);
  },
  pendingWorktreePartitions(physicalRoot: string): string[] {
   return [...dirtyPartitions].filter(partition => partitions.get(partition)?.physicalRootIdentity === physicalRoot);
  },
  /** Called after the owner's successful scoped clear, with its pre-clear snapshot. */
  clearCoverage(partition: string, previousLostCount: number) {
   const current = partitions.get(partition);
   if (!current || !previousLostCount) return;
   const remaining = current.coverage.lostObservations - previousLostCount;
   lostObservations -= previousLostCount;
   if (remaining) {
    partitions.set(partition, { ...current, coverage: { ...current.coverage, lostObservations: remaining } });
    dirtyPartitions.add(partition);
   } else {
    partitions.delete(partition);
    dirtyPartitions.delete(partition);
   }
   if (!lostObservations) reason = null;
   publish(coverage(), [partition]);
  },
  settled(): Promise<void> { return pending ?? Promise.resolve(); },
  exclusive,
  retry() {
   failure = null;
   reason = lostObservations ? 'incomplete_interval' : null;
   const changed: string[] = [];
   for (const [partition, previous] of partitions) {
    if (previous.coverage.reason === 'incomplete_interval') continue;
    partitions.set(partition, { ...previous, coverage: { ...previous.coverage, reason: 'incomplete_interval' } });
    dirtyPartitions.add(partition);
    changed.push(partition);
   }
   if (changed.length) publish(coverage(), changed);
  },
 };
}
