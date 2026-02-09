import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import * as persistence from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storage';
import { handleUpdateContainer } from './socket';

const initialStorageState = storage.getState();

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
        invalidateMessagesForSession: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
        invalidateSessions: vi.fn(),
        invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(),
        invalidateFriendRequests: vi.fn(),
        invalidateFeed: vi.fn(),
        invalidateTodos: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket update handling cursor isolation', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('does not persist durable changes cursor when handling new-session socket updates', async () => {
        const saveChangesCursorSpy = vi.spyOn(persistence, 'saveChangesCursor');
        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u1',
            seq: 10,
            createdAt: 100,
            body: { t: 'new-session' },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(params.invalidateSessions).toHaveBeenCalledTimes(1);
        expect(saveChangesCursorSpy).not.toHaveBeenCalled();
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
});
