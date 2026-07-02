import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
    setRouteAnchorSessionId,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { flushActivityUpdates, handleSocketUpdate, handleUpdateContainer } from './socket';

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
        resetSessionSurfaceVisibilityForTests();
    });

    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        resetSessionSurfaceVisibilityForTests();
        vi.useRealTimers();
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

    it('still applies projection fields for an e2ee session when session encryption is missing instead of dropping the update', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([{
                ...buildSession('s_e2ee_missing_key'),
                encryptionMode: 'e2ee',
                agentState: { controlledByUser: false, requests: {} },
                agentStateVersion: 1,
                metadata: { path: '/tmp', host: 'localhost', name: 'Existing title' },
                metadataVersion: 1,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 100,
            }]);
            // No session encryption available for this e2ee session.
            const params = buildBaseParams({
                encryption: {
                    getSessionEncryption: () => null,
                    getMachineEncryption: () => null,
                    removeSessionEncryption: () => {},
                } as unknown as HandleUpdateContainerBaseParams['encryption'],
            });

            await handleUpdateContainer({
                ...params,
                updateData: {
                    id: 'u_e2ee_missing_key',
                    seq: 12,
                    createdAt: 2_500,
                    body: {
                        t: 'update-session',
                        id: 's_e2ee_missing_key',
                        pendingPermissionRequestCount: 3,
                        pendingUserActionRequestCount: 1,
                        latestReadyEventSeq: 42,
                        latestReadyEventAt: 2_400,
                        latestTurnId: 'turn-9',
                        latestTurnStatus: 'completed',
                        latestTurnStatusObservedAt: 2_450,
                        meaningfulActivityAt: 2_450,
                        // Encrypted payloads we cannot decrypt without the missing key.
                        metadata: { version: 2, value: 'encrypted-metadata' },
                        agentState: { version: 2, value: 'encrypted-agent-state' },
                    },
                },
            });

            // The update must NOT be dropped: projection fields still apply.
            const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
            expect(applySessionsSpy).toHaveBeenCalledTimes(1);
            const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
            expect(updatedSession).toEqual(expect.objectContaining({
                pendingPermissionRequestCount: 3,
                pendingUserActionRequestCount: 1,
                latestReadyEventSeq: 42,
                latestReadyEventAt: 2_400,
                latestTurnId: 'turn-9',
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 2_450,
                meaningfulActivityAt: 2_450,
                updatedAt: 2_500,
            }));
            // Encrypted state is left untouched (skip only the decrypt).
            expect(updatedSession.metadata).toEqual({ path: '/tmp', host: 'localhost', name: 'Existing title' });
            expect(updatedSession.metadataVersion).toBe(1);
            expect(updatedSession.agentState).toEqual({ controlledByUser: false, requests: {} });
            expect(updatedSession.agentStateVersion).toBe(1);
            expect(params.invalidateSessions).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('does not overwrite a newer title when a lower-version metadata payload arrives (hydrated path)', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_meta_version_guard'),
            metadata: { path: '/tmp', host: 'localhost', name: 'Newer title' },
            metadataVersion: 5,
        }]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_meta_version_stale',
                seq: 11,
                createdAt: 2_000,
                body: {
                    t: 'update-session',
                    id: 's_meta_version_guard',
                    latestReadyEventSeq: 7,
                    latestReadyEventAt: 1_990,
                    // Stale metadata: version 3 < stored version 5.
                    metadata: { version: 3, value: JSON.stringify({ path: '/old', host: 'oldbox', name: 'Stale title' }) },
                },
            },
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        // Stale metadata must NOT overwrite the newer title.
        expect(updatedSession.metadata).toEqual({ path: '/tmp', host: 'localhost', name: 'Newer title' });
        expect(updatedSession.metadataVersion).toBe(5);
        // Projection fields still apply.
        expect(updatedSession.latestReadyEventSeq).toBe(7);
        expect(updatedSession.latestReadyEventAt).toBe(1_990);
        expect(updatedSession.updatedAt).toBe(2_000);
    });

    it('applies metadata when the incoming version is higher and treats an equal version as a no-op (hydrated path)', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_meta_version_apply'),
            metadata: { path: '/tmp', host: 'localhost', name: 'Original title' },
            metadataVersion: 2,
        }]);

        // Equal version is a no-op: metadata is not re-applied.
        const equalParams = buildBaseParams();
        await handleUpdateContainer({
            ...equalParams,
            updateData: {
                id: 'u_meta_version_equal',
                seq: 11,
                createdAt: 2_000,
                body: {
                    t: 'update-session',
                    id: 's_meta_version_apply',
                    metadata: { version: 2, value: JSON.stringify({ path: '/equal', host: 'equalbox', name: 'Equal title' }) },
                },
            },
        });
        const equalSpy = equalParams.applySessions as unknown as ReturnType<typeof vi.fn>;
        const equalSession = equalSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(equalSession.metadata).toEqual({ path: '/tmp', host: 'localhost', name: 'Original title' });
        expect(equalSession.metadataVersion).toBe(2);

        // Higher version applies.
        const higherParams = buildBaseParams();
        await handleUpdateContainer({
            ...higherParams,
            updateData: {
                id: 'u_meta_version_higher',
                seq: 12,
                createdAt: 2_100,
                body: {
                    t: 'update-session',
                    id: 's_meta_version_apply',
                    metadata: { version: 3, value: JSON.stringify({ path: '/new', host: 'newbox', name: 'Newer title' }) },
                },
            },
        });
        const higherSpy = higherParams.applySessions as unknown as ReturnType<typeof vi.fn>;
        const higherSession = higherSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(higherSession.metadata).toEqual({ path: '/new', host: 'newbox', name: 'Newer title' });
        expect(higherSession.metadataVersion).toBe(3);
    });

    it('applies the first durable session update immediately and coalesces trailing updates without dropping queued fields', async () => {
        vi.useFakeTimers();
        storage.getState().applySessions([buildSession('s1')]);
        const appliedBatches: Session[][] = [];
        const applySessions = vi.fn<HandleUpdateContainerBaseParams['applySessions']>((sessions) => {
            const nextSessions = sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            })) as Session[];
            appliedBatches.push(nextSessions);
            storage.getState().applySessions(nextSessions);
        });
        const params = buildBaseParams({ applySessions });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_coalesce_1',
                seq: 10,
                createdAt: 100,
                body: {
                    t: 'update-session',
                    id: 's1',
                    metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
                },
            },
        });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_coalesce_2',
                seq: 11,
                createdAt: 101,
                body: {
                    t: 'update-session',
                    id: 's1',
                    pendingPermissionRequestCount: 7,
                },
            },
        });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_coalesce_3',
                seq: 12,
                createdAt: 102,
                body: {
                    t: 'update-session',
                    id: 's1',
                    agentState: { version: 3, value: JSON.stringify({ controlledByUser: true }) },
                },
            },
        });

        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(appliedBatches[0]?.[0]).toEqual(expect.objectContaining({
            metadata: { path: '/work', host: 'devbox' },
            metadataVersion: 2,
        }));

        await vi.runAllTimersAsync();

        expect(applySessions).toHaveBeenCalledTimes(2);
        expect(appliedBatches[1]?.[0]).toEqual(expect.objectContaining({
            metadata: { path: '/work', host: 'devbox' },
            metadataVersion: 2,
            pendingPermissionRequestCount: 7,
            agentState: { controlledByUser: true },
            agentStateVersion: 3,
        }));
    });

    it('does not let a queued stale turn projection clear newer working state', async () => {
        vi.useFakeTimers();
        const sessionId = 's_runtime_ordering';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            seq: 7,
            updatedAt: 1_000,
            thinking: false,
            thinkingAt: 1_000,
            latestTurnId: 'turn-1',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
        }]);
        const applySessions = vi.fn<HandleUpdateContainerBaseParams['applySessions']>((sessions) => {
            storage.getState().applySessions(sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            })) as Session[]);
        });
        const params = buildBaseParams({ applySessions });

        // Starts the coalescing leading window and applies immediately.
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_runtime_ordering_initial_terminal',
                seq: 10,
                createdAt: 1_001,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    latestTurnId: 'turn-1',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_001,
                    thinking: false,
                    thinkingAt: 1_001,
                },
            },
        });

        storage.getState().applySessions([{
            ...storage.getState().sessions[sessionId]!,
            seq: 8,
            updatedAt: 1_010,
            latestTurnId: 'turn-2',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_010,
            thinking: true,
            thinkingAt: 1_010,
        }]);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_runtime_ordering_stale_terminal',
                seq: 11,
                createdAt: 1_005,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    latestTurnId: 'turn-1',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_001,
                    thinking: false,
                    thinkingAt: 1_001,
                },
            },
        });

        expect(storage.getState().sessions[sessionId]).toEqual(expect.objectContaining({
            seq: 8,
            updatedAt: 1_010,
            latestTurnId: 'turn-2',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_010,
            thinking: true,
            thinkingAt: 1_010,
        }));

        await vi.runAllTimersAsync();

        expect(storage.getState().sessions[sessionId]).toEqual(expect.objectContaining({
            seq: 8,
            updatedAt: 1_010,
            latestTurnId: 'turn-2',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_010,
            thinking: true,
            thinkingAt: 1_010,
        }));
        expect(storage.getState().sessionListRenderables[sessionId]).toEqual(expect.objectContaining({
            seq: 8,
            updatedAt: 1_010,
            latestTurnId: 'turn-2',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_010,
            thinking: true,
            thinkingAt: 1_010,
        }));
    });

    it('drops queued durable session updates when the session is deleted before the coalesced flush', async () => {
        vi.useFakeTimers();
        storage.getState().applySessions([buildSession('s1')]);
        const applySessions = vi.fn<HandleUpdateContainerBaseParams['applySessions']>((sessions) => {
            storage.getState().applySessions(sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            })) as Session[]);
        });
        const params = buildBaseParams({ applySessions });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_delete_1',
                seq: 10,
                createdAt: 100,
                body: {
                    t: 'update-session',
                    id: 's1',
                    metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
                },
            },
        });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_delete_2',
                seq: 11,
                createdAt: 101,
                body: {
                    t: 'update-session',
                    id: 's1',
                    pendingPermissionRequestCount: 7,
                },
            },
        });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_delete_3',
                seq: 12,
                createdAt: 102,
                body: {
                    t: 'delete-session',
                    sid: 's1',
                },
            },
        });

        await vi.runAllTimersAsync();

        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(storage.getState().sessions.s1).toBeUndefined();
    });

    it('preserves runtime-local direct-session metadata for loaded plaintext sessions when an update omits externalSessionV1', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([{
                ...buildSession('s1'),
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    externalSessionV1: {
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
                            externalSessionAttentionV1: {
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
                externalSessionV1: expect.objectContaining({
                    v: 1,
                    providerId: 'claude',
                    remoteSessionId: 'remote-1',
                }),
                externalSessionAttentionV1: expect.objectContaining({
                    v: 1,
                    observedProgressToken: '20:msg-2',
                }),
            }));
        } finally {
            consoleError.mockRestore();
        }
    });

    it('preserves runtime-local direct-session metadata for loaded plaintext sessions when an update sets externalSessionV1 to null', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            storage.getState().applySessions([{
                ...buildSession('s1'),
                metadata: {
                    path: '/tmp',
                    host: 'localhost',
                    externalSessionV1: {
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
                            externalSessionV1: null,
                            externalSessionAttentionV1: {
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
                externalSessionV1: expect.objectContaining({
                    v: 1,
                    providerId: 'claude',
                    remoteSessionId: 'remote-1',
                }),
                externalSessionAttentionV1: expect.objectContaining({
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
                        externalSessionV1: {
                            v: 1,
                            providerId: 'claude',
                            machineId: 'machine-1',
                            remoteSessionId: 'remote-1',
                            source: {
                                kind: 'claudeConfig',
                                configDir: '/tmp/.claude',
                            },
                        },
                        externalSessionAttentionV1: {
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

    it('patches cache-only renderables for active-only update-session without forcing a sessions refresh', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_active_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_active_only_cache_only',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_active_only',
                    active: false,
                    activeAt: 1230,
                },
            },
        });

        expect(storage.getState().sessionListRenderables.s_cached_active_only).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1230,
                thinking: false,
                thinkingAt: 1230,
                updatedAt: 1236,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('target-hydrates visible cache-only renderables after update-session projection patches', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_visible_update',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);
        markSessionSurfaceVisible('s_cached_visible_update', 'server-a');

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            sourceServerId: 'server-a',
            updateData: {
                id: 'u_visible_cache_only_update',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_visible_update',
                    active: false,
                    activeAt: 1230,
                },
            },
        });

        expect(storage.getState().sessionListRenderables.s_cached_visible_update).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1230,
                thinking: false,
                thinkingAt: 1230,
                updatedAt: 1236,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_visible_update', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('target-hydrates route-anchored cache-only renderables after update-session projection patches', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_route_update',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);
        setRouteAnchorSessionId('s_cached_route_update');

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_route_cache_only_update',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_route_update',
                    active: false,
                    activeAt: 1230,
                },
            },
        });

        expect(storage.getState().sessionListRenderables.s_cached_route_update).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1230,
                thinking: false,
                thinkingAt: 1230,
                updatedAt: 1236,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_route_update', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('coalesces cache-only non-urgent update-session projection patches until the activity window flushes', async () => {
        vi.useFakeTimers();
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_progress_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                latestReadyEventSeq: 10,
                lastViewedSessionSeq: 1,
                hasUnreadMessages: true,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_progress_only',
                seq: 11,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_progress_only',
                    latestTurnStatusObservedAt: 1235,
                    meaningfulActivityAt: 1235,
                },
            },
        });

        const beforeFlush = storage.getState().sessionListRenderables.s_cached_progress_only;
        expect(beforeFlush?.latestTurnStatusObservedAt).toBeUndefined();
        expect(beforeFlush?.meaningfulActivityAt).toBeUndefined();
        expect(beforeFlush?.updatedAt).toBe(1);

        await vi.runAllTimersAsync();

        expect(storage.getState().sessionListRenderables.s_cached_progress_only).toEqual(
            expect.objectContaining({
                latestTurnStatusObservedAt: 1235,
                meaningfulActivityAt: 1235,
                updatedAt: 1236,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('applies urgent cache-only pending projection immediately after queued non-urgent progress', async () => {
        vi.useFakeTimers();
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_urgent_after_progress',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
                latestReadyEventSeq: null,
                lastViewedSessionSeq: 100,
                hasUnreadMessages: false,
                hasPendingPermissionRequests: false,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_progress_before_urgent',
                seq: 11,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_urgent_after_progress',
                    latestTurnStatusObservedAt: 1235,
                    meaningfulActivityAt: 1235,
                },
            },
        });

        const beforePending = storage.getState().sessionListRenderables.s_cached_urgent_after_progress;
        expect(beforePending?.latestTurnStatusObservedAt).toBeUndefined();
        expect(beforePending?.hasPendingPermissionRequests).toBe(false);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_urgent_pending',
                seq: 12,
                createdAt: 1237,
                body: {
                    t: 'update-session',
                    id: 's_cached_urgent_after_progress',
                    pendingPermissionRequestCount: 1,
                },
            },
        });

        expect(storage.getState().sessionListRenderables.s_cached_urgent_after_progress).toEqual(
            expect.objectContaining({
                latestTurnStatusObservedAt: 1235,
                meaningfulActivityAt: 1235,
                hasPendingPermissionRequests: true,
                updatedAt: 1237,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();
    });

    it('marks cache-only renderables unread when ready projection advances past the read cursor', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_ready_unread',
                seq: 945,
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
                lastViewedSessionSeq: 945,
                latestReadyEventSeq: null,
                hasUnreadMessages: false,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_ready_unread',
            seq: 946,
            createdAt: 1236,
            body: {
                t: 'update-session',
                id: 's_cached_ready_unread',
                latestReadyEventSeq: 946,
                latestReadyEventAt: 1236,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(storage.getState().sessionListRenderables.s_cached_ready_unread).toEqual(
            expect.objectContaining({
                latestReadyEventSeq: 946,
                latestReadyEventAt: 1236,
                hasUnreadMessages: true,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('clears cache-only renderable unread when read cursor catches the ready projection', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_ready_read',
                seq: 946,
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
                lastViewedSessionSeq: 945,
                latestReadyEventSeq: 946,
                hasUnreadMessages: true,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_ready_read',
            seq: 947,
            createdAt: 1237,
            body: {
                t: 'update-session',
                id: 's_cached_ready_read',
                lastViewedSessionSeq: 946,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(storage.getState().sessionListRenderables.s_cached_ready_read).toEqual(
            expect.objectContaining({
                lastViewedSessionSeq: 946,
                hasUnreadMessages: false,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('does not overwrite a newer cache-only title when a lower-version metadata payload arrives', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_meta_version_guard',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 5,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost', name: 'Newer title' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_meta_version_stale',
                seq: 14,
                createdAt: 1238,
                body: {
                    t: 'update-session',
                    id: 's_cached_meta_version_guard',
                    latestReadyEventSeq: 7,
                    // Stale metadata: version 3 < stored 5.
                    metadata: { version: 3, value: JSON.stringify({ path: '/old', host: 'oldbox', name: 'Stale title' }) },
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_meta_version_guard']).toEqual(
            expect.objectContaining({
                metadata: expect.objectContaining({ name: 'Newer title' }),
                metadataVersion: 5,
                latestReadyEventSeq: 7,
                updatedAt: 1238,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('recomputes cache-only unread state after metadata read-state updates are applied', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_metadata_read_state',
                seq: 9,
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
                    readStateV1: { v: 1, sessionSeq: 1, pendingActivityAt: 0, updatedAt: 1 },
                },
                latestReadyEventSeq: 9,
                hasUnreadMessages: true,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_metadata_read_state_cache_only',
                seq: 14,
                createdAt: 1238,
                body: {
                    t: 'update-session',
                    id: 's_cached_metadata_read_state',
                    metadata: {
                        version: 2,
                        value: JSON.stringify({
                            path: '/work',
                            host: 'devbox',
                            readStateV1: { v: 1, sessionSeq: 14, pendingActivityAt: 0, updatedAt: 1238 },
                        }),
                    },
                },
            },
        });

        expect(storage.getState().sessionListRenderables.s_cached_metadata_read_state).toEqual(
            expect.objectContaining({
                metadataVersion: 2,
                metadata: expect.objectContaining({
                    path: '/work',
                    readStateV1: expect.objectContaining({ sessionSeq: 14 }),
                }),
                hasUnreadMessages: false,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('patches cache-only encrypted metadata while deferring hidden encrypted agentState', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_encrypted_state',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 1,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        ]);

        const decryptMetadata = vi.fn(async () => ({ path: '/work', host: 'devbox' }));
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: true }));
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata,
                    decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
        });
        const updateData: ApiUpdateContainer = {
            id: 'u_encrypted_cache_only_state',
            seq: 12,
            createdAt: 1236,
            body: {
                t: 'update-session',
                id: 's_cached_encrypted_state',
                metadata: { version: 2, value: 'encrypted-metadata' },
                agentState: { version: 3, value: 'encrypted-agent-state' },
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1236,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(decryptMetadata).toHaveBeenCalledTimes(1);
        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(storage.getState().sessionListRenderables.s_cached_encrypted_state).toEqual(
            expect.objectContaining({
                updatedAt: 1236,
                metadataVersion: 2,
                agentStateVersion: 1,
                metadata: expect.objectContaining({ path: '/work', host: 'devbox' }),
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1236,
            }),
        );
    });

    it('patches archivedAt on cache-only renderables without forcing a sessions refresh', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_archived',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
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
            id: 'u_plain_session_cache_only_archived',
            seq: 12,
            createdAt: 1237,
                body: {
                    t: 'update-session',
                    id: 's_cached_archived',
                    latestTurnId: 'turn-2',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_236,
                    archivedAt: 44,
                },
            };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(storage.getState().sessionListRenderables.s_cached_archived).toEqual(
            expect.objectContaining({
                archivedAt: 44,
                latestTurnId: 'turn-2',
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1_236,
                updatedAt: 1237,
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
                meaningfulActivityAt: 1_235,
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
                meaningfulActivityAt: 1_235,
            }),
        );
        expect(storage.getState().sessionListIndexByServerId).toBe(initialIndexByServerId);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('target-hydrates visible cache-only renderables after pending-changed patches', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_visible_pending',
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
        markSessionSurfaceVisible('s_cached_visible_pending', 'server-a');
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });

        await handleUpdateContainer({
            ...params,
            sourceServerId: 'server-a',
            updateData: {
                id: 'u_visible_pending_cache_only',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'pending-changed',
                    sid: 's_cached_visible_pending',
                    pendingCount: 4,
                    pendingVersion: 8,
                    meaningfulActivityAt: 1_235,
                },
            },
        });

        expect(storage.getState().sessionListRenderables.s_cached_visible_pending).toEqual(
            expect.objectContaining({
                pendingCount: 4,
                pendingVersion: 8,
                meaningfulActivityAt: 1_235,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_visible_pending', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates hydrated sessions for pending-changed meaningful activity without forcing a sessions refresh', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_pending_hydrated'),
            pendingCount: 0,
            pendingVersion: 1,
            meaningfulActivityAt: 100,
        }]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_pending_hydrated',
                seq: 13,
                createdAt: 1_236,
                body: {
                    t: 'pending-changed',
                    sid: 's_pending_hydrated',
                    pendingCount: 2,
                    pendingVersion: 9,
                    meaningfulActivityAt: 1_235,
                },
            } as ApiUpdateContainer,
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_pending_hydrated',
            pendingCount: 2,
            pendingVersion: 9,
            meaningfulActivityAt: 1_235,
        }));
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('patches hydrated share permission updates without forcing a sessions refresh', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_share_existing'),
            accessLevel: 'view',
            canApprovePermissions: false,
        }]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_existing',
                seq: 14,
                createdAt: 1_238,
                body: {
                    t: 'session-share-updated',
                    sessionId: 's_share_existing',
                    shareId: 'share_1',
                    accessLevel: 'admin',
                    canApprovePermissions: true,
                    updatedAt: 1_238,
                },
            } as ApiUpdateContainer,
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_share_existing',
            accessLevel: 'admin',
            canApprovePermissions: true,
        }));
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('target-hydrates old share updates that cannot prove canApprovePermissions', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_share_legacy_payload'),
            accessLevel: 'edit',
            canApprovePermissions: false,
        }]);
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById } as Partial<HandleUpdateContainerBaseParams>);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_legacy_payload',
                seq: 16,
                createdAt: 1_240,
                body: {
                    t: 'session-share-updated',
                    sessionId: 's_share_legacy_payload',
                    shareId: 'share_legacy',
                    accessLevel: 'admin',
                    updatedAt: 1_240,
                },
            } as ApiUpdateContainer,
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_share_legacy_payload',
            accessLevel: 'admin',
            canApprovePermissions: false,
        }));
        expect(hydrateSessionById).toHaveBeenCalledWith('s_share_legacy_payload', 'share-visibility-change');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('uses targeted session hydration for newly shared sessions instead of invalidating the full list', async () => {
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById } as Partial<HandleUpdateContainerBaseParams>);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_new',
                seq: 15,
                createdAt: 1_239,
                body: {
                    t: 'session-shared',
                    sessionId: 's_share_new',
                    shareId: 'share_2',
                    sharedBy: { id: 'u1', firstName: null, lastName: null, username: 'owner', avatar: null },
                    accessLevel: 'edit',
                    canApprovePermissions: true,
                    createdAt: 1_239,
                },
            } as ApiUpdateContainer,
        });

        expect(hydrateSessionById).toHaveBeenCalledWith('s_share_new', 'share-visibility-change');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('forwards targeted session hydration through the parsed socket update path', async () => {
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById } as Partial<HandleUpdateContainerBaseParams>);

        await handleSocketUpdate({
            ...params,
            update: {
                id: 'u_share_new_socket_path',
                seq: 16,
                createdAt: 1_240,
                body: {
                    t: 'session-shared',
                    sessionId: 's_share_socket_path',
                    shareId: 'share_3',
                    sharedBy: { id: 'u1', firstName: null, lastName: null, username: 'owner', avatar: null },
                    accessLevel: 'edit',
                    canApprovePermissions: true,
                    createdAt: 1_240,
                },
            } as ApiUpdateContainer,
        });

        expect(hydrateSessionById).toHaveBeenCalledWith('s_share_socket_path', 'share-visibility-change');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('preserves direct-session classification for cache-only renderables when an update omits externalSessionV1', async () => {
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
                    externalSessionV1: {
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
                        externalSessionAttentionV1: {
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
            externalSessionV1: expect.objectContaining({
                v: 1,
                providerId: 'claude',
            }),
        }));
    });

    it('preserves direct-session classification for cache-only renderables when an update sets externalSessionV1 to null', async () => {
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
                    externalSessionV1: {
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
                        externalSessionV1: null,
                        externalSessionAttentionV1: {
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
            externalSessionV1: expect.objectContaining({
                v: 1,
                providerId: 'claude',
            }),
        }));
    });

    it('preserves direct-session classification for cache-only renderables when an update sets externalSessionV1 to null', async () => {
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
                    externalSessionV1: {
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
                        externalSessionV1: null,
                        externalSessionAttentionV1: {
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
            externalSessionV1: expect.objectContaining({
                v: 1,
                providerId: 'claude',
            }),
        }));
    });

    it('defers hidden encrypted agentState hydration when projected pending counts are complete and unchanged', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_encrypted'),
            encryptionMode: 'e2ee',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
        }]);
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: false }));
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptAgentState,
                    decryptMetadata: vi.fn(),
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
        });
        const updateData: ApiUpdateContainer = {
            id: 'u_hidden_encrypted_projection',
            seq: 13,
            createdAt: 1238,
            body: {
                t: 'update-session',
                id: 's_hidden_encrypted',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                agentState: { version: 3, value: 'encrypted-state' },
            },
        };

        await handleUpdateContainer({ ...params, updateData });

        expect(decryptAgentState).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_hidden_encrypted',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentStateVersion: 1,
            agentState: {},
        }));
    });

    it('defers hidden encrypted agentState hydration when prior projected pending counts are missing and next counts are zero', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_encrypted_missing_prior_counts'),
            encryptionMode: 'e2ee',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
        }]);
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: false }));
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptAgentState,
                    decryptMetadata: vi.fn(),
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
        });
        const updateData: ApiUpdateContainer = {
            id: 'u_hidden_encrypted_missing_prior_counts',
            seq: 14,
            createdAt: 1239,
            body: {
                t: 'update-session',
                id: 's_hidden_encrypted_missing_prior_counts',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                agentState: { version: 3, value: 'encrypted-state' },
            },
        };

        await handleUpdateContainer({ ...params, updateData });

        expect(decryptAgentState).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_hidden_encrypted_missing_prior_counts',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            agentStateVersion: 1,
            agentState: {},
        }));
    });

    it('hydrates hidden encrypted agentState when the session is still controlled by the user', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_agent_state_controlled'),
            encryptionMode: 'e2ee',
            agentState: { controlledByUser: true, requests: {} },
            metadata: { path: '/cached', host: 'cached-host' },
            metadataVersion: 1,
            agentStateVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }]);
        const decryptedAgentState = { controlledByUser: true, requests: { live: { status: 'pending' } } };
        const decryptAgentState = vi.fn(async () => decryptedAgentState);
        const decryptMetadata = vi.fn(async () => ({ path: '/work', host: 'devbox' }));
        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata,
                    decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
            markSessionStateHydrationDeferred,
        });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hidden_agent_state_controlled',
                seq: 14,
                createdAt: 1_239,
                body: {
                    t: 'update-session',
                    id: 's_hidden_agent_state_controlled',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    metadata: { version: 2, value: 'encrypted-metadata' },
                    agentState: { version: 2, value: 'encrypted-agent-state' },
                },
            },
        });

        expect(decryptAgentState).toHaveBeenCalledTimes(1);
        expect(decryptMetadata).toHaveBeenCalledTimes(1);
        expect(markSessionStateHydrationDeferred).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession).toEqual(expect.objectContaining({
            agentState: decryptedAgentState,
            agentStateVersion: 2,
            metadata: { path: '/work', host: 'devbox' },
            metadataVersion: 2,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
    });

    it('hydrates hidden encrypted agentState when projected pending work increases', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_agent_state_pending_increase'),
            encryptionMode: 'e2ee',
            agentState: { controlledByUser: false, requests: {} },
            agentStateVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }]);
        const decryptedAgentState = { controlledByUser: false, requests: { permission: { status: 'pending' } } };
        const decryptAgentState = vi.fn(async () => decryptedAgentState);
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata: vi.fn(async () => ({ path: '/work', host: 'devbox' })),
                    decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
        });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hidden_agent_state_pending_increase',
                seq: 15,
                createdAt: 1_240,
                body: {
                    t: 'update-session',
                    id: 's_hidden_agent_state_pending_increase',
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    agentState: { version: 2, value: 'encrypted-agent-state' },
                },
            },
        });

        expect(decryptAgentState).toHaveBeenCalledTimes(1);
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession).toEqual(expect.objectContaining({
            agentState: decryptedAgentState,
            agentStateVersion: 2,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
        }));
    });

    it('skips fresh cache-only timestamp-only activity patches until runtime freshness needs refresh', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_activity_timestamp_gate',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_timestamp_gate',
                    {
                        type: 'activity',
                        id: 's_cached_activity_timestamp_gate',
                        sessionId: 's_cached_activity_timestamp_gate',
                        active: true,
                        activeAt: 20_000,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(storage.getState().sessionListRenderables.s_cached_activity_timestamp_gate).toEqual(
            expect.objectContaining({
                activeAt: 1,
                thinkingAt: 1,
                updatedAt: 1,
            }),
        );
        expect(syncPerformanceTelemetry.snapshot().events.find((entry) => entry.name === 'sync.socket.sessions.activity.flush')?.fields)
            .toEqual(expect.objectContaining({
                renderablePatches: 0,
                renderableTimestampOnlySkippedFreshPatches: 1,
            }));

        syncPerformanceTelemetry.reset();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_timestamp_gate',
                    {
                        type: 'activity',
                        id: 's_cached_activity_timestamp_gate',
                        sessionId: 's_cached_activity_timestamp_gate',
                        active: true,
                        activeAt: 61_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(storage.getState().sessionListRenderables.s_cached_activity_timestamp_gate).toEqual(
            expect.objectContaining({
                activeAt: 61_001,
                thinkingAt: 61_001,
                updatedAt: 61_001,
            }),
        );
        expect(syncPerformanceTelemetry.snapshot().events.find((entry) => entry.name === 'sync.socket.sessions.activity.flush')?.fields)
            .toEqual(expect.objectContaining({
                renderablePatches: 1,
                renderableTimestampOnlyPatches: 1,
                renderableTimestampOnlySkippedFreshPatches: 0,
            }));
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('refreshes cache-only activity timestamps even when a durable projection has a newer updatedAt', () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_activity_heartbeat',
                seq: 1,
                createdAt: 1,
                updatedAt: 100_000,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_heartbeat',
                    {
                        type: 'activity',
                        id: 's_cached_activity_heartbeat',
                        sessionId: 's_cached_activity_heartbeat',
                        active: true,
                        activeAt: 70_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(storage.getState().sessionListRenderables.s_cached_activity_heartbeat).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 70_001,
                thinking: true,
                thinkingAt: 70_001,
                presence: 'online',
                updatedAt: 100_000,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('target-hydrates visible cache-only renderables after activity patches', () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_activity_visible',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 1,
                presence: 1,
            },
        ]);
        markSessionSurfaceVisible('s_cached_activity_visible', 'server-a');
        const applySessions = vi.fn();
        const hydrateSessionById = vi.fn();
        const flushParams: Parameters<typeof flushActivityUpdates>[0] & {
            hydrateSessionById: (sessionId: string, reason: 'socket-update-missing-session') => void;
        } = {
            updates: new Map([
                [
                    's_cached_activity_visible',
                    {
                        type: 'activity',
                        id: 's_cached_activity_visible',
                        sessionId: 's_cached_activity_visible',
                        active: true,
                        activeAt: 70_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
            sourceServerId: 'server-a',
            hydrateSessionById,
        };

        flushActivityUpdates(flushParams);

        expect(storage.getState().sessionListRenderables.s_cached_activity_visible).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 70_001,
                thinking: true,
                thinkingAt: 70_001,
                presence: 'online',
                updatedAt: 70_001,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_activity_visible', 'socket-update-missing-session');
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('refreshes hydrated activity timestamps even when a durable session update has a newer updatedAt', () => {
        storage.getState().applySessions([
            {
                ...buildSession('s_hydrated_activity_heartbeat'),
                updatedAt: 100_000,
                active: true,
                activeAt: 1,
                thinking: true,
                thinkingAt: 1,
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_hydrated_activity_heartbeat',
                    {
                        type: 'activity',
                        id: 's_hydrated_activity_heartbeat',
                        sessionId: 's_hydrated_activity_heartbeat',
                        active: true,
                        activeAt: 70_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(applySessions).toHaveBeenCalledTimes(1);
        expect(applySessions.mock.calls[0]?.[0]).toEqual([
            expect.objectContaining({
                id: 's_hydrated_activity_heartbeat',
                active: true,
                activeAt: 70_001,
                thinking: true,
                thinkingAt: 70_001,
                updatedAt: 100_000,
            }),
        ]);
    });

    it('does not regress hydrated activity timestamps from older timestamp-only updates', () => {
        storage.getState().applySessions([
            {
                ...buildSession('s_hydrated_activity_stale_heartbeat'),
                updatedAt: 100_000,
                active: true,
                activeAt: 70_001,
                thinking: true,
                thinkingAt: 70_001,
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_hydrated_activity_stale_heartbeat',
                    {
                        type: 'activity',
                        id: 's_hydrated_activity_stale_heartbeat',
                        sessionId: 's_hydrated_activity_stale_heartbeat',
                        active: true,
                        activeAt: 60_000,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('records activity flush telemetry for hydrated and cache-only renderable updates', () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        storage.getState().applySessions([{ ...buildSession('s_hydrated_activity'), thinking: true, thinkingAt: 1 }]);
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_activity_timestamp_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_hydrated_activity',
                    {
                        type: 'activity',
                        id: 's_hydrated_activity',
                        sessionId: 's_hydrated_activity',
                        active: true,
                        activeAt: 20,
                        thinking: true,
                    },
                ],
                [
                    's_cached_activity_timestamp_only',
                    {
                        type: 'activity',
                        id: 's_cached_activity_timestamp_only',
                        sessionId: 's_cached_activity_timestamp_only',
                        active: true,
                        activeAt: 61_001,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        const event = syncPerformanceTelemetry
            .snapshot()
            .events.find((entry) => entry.name === 'sync.socket.sessions.activity.flush');
        expect(event?.fields).toEqual(expect.objectContaining({
            updates: 2,
            sessions: 1,
            renderablePatches: 1,
            renderableTimestampOnlyPatches: 1,
            renderableStateChangePatches: 0,
        }));
    });

    it('hydrates hidden encrypted metadata while deferring hidden encrypted agentState', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_hidden_metadata'),
            encryptionMode: 'e2ee',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
        }]);
        const decryptMetadata = vi.fn(async () => ({ path: '/work', host: 'devbox' }));
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: false }));
        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptAgentState,
                    decryptMetadata,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
            markSessionStateHydrationDeferred,
        } as Partial<HandleUpdateContainerBaseParams>);
        const updateData: ApiUpdateContainer = {
            id: 'u_hidden_encrypted_metadata_projection',
            seq: 14,
            createdAt: 1239,
            body: {
                t: 'update-session',
                id: 's_hidden_metadata',
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: 1238,
                latestReadyEventSeq: 8,
                latestReadyEventAt: 1238,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1238,
                meaningfulActivityAt: 1238,
                metadata: { version: 3, value: 'encrypted-metadata' },
                agentState: { version: 4, value: 'encrypted-agent-state' },
            },
        };

        await handleUpdateContainer({ ...params, updateData });

        expect(decryptMetadata).toHaveBeenCalledTimes(1);
        // Hidden encrypted agentState must be deferred: it is never decrypted in this path.
        expect(decryptAgentState).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_hidden_metadata',
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 1238,
            latestReadyEventSeq: 8,
            latestReadyEventAt: 1238,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1238,
            meaningfulActivityAt: 1238,
            metadataVersion: 3,
            metadata: { path: '/work', host: 'devbox' },
            agentStateVersion: 1,
            agentState: {},
        }));
        expect(markSessionStateHydrationDeferred).toHaveBeenCalledWith('s_hidden_metadata');
    });
});
