import { describe, expect, it, vi } from 'vitest';

import { createModelTransitionMetadataObserver } from './modelTransitionMetadataObserver';

describe('createModelTransitionMetadataObserver', () => {
  it('queues pending overrides before runtime start and applies after start', async () => {
    let started = false;
    const setSessionModelSelection = vi.fn(async () => {});

    const sync = createModelTransitionMetadataObserver({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () => ({
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 11,
            selection: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: 'pc_work',
              modelId: 'model-b',
            },
          },
        } as any),
      },
      runtime: { setSessionModelSelection },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(setSessionModelSelection).not.toHaveBeenCalled();

    started = true;
    await sync.flushPendingAfterStart();
    expect(setSessionModelSelection).toHaveBeenCalledWith({
      agentTargetKey: 'backend:codex',
      providerConnectionId: 'pc_work',
      modelId: 'model-b',
    });
  });

  it('applies overrides immediately once started', async () => {
    const setSessionModelSelection = vi.fn(async () => {});

    const sync = createModelTransitionMetadataObserver({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 21, modelId: 'model-b' } } as any),
      },
      runtime: { setSessionModelSelection },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    expect(setSessionModelSelection).toHaveBeenCalledWith({
      agentTargetKey: 'backend:codex',
      providerConnectionId: null,
      modelId: 'model-b',
    });
  });

  it('does not independently retry a durable proposal after the transition owner rejects it', async () => {
    const setSessionModelSelection = vi.fn(async () => {
      throw new Error('transition rejected');
    });

    const sync = createModelTransitionMetadataObserver({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 21, modelId: 'model-b' } } as any),
      },
      runtime: { setSessionModelSelection },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    // Allow the fire-and-forget promise to settle.
    await new Promise((r) => setTimeout(r, 0));

    sync.syncFromMetadata();
    await new Promise((r) => setTimeout(r, 0));

    expect(setSessionModelSelection).toHaveBeenCalledTimes(1);
    expect(setSessionModelSelection).toHaveBeenLastCalledWith({
      agentTargetKey: 'backend:codex',
      providerConnectionId: null,
      modelId: 'model-b',
    });
  });

  it('does not apply pending override twice when flush runs during an active apply', async () => {
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    let calls = 0;
    const setSessionModelSelection = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return firstCall;
      return Promise.resolve();
    });

    const sync = createModelTransitionMetadataObserver({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 21, modelId: 'model-b' } } as any),
      },
      runtime: { setSessionModelSelection },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    const flushPromise = sync.flushPendingAfterStart();
    await Promise.resolve();

    expect(setSessionModelSelection).toHaveBeenCalledTimes(1);

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
    const setSessionModelSelection = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return firstCall;
      return Promise.resolve();
    });

    const sync = createModelTransitionMetadataObserver({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () => ({ modelOverrideV1: { v: 1, updatedAt: 31, modelId: 'model-c' } } as any),
      },
      runtime: { setSessionModelSelection },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    started = true;

    const flushA = sync.flushPendingAfterStart();
    await Promise.resolve();
    const flushB = sync.flushPendingAfterStart();

    expect(setSessionModelSelection).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([flushA, flushB]);
    expect(setSessionModelSelection).toHaveBeenCalledTimes(1);
  });

  it('preserves a clear tombstone timestamp without passing a fake model to the engine', async () => {
    let metadata: any = {
      modelSelectionIntentV1: { v: 1, updatedAt: 30, selection: null },
    };
    const setSessionModelSelection = vi.fn(async () => {});
    const sync = createModelTransitionMetadataObserver({
      agentTargetKey: 'backend:codex',
      session: { getMetadataSnapshot: () => metadata },
      runtime: { setSessionModelSelection },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(setSessionModelSelection).not.toHaveBeenCalled();

    metadata = { modelOverrideV1: { v: 1, updatedAt: 20, modelId: 'older-model' } };
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(setSessionModelSelection).not.toHaveBeenCalled();
  });

  it('refuses canonical selections for another agent target instead of applying the bare id', () => {
    const sync = createModelTransitionMetadataObserver({
      agentTargetKey: 'backend:claude',
      session: {
        getMetadataSnapshot: () => ({
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 31,
            selection: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: 'pc_work',
              modelId: 'wrong-agent-model',
            },
          },
        } as any),
      },
      runtime: { setSessionModelSelection: vi.fn(async () => {}) },
      isStarted: () => true,
    });

    expect(() => sync.syncFromMetadata()).toThrow(/target mismatch/i);
  });
});
