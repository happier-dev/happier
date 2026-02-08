import { describe, expect, it } from 'vitest';

import { resolveStartupPermissionModeFromSession } from './startupPermissionModeSeed';

describe('resolveStartupPermissionModeFromSession', () => {
  it('prefers newer transcript inference over older metadata', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 10 } as any),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'safe-yolo' as any, updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'safe-yolo', updatedAt: 20 });
  });

  it('prefers newer metadata over older user messages', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => ({ permissionMode: 'yolo', permissionModeUpdatedAt: 30 } as any),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'default' as any, updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'yolo', updatedAt: 30 });
  });

  it('falls back to transcript inference when metadata has no permission timestamp', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => ({ permissionMode: 'yolo' } as any),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'safe-yolo' as any, updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'safe-yolo', updatedAt: 20 });
  });

  it('ignores metadata when permissionModeUpdatedAt is not a finite number', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => ({ permissionMode: 'yolo', permissionModeUpdatedAt: '999' } as any),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'safe-yolo' as any, updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'safe-yolo', updatedAt: 20 });
  });

  it('falls back to transcript when metadata permissionMode is invalid', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => ({ permissionMode: 'not-a-real-mode', permissionModeUpdatedAt: 30 } as any),
        fetchLatestUserPermissionIntentFromTranscript: async () => ({ intent: 'safe-yolo' as any, updatedAt: 20 }),
      },
    });

    expect(res).toEqual({ mode: 'safe-yolo', updatedAt: 20 });
  });

  it('returns null when neither metadata nor messages specify a permission mode', async () => {
    const res = await resolveStartupPermissionModeFromSession({
      session: {
        getMetadataSnapshot: () => ({ path: '/tmp' } as any),
        fetchLatestUserPermissionIntentFromTranscript: async () => null,
      },
    });

    expect(res).toBeNull();
  });
});
