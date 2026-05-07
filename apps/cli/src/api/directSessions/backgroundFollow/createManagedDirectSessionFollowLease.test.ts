import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

const {
  dispatchActivityNotificationAsyncMock,
  fetchSessionByIdMock,
  readCredentialsMock,
  getActiveAccountSettingsSnapshotMock,
  updateSessionMetadataWithRetryMock,
} = vi.hoisted(() => ({
  dispatchActivityNotificationAsyncMock: vi.fn(async () => ({
    attemptedChannels: 1,
    deliveredChannels: 1,
  })),
  fetchSessionByIdMock: vi.fn(),
  readCredentialsMock: vi.fn(),
  getActiveAccountSettingsSnapshotMock: vi.fn(),
  updateSessionMetadataWithRetryMock: vi.fn(),
}));

vi.mock('@/activity/notifications/dispatchActivityNotification', () => ({
  dispatchActivityNotificationAsync: dispatchActivityNotificationAsyncMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', async () => {
  const actual = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
  return {
    ...actual,
    fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
  };
});

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: () => getActiveAccountSettingsSnapshotMock(),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: (...args: unknown[]) => updateSessionMetadataWithRetryMock(...args),
}));

type TranscriptUpdate = Readonly<{
  items: Iterable<DirectTranscriptRawMessageV1>;
  nextCursor?: string | null;
  truncated: boolean;
}>;

type TranscriptUpdateListener = (update: TranscriptUpdate) => void | Promise<void>;

const directMessage = {
  id: 'direct-2',
  createdAtMs: 1_050,
  localId: 'direct-local-2',
  raw: {
    type: 'assistant',
    uuid: 'direct-2',
    message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] },
  },
} satisfies DirectTranscriptRawMessageV1;

describe('createManagedDirectSessionFollowLease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readCredentialsMock.mockResolvedValue({
      token: 'token-test',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess-managed-follow',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        summary: {
          text: 'Managed follow session',
        },
      }),
    });
    getActiveAccountSettingsSnapshotMock.mockReturnValue({
      source: 'active',
      settings: {
        notificationsSettingsV1: {
          v: 1,
          pushEnabled: true,
          ready: true,
          permissionRequest: false,
        },
      },
      settingsSecretsReadKeys: [],
    });
    updateSessionMetadataWithRetryMock.mockResolvedValue({
      version: 2,
      metadata: {},
    });
  });

  it('emits direct-session transcript delta updates from provider follow updates', async () => {
    const { createManagedDirectSessionFollowLease } = await import('./createManagedDirectSessionFollowLease');
    const listeners: TranscriptUpdateListener[] = [];
    const emitDirectSessionTranscriptUpdate = vi.fn();

    const lease = await createManagedDirectSessionFollowLease({
      sessionId: 'sess-managed-follow',
      reason: 'attached_view',
      acquireProviderFollowLease: async () => ({
        release: async () => {},
        subscribeToTranscriptUpdates: (nextListener: TranscriptUpdateListener) => {
          listeners.push(nextListener);
          return () => {
            listeners.length = 0;
          };
        },
      }),
      emitDirectSessionTranscriptUpdate,
      shouldProcessBackgroundFollowEffects: () => false,
    });

    expect(lease).not.toBeNull();
    const currentListener = listeners[0];
    expect(currentListener).toEqual(expect.any(Function));
    if (!currentListener) {
      throw new Error('expected transcript update listener');
    }

    await currentListener({
      items: new Set([directMessage]),
      nextCursor: 'cursor-2',
      truncated: false,
    });

    expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledWith({
      type: 'direct-session-transcript-delta',
      sessionId: 'sess-managed-follow',
      items: [directMessage],
      nextCursor: 'cursor-2',
      truncated: false,
    });
  });

  it('swallows transcript delta emit failures and keeps provider lease cleanup idempotent', async () => {
    const { createManagedDirectSessionFollowLease } = await import('./createManagedDirectSessionFollowLease');
    const listeners: TranscriptUpdateListener[] = [];
    const release = vi.fn(async () => {});
    const unsubscribe = vi.fn();
    const emitDirectSessionTranscriptUpdate = vi.fn(() => {
      throw new Error('socket unavailable');
    });

    const lease = await createManagedDirectSessionFollowLease({
      sessionId: 'sess-managed-follow',
      reason: 'background_follow',
      acquireProviderFollowLease: async () => ({
        release,
        subscribeToTranscriptUpdates: (nextListener: TranscriptUpdateListener) => {
          listeners.push(nextListener);
          return unsubscribe;
        },
      }),
      emitDirectSessionTranscriptUpdate,
      shouldProcessBackgroundFollowEffects: () => true,
    });

    expect(lease).not.toBeNull();
    const currentListener = listeners[0];
    expect(currentListener).toEqual(expect.any(Function));
    if (!currentListener) {
      throw new Error('expected transcript update listener');
    }

    await expect(currentListener({
      items: [directMessage],
      nextCursor: null,
      truncated: true,
    })).resolves.toBeUndefined();

    await lease?.release();
    await lease?.release();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('updates observed progress for detached background-follow transcript updates', async () => {
    const { createManagedDirectSessionFollowLease } = await import('./createManagedDirectSessionFollowLease');
    const listeners: TranscriptUpdateListener[] = [];

    const lease = await createManagedDirectSessionFollowLease({
      sessionId: 'sess-managed-follow',
      reason: 'background_follow',
      acquireProviderFollowLease: async () => ({
        release: async () => {},
        subscribeToTranscriptUpdates: (nextListener: TranscriptUpdateListener) => {
          listeners.push(nextListener);
          return () => {
            listeners.length = 0;
          };
        },
      }),
      shouldProcessBackgroundFollowEffects: () => true,
    });

    expect(lease).not.toBeNull();
    const currentListener = listeners[0];
    expect(currentListener).toEqual(expect.any(Function));
    if (!currentListener) {
      throw new Error('expected transcript update listener');
    }

    await currentListener({
      items: [directMessage],
      nextCursor: 'cursor-progress',
      truncated: false,
    });

    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token-test',
      sessionId: 'sess-managed-follow',
    }));
    const retryArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
    const next = retryArgs.updater({
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'claudeConfig' },
        linkedAtMs: 1,
      },
    });
    expect(next.directSessionV1.lastKnownActivityAtMs).toBe(1_050);
    expect(next.directSessionAttentionV1).toEqual({
      v: 1,
      observedProgressToken: '1050:direct-2',
      observedAtMs: 1_050,
    });
  });

  it('dispatches ready notifications for detached background-follow assistant previews', async () => {
    const { createManagedDirectSessionFollowLease } = await import('./createManagedDirectSessionFollowLease');
    const listeners: TranscriptUpdateListener[] = [];

    await createManagedDirectSessionFollowLease({
      sessionId: 'sess-managed-follow',
      reason: 'background_follow',
      acquireProviderFollowLease: async () => ({
        release: async () => {},
        subscribeToTranscriptUpdates: (nextListener: TranscriptUpdateListener) => {
          listeners.push(nextListener);
          return () => {};
        },
      }),
      shouldProcessBackgroundFollowEffects: () => true,
    });

    const currentListener = listeners[0];
    expect(currentListener).toEqual(expect.any(Function));
    if (!currentListener) {
      throw new Error('expected transcript update listener');
    }

    await currentListener({
      items: [directMessage],
      nextCursor: 'cursor-notification',
      truncated: false,
    });

    expect(dispatchActivityNotificationAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        topic: 'ready',
        sessionId: 'sess-managed-follow',
        sessionTitle: 'Managed follow session',
        assistantPreviewText: 'hello from push',
      }),
    }));
  });

  it('suppresses detached metadata and ready notifications while background-follow effects are disabled', async () => {
    const { createManagedDirectSessionFollowLease } = await import('./createManagedDirectSessionFollowLease');
    const listeners: TranscriptUpdateListener[] = [];
    const emitDirectSessionTranscriptUpdate = vi.fn(async () => {});

    await createManagedDirectSessionFollowLease({
      sessionId: 'sess-managed-follow',
      reason: 'background_follow',
      acquireProviderFollowLease: async () => ({
        release: async () => {},
        subscribeToTranscriptUpdates: (nextListener: TranscriptUpdateListener) => {
          listeners.push(nextListener);
          return () => {};
        },
      }),
      emitDirectSessionTranscriptUpdate,
      shouldProcessBackgroundFollowEffects: () => false,
    });

    const currentListener = listeners[0];
    expect(currentListener).toEqual(expect.any(Function));
    if (!currentListener) {
      throw new Error('expected transcript update listener');
    }

    await currentListener({
      items: [directMessage],
      nextCursor: 'cursor-suppressed',
      truncated: false,
    });

    expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-managed-follow',
      nextCursor: 'cursor-suppressed',
    }));
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();
    expect(readCredentialsMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdMock).not.toHaveBeenCalled();
  });
});
