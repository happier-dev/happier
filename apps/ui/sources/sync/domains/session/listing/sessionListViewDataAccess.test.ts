import { describe, expect, it } from 'vitest';

import {
    findSessionListViewDataSession,
    listSessionListViewDataSessionIds,
    listSessionListViewDataSessions,
} from './sessionListViewDataAccess';

describe('sessionListViewDataAccess', () => {
    it('enumerates only session rows from active list data with server metadata', () => {
        const items: any[] = [
            { type: 'header', title: 'Active', headerKind: 'active' },
            {
                type: 'session',
                serverId: 'server-a',
                serverName: 'Primary',
                session: { id: 's1', updatedAt: 1 },
            },
            {
                type: 'session',
                serverId: 'server-b',
                session: { id: 's2', updatedAt: 2 },
            },
        ];

        expect(listSessionListViewDataSessions(items)).toEqual([
            {
                serverId: 'server-a',
                serverName: 'Primary',
                session: { id: 's1', updatedAt: 1 },
            },
            {
                serverId: 'server-b',
                serverName: null,
                session: { id: 's2', updatedAt: 2 },
            },
        ]);
    });

    it('finds a session row by id from active list data', () => {
        const items: any[] = [
            {
                type: 'session',
                serverId: 'server-a',
                serverName: 'Primary',
                session: { id: 's1', updatedAt: 1 },
            },
            {
                type: 'session',
                serverId: 'server-b',
                session: { id: 's2', updatedAt: 2 },
            },
        ];

        expect(findSessionListViewDataSession(items, 's2')).toEqual({
            serverId: 'server-b',
            serverName: null,
            session: { id: 's2', updatedAt: 2 },
        });
        expect(findSessionListViewDataSession(items, 'missing')).toBeNull();
    });

    it('lists session ids in active-list order and respects a limit', () => {
        const items: any[] = [
            { type: 'header', title: 'Active', headerKind: 'active' },
            { type: 'session', session: { id: 's1', updatedAt: 1 } },
            { type: 'session', session: { id: 's2', updatedAt: 2 } },
            { type: 'session', session: { id: 's3', updatedAt: 3 } },
        ];

        expect(listSessionListViewDataSessionIds(items)).toEqual(['s1', 's2', 's3']);
        expect(listSessionListViewDataSessionIds(items, 2)).toEqual(['s1', 's2']);
    });
});
