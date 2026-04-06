import { describe, expect, it } from 'vitest';

import {
    findSessionListCachedSession,
    listSessionListCachedActiveSessionIds,
    listSessionListCachedActiveSessions,
    listSessionListCachedServerSessions,
    listSessionListCachedServers,
    resolveSessionListCachedSessionServerScopeFromState,
    resolveSessionListPreferredSessionMetadataFromState,
    resolveSessionListPreferredServerIdFromState,
    resolveSessionListCachedSessionServerIdFromState,
} from './sessionListCacheState';
import {
    findServerScopedSessionListCacheSession,
    listServerScopedSessionListCacheServers,
    listServerScopedSessionListCacheSessions,
} from './serverScopedSessionListCache';

describe('sessionListCacheState', () => {
    it('prefers the active list cache entry before side-server cache entries', () => {
        const state: any = {
            sessionListViewData: [
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: { id: 's1', updatedAt: 10 },
                },
            ],
            sessionListViewDataByServerId: {
                'side-server': [
                    {
                        type: 'session',
                        serverId: 'side-server',
                        serverName: 'Side',
                        session: { id: 's1', updatedAt: 5 },
                    },
                ],
            },
        };

        expect(findSessionListCachedSession(state, 's1')).toEqual({
            serverId: 'active-server',
            serverName: 'Active',
            session: { id: 's1', updatedAt: 10 },
        });
    });

    it('falls back to side-server cache entries when the active list has no match', () => {
        const state: any = {
            sessionListViewData: [],
            sessionListViewDataByServerId: {
                'side-server': [
                    {
                        type: 'session',
                        serverId: 'side-server',
                        serverName: 'Side',
                        session: { id: 's2', updatedAt: 7 },
                    },
                ],
            },
        };
        const scopedMatch = findServerScopedSessionListCacheSession(state.sessionListViewDataByServerId, 's2');
        expect(scopedMatch).toEqual({
            type: 'session',
            serverId: 'side-server',
            serverName: 'Side',
            session: { id: 's2', updatedAt: 7 },
        });
        expect(findSessionListCachedSession(state, 's2')).toBe(scopedMatch);
        expect(findSessionListCachedSession(state, 'missing')).toBeNull();
    });

    it('resolves the direct session-map serverId before cached list data', () => {
        const state: any = {
            sessions: {
                s1: { id: 's1', serverId: 'session-server' },
            },
            sessionListViewData: [
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: { id: 's1', updatedAt: 10 },
                },
            ],
            sessionListViewDataByServerId: {
                'side-server': [
                    {
                        type: 'session',
                        serverId: 'side-server',
                        serverName: 'Side',
                        session: { id: 's1', updatedAt: 5 },
                    },
                ],
            },
        };

        expect(resolveSessionListCachedSessionServerIdFromState(state, 's1')).toBe('session-server');
    });

    it('resolves a preferred serverId from the canonical session cache state', () => {
        const state: any = {
            sessions: {
                s1: { id: 's1', serverId: 'session-server' },
            },
            sessionListViewData: [
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: { id: 's1', updatedAt: 10 },
                },
            ],
            sessionListViewDataByServerId: {
                'side-server': [
                    {
                        type: 'session',
                        serverId: 'side-server',
                        serverName: 'Side',
                        session: { id: 's1', updatedAt: 5 },
                    },
                ],
            },
        };

        expect(resolveSessionListPreferredServerIdFromState(state, 's1', 'active-server')).toBe('session-server');
        expect(resolveSessionListPreferredServerIdFromState(state, 'missing', 'active-server')).toBe('active-server');
        expect(resolveSessionListPreferredServerIdFromState(state, 'missing', '   ')).toBeNull();
    });

    it('resolves the cached session server scope from the canonical session cache state', () => {
        const state: any = {
            sessions: {
                s1: { id: 's1', serverId: ' session-server ' },
            },
            sessionListViewData: [
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: ' Active ',
                    session: { id: 's1', updatedAt: 10 },
                },
            ],
        };

        expect(resolveSessionListCachedSessionServerScopeFromState(state, 's1')).toEqual({
            serverId: 'session-server',
            serverName: 'Active',
        });
        expect(resolveSessionListCachedSessionServerScopeFromState(state, 'missing')).toBeNull();
    });

    it('prefers cached list metadata over stale direct session metadata for voice labels', () => {
        const state: any = {
            sessions: {
                s1: {
                    id: 's1',
                    metadata: {
                        summary: { text: 'Direct summary' },
                    },
                },
            },
            sessionListViewData: [
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: {
                        id: 's1',
                        metadata: {
                            summary: { text: 'Cached summary' },
                        },
                    },
                },
            ],
        };

        expect(resolveSessionListPreferredSessionMetadataFromState(state, 's1')).toEqual({
            summary: { text: 'Cached summary' },
        });
        expect(resolveSessionListPreferredSessionMetadataFromState(state, 'missing')).toBeNull();
    });

    it('lists only side-server cached session rows from state', () => {
        const state: any = {
            sessionListViewData: [
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: { id: 'active-session', updatedAt: 10 },
                },
            ],
            sessionListViewDataByServerId: {
                'side-server': [
                    { type: 'header', title: 'Side', serverId: 'side-server' },
                    {
                        type: 'session',
                        serverId: 'side-server',
                        serverName: 'Side',
                        session: { id: 's2', updatedAt: 7 },
                    },
                ],
            },
        };

        const canonicalSession = state.sessionListViewDataByServerId['side-server'][1];
        const scopedSessions = listServerScopedSessionListCacheSessions(state.sessionListViewDataByServerId);

        expect(scopedSessions).toEqual([
            {
                type: 'session',
                serverId: 'side-server',
                serverName: 'Side',
                session: { id: 's2', updatedAt: 7 },
            },
        ]);
        expect(scopedSessions[0]).toBe(canonicalSession);
        expect(listSessionListCachedServerSessions(state)).toEqual([
            {
                type: 'session',
                serverId: 'side-server',
                serverName: 'Side',
                session: { id: 's2', updatedAt: 7 },
            },
        ]);
    });

    it('lists active-list cached sessions and preserves their list order', () => {
        const state: any = {
            sessionListViewData: [
                { type: 'header', title: 'Pinned', serverId: 'active-server' },
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: { id: 's1', updatedAt: 10 },
                },
                {
                    type: 'session',
                    serverId: 'active-server',
                    serverName: 'Active',
                    session: { id: 's2', updatedAt: 5 },
                },
            ],
        };

        expect(listSessionListCachedActiveSessions(state)).toEqual([
            {
                serverId: 'active-server',
                serverName: 'Active',
                session: { id: 's1', updatedAt: 10 },
            },
            {
                serverId: 'active-server',
                serverName: 'Active',
                session: { id: 's2', updatedAt: 5 },
            },
        ]);
        expect(listSessionListCachedActiveSessionIds(state, 1)).toEqual(['s1']);
    });

    it('reuses shared empty arrays for missing cached active and side-server session listings', () => {
        const firstActive = listSessionListCachedActiveSessions(null);
        const secondActive = listSessionListCachedActiveSessions(undefined);
        const firstServers = listSessionListCachedServerSessions(null);
        const secondServers = listSessionListCachedServerSessions(undefined);
        const firstServerIds = listSessionListCachedServers(null);
        const secondServerIds = listSessionListCachedServers(undefined);

        expect(firstActive).toBe(secondActive);
        expect(firstServers).toBe(secondServers);
        expect(firstServerIds).toBe(secondServerIds);
        expect(firstActive).toEqual([]);
        expect(firstServers).toEqual([]);
        expect(firstServerIds).toEqual([]);
    });

    it('lists only side-server cached servers from state', () => {
        const state: any = {
            sessionListViewDataByServerId: {
                'server-a': [{ type: 'header', title: 'Only header', serverId: 'server-a' }],
                'server-b': [
                    {
                        type: 'session',
                        serverId: 'server-b',
                        serverName: 'Review',
                        session: { id: 's-review', updatedAt: 4 },
                    },
                ],
            },
        };

        expect(listServerScopedSessionListCacheServers(state.sessionListViewDataByServerId)).toEqual([
            { serverId: 'server-b', serverName: 'Review' },
        ]);
        expect(listSessionListCachedServers(state)).toEqual([
            { serverId: 'server-b', serverName: 'Review' },
        ]);
    });
});
