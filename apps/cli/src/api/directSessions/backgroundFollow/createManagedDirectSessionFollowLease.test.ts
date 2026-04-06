import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    dispatchActivityNotificationAsyncMock,
    fetchSessionByIdMock,
    readCredentialsMock,
    getActiveAccountSettingsSnapshotMock,
    updateSessionMetadataWithObservedDirectSessionProgressMock,
} = vi.hoisted(() => ({
    dispatchActivityNotificationAsyncMock: vi.fn(async () => ({
        attemptedChannels: 1,
        deliveredChannels: 1,
    })),
    fetchSessionByIdMock: vi.fn(),
    readCredentialsMock: vi.fn(),
    getActiveAccountSettingsSnapshotMock: vi.fn(),
    updateSessionMetadataWithObservedDirectSessionProgressMock: vi.fn(async () => {}),
}));

vi.mock('@/activity/notifications/dispatchActivityNotification', () => ({
    dispatchActivityNotificationAsync: dispatchActivityNotificationAsyncMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
    fetchSessionById: fetchSessionByIdMock,
}));

vi.mock('@/persistence', () => ({
    readCredentials: readCredentialsMock,
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
    getActiveAccountSettingsSnapshot: getActiveAccountSettingsSnapshotMock,
}));

vi.mock('./directSessionBackgroundFollowMetadata', async () => {
    const actual = await vi.importActual<typeof import('./directSessionBackgroundFollowMetadata')>('./directSessionBackgroundFollowMetadata');
    return {
        ...actual,
        updateSessionMetadataWithObservedDirectSessionProgress: updateSessionMetadataWithObservedDirectSessionProgressMock,
    };
});

import { createManagedDirectSessionFollowLease } from './createManagedDirectSessionFollowLease';

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
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('suppresses detached background-follow side effects for attached_view updates even when background follow is enabled', async () => {
        let listener: ((update: Readonly<{
            items: readonly Record<string, unknown>[];
            nextCursor: string | null;
            truncated: boolean;
        }>) => void | Promise<void>) | null = null;
        const emitDirectSessionTranscriptUpdate = vi.fn(async () => {});

        const lease = await createManagedDirectSessionFollowLease({
            sessionId: 'sess-managed-follow',
            reason: 'attached_view',
            acquireProviderFollowLease: async () => ({
                release: async () => {},
                subscribeToTranscriptUpdates: (nextListener) => {
                    listener = nextListener as typeof listener;
                    return () => {
                        listener = null;
                    };
                },
            }),
            emitDirectSessionTranscriptUpdate,
            shouldProcessBackgroundFollowEffects: () => true,
        });

        expect(lease).not.toBeNull();
        expect(listener).not.toBeNull();

        const attachedListener = listener as NonNullable<typeof listener>;
        await attachedListener({
            items: [{
                role: 'assistant',
                content: {
                    type: 'provider',
                    data: {
                        message: {
                            content: [{ type: 'text', text: 'attached delta' }],
                        },
                    },
                },
            }],
            nextCursor: 'cursor-1',
            truncated: false,
        });

        expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-managed-follow',
            nextCursor: 'cursor-1',
        }));
        expect(updateSessionMetadataWithObservedDirectSessionProgressMock).not.toHaveBeenCalled();
        expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();
        expect(readCredentialsMock).not.toHaveBeenCalled();
        expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    });

    it('releases the provider hot lease immediately for background_follow subscriptions and keeps cleanup idempotent', async () => {
        const release = vi.fn(async () => {});
        const unsubscribe = vi.fn(() => {});

        const lease = await createManagedDirectSessionFollowLease({
            sessionId: 'sess-managed-follow',
            reason: 'background_follow',
            acquireProviderFollowLease: async () => ({
                release,
                subscribeToTranscriptUpdates: () => unsubscribe,
            }),
            shouldProcessBackgroundFollowEffects: () => true,
        });

        expect(lease).not.toBeNull();
        expect(release).toHaveBeenCalledTimes(1);

        await lease?.release();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('suppresses detached metadata and ready notifications for background_follow updates when active-view suppression is enabled', async () => {
        let listener: ((update: Readonly<{
            items: readonly Record<string, unknown>[];
            nextCursor: string | null;
            truncated: boolean;
        }>) => void | Promise<void>) | null = null;
        const release = vi.fn(async () => {});
        const emitDirectSessionTranscriptUpdate = vi.fn(async () => {});

        const lease = await createManagedDirectSessionFollowLease({
            sessionId: 'sess-managed-follow',
            reason: 'background_follow',
            acquireProviderFollowLease: async () => ({
                release,
                subscribeToTranscriptUpdates: (nextListener) => {
                    listener = nextListener as typeof listener;
                    return () => {
                        listener = null;
                    };
                },
            }),
            emitDirectSessionTranscriptUpdate,
            shouldProcessBackgroundFollowEffects: () => false,
        });

        expect(lease).not.toBeNull();
        expect(listener).not.toBeNull();

        const backgroundListener = listener as NonNullable<typeof listener>;
        await backgroundListener({
            items: [{
                role: 'assistant',
                content: {
                    type: 'provider',
                    data: {
                        message: {
                            content: [{ type: 'text', text: 'suppressed while attached' }],
                        },
                    },
                },
            }],
            nextCursor: 'cursor-suppressed',
            truncated: false,
        });

        expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-managed-follow',
            nextCursor: 'cursor-suppressed',
        }));
        expect(updateSessionMetadataWithObservedDirectSessionProgressMock).not.toHaveBeenCalled();
        expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();
        expect(readCredentialsMock).not.toHaveBeenCalled();
        expect(fetchSessionByIdMock).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });
});
