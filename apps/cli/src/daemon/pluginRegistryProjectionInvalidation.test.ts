import { describe, expect, it, vi } from 'vitest';

import type { DaemonState } from '@/api/types';

import { createDaemonPluginRegistryProjectionInvalidation } from './pluginRegistryProjectionInvalidation';

describe('createDaemonPluginRegistryProjectionInvalidation', () => {
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
    invalidation.onDurableRegistryApplied();
    invalidation.onDurableRegistryApplied();
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
    expect(updater(currentState)).toBe(currentState);
  });
});
