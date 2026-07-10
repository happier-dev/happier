import { describe, expect, it, vi } from 'vitest';

import { createSessionClientMaterializationRuntime } from './createSessionClientMaterializationRuntime';

describe('createSessionClientMaterializationRuntime', () => {
  type RuntimeDeps = Parameters<typeof createSessionClientMaterializationRuntime>[0];

  function createRuntime(overrides: Partial<RuntimeDeps> = {}) {
	    return createSessionClientMaterializationRuntime({
	      forgetMaterializationRecovery: vi.fn(),
	      onKeepAliveStateMayHaveChanged: vi.fn(),
	      initialPendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
	      ...overrides,
	    });
  }

  it('keeps active-turn pending materialization blocked even when the host steer intake is open', () => {
    const runtime = createRuntime({
      initialLatestTurnStatus: 'in_progress',
    });

    expect(runtime.shouldAttemptPendingMaterialization()).toBe(false);
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

  it('keeps active-turn pending materialization blocked by the turn boundary owner', () => {
    const runtime = createRuntime({
      initialLatestTurnStatus: 'in_progress',
    });

    expect(runtime.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('treats daemon-observed end_session settlement as terminal pending-drain state', () => {
    const runtime = createRuntime();

    expect(runtime.observeSessionTurnMutationAction('begin', 100)).toEqual({ isTerminal: false });
    expect(runtime.hasActiveLocalTurn()).toBe(true);
    expect(runtime.getLatestTurnStatus()).toBe('in_progress');
    expect(runtime.getLatestTurnStatusObservedAt()).toBe(100);
    expect(runtime.shouldAttemptPendingMaterialization()).toBe(false);
    expect(runtime.shouldForceRefreshStaleBlockedTurnStatus()).toBe(false);

	    expect(runtime.observeSessionTurnMutationAction('end_session', 200)).toEqual({ isTerminal: true });
	    expect(runtime.hasActiveLocalTurn()).toBe(false);
	    expect(runtime.getLatestTurnStatus()).toBe('cancelled');
	    expect(runtime.getLatestTurnStatusObservedAt()).toBe(200);
	    expect(runtime.shouldForceRefreshStaleBlockedTurnStatus()).toBe(false);
	    expect(runtime.shouldAttemptPendingMaterialization()).toBe(true);

	    expect(runtime.observeMaterializeResult({ didMaterialize: true })).toBe(true);
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

  it('keeps agent-queue echo suppression until explicitly cleared', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime();

      runtime.markAgentQueueEchoSuppressedLocalId('local-1');
      expect(runtime.hasAgentQueueEchoSuppressedLocalId('local-1')).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(runtime.hasAgentQueueEchoSuppressedLocalId('local-1')).toBe(true);

      runtime.clearAgentQueueEchoSuppressedLocalId('local-1');
      expect(runtime.hasAgentQueueEchoSuppressedLocalId('local-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
