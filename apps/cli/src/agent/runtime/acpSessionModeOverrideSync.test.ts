import { describe, expect, it, vi } from 'vitest';

import { createAcpSessionModeOverrideSynchronizer } from './acpSessionModeOverrideSync';

describe('createAcpSessionModeOverrideSynchronizer', () => {
  it('queues pending overrides before runtime start and applies after start', async () => {
    let started = false;
    const setSessionMode = vi.fn(async (_modeId: string) => {});

    const sync = createAcpSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 11, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(setSessionMode).not.toHaveBeenCalled();

    started = true;
    await sync.flushPendingAfterStart();
    expect(setSessionMode).toHaveBeenCalledWith('plan');
  });

  it('applies overrides immediately once started', async () => {
    const setSessionMode = vi.fn(async (_modeId: string) => {});

    const sync = createAcpSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 21, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionMode).toHaveBeenCalledWith('plan');
  });

  it('retries the same override when runtime apply fails', async () => {
    let attempt = 0;
    const setSessionMode = vi.fn(async (_modeId: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient failure');
    });

    const sync = createAcpSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 31, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await new Promise((r) => setTimeout(r, 0));

    sync.syncFromMetadata();
    await new Promise((r) => setTimeout(r, 0));

    expect(setSessionMode).toHaveBeenCalledTimes(2);
    expect(setSessionMode).toHaveBeenLastCalledWith('plan');
  });

  it('does not start a concurrent apply while flushPendingAfterStart is in flight', async () => {
    let started = false;
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const setSessionMode = vi.fn(async (_modeId: string) => {
      calls += 1;
      if (calls === 1) return firstCall;
      return Promise.resolve();
    });

    const sync = createAcpSessionModeOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ acpSessionModeOverrideV1: { v: 1, updatedAt: 41, modeId: 'plan' } } as any),
      },
      runtime: { setSessionMode },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    started = true;

    const flushPromise = sync.flushPendingAfterStart();
    sync.syncFromMetadata();
    await Promise.resolve();

    expect(setSessionMode).toHaveBeenCalledTimes(1);

    resolveFirst();
    await flushPromise;
  });
});
