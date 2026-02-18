import { describe, expect, it, vi } from 'vitest';

import { initializeRuntimeOverridesSynchronizer } from './runtimeOverridesSynchronizer';

describe('initializeRuntimeOverridesSynchronizer', () => {
  it('prefers newer transcript intent over older metadata when seeding attach sessions', async () => {
    const fetchLatestUserPermissionIntentFromTranscript = vi.fn(async () => ({ intent: 'safe-yolo' as any, updatedAt: 20 }));

    const sync = await initializeRuntimeOverridesSynchronizer({
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
      explicitPermissionMode: 'plan' as any,
      sessionKind: 'attach',
      session: {
        getMetadataSnapshot: () =>
          ({ permissionMode: 'yolo', permissionModeUpdatedAt: 999, modelOverrideV1: { v: 1, updatedAt: 50, modelId: 'gpt-4.1' } } as any),
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
    expect(sync.getSnapshot().modelOverride.current).toBe('gpt-4.1');
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
    expect(sync.getSnapshot().modelOverride.current).toBe('gpt-4.1');
    expect(sync.getSnapshot().modelOverride.updatedAt).toBe(50);
    expect(onPermissionModeApplied).toHaveBeenCalledTimes(1);
    expect(onModelOverrideApplied).toHaveBeenCalledTimes(1);
  });
});
