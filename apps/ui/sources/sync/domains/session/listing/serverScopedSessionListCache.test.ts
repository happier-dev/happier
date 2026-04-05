import { describe, expect, it } from 'vitest';

import {
    findServerScopedSessionListCacheSession,
    listServerScopedSessionListCacheServers,
    listServerScopedSessionListCacheSessions,
} from './serverScopedSessionListCache';

describe('serverScopedSessionListCache', () => {
    it('enumerates only session rows from the per-server cache', () => {
        const cache: any = {
            'server-a': [
                { type: 'header', title: 'Server A', serverId: 'server-a', serverName: 'Server A' },
                {
                    type: 'session',
                    serverId: 'server-a',
                    serverName: 'Server A',
                    session: { id: 's1', updatedAt: 1 },
                },
            ],
            'server-b': [
                {
                    type: 'session',
                    serverId: 'server-b',
                    session: { id: 's2', updatedAt: 2 },
                },
            ],
        };

        expect(listServerScopedSessionListCacheSessions(cache)).toEqual([
            {
                serverId: 'server-a',
                serverName: 'Server A',
                session: { id: 's1', updatedAt: 1 },
            },
            {
                serverId: 'server-b',
                serverName: null,
                session: { id: 's2', updatedAt: 2 },
            },
        ]);
    });

    it('finds a cached session by id and returns its server scope metadata', () => {
        const cache: any = {
            'server-a': [
                { type: 'header', title: 'Server A', serverId: 'server-a', serverName: 'Server A' },
                {
                    type: 'session',
                    serverId: 'server-a',
                    serverName: 'Server A',
                    session: { id: 's1', updatedAt: 1 },
                },
            ],
            'server-b': [
                {
                    type: 'session',
                    serverId: 'server-b',
                    serverName: 'Server B',
                    session: { id: 's2', updatedAt: 2 },
                },
            ],
        };

        expect(findServerScopedSessionListCacheSession(cache, 's2')).toEqual({
            serverId: 'server-b',
            serverName: 'Server B',
            session: { id: 's2', updatedAt: 2 },
        });
        expect(findServerScopedSessionListCacheSession(cache, 'missing')).toBeNull();
    });

    it('lists only servers that currently have cached session rows', () => {
        const cache: any = {
            'server-a': [
                { type: 'header', title: 'Server A', serverId: 'server-a', serverName: 'Server A' },
            ],
            'server-b': [
                {
                    type: 'session',
                    serverId: 'server-b',
                    session: { id: 's2', updatedAt: 2 },
                },
            ],
            'server-c': [
                {
                    type: 'session',
                    serverId: 'server-c',
                    serverName: 'Review Server',
                    session: { id: 's3', updatedAt: 3 },
                },
                {
                    type: 'session',
                    serverId: 'server-c',
                    serverName: 'Ignored duplicate',
                    session: { id: 's4', updatedAt: 4 },
                },
            ],
        };

        expect(listServerScopedSessionListCacheServers(cache)).toEqual([
            { serverId: 'server-b', serverName: null },
            { serverId: 'server-c', serverName: 'Review Server' },
        ]);
    });
});
