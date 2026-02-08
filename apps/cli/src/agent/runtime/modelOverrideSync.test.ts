import { describe, expect, it, vi } from 'vitest';

import { createModelOverrideSynchronizer } from './modelOverrideSync';

describe('createModelOverrideSynchronizer', () => {
  it('queues pending overrides before runtime start and applies after start', async () => {
    let started = false;
    const setSessionModel = vi.fn(async (_modelId: string) => {});

    const sync = createModelOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'model-b' } } as any),
      },
      runtime: { setSessionModel },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(setSessionModel).not.toHaveBeenCalled();

    started = true;
    await sync.flushPendingAfterStart();
    expect(setSessionModel).toHaveBeenCalledWith('model-b');
  });

  it('applies overrides immediately once started', async () => {
    const setSessionModel = vi.fn(async (_modelId: string) => {});

    const sync = createModelOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 21, modelId: 'model-b' } } as any),
      },
      runtime: { setSessionModel },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionModel).toHaveBeenCalledWith('model-b');
  });

  it('retries overrides when setSessionModel fails', async () => {
    let attempt = 0;
    const setSessionModel = vi.fn(async (_modelId: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient failure');
    });

    const sync = createModelOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 21, modelId: 'model-b' } } as any),
      },
      runtime: { setSessionModel },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    // Allow the fire-and-forget promise to settle.
    await new Promise((r) => setTimeout(r, 0));

    sync.syncFromMetadata();
    await new Promise((r) => setTimeout(r, 0));

    expect(setSessionModel).toHaveBeenCalledTimes(2);
    expect(setSessionModel).toHaveBeenLastCalledWith('model-b');
  });

  it('does not apply pending override twice when flush runs during an active apply', async () => {
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    let calls = 0;
    const setSessionModel = vi.fn(async (_modelId: string) => {
      calls += 1;
      if (calls === 1) return firstCall;
      return Promise.resolve();
    });

    const sync = createModelOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 21, modelId: 'model-b' } } as any),
      },
      runtime: { setSessionModel },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    const flushPromise = sync.flushPendingAfterStart();
    await Promise.resolve();

    expect(setSessionModel).toHaveBeenCalledTimes(1);

    resolveFirst();
    await flushPromise;
  });

  it('serializes concurrent flushPendingAfterStart calls', async () => {
    let started = false;
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    let calls = 0;
    const setSessionModel = vi.fn(async (_modelId: string) => {
      calls += 1;
      if (calls === 1) return firstCall;
      return Promise.resolve();
    });

    const sync = createModelOverrideSynchronizer({
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 31, modelId: 'model-c' } } as any),
      },
      runtime: { setSessionModel },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    started = true;

    const flushA = sync.flushPendingAfterStart();
    await Promise.resolve();
    const flushB = sync.flushPendingAfterStart();

    expect(setSessionModel).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([flushA, flushB]);
    expect(setSessionModel).toHaveBeenCalledTimes(1);
  });
});
