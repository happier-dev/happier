import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSessionFollowLease } from '@/session/external/providerOps';

const {
    dispatchActivityNotificationAsyncMock,
    fetchSessionByIdMock,
    readCredentialsMock,
    getActiveAccountSettingsSnapshotMock,
    updateSessionMetadataWithObservedExternalSessionProgressMock,
} = vi.hoisted(() => ({
    dispatchActivityNotificationAsyncMock: vi.fn(async () => ({
        attemptedChannels: 1,
        deliveredChannels: 1,
    })),
    fetchSessionByIdMock: vi.fn(),
    readCredentialsMock: vi.fn(),
    getActiveAccountSettingsSnapshotMock: vi.fn(),
    updateSessionMetadataWithObservedExternalSessionProgressMock: vi.fn(async () => {}),
}));

vi.mock('@/notifications/activity/dispatchActivityNotification', () => ({
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

vi.mock('./externalSessionBackgroundFollowMetadata', async () => {
    const actual = await vi.importActual<typeof import('./externalSessionBackgroundFollowMetadata')>('./externalSessionBackgroundFollowMetadata');
    return {
        ...actual,
        updateSessionMetadataWithObservedExternalSessionProgress: updateSessionMetadataWithObservedExternalSessionProgressMock,
    };
});

import { createManagedExternalSessionFollowLease } from './createManagedExternalSessionFollowLease';

type TranscriptUpdateListener = Parameters<NonNullable<ExternalSessionFollowLease['subscribeToTranscriptUpdates']>>[0];

describe('createManagedExternalSessionFollowLease', () => {
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
        let listener: TranscriptUpdateListener | null = null;
        const emitExternalSessionTranscriptUpdate = vi.fn(async () => {});

        const lease = await createManagedExternalSessionFollowLease({
            sessionId: 'sess-managed-follow',
            reason: 'attached_view',
            acquireProviderFollowLease: async () => ({
                release: async () => {},
                subscribeToTranscriptUpdates: (nextListener) => {
                    listener = nextListener;
                    return () => {
                        listener = null;
                    };
                },
            }),
            emitExternalSessionTranscriptUpdate,
            shouldProcessBackgroundFollowEffects: () => true,
        });

        expect(lease).not.toBeNull();
        expect(listener).not.toBeNull();
        if (!listener) {
            throw new Error('expected transcript update listener');
        }

        const attachedListener: TranscriptUpdateListener = listener;
        await attachedListener({
            items: [{
                id: 'msg-attached-1',
                createdAtMs: 1,
                raw: {},
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
            fromCursor: 'cursor-0',
            nextCursor: 'cursor-1',
            truncated: false,
        });

        expect(emitExternalSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-managed-follow',
            fromCursor: 'cursor-0',
            nextCursor: 'cursor-1',
        }));
        expect(updateSessionMetadataWithObservedExternalSessionProgressMock).not.toHaveBeenCalled();
        expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();
        expect(readCredentialsMock).not.toHaveBeenCalled();
        expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    });

    it('keeps the provider follow lease active for background_follow subscriptions and keeps cleanup idempotent', async () => {
        const release = vi.fn(async () => {});
        const unsubscribe = vi.fn(() => {});

        const lease = await createManagedExternalSessionFollowLease({
            sessionId: 'sess-managed-follow',
            reason: 'background_follow',
            acquireProviderFollowLease: async () => ({
                release,
                subscribeToTranscriptUpdates: () => unsubscribe,
            }),
            shouldProcessBackgroundFollowEffects: () => true,
        });

        expect(lease).not.toBeNull();
        expect(release).not.toHaveBeenCalled();

        await lease?.release();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('keeps detached background-follow transcript updates flowing even when provider release would stop delivery', async () => {
        let listener: TranscriptUpdateListener | null = null;
        let closed = false;

        const lease = await createManagedExternalSessionFollowLease({
            sessionId: 'sess-managed-follow',
            reason: 'background_follow',
            acquireProviderFollowLease: async () => ({
                release: async () => {
                    closed = true;
                },
                subscribeToTranscriptUpdates: (nextListener) => {
                    listener = nextListener;
                    return () => {
                        listener = null;
                    };
                },
            }),
            shouldProcessBackgroundFollowEffects: () => true,
        });

        expect(lease).not.toBeNull();
        expect(listener).not.toBeNull();

        if (!listener) {
            throw new Error('expected transcript update listener');
        }

        const emitDetachedUpdate = async () => {
            if (closed || !listener) return;
            await listener({
                items: [{
                    id: 'msg-background-detached-1',
                    createdAtMs: 10,
                    raw: {},
                    role: 'assistant',
                    content: {
                        type: 'provider',
                        data: {
                            message: {
                                content: [{ type: 'text', text: 'detached delta' }],
                            },
                        },
                    },
                }],
                nextCursor: 'cursor-detached-1',
                truncated: false,
            });
        };

        await emitDetachedUpdate();

        expect(updateSessionMetadataWithObservedExternalSessionProgressMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-managed-follow',
            observedProgress: expect.objectContaining({
                token: '10:msg-background-detached-1',
            }),
        }));
    });

    it('suppresses detached metadata and ready notifications for background_follow updates when active-view suppression is enabled', async () => {
        let listener: TranscriptUpdateListener | null = null;
        const release = vi.fn(async () => {});
        const emitExternalSessionTranscriptUpdate = vi.fn(async () => {});

        const lease = await createManagedExternalSessionFollowLease({
            sessionId: 'sess-managed-follow',
            reason: 'background_follow',
            acquireProviderFollowLease: async () => ({
                release,
                subscribeToTranscriptUpdates: (nextListener) => {
                    listener = nextListener;
                    return () => {
                        listener = null;
                    };
                },
            }),
            emitExternalSessionTranscriptUpdate,
            shouldProcessBackgroundFollowEffects: () => false,
        });

        expect(lease).not.toBeNull();
        expect(listener).not.toBeNull();
        if (!listener) {
            throw new Error('expected transcript update listener');
        }

        const backgroundListener: TranscriptUpdateListener = listener;
        await backgroundListener({
            items: [{
                id: 'msg-background-1',
                createdAtMs: 1,
                raw: {},
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
            fromCursor: 'cursor-before-suppressed',
            nextCursor: 'cursor-suppressed',
            truncated: false,
        });

        expect(emitExternalSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-managed-follow',
            fromCursor: 'cursor-before-suppressed',
            nextCursor: 'cursor-suppressed',
        }));
        expect(updateSessionMetadataWithObservedExternalSessionProgressMock).not.toHaveBeenCalled();
        expect(dispatchActivityNotificationAsyncMock).not.toHaveBeenCalled();
        expect(readCredentialsMock).not.toHaveBeenCalled();
        expect(fetchSessionByIdMock).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });
});
