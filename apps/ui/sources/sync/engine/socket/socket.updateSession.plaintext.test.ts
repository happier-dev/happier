import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
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

    afterEach(() => {
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

    it('invalidates sessions when an update-session targets a cache-only row with no hydrated session', async () => {
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
                metadata: { version: 2, value: JSON.stringify({ path: '/work', host: 'devbox' }) },
            },
        };

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(params.invalidateSessions).toHaveBeenCalledTimes(1);
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

    it('keeps invalidating cache-only rows for metadata update-session payloads', async () => {
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

        expect(params.invalidateSessions).toHaveBeenCalledTimes(1);
    });

    it('updates cache-only renderables for activity updates without waiting for hydration', () => {
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
                active: false,
                activeAt: 20,
                thinking: false,
                thinkingAt: 20,
                presence: 20,
            }),
        );
        expect(applySessions).not.toHaveBeenCalled();
    });
});
