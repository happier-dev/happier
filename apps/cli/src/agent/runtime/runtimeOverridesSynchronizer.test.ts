import { describe, expect, it, vi } from 'vitest';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';

import {
  initializeRuntimeOverridesSynchronizer,
  setupRuntimeMetadataDrivenOverridesSync,
} from './runtimeOverridesSynchronizer';

describe('initializeRuntimeOverridesSynchronizer', () => {
  it('prefers newer transcript intent over older metadata when seeding attach sessions', async () => {
    const fetchLatestUserPermissionIntentFromTranscript = vi.fn(async () => ({ intent: 'safe-yolo' as any, updatedAt: 20 }));

    const sync = await initializeRuntimeOverridesSynchronizer({
      agentTargetKey: 'backend:codex',
      explicitPermissionMode: undefined,
      sessionKind: 'attach',
      session: {
        getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 10 } as any),
        fetchLatestUserPermissionIntentFromTranscript,
      },
      permissionMode: { current: 'default', updatedAt: 0 },
      modelOverride: { current: null, updatedAt: 0 },
    });

    await sync.seedFromSession();

    expect(fetchLatestUserPermissionIntentFromTranscript).toHaveBeenCalledTimes(1);
    expect(sync.getSnapshot().permissionMode.current).toBe('safe-yolo');
    expect(sync.getSnapshot().permissionMode.updatedAt).toBe(20);
  });

  it('does not fetch transcript intent for fresh sessions when seeding permission mode', async () => {
    const fetchLatestUserPermissionIntentFromTranscript = vi.fn(async () => {
      throw new Error('should not fetch transcript for fresh sessions');
    });

    const onPermissionModeApplied = vi.fn();

    const sync = await initializeRuntimeOverridesSynchronizer({
      agentTargetKey: 'backend:codex',
      explicitPermissionMode: undefined,
      sessionKind: 'fresh',
      session: {
        getMetadataSnapshot: () => ({ permissionMode: 'yolo', permissionModeUpdatedAt: 30 } as any),
        fetchLatestUserPermissionIntentFromTranscript,
      },
      permissionMode: { current: 'default', updatedAt: 0 },
      modelOverride: { current: null, updatedAt: 0 },
      onPermissionModeApplied,
    });

    await sync.seedFromSession();

    expect(fetchLatestUserPermissionIntentFromTranscript).not.toHaveBeenCalled();
    expect(sync.getSnapshot().permissionMode.current).toBe('yolo');
    expect(sync.getSnapshot().permissionMode.updatedAt).toBe(30);
    expect(onPermissionModeApplied).toHaveBeenCalledTimes(1);
  });

  it('does not override explicit permission mode from metadata updates', async () => {
    const onPermissionModeApplied = vi.fn();

    const sync = await initializeRuntimeOverridesSynchronizer({
      agentTargetKey: 'backend:codex',
      explicitPermissionMode: 'plan' as any,
      sessionKind: 'attach',
      session: {
        getMetadataSnapshot: () =>
          ({
            permissionMode: 'yolo',
            permissionModeUpdatedAt: 999,
            modelSelectionIntentV1: {
              v: 1,
              updatedAt: 50,
              selection: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: 'pc_work',
                modelId: 'gpt-4.1',
              },
            },
          } as any),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'yolo' as any, updatedAt: 1000 }),
      },
      permissionMode: { current: 'default', updatedAt: 0 },
      modelOverride: { current: null, updatedAt: 0 },
      onPermissionModeApplied,
    });

    await sync.seedFromSession();
    const afterSeed = sync.getSnapshot().permissionMode;
    expect(afterSeed.current).toBe('plan');

    sync.syncFromMetadata();
    const afterMetadata = sync.getSnapshot().permissionMode;
    expect(afterMetadata.current).toBe('plan');
    expect(sync.getSnapshot().modelOverride.current).toEqual({
      agentTargetKey: 'backend:codex',
      providerConnectionId: 'pc_work',
      modelId: 'gpt-4.1',
    });
    expect(onPermissionModeApplied).toHaveBeenCalledTimes(1);
  });

  it('syncs permission mode and model override from metadata when newer', async () => {
    const session = {
      getMetadataSnapshot: () =>
        ({
          permissionMode: 'acceptEdits',
          permissionModeUpdatedAt: 20,
          modelOverrideV1: { v: 1, updatedAt: 50, modelId: 'gpt-4.1' },
        }) as any,
      fetchLatestUserPermissionIntentFromTranscript: async () => null,
    };

    const onPermissionModeApplied = vi.fn();
    const onModelOverrideApplied = vi.fn();

    const sync = await initializeRuntimeOverridesSynchronizer({
      agentTargetKey: 'backend:codex',
      explicitPermissionMode: undefined,
      sessionKind: 'attach',
      session,
      permissionMode: { current: 'default', updatedAt: 10 },
      modelOverride: { current: null, updatedAt: 0 },
      onPermissionModeApplied,
      onModelOverrideApplied,
    });

    sync.syncFromMetadata();

    expect(sync.getSnapshot().permissionMode.current).toBe('safe-yolo');
    expect(sync.getSnapshot().permissionMode.updatedAt).toBe(20);
    expect(sync.getSnapshot().modelOverride.current).toEqual({
      agentTargetKey: 'backend:codex',
      providerConnectionId: null,
      modelId: 'gpt-4.1',
    });
    expect(sync.getSnapshot().modelOverride.updatedAt).toBe(50);
    expect(onPermissionModeApplied).toHaveBeenCalledTimes(1);
    expect(onModelOverrideApplied).toHaveBeenCalledTimes(1);
  });
});

describe('setupRuntimeMetadataDrivenOverridesSync', () => {
  it('performs an immediate shared metadata sync and persists startup overrides without waiting for transcript seeding', async () => {
    let resolveTranscriptSeed: ((value: { intent: any; updatedAt: number } | null) => void) | undefined;
    const persistStartupOverridesCache = vi.fn();

    const permissionMode = { current: 'default' as any, updatedAt: 0 };
    const modelOverride = { current: null as ProviderBoundModelRef | null, updatedAt: 0 };

    await setupRuntimeMetadataDrivenOverridesSync({
      agentTargetKey: 'backend:codex',
      explicitPermissionMode: undefined,
      sessionKind: 'attach',
      session: {
        getMetadataSnapshot: () =>
          ({
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 11,
            modelOverrideV1: { v: 1, updatedAt: 12, modelId: 'gpt-4.1' },
          }) as any,
        fetchLatestUserPermissionIntentFromTranscript: () =>
          new Promise((resolve) => {
            resolveTranscriptSeed = resolve;
          }),
        waitForMetadataUpdate: async () => false,
      },
      permissionMode,
      modelOverride,
      persistStartupOverridesCache,
      shouldExit: () => true,
      getAbortSignal: () => undefined,
    });

    expect(permissionMode).toEqual({ current: 'safe-yolo', updatedAt: 11 });
    expect(modelOverride).toEqual({
      current: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'gpt-4.1',
      },
      updatedAt: 12,
    });
    expect(persistStartupOverridesCache).toHaveBeenCalledTimes(1);

    if (resolveTranscriptSeed) {
      resolveTranscriptSeed(null);
    }
    await Promise.resolve();
  });

  it('replays metadata updates through the shared watcher loop', async () => {
    let metadata = {
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      modelOverrideV1: { v: 1, updatedAt: 2, modelId: 'gpt-4o-mini' },
    } as any;
    let shouldExit = false;
    let waitCalls = 0;

    const permissionMode = { current: 'default' as any, updatedAt: 0 };
    const modelOverride = { current: null as ProviderBoundModelRef | null, updatedAt: 0 };

    await setupRuntimeMetadataDrivenOverridesSync({
      agentTargetKey: 'backend:codex',
      explicitPermissionMode: undefined,
      sessionKind: 'fresh',
      session: {
        getMetadataSnapshot: () => metadata,
        fetchLatestUserPermissionIntentFromTranscript: async () => null,
        waitForMetadataUpdate: async () => {
          waitCalls += 1;
          metadata = {
            permissionMode: 'plan',
            permissionModeUpdatedAt: 20,
            modelOverrideV1: { v: 1, updatedAt: 21, modelId: 'gpt-5' },
          } as any;
          shouldExit = true;
          return waitCalls === 1;
        },
      },
      permissionMode,
      modelOverride,
      persistStartupOverridesCache: () => {},
      shouldExit: () => shouldExit,
      getAbortSignal: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(permissionMode).toEqual({ current: 'plan', updatedAt: 20 });
    expect(modelOverride).toEqual({
      current: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'gpt-5',
      },
      updatedAt: 21,
    });
  });

  it('retries metadata watching after transient waitForMetadataUpdate failures', async () => {
    vi.useFakeTimers();
    try {
      let shouldExit = false;
      let attempts = 0;

      await setupRuntimeMetadataDrivenOverridesSync({
        agentTargetKey: 'backend:codex',
        explicitPermissionMode: undefined,
        sessionKind: 'fresh',
        session: {
          getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 1 } as any),
          fetchLatestUserPermissionIntentFromTranscript: async () => null,
          waitForMetadataUpdate: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('transient metadata wait failure');
            }
            shouldExit = true;
            return false;
          },
        },
        permissionMode: { current: 'default' as any, updatedAt: 0 },
        modelOverride: { current: null, updatedAt: 0 },
        persistStartupOverridesCache: () => {},
        shouldExit: () => shouldExit,
        getAbortSignal: () => undefined,
      });

      await Promise.resolve();
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(25);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off after non-aborted metadata waits resolve false', async () => {
    vi.useFakeTimers();
    try {
      let shouldExit = false;
      let attempts = 0;

      await setupRuntimeMetadataDrivenOverridesSync({
        agentTargetKey: 'backend:codex',
        explicitPermissionMode: undefined,
        sessionKind: 'fresh',
        session: {
          getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 1 } as any),
          fetchLatestUserPermissionIntentFromTranscript: async () => null,
          waitForMetadataUpdate: async () => {
            attempts += 1;
            if (attempts > 1) {
              shouldExit = true;
            }
            return false;
          },
        },
        permissionMode: { current: 'default' as any, updatedAt: 0 },
        modelOverride: { current: null, updatedAt: 0 },
        persistStartupOverridesCache: () => {},
        shouldExit: () => shouldExit,
        getAbortSignal: () => undefined,
      });

      await Promise.resolve();
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(25);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps watching metadata after update application fails', async () => {
    vi.useFakeTimers();
    try {
      let shouldExit = false;
      let attempts = 0;
      const onModelOverrideApplied = vi.fn(() => {
        throw new Error('metadata apply failed');
      });

      await setupRuntimeMetadataDrivenOverridesSync({
        agentTargetKey: 'backend:codex',
        explicitPermissionMode: undefined,
        sessionKind: 'fresh',
        session: {
          getMetadataSnapshot: () =>
            ({
              permissionMode: 'default',
              permissionModeUpdatedAt: 1,
              ...(attempts > 0
                ? { modelOverrideV1: { v: 1, updatedAt: 10 + attempts, modelId: `gpt-${attempts}` } }
                : {}),
            }) as any,
          fetchLatestUserPermissionIntentFromTranscript: async () => null,
          waitForMetadataUpdate: async () => {
            attempts += 1;
            if (attempts === 1) {
              return true;
            }
            shouldExit = true;
            return false;
          },
        },
        permissionMode: { current: 'default' as any, updatedAt: 0 },
        modelOverride: { current: null, updatedAt: 0 },
        onModelOverrideApplied,
        persistStartupOverridesCache: () => {},
        shouldExit: () => shouldExit,
        getAbortSignal: () => undefined,
      });

      await Promise.resolve();
      expect(attempts).toBe(1);
      expect(onModelOverrideApplied).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
