import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import * as persistence from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storage';
import { flushActivityUpdates, handleUpdateContainer } from './socket';

const initialStorageState = storage.getInitialState();

function buildSession(sessionId: string): Session {
    return {
        id: sessionId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function buildBaseParams(overrides: Partial<Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'>> = {}) {
    return {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
        } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
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
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket update handling cursor isolation', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('applies self-sufficient new-session socket updates without full list invalidation', async () => {
        const saveChangesCursorSpy = vi.spyOn(persistence, 'saveChangesCursor');
        const sessionDataKey = new Uint8Array([1, 2, 3]);
        const decryptEncryptionKey = vi.fn(async (_value: string) => sessionDataKey);
        const initializeSessions = vi.fn(async (_sessionKeys: Map<string, Uint8Array | null>) => {});
        const sessionEncryption = {
            decryptSessionSnapshotState: vi.fn(async () => ({
                metadata: {
                    name: 'Wave 11 created elsewhere',
                    path: '/repo',
                    homeDir: '/home/tester',
                    host: 'tester-host',
                    machineId: 'machine_1',
                    flavor: 'codex',
                },
                agentState: {},
            })),
            decryptMetadata: vi.fn(),
            decryptAgentState: vi.fn(),
        };
        const getSessionEncryption = vi.fn(() => sessionEncryption);
        const applySessions = vi.fn<Parameters<typeof handleUpdateContainer>[0]['applySessions']>();
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({
            applySessions,
            hydrateSessionById,
            encryption: {
                getSessionEncryption,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey,
                initializeSessions,
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
        });
        const updateData: ApiUpdateContainer = {
            id: 'u1',
            seq: 10,
            createdAt: 100,
            body: {
                t: 'new-session',
                id: 's_new',
                seq: 1,
                metadata: 'encrypted-metadata',
                metadataVersion: 2,
                agentState: 'encrypted-agent-state',
                agentStateVersion: 3,
                dataEncryptionKey: 'encrypted-data-key',
                encryptionMode: 'e2ee',
                active: true,
                activeAt: 100,
                createdAt: 90,
                updatedAt: 100,
                meaningfulActivityAt: 95,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(decryptEncryptionKey).toHaveBeenCalledWith('encrypted-data-key');
        expect(initializeSessions).toHaveBeenCalledTimes(1);
        const initializedSessionKeys = initializeSessions.mock.calls[0]?.[0];
        expect(initializedSessionKeys).toBeInstanceOf(Map);
        expect(Array.from(initializedSessionKeys?.entries() ?? [])).toEqual([
            ['s_new', sessionDataKey],
        ]);
        expect(getSessionEncryption).toHaveBeenCalledWith('s_new');
        expect(sessionEncryption.decryptSessionSnapshotState).toHaveBeenCalledWith(
            2,
            'encrypted-metadata',
            3,
            'encrypted-agent-state',
        );
        expect(applySessions).toHaveBeenCalledTimes(1);
        const appliedSession = applySessions.mock.calls[0]?.[0]?.[0] as Session;
        expect(appliedSession).toMatchObject({
            id: 's_new',
            seq: 1,
            encryptionMode: 'e2ee',
            createdAt: 90,
            updatedAt: 100,
            meaningfulActivityAt: 95,
            active: true,
            activeAt: 100,
            metadataVersion: 2,
            agentStateVersion: 3,
            presence: 'online',
        });
        expect(appliedSession.metadata?.name).toBe('Wave 11 created elsewhere');
        expect(hydrateSessionById).toHaveBeenCalledWith('s_new', 'socket-new-session-reconcile');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect(saveChangesCursorSpy).not.toHaveBeenCalled();
    });

    it('falls back to targeted hydration when a new-session socket payload cannot be decrypted', async () => {
        const decryptEncryptionKey = vi.fn(async (_value: string) => {
            throw new Error('decrypt failed');
        });
        const hydrateSessionById = vi.fn();
        const applySessions = vi.fn<Parameters<typeof handleUpdateContainer>[0]['applySessions']>();
        const params = buildBaseParams({
            applySessions,
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey,
                initializeSessions: vi.fn(async (_sessionKeys: Map<string, Uint8Array | null>) => {}),
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            hydrateSessionById,
        });
        // Compatibility fixture: older socket payloads can carry only sid even though the current contract requires id.
        const updateData: ApiUpdateContainer = {
            id: 'u1b',
            seq: 11,
            createdAt: 101,
            body: {
                t: 'new-session',
                id: 's_decrypt_fail',
                seq: 1,
                metadata: 'encrypted-metadata',
                metadataVersion: 2,
                agentState: 'encrypted-agent-state',
                agentStateVersion: 3,
                dataEncryptionKey: 'encrypted-data-key',
                encryptionMode: 'e2ee',
                active: true,
                activeAt: 101,
                createdAt: 90,
                updatedAt: 101,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(applySessions).not.toHaveBeenCalled();
        expect(hydrateSessionById).toHaveBeenCalledWith('s_decrypt_fail', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('falls back to targeted hydration using sid when a new-session socket payload has no id', async () => {
        const hydrateSessionById = vi.fn();
        const params = buildBaseParams({
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey: vi.fn(async (_value: string) => {
                    throw new Error('decrypt failed');
                }),
                initializeSessions: vi.fn(async (_sessionKeys: Map<string, Uint8Array | null>) => {}),
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
            hydrateSessionById,
        });
        const updateData: ApiUpdateContainer = {
            id: 'u1c',
            seq: 12,
            createdAt: 102,
            body: {
                t: 'new-session',
                sid: 's_sid_only_decrypt_fail',
                seq: 1,
                metadata: 'encrypted-metadata',
                metadataVersion: 2,
                agentState: 'encrypted-agent-state',
                agentStateVersion: 3,
                dataEncryptionKey: 'encrypted-data-key',
                encryptionMode: 'e2ee',
            },
        } as unknown as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(hydrateSessionById).toHaveBeenCalledWith('s_sid_only_decrypt_fail', 'socket-update-missing-session');
        expect(params.invalidateSessions).not.toHaveBeenCalled();
    });

    it('does not persist durable changes cursor when applying pending-changed socket updates', async () => {
        const sessionId = 's1';
        storage.getState().applySessions([buildSession(sessionId)]);
        const saveChangesCursorSpy = vi.spyOn(persistence, 'saveChangesCursor');
        const applySessions = vi.fn();
        const params = buildBaseParams({ applySessions });
        const updateData: ApiUpdateContainer = {
            id: 'u2',
            seq: 11,
            createdAt: 101,
            body: {
                t: 'pending-changed',
                sid: sessionId,
                pendingCount: 3,
                pendingVersion: 42,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(applySessions).toHaveBeenCalledTimes(1);
        const updatedSession = applySessions.mock.calls[0]?.[0]?.[0] as Session & {
            pendingCount?: number;
            pendingVersion?: number;
        };
        expect(updatedSession?.pendingCount).toBe(3);
        expect(updatedSession?.pendingVersion).toBe(42);
        expect(saveChangesCursorSpy).not.toHaveBeenCalled();
    });

    it('ignores stale activity thinking=true updates after lifecycle clear', () => {
        const sessionId = 's_stale_activity';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            thinking: false,
            thinkingAt: 200,
            updatedAt: 200,
        }]);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: true, activeAt: 150, thinking: true }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('ignores stale activity thinking=true updates when activeAt equals updatedAt (prevents resurrecting cleared sessions)', () => {
        const sessionId = 's_equal_activeAt';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            thinking: false,
            thinkingAt: 150,
            updatedAt: 150,
        }]);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: true, activeAt: 150, thinking: true }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        expect(applySessions).not.toHaveBeenCalled();
    });

    it('does not let newer legacy activity thinking override a terminal turn projection', () => {
        const sessionId = 's_terminal_activity';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            thinking: false,
            thinkingAt: 200,
            updatedAt: 200,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 200,
        }]);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: true, activeAt: 300, thinking: true }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        expect(applySessions).toHaveBeenCalledTimes(1);
        const updatedSession = applySessions.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession.activeAt).toBe(300);
        expect(updatedSession.thinking).toBe(false);
        expect(updatedSession.latestTurnStatus).toBe('completed');
    });

    it('applies activity active=false updates even if activeAt < updatedAt', async () => {
        const sessionId = 's_inactive_turnoff';
        storage.getState().applySessions([{
            ...buildSession(sessionId),
            active: true,
            activeAt: 100,
            updatedAt: 200,
            thinking: false,
            thinkingAt: 200,
        }]);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: false, activeAt: 150, thinking: false }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        await expect.poll(() => applySessions.mock.calls.length).toBe(1);
        const updatedSession = applySessions.mock.calls[0]?.[0]?.[0] as Session;
        expect(updatedSession.active).toBe(false);
        expect(updatedSession.activeAt).toBe(150);
        expect(updatedSession.thinking).toBe(false);
        expect(updatedSession.thinkingAt).toBe(150);
    });

    it('patches list-only session rows from activity updates', async () => {
        vi.useFakeTimers();
        const sessionId = 's_renderable_only';
        storage.setState({
            sessions: {},
            sessionMessages: {},
            sessionPending: {},
            sessionListRenderables: {
                [sessionId]: buildSessionListRenderableFromSession({
                    ...buildSession(sessionId),
                    active: true,
                    activeAt: 100,
                    thinking: false,
                    thinkingAt: 0,
                }),
            },
            isDataReady: true,
        } as never);

        const updates = new Map<string, any>([
            [sessionId, { type: 'activity', id: sessionId, active: true, activeAt: 200, thinking: true }],
        ]);
        const applySessions = vi.fn();

        flushActivityUpdates({ updates, applySessions });

        expect(applySessions).not.toHaveBeenCalled();
        expect(storage.getState().sessionListRenderables[sessionId]).toMatchObject({
            active: true,
            activeAt: 100,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        await vi.advanceTimersByTimeAsync(16);

        expect(storage.getState().sessionListRenderables[sessionId]).toMatchObject({
            active: true,
            activeAt: 200,
            thinking: true,
            thinkingAt: 200,
            presence: 'online',
        });
    });
});
