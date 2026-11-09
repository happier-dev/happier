import { describe, expect, it, vi } from 'vitest';

import { createSessionClientMaterializationRuntime } from './createSessionClientMaterializationRuntime';
import { readLatestTurnStatusSnapshot } from '../../sessionTurnStatusSnapshot';

describe('createSessionClientMaterializationRuntime', () => {
  type RuntimeDeps = Parameters<typeof createSessionClientMaterializationRuntime>[0];

  function createRuntime(overrides: Partial<RuntimeDeps> = {}) {
	    return createSessionClientMaterializationRuntime({
	      onKeepAliveStateMayHaveChanged: vi.fn(),
	      initialPendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
	      ...overrides,
	    });
  }

  it('retains exact Pending custody until settlement without per-input expiry', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime();
      const timersBefore = vi.getTimerCount();
      runtime.markPendingQueueMaterializedLocalId('late-echo');
      expect(vi.getTimerCount()).toBe(timersBefore);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(runtime.hasMaterializedLocalId('late-echo')).toBe(true);
      expect(runtime.shouldKeepUserSocketConnected({
        hasProviderInputConsumer: false, hasMetadataWaiters: false,
      })).toBe(true);
      runtime.deleteMaterializedLocalId('late-echo');
      expect(runtime.hasMaterializedLocalId('late-echo')).toBe(false);
      expect(runtime.shouldKeepUserSocketConnected({
        hasProviderInputConsumer: false, hasMetadataWaiters: false,
      })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves active-turn delivery authority with the server Pending owner', () => {
    const runtime = createRuntime({
      initialLatestTurnStatus: 'in_progress',
    });

    expect(runtime.shouldAttemptPendingMaterialization()).toBe(true);
    expect(runtime.getPendingClaimForegroundState(false)).toBe('active_unsteerable');
    expect(runtime.getPendingClaimForegroundState(true)).toBe('active_steerable');
  });

  it('projects local turn begin and completion into claim facts without skipping server admission', () => {
    const runtime = createRuntime({ initialLatestTurnStatus: 'completed' });
    expect(runtime.getPendingClaimForegroundState(true)).toBe('ready');
    runtime.observeSessionTurnMutationAction('begin', 100);
    runtime.applyLatestTurnStatus('completed', 99);
    expect(runtime.getPendingClaimForegroundState(false)).toBe('active_unsteerable');
    expect(runtime.shouldAttemptPendingMaterialization()).toBe(true);
    runtime.observeSessionTurnMutationAction('complete', 200);
    expect(runtime.getPendingClaimForegroundState(true)).toBe('ready');
  });

  it('does not attempt materialization when every queued pending row is blocked', () => {
    const runtime = createRuntime({
      initialPendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 1,
        pendingVersion: 3,
      },
    });

    expect(runtime.shouldAttemptPendingMaterialization()).toBe(false);
    expect(runtime.shouldRefreshTurnStatusBeforePendingMaterialization()).toBe(false);
    expect(runtime.shouldForceRefreshStaleBlockedTurnStatus()).toBe(false);
  });

  it('treats daemon-observed end_session settlement as terminal pending-drain state', () => {
    const runtime = createRuntime();

    expect(runtime.observeSessionTurnMutationAction('begin', 100)).toEqual({ isTerminal: false });
    expect(runtime.hasActiveLocalTurn()).toBe(true);
    expect(runtime.getLatestTurnStatus()).toBe('in_progress');
    expect(runtime.getLatestTurnStatusObservedAt()).toBe(100);
    expect(runtime.shouldAttemptPendingMaterialization()).toBe(true);
    expect(runtime.shouldForceRefreshStaleBlockedTurnStatus()).toBe(false);

	    expect(runtime.observeSessionTurnMutationAction('end_session', 200)).toEqual({ isTerminal: true });
	    expect(runtime.hasActiveLocalTurn()).toBe(false);
	    expect(runtime.getLatestTurnStatus()).toBe('cancelled');
	    expect(runtime.getLatestTurnStatusObservedAt()).toBe(200);
	    expect(runtime.shouldForceRefreshStaleBlockedTurnStatus()).toBe(false);
	    expect(runtime.shouldAttemptPendingMaterialization()).toBe(true);

	    expect(runtime.applyPendingQueueState({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 })).toBe(true);
	    expect(runtime.getPendingQueueState()).toEqual({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 });
	    expect(runtime.shouldAttemptPendingMaterialization()).toBe(false);
	  });

  it('exposes only complete latest-turn snapshots to transport consumers', () => {
    const runtime = createRuntime({
      initialLatestTurnStatus: 'completed',
      initialLatestTurnStatusObservedAt: 123,
    });

    expect(runtime.getLatestTurnSnapshot()).toEqual({
      status: 'completed',
      observedAt: 123,
    });

    runtime.applyLatestTurnStatus(null, 234);
    expect(runtime.getLatestTurnSnapshot()).toBeNull();

    runtime.applyLatestTurnStatus('failed');
    expect(runtime.getLatestTurnSnapshot()).toBeNull();

    runtime.applyLatestTurnStatus('failed', 345);
    expect(runtime.getLatestTurnSnapshot()).toEqual({
      status: 'failed',
      observedAt: 345,
    });
  });

  it('releases the asking turn for returned information and clears waiting on the next begin', () => {
    const runtime = createRuntime();
    runtime.observeSessionTurnMutationAction('begin', 100);
    expect(runtime.observeSessionTurnMutationAction('wait', 200)).toEqual({ isTerminal: true });
    expect(runtime.getLatestTurnSnapshot()).toEqual({ status: 'waiting', observedAt: 200 });
    expect(runtime.hasActiveLocalTurn()).toBe(false);
    expect(runtime.shouldAttemptPendingMaterialization()).toBe(true);
    // Snapshot/reconnect must preserve the same typed state as the local owner.
    expect(readLatestTurnStatusSnapshot('waiting')).toBe('waiting');
    runtime.observeSessionTurnMutationAction('begin', 300);
    expect(runtime.getLatestTurnSnapshot()).toEqual({ status: 'in_progress', observedAt: 300 });
    expect(runtime.hasActiveLocalTurn()).toBe(true);
  });

  it('rejects an older remote turn projection after a newer local terminal event', () => {
    const runtime = createRuntime();

    runtime.observeSessionTurnMutationAction('begin', 100);
    runtime.observeSessionTurnMutationAction('complete', 200);
    runtime.applyLatestTurnStatus('in_progress', 150);

    expect(runtime.getLatestTurnSnapshot()).toEqual({
      status: 'completed',
      observedAt: 200,
    });
  });

  it('does not let a remote status without observation time overwrite timestamped local evidence', () => {
    const runtime = createRuntime();

    runtime.observeSessionTurnMutationAction('complete', 200);
    runtime.applyLatestTurnStatus('in_progress');

    expect(runtime.getLatestTurnSnapshot()).toEqual({
      status: 'completed',
      observedAt: 200,
    });
  });

  it('accepts a genuinely newer remote in-progress projection', () => {
    const runtime = createRuntime();

    runtime.observeSessionTurnMutationAction('complete', 200);
    runtime.applyLatestTurnStatus('in_progress', 300);

    expect(runtime.getLatestTurnSnapshot()).toEqual({
      status: 'in_progress',
      observedAt: 300,
    });
  });
});
