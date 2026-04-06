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
                    serverName: null,
                    session: { id: 's2', updatedAt: 2 },
                },
            ],
        };

        const canonicalSessionA = cache['server-a'][1];
        const canonicalSessionB = cache['server-b'][0];
        const entries = listServerScopedSessionListCacheSessions(cache);

        expect(entries).toEqual([
            {
                type: 'session',
                serverId: 'server-a',
                serverName: 'Server A',
                session: { id: 's1', updatedAt: 1 },
            },
            {
                type: 'session',
                serverId: 'server-b',
                serverName: null,
                session: { id: 's2', updatedAt: 2 },
            },
        ]);
        expect(entries[0]).toBe(canonicalSessionA);
        expect(entries[1]).toBe(canonicalSessionB);
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

        const scopedMatch = cache['server-b'][0];
        expect(findServerScopedSessionListCacheSession(cache, 's2')).toBe(scopedMatch);
        expect(scopedMatch).toEqual({
            type: 'session',
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

    it('reuses shared empty arrays for empty session and server listings', () => {
        const sessionsFromNull = listServerScopedSessionListCacheSessions(null);
        const sessionsFromEmpty = listServerScopedSessionListCacheSessions(undefined);
        const serversFromNull = listServerScopedSessionListCacheServers(null);
        const serversFromEmpty = listServerScopedSessionListCacheServers({});

        expect(sessionsFromNull).toBe(sessionsFromEmpty);
        expect(serversFromNull).toBe(serversFromEmpty);
        expect(sessionsFromNull).toEqual([]);
        expect(serversFromNull).toEqual([]);
    });

    it('reuses the same empty array for repeated empty session listings', () => {
        const first = listServerScopedSessionListCacheSessions(null);
        const second = listServerScopedSessionListCacheSessions({});

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });

    it('reuses the same empty array when only header rows are cached for sessions', () => {
        const cache: any = {
            'server-a': [
                { type: 'header', title: 'Server A', serverId: 'server-a', serverName: 'Server A' },
            ],
            'server-b': [
                { type: 'header', title: 'Server B', serverId: 'server-b', serverName: 'Server B' },
            ],
        };

        const first = listServerScopedSessionListCacheSessions(cache);
        const second = listServerScopedSessionListCacheSessions(cache);

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });

    it('reuses the same empty array for repeated empty server listings', () => {
        const first = listServerScopedSessionListCacheServers(null);
        const second = listServerScopedSessionListCacheServers({});

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });

    it('reuses the same empty array when only header rows are cached for servers', () => {
        const cache: any = {
            'server-a': [
                { type: 'header', title: 'Server A', serverId: 'server-a', serverName: 'Server A' },
            ],
            'server-b': [
                { type: 'header', title: 'Server B', serverId: 'server-b', serverName: 'Server B' },
            ],
        };

        const first = listServerScopedSessionListCacheServers(cache);
        const second = listServerScopedSessionListCacheServers(cache);

        expect(first).toBe(second);
        expect(first).toEqual([]);
    });
});
