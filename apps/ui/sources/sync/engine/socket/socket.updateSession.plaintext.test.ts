import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { handleUpdateContainer } from './socket';

const initialStorageState = storage.getInitialState();
type HandleUpdateContainerParams = Parameters<typeof handleUpdateContainer>[0];
type HandleUpdateContainerBaseParams = Omit<HandleUpdateContainerParams, 'updateData'>;

function buildSession(sessionId: string): Session {
    return {
        id: sessionId,
        seq: 1,
        encryptionMode: 'plain',
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { path: '/tmp', host: 'localhost' },
        metadataVersion: 1,
        agentState: {},
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function buildBaseParams(overrides: Partial<HandleUpdateContainerBaseParams> = {}): HandleUpdateContainerBaseParams {
    return {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
        } as unknown as HandleUpdateContainerBaseParams['encryption'],
        artifactDataKeys: new Map<string, Uint8Array>(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        applyMessages: vi.fn(),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => false),
        getSessionMaterializedMaxSeq: vi.fn(() => 0),
        markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
        invalidateMachines: vi.fn(),
        invalidateSessions: vi.fn(),
        invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(),
        invalidateFriendRequests: vi.fn(),
        invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(),
        invalidateTodos: vi.fn(),
        onTaskLifecycleEvent: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket update handling: plaintext update-session', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('applies plaintext session updates when session encryption is unavailable', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([buildSession('s1')]);
            const params = buildBaseParams();
            const updateData: ApiUpdateContainer = {
                id: 'u_plain_session',
                seq: 10,
                createdAt: 1234,
                body: {
                    t: 'update-session',
                    id: 's1',
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 1,
                    metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
                    agentState: { version: 3, value: JSON.stringify({ controlledByUser: true }) },
                },
            };

            await handleUpdateContainer({
                ...params,
                updateData,
            });

            expect(consoleError).not.toHaveBeenCalled();
            const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
            expect(applySessionsSpy).toHaveBeenCalledTimes(1);
            const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
            expect(updatedSession.metadata).toEqual({ path: '/work', host: 'devbox' });
            expect(updatedSession.metadataVersion).toBe(2);
            expect(updatedSession.agentState).toEqual({ controlledByUser: true });
            expect(updatedSession.agentStateVersion).toBe(3);
            expect(updatedSession.lastViewedSessionSeq).toBe(5);
            expect(updatedSession.pendingPermissionRequestCount).toBe(2);
            expect(updatedSession.pendingUserActionRequestCount).toBe(1);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('preserves runtime-local direct-session metadata for loaded plaintext sessions when an update omits directSessionV1', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([{
                ...buildSession('s1'),
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: {
                            kind: 'claudeConfigDir',
                            configDir: '/tmp/.claude',
                        },
                    },
                },
            }]);
            const params = buildBaseParams();
            const updateData: ApiUpdateContainer = {
                id: 'u_plain_session_direct_runtime_local',
                seq: 10,
                createdAt: 1234,
                body: {
                    t: 'update-session',
                    id: 's1',
                    metadata: {
                        version: 2,
                        value: JSON.stringify({
                            path: '/work',
                            host: 'devbox',
                            directSessionAttentionV1: {
                                v: 1,
                                observedProgressToken: '20:msg-2',
                                viewedProgressToken: '10:msg-1',
                                observedAtMs: 20,
                                viewedAtMs: 10,
                            },
                        }),
                    },
                },
            };

            await handleUpdateContainer({
                ...params,
                updateData,
            });

            expect(consoleError).not.toHaveBeenCalled();
            const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
            expect(applySessionsSpy).toHaveBeenCalledTimes(1);
            const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
            expect(updatedSession.metadata).toEqual(expect.objectContaining({
                path: '/work',
                host: 'devbox',
                machineId: 'machine-1',
                directSessionV1: expect.objectContaining({
                    v: 1,
                    providerId: 'claude',
                    remoteSessionId: 'remote-1',
                }),
                directSessionAttentionV1: expect.objectContaining({
                    v: 1,
                    observedProgressToken: '20:msg-2',
                }),
            }));
        } finally {
            consoleError.mockRestore();
        }
    });

    it('preserves runtime-local direct-session metadata for loaded plaintext sessions when an update sets directSessionV1 to null', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([{
                ...buildSession('s1'),
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: {
                            kind: 'claudeConfigDir',
                            configDir: '/tmp/.claude',
                        },
                    },
                },
            }]);
            const params = buildBaseParams();
            const updateData: ApiUpdateContainer = {
                id: 'u_plain_session_direct_runtime_local_null_link',
                seq: 10,
                createdAt: 1234,
                body: {
                    t: 'update-session',
                    id: 's1',
                    metadata: {
                        version: 2,
                        value: JSON.stringify({
                            path: '/work',
                            host: 'devbox',
                            directSessionV1: null,
                            directSessionAttentionV1: {
                                v: 1,
                                observedProgressToken: '20:msg-2',
                                viewedProgressToken: '10:msg-1',
                                observedAtMs: 20,
                                viewedAtMs: 10,
                            },
                        }),
                    },
                },
            };

            await handleUpdateContainer({
                ...params,
                updateData,
            });

            expect(consoleError).not.toHaveBeenCalled();
            const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
            expect(applySessionsSpy).toHaveBeenCalledTimes(1);
            const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
            expect(updatedSession.metadata).toEqual(expect.objectContaining({
                path: '/work',
                host: 'devbox',
                directSessionV1: expect.objectContaining({
                    v: 1,
                    providerId: 'claude',
                    remoteSessionId: 'remote-1',
                }),
                directSessionAttentionV1: expect.objectContaining({
                    v: 1,
                    observedProgressToken: '20:msg-2',
                }),
            }));
        } finally {
            consoleError.mockRestore();
        }
    });

    it('patches cache-only renderables for plaintext update-session without forcing a sessions refresh', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only',
            seq: 11,
            createdAt: 1235,
            body: {
                t: 'update-session',
                id: 's_cached_only',
                metadata: {
                    version: 2,
                    value: JSON.stringify({
                        path: '/work',
                        host: 'devbox',
                        directSessionV1: {
                            v: 1,
                            providerId: 'claude',
                            machineId: 'machine-1',
                            remoteSessionId: 'remote-1',
                            source: {
                                kind: 'claudeConfig',
                                configDir: '/tmp/.claude',
                            },
                        },
                        directSessionAttentionV1: {
                            v: 1,
                            observedProgressToken: '20:msg-2',
                            viewedProgressToken: '10:msg-1',
                            observedAtMs: 20,
                            viewedAtMs: 10,
                        },
                    }),
                },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(storage.getState().sessionListRenderables['s_cached_only']).toEqual(
            expect.objectContaining({
                updatedAt: 1235,
                seq: 1,
                metadataVersion: 2,
                metadata: expect.objectContaining({
                    path: '/work',
                    host: 'devbox',
                }),
                hasUnreadMessages: true,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates cache-only renderables for pending-changed without forcing a sessions refresh', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_pending',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingVersion: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);
        const initialIndexByServerId = storage.getState().sessionListIndexByServerId;

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_pending_cache_only',
            seq: 12,
            createdAt: 1236,
            body: {
                t: 'pending-changed',
                sid: 's_cached_pending',
                pendingCount: 4,
                pendingVersion: 8,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(storage.getState().sessionListRenderables['s_cached_pending']).toEqual(
            expect.objectContaining({
                pendingCount: 4,
                pendingVersion: 8,
            }),
        );
        expect(storage.getState().sessionListIndexByServerId).toBe(initialIndexByServerId);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('preserves direct-session classification for cache-only renderables when an update omits directSessionV1', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_direct',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
                    },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_direct_runtime_local',
            seq: 11,
            createdAt: 1235,
            body: {
                t: 'update-session',
                id: 's_cached_direct',
                metadata: {
                    version: 2,
                    value: JSON.stringify({
                        path: '/work',
                        host: 'devbox',
                        directSessionAttentionV1: {
                            v: 1,
                            observedProgressToken: '20:msg-2',
                            viewedProgressToken: '10:msg-1',
                            observedAtMs: 20,
                            viewedAtMs: 10,
                        },
                    }),
                },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect((params.fetchSessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const renderable = storage.getState().sessionListRenderables.s_cached_direct;
        expect(renderable?.metadata).toEqual(expect.objectContaining({
            path: '/work',
            host: 'devbox',
            directSessionV1: expect.objectContaining({
                v: 1,
                providerId: 'claude',
            }),
        }));
    });

    it('preserves direct-session classification for cache-only renderables when an update sets directSessionV1 to null', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_direct',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
                    },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_direct_runtime_local_null',
            seq: 12,
            createdAt: 1236,
            body: {
                t: 'update-session',
                id: 's_cached_direct',
                metadata: {
                    version: 2,
                    value: JSON.stringify({
                        path: '/work',
                        host: 'devbox',
                        directSessionV1: null,
                        directSessionAttentionV1: {
                            v: 1,
                            observedProgressToken: '20:msg-2',
                            viewedProgressToken: '10:msg-1',
                            observedAtMs: 20,
                            viewedAtMs: 10,
                        },
                    }),
                },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect((params.fetchSessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const renderable = storage.getState().sessionListRenderables.s_cached_direct;
        expect(renderable?.metadata).toEqual(expect.objectContaining({
            path: '/work',
            host: 'devbox',
            directSessionV1: expect.objectContaining({
                v: 1,
                providerId: 'claude',
            }),
        }));
    });

    it('preserves direct-session classification for cache-only renderables when an update sets directSessionV1 to null', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_direct',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    directSessionV1: {
                        v: 1,
                        providerId: 'claude',
                    },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_direct_runtime_local_null_link',
            seq: 11,
            createdAt: 1235,
            body: {
                t: 'update-session',
                id: 's_cached_direct',
                metadata: {
                    version: 2,
                    value: JSON.stringify({
                        path: '/work',
                        host: 'devbox',
                        directSessionV1: null,
                        directSessionAttentionV1: {
                            v: 1,
                            observedProgressToken: '20:msg-2',
                            viewedProgressToken: '10:msg-1',
                            observedAtMs: 20,
                            viewedAtMs: 10,
                        },
                    }),
                },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect((params.fetchSessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        const renderable = storage.getState().sessionListRenderables.s_cached_direct;
        expect(renderable?.metadata).toEqual(expect.objectContaining({
            path: '/work',
            host: 'devbox',
            directSessionV1: expect.objectContaining({
                v: 1,
                providerId: 'claude',
            }),
        }));
    });
});
