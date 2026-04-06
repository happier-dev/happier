import { describe, expect, it } from 'vitest';

import {
    findSessionListViewDataSession,
    listSessionListViewDataSessionIds,
    listSessionListViewDataSessions,
    normalizeSessionListViewDataSessionEntry,
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
        expect(findSessionListViewDataSession(items, 's2')).toBe(normalizeSessionListViewDataSessionEntry(items[1]));
        expect(findSessionListViewDataSession(items, 'missing')).toBeNull();
    });

    it('reuses the same normalized session entry object for repeated normalization of the same item', () => {
        const item: any = {
            type: 'session',
            serverId: 'server-a',
            serverName: 'Primary',
            session: { id: 's1', updatedAt: 1 },
        };

        const first = normalizeSessionListViewDataSessionEntry(item);
        const second = normalizeSessionListViewDataSessionEntry(item);

        expect(first).toBe(second);
        expect(first).toEqual({
            serverId: 'server-a',
            serverName: 'Primary',
            session: { id: 's1', updatedAt: 1 },
        });
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

    it('reuses the same empty array for empty or missing session-list data', () => {
        const first = listSessionListViewDataSessionIds(null);
        const second = listSessionListViewDataSessionIds(undefined);
        const third = listSessionListViewDataSessionIds([]);
        const sessions = listSessionListViewDataSessions(null);

        expect(first).toBe(second);
        expect(second).toBe(third);
        expect(first).toBe(sessions);
        expect(first).toEqual([]);
    });

    it('reuses the same empty array when there are no session rows to enumerate', () => {
        const first = listSessionListViewDataSessions(null);
        const second = listSessionListViewDataSessions(undefined);
        const third = listSessionListViewDataSessions([]);

        expect(first).toBe(second);
        expect(second).toBe(third);
        expect(first).toEqual([]);
    });
});
