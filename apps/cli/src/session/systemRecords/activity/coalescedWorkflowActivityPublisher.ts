import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import { isPermanentRequestError } from '@/api/client/httpStatusError';
import { createCoalescedScheduler } from '@/utils/coalescedScheduler';

import type { WorkflowActivityObservationLike } from './workflowActivityObservation';
import type { WorkflowActivityPublisher } from './publishWorkflowActivitySnapshot';

/**
 * Coalescing/scheduling wrapper around the per-run workflow activity publisher (CWF3).
 *
 * The single choke point for write-rate control. It reuses the generic `createCoalescedScheduler`
 * (one in-flight drain, follow-up coalesced) and layers workflow-specific semantics on top:
 *
 * - Debounce progress-only updates with a latest-wins delay so a progress burst becomes one write.
 * - Bypass the debounce and publish immediately on UX-relevant transitions: run start, status-class
 *   change, or terminal status — so the UI discovers runs and terminal outcomes promptly.
 * - Accumulate changed run ids across notifies so the eventual publish carries every dirty run.
 * - `flush()` drains pending work immediately (terminal flush / stream close / session finalization).
 * - `dispose()` stops scheduling.
 *
 * Per-run fingerprint/no-op suppression already lives upstream in the tracker, which reports
 * `changedRunIds` only for material changes, so this layer never needs to diff snapshots; an empty
 * change set is simply a no-op. The durable publisher owns record revisions.
 */
export type CoalescedWorkflowActivityPublisher = Readonly<{
  /** Record a tracker observation. Triggers an immediate or debounced publish. */
  notify(observation: WorkflowActivityObservationLike): void;
  /** Drain any pending changes immediately (terminal/stream-close/shutdown). */
  flush(): Promise<void>;
  /** Stop scheduling. */
  dispose(): void;
}>;

export function createCoalescedWorkflowActivityPublisher(params: Readonly<{
  publisher: WorkflowActivityPublisher;
  getSnapshots: () => ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}>): CoalescedWorkflowActivityPublisher {
  const debounceMs = params.debounceMs ?? 300;
  const pendingChangedRunIds = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // The currently-running publish drain (scheduler- OR flush-driven). `flush()` awaits this so a
  // caller that needs the terminal write to have LANDED (startup reconciliation, stream close,
  // shutdown) never returns while a `notify`-triggered immediate drain is still mid-publish — the
  // scheduler fires drains fire-and-forget, so without this a `flush()` racing an in-flight drain
  // would see an already-cleared pending set and return before the headline write completed.
  let inFlightDrain: Promise<void> | null = null;

  const runPublishDrain = async (): Promise<void> => {
    if (disposed) return;
    if (pendingChangedRunIds.size === 0) return;
    const changedRunIds = [...pendingChangedRunIds];
    pendingChangedRunIds.clear();
    try {
      const result = await params.publisher.publish({
        snapshots: params.getSnapshots(),
        changedRunIds,
      });
      scheduleRetry(result.failedRunIds);
    } catch (error) {
      // A drain-level throw is the headline write (or an unexpected fault), so the run partition
      // the publisher computes never happened. The SAME rule decides it: a refusal the server will
      // repeat is dropped rather than re-queued, or this becomes a debounce-interval write loop for
      // the session's lifetime. New evidence still produces a fresh attempt via `notify`.
      if (!isPermanentRequestError(error)) scheduleRetry(changedRunIds);
      throw error;
    }
  };

  const trackedPublishDrain = (): Promise<void> => {
    const drain = runPublishDrain();
    const tracked = drain.finally(() => {
      if (inFlightDrain === tracked) inFlightDrain = null;
    });
    inFlightDrain = tracked;
    return tracked;
  };

  const scheduler = createCoalescedScheduler({
    drain: trackedPublishDrain,
    onError: params.onError,
  });

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function triggerNow(): void {
    clearDebounce();
    scheduler.trigger();
  }

  function scheduleRetry(runIds: readonly string[]): void {
    if (disposed || runIds.length === 0) return;
    for (const runId of runIds) pendingChangedRunIds.add(runId);
    if (pendingChangedRunIds.size === 0 || debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scheduler.trigger();
    }, debounceMs);
  }

  function notify(observation: WorkflowActivityObservationLike): void {
    if (disposed) return;
    for (const runId of observation.changedRunIds) pendingChangedRunIds.add(runId);
    if (pendingChangedRunIds.size === 0) return;

    const immediate =
      observation.startedRunIds.length > 0
      || observation.statusChangedRunIds.length > 0
      || observation.terminalRunIds.length > 0;

    if (immediate) {
      triggerNow();
      return;
    }
    // Progress-only: latest-wins debounce.
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scheduler.trigger();
    }, debounceMs);
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    // Drain to quiescence. `notify` fires scheduler drains fire-and-forget, and each drain may
    // schedule a follow-up (a `do/while` re-drain for triggers that arrived mid-publish, or a
    // `scheduleRetry` debounce). A single await/drain would return while later terminal writes are
    // still pending, leaving the headline stuck at an early snapshot. So: cancel any debounce timer,
    // await the in-flight drain so its writes LAND, then drain any work that surfaced — repeat until
    // no drain is running and nothing is pending. A hard iteration cap guards against a pathological
    // publisher that never settles (it would only ever drop trailing retries, never lose committed
    // state, since the headline is rebuilt from committed runs on every publish).
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      if (disposed) return;
      clearDebounce();
      if (inFlightDrain) {
        await inFlightDrain;
        continue;
      }
      if (pendingChangedRunIds.size === 0) return;
      await trackedPublishDrain();
    }
  }

  function dispose(): void {
    disposed = true;
    clearDebounce();
    pendingChangedRunIds.clear();
    scheduler.dispose();
  }

  return { notify, flush, dispose };
}
