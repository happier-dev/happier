import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/plugin-sdk/sessions/work-state';
import { createCoalescedScheduler } from '@happier-dev/plugin-sdk/async';

import type { WorkflowActivityObservationLike } from './workflowActivityObservation.js';
import type { WorkflowActivityPublisher } from './publishWorkflowActivitySnapshot.js';

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
 * Per-run fingerprint/no-op suppression already lives upstream in the tracker (it reports
 * `changedRunIds` only on material changes), so this layer never needs to diff snapshots; an empty
 * change set is simply a no-op.
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

  const scheduler = createCoalescedScheduler({
    drain: async () => {
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
        scheduleRetry(changedRunIds);
        throw error;
      }
    },
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
    clearDebounce();
    // The generic scheduler owns the only publish loop. Its flush barrier waits for an already
    // active drain and coalesces these pending ids into a follow-up, avoiding a competing direct
    // publish that could return early or race record/headline revision ownership.
    await scheduler.flush();
  }

  function dispose(): void {
    disposed = true;
    clearDebounce();
    pendingChangedRunIds.clear();
    scheduler.dispose();
  }

  return { notify, flush, dispose };
}
