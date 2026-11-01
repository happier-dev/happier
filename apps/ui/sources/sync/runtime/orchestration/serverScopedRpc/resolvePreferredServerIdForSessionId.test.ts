import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

const initialState = storage.getState();
const activeServerId = getActiveServerSnapshot().serverId;
const ownerServerId = activeServerId + '-owner';

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
        storage.setState(initialState, true);
    });

    afterEach(() => {
        storage.setState(initialState, true);
    });

    it('prefers the locally resolved owning server for a known session', async () => {
        const session = createSession('session-1', ownerServerId);
        storage.setState((state) => ({
            ...state,
            sessions: {
                'session-1': session,
            },
            // The row corpus is Home-scoped, so a Session owned by `owner-server`
            // is projected there. Duplicating it under the focused Home would be
            // the two-Home collision the fail-closed case below covers.
            sessionListRowsByServerId: {
                [ownerServerId]: {
                    'session-1': createRenderableSession('session-1', ownerServerId),
                },
            },
            ordinarySessionListMembershipByServerId: { [ownerServerId]: ['session-1'] },
            sessionListIndexByServerId: {
                [ownerServerId]: [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: ownerServerId,
                        serverName: 'Owner',
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBe(ownerServerId);
    });

    it('resolves ordinary Home membership without a hydrated Session', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListRowsByServerId: {
                [activeServerId]: {
                    'session-1': createRenderableSession('session-1', activeServerId),
                },
            },
            ordinarySessionListMembershipByServerId: { [activeServerId]: ['session-1'] },
            sessionListIndexByServerId: {
                [activeServerId]: [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: activeServerId,
                        serverName: 'Active',
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBe(activeServerId);
    });

    it('ignores a stale canonical row without authoritative membership', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListRowsByServerId: {
                [activeServerId]: {
                    'session-1': createRenderableSession('session-1', activeServerId),
                },
            },
            ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBeUndefined();
    });

    it('fails closed when the same bare session id is projected by two Homes', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {
                'session-1': createSession('session-1', activeServerId),
            },
            sessionListRowsByServerId: {
                [activeServerId]: {
                    'session-1': createRenderableSession('session-1', activeServerId),
                },
                [ownerServerId]: {
                    'session-1': createRenderableSession('session-1', ownerServerId),
                },
            },
            ordinarySessionListMembershipByServerId: {
                [activeServerId]: ['session-1'],
                [ownerServerId]: ['session-1'],
            },
            sessionListIndexByServerId: {
                [activeServerId]: [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: activeServerId,
                        serverName: 'Active',
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBeUndefined();
    });

    it('returns undefined when the session cannot be resolved to any cached server', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListIndexByServerId: {
                [activeServerId]: [],
            },
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBeUndefined();
    });
});
