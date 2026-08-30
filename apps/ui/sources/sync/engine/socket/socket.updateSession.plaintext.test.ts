import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { clearActiveViewingSessionsForServerScopeReset, markSessionVisible } from '@/sync/domains/session/activeViewingSession';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { clearMountedSessionRealtimeTranscriptConsumers } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { flushActivityUpdates, handleUpdateContainer } from './socket';

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
        artifactDataKeys: new Map(),
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
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionId: null,
            trackedSessionIds: [],
            lastFocusedSessionId: null,
        });
        voiceSessionBindingStore.setState((state) => ({
            ...state,
            bindingsByConversationSessionId: {},
        }));
        storage.setState(initialStorageState, true);
    });

    it('applies working-to-online activity even when a newer durable projection advanced updatedAt', () => {
        const session = {
            ...buildSession('s_working_to_online'),
            updatedAt: 200,
            activeAt: 100,
            thinking: true,
            thinkingAt: 100,
        };
        storage.setState({
            ...initialStorageState,
            sessions: { [session.id]: session },
        });
        const applySessions = vi.fn();

        flushActivityUpdates({
            updates: new Map([[session.id, {
                type: 'activity',
                id: session.id,
                active: true,
                activeAt: 150,
                thinking: false,
            }]]),
            applySessions,
        });

        expect(applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: session.id,
                active: true,
                thinking: false,
                activeAt: 150,
            }),
        ]);
    });

    afterEach(() => {
        clearActiveViewingSessionsForServerScopeReset();
        clearMountedSessionRealtimeTranscriptConsumers();
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionId: null,
            trackedSessionIds: [],
            lastFocusedSessionId: null,
        });
        voiceSessionBindingStore.setState((state) => ({
            ...state,
            bindingsByConversationSessionId: {},
        }));
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
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

    it('hydrates hidden encrypted metadata while deferring agentState when no full transcript consumer is active', async () => {
        storage.getState().applySessions([{
            ...buildSession('s1'),
            encryptionMode: 'e2ee',
            agentState: { controlledByUser: false, requests: {} },
            agentStateVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
        }]);
        const decryptMetadata = vi.fn(async () => ({
            path: '/work',
            host: 'devbox',
            title: 'Renamed session',
            summary: 'Updated list summary',
        }));
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: true, requests: {} }));
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
        const markSessionStateHydrationDeferred = vi.fn();

        await handleUpdateContainer({
            ...params,
            markSessionStateHydrationDeferred,
            updateData: {
                id: 'u_projection_hidden',
                seq: 11,
                createdAt: 2_000,
                body: {
                    t: 'update-session',
                    id: 's1',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestReadyEventSeq: 12,
                    latestReadyEventAt: 1_950,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_950,
                    meaningfulActivityAt: 1_950,
                    metadata: { version: 2, value: 'encrypted-metadata' },
                    agentState: { version: 2, value: 'encrypted-agent-state' },
                },
            },
        });

        expect(decryptMetadata).toHaveBeenCalledTimes(1);
        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(markSessionStateHydrationDeferred).toHaveBeenCalledWith('s1');
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession).toEqual(expect.objectContaining({
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestReadyEventSeq: 12,
            latestReadyEventAt: 1_950,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_950,
            meaningfulActivityAt: 1_950,
            metadata: {
                path: '/work',
                host: 'devbox',
                title: 'Renamed session',
                summary: 'Updated list summary',
            },
            metadataVersion: 2,
            agentState: { controlledByUser: false, requests: {} },
            agentStateVersion: 1,
        }));
    });

    it('defers hidden encrypted agentState hydration when projected counts show no side-effect work', async () => {
        storage.getState().applySessions([{
            ...buildSession('s1'),
            encryptionMode: 'e2ee',
            agentState: { controlledByUser: false, requests: {} },
            agentStateVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 100,
        }]);
        const decryptAgentState = vi.fn(async () => ({ controlledByUser: false, requests: {} }));
        const onSessionVisible = vi.fn();
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata: vi.fn(async () => ({ path: '/work', host: 'devbox' })),
                    decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
            onSessionVisible,
        });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hidden_agent_state_projection',
                seq: 12,
                createdAt: 2_100,
                body: {
                    t: 'update-session',
                    id: 's1',
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 2_050,
                    agentState: { version: 2, value: 'encrypted-agent-state' },
                },
            },
        });

        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(onSessionVisible).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession).toEqual(expect.objectContaining({
            agentState: { controlledByUser: false, requests: {} },
            agentStateVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 2_050,
        }));
    });

    it('hydrates visible scoped encrypted agentState using the source server when the local session cache has a stale alias', async () => {
        const sessionId = 's_source_scoped_state';
        const sourceServerId = 'srv_actual_state_scope';
        const staleLocalServerId = 'stack_route_alias_for_state_scope';
        markSessionVisible(sessionId, sourceServerId);
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            serverId: staleLocalServerId,
            encryptionMode: 'e2ee',
            agentState: { controlledByUser: false, requests: {} },
            agentStateVersion: 1,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }]);
        const decryptedAgentState = { controlledByUser: false, requests: { live: { status: 'running' } } };
        const decryptAgentState = vi.fn(async () => decryptedAgentState);
        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => ({
                    decryptMetadata: vi.fn(async () => ({ path: '/work', host: 'devbox' })),
                    decryptAgentState,
                }),
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
            } as unknown as HandleUpdateContainerBaseParams['encryption'],
            markSessionStateHydrationDeferred,
        });

        await handleUpdateContainer({
            ...params,
            sourceServerId,
            updateData: {
                id: 'u_source_scoped_agent_state',
                seq: 13,
                createdAt: 2_200,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    agentState: { version: 2, value: 'encrypted-agent-state' },
                },
            },
        });

        expect(decryptAgentState).toHaveBeenCalledTimes(1);
        expect(markSessionStateHydrationDeferred).not.toHaveBeenCalled();
        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        const updatedSession = applySessionsSpy.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession).toEqual(expect.objectContaining({
            agentState: decryptedAgentState,
            agentStateVersion: 2,
        }));
    });

    it('hydrates hidden encrypted agentState when the session is still controlled by the user', async () => {
        storage.getState().applySessions([{
            ...buildSession('s1'),
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
                seq: 13,
                createdAt: 2_200,
                body: {
                    t: 'update-session',
                    id: 's1',
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
            ...buildSession('s1'),
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
                seq: 14,
                createdAt: 2_300,
                body: {
                    t: 'update-session',
                    id: 's1',
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

    it('reports ready cursor projection advances once for update-session payloads', async () => {
        vi.useFakeTimers();
        storage.getState().applySessions([{
            ...buildSession('s1'),
            lastViewedSessionSeq: 2,
            latestReadyEventSeq: 3,
        }]);
        const onReadyProjectionAdvance = vi.fn();
        const applySessions = vi.fn<HandleUpdateContainerBaseParams['applySessions']>((sessions) => {
            storage.getState().applySessions(sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            })) as Session[]);
        });
        const params = buildBaseParams({
            onReadyProjectionAdvance,
            applySessions,
        });

        const updateData: ApiUpdateContainer = {
            id: 'u_ready_projection',
            seq: 12,
            createdAt: 2_000,
            body: {
                t: 'update-session',
                id: 's1',
                latestReadyEventSeq: 4,
                latestReadyEventAt: 1_900,
            },
        };

        await handleUpdateContainer({ ...params, updateData });
        await handleUpdateContainer({ ...params, updateData: { ...updateData, id: 'u_ready_projection_replay', seq: 13 } });
        await vi.runAllTimersAsync();

        expect(onReadyProjectionAdvance).toHaveBeenCalledTimes(1);
        expect(onReadyProjectionAdvance).toHaveBeenCalledWith('s1', 4);
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

    it('invalidates sessions when an unpatchable agentState update-session targets a cache-only row', async () => {
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
                agentState: { version: 2, value: JSON.stringify({ controlledByUser: true }) },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(params.invalidateSessions).toHaveBeenCalledTimes(1);
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('records the socket invalidation reason when an update-session payload cannot patch a local row', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
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
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_session_cache_only_telemetry',
            seq: 11,
            createdAt: 1235,
            body: {
                t: 'update-session',
                id: 's_cached_only',
                agentState: { version: 2, value: JSON.stringify({ controlledByUser: true }) },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        const event = syncPerformanceTelemetry
            .snapshot()
            .events.find((entry) => entry.name === 'sync.sessions.invalidate.requested');
        expect(event?.fields).toEqual(expect.objectContaining({
            reason_socketUpdateSessionMissingUnpatchable: 1,
            hasCachedRenderable: 1,
        }));
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
                pendingBlockedCount: 1,
                pendingVersion: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);

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
                meaningfulActivityAt: 2_345,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(storage.getState().sessionListRenderables['s_cached_pending']).toEqual(
            expect.objectContaining({
                pendingCount: 4,
                pendingBlockedCount: 1,
                pendingVersion: 8,
                meaningfulActivityAt: 2_345,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('clears cache-only blocked pending state when pending-changed sends explicit zero', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_pending_clear',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 2,
                pendingBlockedCount: 1,
                pendingVersion: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_pending_cache_only_clear',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'pending-changed',
                    sid: 's_cached_pending_clear',
                    pendingCount: 1,
                    pendingBlockedCount: 0,
                    pendingVersion: 8,
                },
            } as ApiUpdateContainer,
        });

        expect(storage.getState().sessionListRenderables.s_cached_pending_clear).toEqual(
            expect.objectContaining({
                pendingCount: 1,
                pendingBlockedCount: 0,
                pendingVersion: 8,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('target-hydrates visible cache-only pending-changed rows after patching the renderable', async () => {
        const sessionId = 's_visible_cached_pending';
        storage.getState().replaceSessionListRenderables([
            {
                id: sessionId,
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
        markSessionVisible(sessionId, 'server-visible');

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            sourceServerId: 'server-visible',
            updateData: {
                id: 'u_visible_pending_cache_only',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'pending-changed',
                    sid: sessionId,
                    pendingCount: 4,
                    pendingVersion: 8,
                    meaningfulActivityAt: 2_345,
                },
            },
        });

        expect(storage.getState().sessionListRenderables[sessionId]).toEqual(
            expect.objectContaining({
                pendingCount: 4,
                pendingVersion: 8,
                meaningfulActivityAt: 2_345,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith(sessionId, 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates hydrated sessions for pending-changed meaningful activity without forcing a sessions refresh', async () => {
        storage.getState().applySessions([{ ...buildSession('s_hydrated_pending'), pendingBlockedCount: 1 }]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hydrated_pending_activity',
                seq: 13,
                createdAt: 1237,
                body: {
                    t: 'pending-changed',
                    sid: 's_hydrated_pending',
                    pendingCount: 2,
                    pendingVersion: 5,
                    meaningfulActivityAt: 3_456,
                },
            } as ApiUpdateContainer,
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_hydrated_pending',
            pendingCount: 2,
            pendingBlockedCount: 1,
            pendingVersion: 5,
            meaningfulActivityAt: 3_456,
        }));
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('clears hydrated blocked pending state when pending-changed sends explicit zero', async () => {
        storage.getState().applySessions([{ ...buildSession('s_hydrated_pending_clear'), pendingBlockedCount: 1 }]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hydrated_pending_clear',
                seq: 13,
                createdAt: 1237,
                body: {
                    t: 'pending-changed',
                    sid: 's_hydrated_pending_clear',
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 5,
                },
            } as ApiUpdateContainer,
        });

        const applySessionsSpy = params.applySessions as unknown as ReturnType<typeof vi.fn>;
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0]?.[0]?.[0]).toEqual(expect.objectContaining({
            id: 's_hydrated_pending_clear',
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 5,
        }));
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('prunes cached server-owned pending rows when pending-changed sends zero queued rows', async () => {
        const sessionId = 's_hydrated_pending_detail_clear';
        storage.getState().applySessions([{ ...buildSession(sessionId), pendingCount: 1, pendingVersion: 1 }]);
        storage.getState().applyPendingMessages(sessionId, [
            {
                id: 'server-pending-1',
                localId: 'server-pending-1',
                createdAt: 1,
                updatedAt: 1,
                source: 'server_pending',
                text: 'sent to provider',
                rawRecord: {},
            },
            {
                id: 'local-outbound-1',
                localId: 'local-outbound-1',
                createdAt: 2,
                updatedAt: 2,
                source: 'local_outbound',
                deliveryStatus: 'queued',
                text: 'saving locally',
                rawRecord: {},
            },
            {
                id: 'local-accepted-1',
                localId: 'local-accepted-1',
                createdAt: 3,
                updatedAt: 3,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'server_delivering',
                text: 'already handed to the server',
                rawRecord: {},
            },
            {
                id: 'local-external-1',
                localId: 'local-external-1',
                createdAt: 4,
                updatedAt: 4,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'external_handoff',
                text: 'external custody remains visible',
                rawRecord: {},
            },
            {
                id: 'local-blocked-1',
                localId: 'local-blocked-1',
                createdAt: 5,
                updatedAt: 5,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'blocked',
                text: 'blocked custody remains visible',
                rawRecord: {},
            },
            {
                id: 'local-cancel-1',
                localId: 'local-cancel-1',
                createdAt: 6,
                updatedAt: 6,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'server_delivering',
                pendingOutboxOperation: 'cancel',
                text: 'cancel custody remains visible',
                rawRecord: {},
            },
        ]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_hydrated_pending_detail_clear',
                seq: 13,
                createdAt: 1237,
                body: {
                    t: 'pending-changed',
                    sid: sessionId,
                    pendingCount: 0,
                    pendingBlockedCount: 0,
                    pendingVersion: 5,
                },
            } as ApiUpdateContainer,
        });

        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
            'local-outbound-1',
            'local-external-1',
            'local-blocked-1',
            'local-cancel-1',
        ]);
    });

    it('uses targeted session hydration for unpatchable cache-only update-session payloads when available', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_targeted',
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
            },
        ]);

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_plain_session_cache_only_targeted',
                seq: 11,
                createdAt: 1235,
                body: {
                    t: 'update-session',
                    id: 's_cached_targeted',
                    agentState: { version: 2, value: JSON.stringify({ controlledByUser: true }) },
                },
            },
        });

        expect(hydrateSessionById).toHaveBeenCalledWith('s_cached_targeted', 'socket-update-unpatchable');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('applies recipient share permission updates to existing sessions without list invalidation', async () => {
        storage.getState().applySessions([{
            ...buildSession('s_share_existing'),
            accessLevel: 'edit',
            canApprovePermissions: false,
        }]);
        const params = buildBaseParams();

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_existing',
                seq: 14,
                createdAt: 1238,
                body: {
                    t: 'session-share-updated',
                    sessionId: 's_share_existing',
                    shareId: 'share_1',
                    accessLevel: 'admin',
                    canApprovePermissions: true,
                    updatedAt: 1238,
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
        const params = buildBaseParams({ hydrateSessionById });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_legacy_payload',
                seq: 16,
                createdAt: 1240,
                body: {
                    t: 'session-share-updated',
                    sessionId: 's_share_legacy_payload',
                    shareId: 'share_legacy',
                    accessLevel: 'admin',
                    updatedAt: 1240,
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
        const params = buildBaseParams({ hydrateSessionById });

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_share_new',
                seq: 15,
                createdAt: 1239,
                body: {
                    t: 'session-shared',
                    sessionId: 's_share_new',
                    shareId: 'share_2',
                    sharedBy: { id: 'u1', firstName: null, lastName: null, username: 'owner', avatar: null },
                    accessLevel: 'edit',
                    canApprovePermissions: true,
                    createdAt: 1239,
                },
            } as ApiUpdateContainer,
        });

        expect(hydrateSessionById).toHaveBeenCalledWith('s_share_new', 'share-visibility-change');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates cache-only renderables for archive-only update-session payloads without forcing a sessions refresh', async () => {
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
                lastViewedSessionSeq: 2,
                hasUnreadMessages: false,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_archive_cache_only',
            seq: 13,
            createdAt: 1237,
            body: {
                t: 'update-session',
                id: 's_cached_archived',
                archivedAt: 44,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(storage.getState().sessionListRenderables['s_cached_archived']).toEqual(
            expect.objectContaining({
                archivedAt: 44,
                updatedAt: 1237,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates cache-only renderables for safe projection update-session payloads without forcing hydration', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_projection',
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
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_projection_cache_only',
                seq: 13,
                createdAt: 1237,
                body: {
                    t: 'update-session',
                    id: 's_cached_projection',
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 1,
                    pendingRequestObservedAt: 1200,
                    latestReadyEventSeq: 9,
                    latestReadyEventAt: 1210,
                    latestTurnId: 'turn-2',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1210,
                    meaningfulActivityAt: 1210,
                    archivedAt: null,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_projection']).toEqual(
            expect.objectContaining({
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: true,
                pendingRequestObservedAt: 1200,
                latestReadyEventSeq: 9,
                latestReadyEventAt: 1210,
                hasUnreadMessages: true,
                latestTurnId: 'turn-2',
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1210,
                meaningfulActivityAt: 1210,
                updatedAt: 1237,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates cache-only renderables for runtime activity projection payloads without forcing hydration', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_runtime_activity_projection',
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
                latestTurnStatus: 'completed',
                runtimeActivityState: 'idle',
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 1,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_runtime_activity_projection_cache_only',
                seq: 13,
                createdAt: 1237,
                body: {
                    t: 'update-session',
                    id: 's_cached_runtime_activity_projection',
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 1200,
                    runtimeActivityRevision: 2,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_runtime_activity_projection']).toEqual(
            expect.objectContaining({
                runtimeActivityActiveCount: 1,
                runtimeActivityState: 'active',
                runtimeActivityObservedAt: 1200,
                runtimeActivityRevision: 2,
                updatedAt: 1237,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('target-hydrates visible cache-only update-session projections after patching the renderable', async () => {
        vi.useFakeTimers();
        const sessionId = 's_visible_cache_projection';
        storage.getState().replaceSessionListRenderables([
            {
                id: sessionId,
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
            },
        ]);
        markSessionVisible(sessionId, 'server-visible');

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            sourceServerId: 'server-visible',
            updateData: {
                id: 'u_visible_projection_cache_only',
                seq: 13,
                createdAt: 1237,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    latestTurnId: 'turn-2',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 1210,
                    meaningfulActivityAt: 1210,
                },
            },
        });
        await vi.runAllTimersAsync();

        expect(storage.getState().sessionListRenderables[sessionId]).toEqual(
            expect.objectContaining({
                latestTurnId: 'turn-2',
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 1210,
                meaningfulActivityAt: 1210,
                updatedAt: 1237,
            }),
        );
        expect(hydrateSessionById).toHaveBeenCalledWith(sessionId, 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('target-hydrates live full-content session turn projections after terminal turn updates', async () => {
        const sessionId = 's_live_turn_projection';
        const sourceServerId = 'server-live-turns';
        markSessionVisible(sessionId, sourceServerId);
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            active: false,
            latestTurnId: 'turn-1',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_100,
        }]);

        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({ hydrateSessionById });
        await handleUpdateContainer({
            ...params,
            sourceServerId,
            updateData: {
                id: 'u_live_turn_projection',
                seq: 14,
                createdAt: 1_237,
                body: {
                    t: 'update-session',
                    id: sessionId,
                    latestTurnId: 'turn-1',
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1_235,
                },
            },
        });

        expect(hydrateSessionById).toHaveBeenCalledWith(sessionId, 'socket-update-turn-projection');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('updates cache-only renderables for active-only update-session payloads without forcing hydration', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_active_projection',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 1,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_active_projection_cache_only',
                seq: 14,
                createdAt: 1238,
                body: {
                    t: 'update-session',
                    id: 's_cached_active_projection',
                    active: false,
                    activeAt: 1230,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_active_projection']).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1230,
                thinking: false,
                thinkingAt: 1230,
                updatedAt: 1238,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('updates cache-only renderables for safe projection fields while deferring agentState payloads', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_projection_with_state',
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
            },
        ]);

        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({ markSessionStateHydrationDeferred });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_projection_with_state_cache_only',
                seq: 14,
                createdAt: 1238,
                body: {
                    t: 'update-session',
                    id: 's_cached_projection_with_state',
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    pendingRequestObservedAt: 1220,
                    latestReadyEventSeq: 11,
                    latestReadyEventAt: 1221,
                    agentState: { version: 2, value: JSON.stringify({ controlledByUser: true }) },
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_projection_with_state']).toEqual(
            expect.objectContaining({
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: false,
                pendingRequestObservedAt: 1220,
                latestReadyEventSeq: 11,
                latestReadyEventAt: 1221,
                agentStateVersion: 0,
                hasUnreadMessages: true,
            }),
        );
        expect(markSessionStateHydrationDeferred).toHaveBeenCalledWith('s_cached_projection_with_state');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('keeps cache-only projection fields when metadata cannot be hydrated yet', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_projection_with_deferred_metadata',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost', name: 'Old title' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const markSessionStateHydrationDeferred = vi.fn();
        const params = buildBaseParams({ markSessionStateHydrationDeferred });
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_projection_with_deferred_metadata_cache_only',
                seq: 15,
                createdAt: 1240,
                body: {
                    t: 'update-session',
                    id: 's_cached_projection_with_deferred_metadata',
                    metadata: { version: 2, value: 'encrypted-metadata-without-loaded-key' },
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    latestReadyEventSeq: 12,
                    latestReadyEventAt: 1239,
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1239,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_projection_with_deferred_metadata']).toEqual(
            expect.objectContaining({
                metadata: expect.objectContaining({ name: 'Old title' }),
                metadataVersion: 1,
                hasPendingPermissionRequests: true,
                hasPendingUserActionRequests: false,
                latestReadyEventSeq: 12,
                latestReadyEventAt: 1239,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1239,
                hasUnreadMessages: true,
                updatedAt: 1240,
            }),
        );
        expect(markSessionStateHydrationDeferred).toHaveBeenCalledWith('s_cached_projection_with_deferred_metadata');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('coalesces cache-only non-urgent update-session projection patches until the activity window flushes', async () => {
        vi.useFakeTimers();
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_projection_progress_only',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                latestReadyEventSeq: 10,
                lastViewedSessionSeq: 1,
                hasUnreadMessages: true,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_projection_progress_only',
                seq: 11,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_projection_progress_only',
                    latestTurnStatusObservedAt: 1235,
                    meaningfulActivityAt: 1235,
                },
            },
        });

        const progressBeforeFlush = storage.getState().sessionListRenderables['s_cached_projection_progress_only'];
        expect(progressBeforeFlush?.latestTurnStatusObservedAt).toBeUndefined();
        expect(progressBeforeFlush?.meaningfulActivityAt).toBeUndefined();
        expect(progressBeforeFlush?.updatedAt).toBe(1);

        await vi.runAllTimersAsync();

        expect(storage.getState().sessionListRenderables['s_cached_projection_progress_only']).toEqual(
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
                id: 's_cached_projection_urgent_after_progress',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                latestReadyEventSeq: null,
                lastViewedSessionSeq: 100,
                hasUnreadMessages: false,
                hasPendingPermissionRequests: false,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_projection_progress_before_urgent',
                seq: 11,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_projection_urgent_after_progress',
                    latestTurnStatusObservedAt: 1235,
                    meaningfulActivityAt: 1235,
                },
            },
        });

        const urgentBeforePending = storage.getState().sessionListRenderables['s_cached_projection_urgent_after_progress'];
        expect(urgentBeforePending?.latestTurnStatusObservedAt).toBeUndefined();
        expect(urgentBeforePending?.hasPendingPermissionRequests).toBe(false);

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_projection_urgent_pending',
                seq: 12,
                createdAt: 1237,
                body: {
                    t: 'update-session',
                    id: 's_cached_projection_urgent_after_progress',
                    pendingPermissionRequestCount: 1,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_projection_urgent_after_progress']).toEqual(
            expect.objectContaining({
                latestTurnStatusObservedAt: 1235,
                meaningfulActivityAt: 1235,
                hasPendingPermissionRequests: true,
                updatedAt: 1237,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(16);
    });

    it('applies same-timestamp higher-seq urgent cache-only projection after queued non-urgent progress', async () => {
        vi.useFakeTimers();
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_projection_same_timestamp_urgent',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                latestReadyEventSeq: null,
                lastViewedSessionSeq: 100,
                hasUnreadMessages: false,
                hasPendingPermissionRequests: false,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_projection_same_timestamp_progress',
                seq: 11,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_projection_same_timestamp_urgent',
                    latestTurnStatusObservedAt: 1235,
                    meaningfulActivityAt: 1235,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_projection_same_timestamp_urgent']).toEqual(
            expect.objectContaining({
                seq: 1,
                updatedAt: 1,
                hasPendingPermissionRequests: false,
            }),
        );

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_projection_same_timestamp_urgent_pending',
                seq: 12,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_projection_same_timestamp_urgent',
                    pendingPermissionRequestCount: 1,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_projection_same_timestamp_urgent']).toEqual(
            expect.objectContaining({
                latestTurnStatusObservedAt: 1235,
                meaningfulActivityAt: 1235,
                hasPendingPermissionRequests: true,
                updatedAt: 1236,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(16);
    });

    it('marks cache-only renderables unread when a ready projection advances past the read cursor', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_ready_becomes_unread',
                seq: 945,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                latestReadyEventSeq: null,
                lastViewedSessionSeq: 945,
                hasUnreadMessages: false,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_cache_only_ready_becomes_unread',
                seq: 946,
                createdAt: 1236,
                body: {
                    t: 'update-session',
                    id: 's_cached_ready_becomes_unread',
                    latestReadyEventSeq: 946,
                    latestReadyEventAt: 1236,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_ready_becomes_unread']).toEqual(
            expect.objectContaining({
                latestReadyEventSeq: 946,
                latestReadyEventAt: 1236,
                hasUnreadMessages: true,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('clears cache-only unread state when read cursor catches up to the ready projection', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_read_cursor',
                seq: 9,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp', host: 'localhost' },
                latestReadyEventSeq: 9,
                lastViewedSessionSeq: 2,
                hasUnreadMessages: true,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const params = buildBaseParams();
        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_read_cursor_cache_only',
                seq: 14,
                createdAt: 1238,
                body: {
                    t: 'update-session',
                    id: 's_cached_read_cursor',
                    lastViewedSessionSeq: 9,
                },
            },
        });

        expect(storage.getState().sessionListRenderables['s_cached_read_cursor']).toEqual(
            expect.objectContaining({
                lastViewedSessionSeq: 9,
                latestReadyEventSeq: 9,
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

    it('patches cache-only renderables for plaintext metadata update-session payloads', async () => {
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_metadata',
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
            },
        ]);

        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_plain_metadata_cache_only',
            seq: 14,
            createdAt: 1238,
            body: {
                t: 'update-session',
                id: 's_cached_metadata',
                metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
                archivedAt: 55,
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(storage.getState().sessionListRenderables['s_cached_metadata']).toEqual(
            expect.objectContaining({
                metadata: expect.objectContaining({ path: '/work', host: 'devbox' }),
                metadataVersion: 2,
                archivedAt: 55,
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

        expect(storage.getState().sessionListRenderables['s_cached_metadata_read_state']).toEqual(
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
                id: 's_cached_encrypted_metadata',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 1,
                metadata: { path: '/tmp', host: 'localhost' },
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            },
        ]);

        const decryptMetadata = vi.fn(async () => ({ path: '/work', host: 'devbox', name: 'Renamed' }));
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

        await handleUpdateContainer({
            ...params,
            updateData: {
                id: 'u_encrypted_metadata_cache_only',
                seq: 15,
                createdAt: 1239,
                body: {
                    t: 'update-session',
                    id: 's_cached_encrypted_metadata',
                    metadata: { version: 2, value: 'encrypted-metadata' },
                    agentState: { version: 3, value: 'encrypted-agent-state' },
                    latestTurnStatus: 'completed',
                    latestTurnStatusObservedAt: 1239,
                },
            },
        });

        expect(decryptMetadata).toHaveBeenCalledTimes(1);
        expect(decryptAgentState).not.toHaveBeenCalled();
        expect(storage.getState().sessionListRenderables['s_cached_encrypted_metadata']).toEqual(
            expect.objectContaining({
                metadata: expect.objectContaining({ path: '/work', host: 'devbox', name: 'Renamed' }),
                metadataVersion: 2,
                agentStateVersion: 1,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1239,
                updatedAt: 1239,
            }),
        );
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect((params.applySessions as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('skips fresh cache-only timestamp-only activity patches until runtime freshness needs refresh', async () => {
        vi.useFakeTimers();
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
                activeAt: 1,
                thinkingAt: 1,
                updatedAt: 1,
            }),
        );
        expect(syncPerformanceTelemetry.snapshot().events.find((entry) => entry.name === 'sync.socket.sessions.activity.flush')?.fields)
            .toEqual(expect.objectContaining({
                renderablePatches: 1,
                renderableTimestampOnlyPatches: 1,
                renderableTimestampOnlySkippedFreshPatches: 0,
            }));

        await vi.advanceTimersByTimeAsync(16);

        expect(storage.getState().sessionListRenderables.s_cached_activity_timestamp_gate).toEqual(
            expect.objectContaining({
                activeAt: 61_001,
                thinkingAt: 61_001,
                updatedAt: 61_001,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('refreshes cache-only activity timestamps even when a durable projection has a newer updatedAt', async () => {
        vi.useFakeTimers();
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
                activeAt: 1,
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
                updatedAt: 100_000,
            }),
        );

        await vi.advanceTimersByTimeAsync(16);

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

    it('records activity flush telemetry for hydrated and cache-only renderable updates', async () => {
        vi.useFakeTimers();
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

        await vi.advanceTimersByTimeAsync(16);
    });

    it('updates cache-only renderables for activity updates without waiting for hydration', async () => {
        vi.useFakeTimers();
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_activity',
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
                    's_cached_activity',
                    {
                        type: 'activity',
                        id: 's_cached_activity',
                        sessionId: 's_cached_activity',
                        active: false,
                        activeAt: 20,
                        thinking: false,
                    },
                ],
            ]),
            applySessions,
        });

        expect(storage.getState().sessionListRenderables['s_cached_activity']).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 1,
                thinking: true,
                thinkingAt: 1,
                presence: 'online',
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(16);

        expect(storage.getState().sessionListRenderables['s_cached_activity']).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 20,
                thinking: false,
                thinkingAt: 20,
                presence: 20,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });

    it('coalesces cache-only activity renderable patches across sessions before touching the list store', async () => {
        vi.useFakeTimers();
        storage.getState().replaceSessionListRenderables([
            {
                id: 's_cached_activity_coalesced_one',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp/one', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
            {
                id: 's_cached_activity_coalesced_two',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: false,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: { path: '/tmp/two', host: 'localhost' },
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            },
        ]);

        const applySessions = vi.fn();
        flushActivityUpdates({
            updates: new Map([
                [
                    's_cached_activity_coalesced_one',
                    {
                        type: 'activity',
                        id: 's_cached_activity_coalesced_one',
                        sessionId: 's_cached_activity_coalesced_one',
                        active: true,
                        activeAt: 20,
                        thinking: true,
                    },
                ],
                [
                    's_cached_activity_coalesced_two',
                    {
                        type: 'activity',
                        id: 's_cached_activity_coalesced_two',
                        sessionId: 's_cached_activity_coalesced_two',
                        active: true,
                        activeAt: 21,
                        thinking: true,
                    },
                ],
            ]),
            applySessions,
        });

        expect(storage.getState().sessionListRenderables['s_cached_activity_coalesced_one']).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            }),
        );
        expect(storage.getState().sessionListRenderables['s_cached_activity_coalesced_two']).toEqual(
            expect.objectContaining({
                active: false,
                activeAt: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(16);

        expect(storage.getState().sessionListRenderables['s_cached_activity_coalesced_one']).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 20,
                thinking: true,
                thinkingAt: 20,
                presence: 'online',
            }),
        );
        expect(storage.getState().sessionListRenderables['s_cached_activity_coalesced_two']).toEqual(
            expect.objectContaining({
                active: true,
                activeAt: 21,
                thinking: true,
                thinkingAt: 21,
                presence: 'online',
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });
});
