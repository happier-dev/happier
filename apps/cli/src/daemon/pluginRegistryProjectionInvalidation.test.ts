import { describe, expect, it, vi } from 'vitest';

import type { DaemonState } from '@/api/types';

import { createDaemonPluginRegistryProjectionInvalidation } from './pluginRegistryProjectionInvalidation';

describe('createDaemonPluginRegistryProjectionInvalidation', () => {
  it('exposes and signals the same projection fact before remote publication completes', () => {
    const onProjectionInvalidated = vi.fn();
    const invalidation = createDaemonPluginRegistryProjectionInvalidation({
      getApiMachine: () => ({
        getContributionRegistryProjectionRevision: () => 17,
        updateDaemonState: async () => { throw new Error('offline'); },
      }),
      isDaemonQuiescing: () => false,
      onPublicationFailure: vi.fn(),
      onProjectionInvalidated,
    });
    expect(invalidation.readRevision()).toBe(17);
    invalidation.invalidateProjection();
    expect(invalidation.readRevision()).toBe(18);
    expect(onProjectionInvalidated).toHaveBeenCalledWith(18);
  });
  it('replays one durable registry invalidation after an aborted handoff resumes', async () => {
    let quiescing = true;
    const updateDaemonState = vi.fn<(
      updater: (state: DaemonState | null) => DaemonState,
    ) => Promise<unknown>>(async () => undefined);
    const invalidation = createDaemonPluginRegistryProjectionInvalidation({
      getApiMachine: () => ({ updateDaemonState }),
      isDaemonQuiescing: () => quiescing,
      onPublicationFailure: vi.fn(),
    });

    // Both applications are already durable; the UI needs only one currentness
    // signal when the original daemon retains its lock after handoff failure.
    invalidation.invalidateProjection();
    invalidation.invalidateProjection();
    expect(updateDaemonState).not.toHaveBeenCalled();

    quiescing = false;
    invalidation.resume();
    invalidation.resume();

    await vi.waitFor(() => {
      expect(updateDaemonState).toHaveBeenCalledOnce();
    });
    const updater = updateDaemonState.mock.calls[0]?.[0];
    if (typeof updater !== 'function') {
      throw new Error('expected daemon-state currentness updater');
    }
    const currentState = Object.freeze({ status: 'running' as const, pid: 17 });
    const first = updater(currentState);
    expect(first).toEqual({ ...currentState, contributionRegistryProjectionRevision: 1 });
    // A CAS retry or unrelated state update publishes the same fact; it does
    // not manufacture a catalog change. Only invalidateProjection advances it.
    const next = updater({ ...first, localServices: { v: 1, state: 'disabled' } });
    expect(next).toEqual({
      ...first,
      localServices: { v: 1, state: 'disabled' },
      contributionRegistryProjectionRevision: 1,
    });
  });
});
