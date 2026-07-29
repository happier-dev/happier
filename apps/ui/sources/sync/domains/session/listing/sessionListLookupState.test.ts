import { describe, expect, it } from 'vitest';

import {
    findSessionListLookupSession,
    listSessionListLookupActiveSessionIds,
    listSessionListLookupActiveSessions,
    listSessionListLookupServerSessions,
    listSessionListLookupServers,
    resolveSessionListLookupSessionServerScopeFromState,
    resolveSessionListLookupSessionServerId,
    resolveSessionListPreferredServerIdFromState,
    resolveSessionListPreferredSessionMetadataFromState,
} from './sessionListLookupState';

describe('sessionListLookupState', () => {
    it('resolves the preferred serverId from the canonical session list index without sessionListViewData', () => {
        const state: any = {
            sessionListIndexByServerId: {
                'active-server': [
                    { type: 'header', title: 'Pinned', serverId: 'active-server' },
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
        };

        expect(resolveSessionListPreferredServerIdFromState(state, 's1', 'active-server')).toBe('active-server');
        expect(resolveSessionListLookupSessionServerScopeFromState(state, 's1')).toEqual({
            serverId: 'active-server',
            serverName: 'Active',
        });
    });

    it('resolves the lookup session scope from the canonical index even when direct session serverId is stale', () => {
        const state: any = {
            sessions: {
                s1: { id: 's1', serverId: 'stale-server' },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
        };

        expect(resolveSessionListLookupSessionServerScopeFromState(state, 's1')).toEqual({
            serverId: 'active-server',
            serverName: 'Active',
        });
    });

    it('lists active session ids from the canonical session list index without sessionListViewData', () => {
        const state: any = {
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
                s2: {
                    id: 's2',
                    seq: 2,
                    createdAt: 2,
                    updatedAt: 5,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    { type: 'header', title: 'Pinned', serverId: 'active-server' },
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                    {
                        type: 'session',
                        sessionId: 's2',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
        };

        expect(listSessionListLookupActiveSessions(state)).toEqual([
            {
                serverId: 'active-server',
                serverName: 'Active',
                session: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
            {
                serverId: 'active-server',
                serverName: 'Active',
                session: {
                    id: 's2',
                    seq: 2,
                    createdAt: 2,
                    updatedAt: 5,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
        ]);
        expect(listSessionListLookupActiveSessionIds(state, 1)).toEqual(['s1']);
    });

    it('prefers the active lookup entry before side-server cache entries', () => {
        const state: any = {
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
                'side-server': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'side-server',
                        serverName: 'Side',
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {
                'side-server': {
                    serverName: 'Side',
                    sessions: {
                        s1: { id: 's1', updatedAt: 5 },
                    },
                },
            },
        };

        expect(findSessionListLookupSession(state, 's1')).toEqual({
            serverId: 'active-server',
            serverName: 'Active',
            session: expect.objectContaining({
                id: 's1',
                updatedAt: 10,
                active: false,
                metadata: expect.objectContaining({ path: '' }),
            }),
        });
    });

    it('reuses the lookup session memo for repeated lookups on the same state snapshot', () => {
        let activeListReads = 0;
        let concurrentListReads = 0;
        const state: any = {
            get sessionListRenderables() {
                activeListReads += 1;
                return {
                    s1: {
                        id: 's1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 10,
                        active: false,
                        activeAt: 0,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: { path: '' },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 0,
                    },
                };
            },
            get sessionListIndexByServerId() {
                activeListReads += 1;
                return {
                    'active-server': [
                        {
                            type: 'session',
                            sessionId: 's1',
                            serverId: 'active-server',
                            serverName: 'Active',
                        },
                    ],
                };
            },
            get concurrentSessionListCacheByServerId() {
                concurrentListReads += 1;
                return {
                    'side-server': {
                        serverName: 'Side',
                        sessions: {
                            s1: { id: 's1', updatedAt: 5 },
                        },
                    },
                };
            },
        };

        const first = findSessionListLookupSession(state, ' s1 ');
        const readsAfterFirst = activeListReads;
        const second = findSessionListLookupSession(state, 's1');

        expect(first).toEqual({
            serverId: 'active-server',
            serverName: 'Active',
            session: {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: false,
                activeAt: 0,
                metadataVersion: 1,
                agentStateVersion: 1,
                metadata: expect.objectContaining({ path: '' }),
                thinking: false,
                thinkingAt: 0,
                presence: 0,
            },
        });
        expect(second).toBe(first);
        expect(activeListReads).toBe(readsAfterFirst);
        expect(concurrentListReads).toBe(0);
    });

    it('falls back to side-server cache entries when the active list has no match', () => {
        const state: any = {
            sessionListIndexByServerId: {
                'active-server': [],
            },
            concurrentSessionListCacheByServerId: {
                'side-server': {
                    serverName: 'Side',
                    sessions: {
                        s2: { id: 's2', updatedAt: 7 },
                    },
                },
            },
        };
        expect(findSessionListLookupSession(state, 's2')).toEqual({
            serverId: 'side-server',
            serverName: 'Side',
            session: { id: 's2', updatedAt: 7 },
        });
        expect(findSessionListLookupSession(state, 'missing')).toBeNull();
    });

    it('resolves a preferred serverId from the canonical session lookup state', () => {
        const state: any = {
            sessions: {
                s1: { id: 's1', serverId: 'session-server' },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {
                'side-server': {
                    serverName: 'Side',
                    sessions: {
                        s1: { id: 's1', updatedAt: 5 },
                    },
                },
            },
        };

        expect(resolveSessionListPreferredServerIdFromState(state, 's1', 'active-server')).toBe('session-server');
        expect(resolveSessionListPreferredServerIdFromState(state, 'missing', 'active-server')).toBe('active-server');
        expect(resolveSessionListPreferredServerIdFromState(state, 'missing', '   ')).toBeNull();
    });

    it('reuses the resolved preferred serverId for repeated lookups on the same state snapshot', () => {
        let serverIdReads = 0;
        const state: any = {
            sessions: {
                s1: {
                    id: 's1',
                    get serverId() {
                        serverIdReads += 1;
                        return ' session-server ';
                    },
                },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
        };

        const first = resolveSessionListPreferredServerIdFromState(state, ' s1 ', ' active-server ');
        const second = resolveSessionListPreferredServerIdFromState(state, 's1', 'active-server');

        expect(first).toBe('session-server');
        expect(second).toBe('session-server');
        expect(first).toBe(second);
        expect(serverIdReads).toBe(1);
    });

    it('resolves the lookup session server scope from the canonical session lookup state', () => {
        const state: any = {
            sessions: {
                s1: { id: 's1', serverId: ' session-server ' },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: ' Active ',
                    },
                ],
            },
        };

        expect(resolveSessionListLookupSessionServerScopeFromState(state, 's1')).toEqual({
            serverId: 'active-server',
            serverName: 'Active',
        });
        expect(resolveSessionListLookupSessionServerScopeFromState(state, 'missing')).toBeNull();
    });

    it('reuses the resolved session server scope for repeated lookups on the same state snapshot', () => {
        let serverIdReads = 0;
        const state: any = {
            sessions: {
                s1: {
                    id: 's1',
                    get serverId() {
                        serverIdReads += 1;
                        return ' session-server ';
                    },
                },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
        };

        const first = resolveSessionListLookupSessionServerScopeFromState(state, ' s1 ');
        const second = resolveSessionListLookupSessionServerScopeFromState(state, 's1');

        expect(first).toEqual({
            serverId: 'active-server',
            serverName: 'Active',
        });
        expect(second).toBe(first);
        expect(serverIdReads).toBe(1);
    });

    it('reuses the lookup session serverId memo for repeated lookups on the same state snapshot', () => {
        let serverIdReads = 0;
        const state: any = {
            sessions: {
                s1: {
                    id: 's1',
                    get serverId() {
                        serverIdReads += 1;
                        return ' session-server ';
                    },
                },
            },
        };

        const first = resolveSessionListLookupSessionServerId(state, ' s1 ');
        const second = resolveSessionListLookupSessionServerId(state, 's1');

        expect(first).toBe('session-server');
        expect(second).toBe(first);
        expect(serverIdReads).toBe(1);
    });

    it('prefers the direct session serverId before lookup-list resolution', () => {
        let sessionsReads = 0;
        let directServerIdReads = 0;
        let activeListReads = 0;
        let concurrentListReads = 0;
        const state: any = {
            get sessions() {
                sessionsReads += 1;
                return {
                    s1: {
                        id: 's1',
                        get serverId() {
                            directServerIdReads += 1;
                            return ' session-server ';
                        },
                    },
                };
            },
            get sessionListIndexByServerId() {
                activeListReads += 1;
                return {
                    'active-server': [
                        {
                            type: 'session',
                            sessionId: 's1',
                            serverId: 'active-server',
                            serverName: 'Active',
                        },
                    ],
                };
            },
            get concurrentSessionListCacheByServerId() {
                concurrentListReads += 1;
                return {
                    'side-server': {
                        serverName: 'Side',
                        sessions: {
                            s1: { id: 's1', updatedAt: 5 },
                        },
                    },
                };
            },
        };

        expect(resolveSessionListLookupSessionServerId(state, ' s1 ')).toBe('session-server');
        expect(sessionsReads).toBe(1);
        expect(directServerIdReads).toBe(1);
        expect(activeListReads).toBe(0);
        expect(concurrentListReads).toBe(0);
    });

    it('prefers lookup-list metadata over stale direct session metadata for voice labels', () => {
        const state: any = {
            sessions: {
                s1: {
                    id: 's1',
                    metadata: {
                        summary: { text: 'Direct summary' },
                    },
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 2,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: {
                        summary: { text: 'Lookup summary' },
                        path: '',
                    },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
        };

        expect(resolveSessionListPreferredSessionMetadataFromState(state, 's1')).toEqual({
            path: '',
            summary: { text: 'Lookup summary' },
        });
        expect(resolveSessionListPreferredSessionMetadataFromState(state, 'missing')).toBeNull();
    });

    it('preserves canonical direct-session machine identity when lookup metadata is stripped', () => {
        const state: any = {
            sessions: {
                s1: {
                    id: 's1',
                    metadata: {
                        path: '/workspace/direct-repo',
                        externalSessionV1: {
                            v: 1,
                            agentId: 'codex',
                            machineId: 'm-direct',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    },
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 2,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: {
                        path: '/workspace/direct-repo',
                        machineId: null,
                        externalSessionV1: {
                            v: 1,
                            agentId: 'codex',
                        },
                    },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
            sessionListIndexByServerId: {
                'server-a': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'server-a',
                        serverName: 'Server A',
                    },
                ],
            },
        };

        expect(resolveSessionListPreferredSessionMetadataFromState(state, 's1')).toEqual(expect.objectContaining({
            path: '/workspace/direct-repo',
            machineId: 'm-direct',
        }));
    });

    it('reuses the preferred session metadata for repeated lookups on the same state snapshot', () => {
        let metadataReads = 0;
        const state: any = {
            sessions: {
                s1: {
                    id: 's1',
                    get metadata() {
                        metadataReads += 1;
                        return {
                            summary: { text: 'Direct summary' },
                        };
                    },
                },
            },
        };

        const first = resolveSessionListPreferredSessionMetadataFromState(state, ' s1 ');
        const second = resolveSessionListPreferredSessionMetadataFromState(state, 's1');

        expect(first).toEqual({
            summary: { text: 'Direct summary' },
        });
        expect(second).toBe(first);
        expect(metadataReads).toBe(1);
    });

    it('lists server-scoped lookup session rows from state', () => {
        const state: any = {
            concurrentSessionListCacheByServerId: {
                'side-server': {
                    serverName: 'Side',
                    sessions: {
                        s2: { id: 's2', updatedAt: 7 },
                    },
                },
            },
        };

        expect(listSessionListLookupServerSessions(state)).toEqual([
            {
                serverId: 'side-server',
                serverName: 'Side',
                session: { id: 's2', updatedAt: 7 },
            },
        ]);
    });

    it('lists active-list lookup sessions and preserves their list order', () => {
        const state: any = {
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
                s2: {
                    id: 's2',
                    seq: 2,
                    createdAt: 2,
                    updatedAt: 5,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
            sessionListIndexByServerId: {
                'active-server': [
                    { type: 'header', title: 'Pinned', serverId: 'active-server' },
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                    {
                        type: 'session',
                        sessionId: 's2',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
        };

        expect(listSessionListLookupActiveSessions(state)).toEqual([
            {
                serverId: 'active-server',
                serverName: 'Active',
                session: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 10,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
            {
                serverId: 'active-server',
                serverName: 'Active',
                session: {
                    id: 's2',
                    seq: 2,
                    createdAt: 2,
                    updatedAt: 5,
                    active: false,
                    activeAt: 0,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: { path: '' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 0,
                },
            },
        ]);
        expect(listSessionListLookupActiveSessionIds(state, 1)).toEqual(['s1']);
    });

    it('reuses shared empty arrays for missing cached active and side-server session listings', () => {
        const firstActive = listSessionListLookupActiveSessions(null);
        const secondActive = listSessionListLookupActiveSessions(undefined);
        const firstServers = listSessionListLookupServerSessions(null);
        const secondServers = listSessionListLookupServerSessions(undefined);
        const firstServerIds = listSessionListLookupServers(null);
        const secondServerIds = listSessionListLookupServers(undefined);

        expect(firstActive).toBe(secondActive);
        expect(firstServers).toBe(secondServers);
        expect(firstServerIds).toBe(secondServerIds);
        expect(firstActive).toEqual([]);
        expect(firstServers).toEqual([]);
        expect(firstServerIds).toEqual([]);
    });

    it('lists server-scoped cached servers from state', () => {
        const state: any = {
            concurrentSessionListCacheByServerId: {
                'server-a': { serverName: 'Empty', sessions: {} },
                'server-b': {
                    serverName: 'Review',
                    sessions: {
                        's-review': { id: 's-review', updatedAt: 4 },
                    },
                },
            },
        };

        expect(listSessionListLookupServers(state)).toEqual([
            { serverId: 'server-b', serverName: 'Review' },
        ]);
    });

    it('reads from the concurrent session cache when the active lookup list misses', () => {
        const state: any = {
            concurrentSessionListCacheByServerId: {
                'side-server': {
                    serverName: 'Side',
                    sessions: {
                        s2: { id: 's2', updatedAt: 7 },
                    },
                },
            },
        };

        expect(findSessionListLookupSession(state, 's2')).toEqual({
            serverId: 'side-server',
            serverName: 'Side',
            session: { id: 's2', updatedAt: 7 },
        });
        expect(listSessionListLookupServers(state)).toEqual([
            { serverId: 'side-server', serverName: 'Side' },
        ]);
    });
});
