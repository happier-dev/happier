import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storage';

const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => getActiveServerSnapshotMock(),
}));

const initialState = storage.getState();

function createSession(id: string, serverId?: string) {
    return {
        id,
        serverId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        pendingVersion: 1,
        pendingCount: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
    };
}

function createRenderableSession(id: string, serverId: string) {
    return buildSessionListRenderableFromSession(createSession(id, serverId));
}

describe('resolvePreferredServerIdForSessionId', () => {
    beforeEach(() => {
        getActiveServerSnapshotMock.mockReset();
        getActiveServerSnapshotMock.mockReturnValue({ serverId: 'active-server' });
        storage.setState(initialState, true);
    });

    afterEach(() => {
        storage.setState(initialState, true);
    });

    it('prefers the locally resolved owning server for a known session', async () => {
        const session = createSession('session-1', 'owner-server');
        storage.setState((state) => ({
            ...state,
            sessions: {
                'session-1': session,
            },
            sessionListViewData: [
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: createRenderableSession('session-1', 'active-server'),
                },
            ],
            sessionListViewDataByServerId: {
                'owner-server': [
                    {
                        type: 'session',
                        serverId: 'owner-server',
                        serverName: 'Owner',
                        session: createRenderableSession('session-1', 'owner-server'),
                    },
                ],
            },
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBe('owner-server');
    });

    it('falls back to the active server when the owning server is unknown', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListViewData: [
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: createRenderableSession('session-1', 'active-server'),
                },
            ],
            sessionListViewDataByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBe('active-server');
    });
});
