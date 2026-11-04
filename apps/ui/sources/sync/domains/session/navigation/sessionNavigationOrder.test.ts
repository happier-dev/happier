import { describe, expect, it } from 'vitest';

import {
    buildServerScopedSessionKey,
    buildVisibleSessionNavigationEntries,
    findVisibleSessionNavigationEntryByScope,
    moveSessionMruEntryToFront,
    resolveSessionMruNavigation,
    resolveVisibleSessionEdgeNavigation,
    resolveVisibleSessionNavigation,
} from './sessionNavigationOrder';

type HeaderItem = Readonly<{
    type: 'header';
    groupKey: string;
    title: string;
}>;

type SessionItem = Readonly<{
    type: 'session';
    serverId?: string;
    sessionId: string;
}>;

type TestItem = HeaderItem | SessionItem;

const header = (groupKey: string): HeaderItem => ({
    type: 'header',
    groupKey,
    title: groupKey,
});

const session = (id: string, serverId?: string): SessionItem => ({
    type: 'session',
    serverId,
    sessionId: id,
});

describe('session navigation order helpers', () => {
    it('steps through every rendered occurrence while retaining entity addresses', () => {
        const entries = buildVisibleSessionNavigationEntries([
            { ...session('alpha', 'server-a'), occurrenceRole: 'needsYou' },
            session('beta', 'server-a'),
            session('alpha', 'server-a'),
            session('gamma', 'server-a'),
        ]);
        const step = (cursorOccurrenceKey: string | null, direction: 'previous' | 'next' = 'next') => resolveVisibleSessionNavigation({
            visibleEntries: entries,
            activeSessionKey: entries[0].sessionKey,
            cursorOccurrenceKey,
            direction,
        });
        const base = step(entries[1].occurrenceKey ?? null);
        expect(base).toBe(entries[2]);
        expect(step(base?.occurrenceKey ?? null)).toBe(entries[3]);
        expect(step(base?.occurrenceKey ?? null, 'previous')).toBe(entries[1]);
        expect(entries[0].sessionKey).toBe(entries[2].sessionKey);
        expect(entries[0].occurrenceKey).not.toBe(entries[2].occurrenceKey);
        expect(findVisibleSessionNavigationEntryByScope(entries, 'alpha', null)).toBe(entries[0]);
    });

    it('builds server-scoped keys without treating blank server ids as scope', () => {
        expect(buildServerScopedSessionKey(' sess-a ', ' server-a ')).toBe(buildServerScopedSessionKey('sess-a', 'server-a'));
        expect(buildServerScopedSessionKey(' sess-a ', '   ')).toBe('sess-a');
    });

    it('resumes from the active entity when the previously focused occurrence disappears', () => {
        const entries = buildVisibleSessionNavigationEntries([
            session('alpha', 'server-a'), session('beta', 'server-a'), session('gamma', 'server-a'),
        ]);
        expect(resolveVisibleSessionNavigation({
            visibleEntries: entries,
            activeSessionKey: entries[1].sessionKey,
            cursorOccurrenceKey: 'departed-shelf-copy',
            direction: 'next',
        })).toBe(entries[2]);
    });

    it('builds visible navigation entries from session rows only', () => {
        const items: TestItem[] = [
            header('today'),
            session('alpha', 'server-a'),
            header('yesterday'),
            session('beta', 'server-a'),
            session('alpha', 'server-b'),
        ];

        expect(buildVisibleSessionNavigationEntries(items)).toMatchObject([
            { index: 1, sessionId: 'alpha', sessionKey: buildServerScopedSessionKey('alpha', 'server-a'), serverId: 'server-a' },
            { index: 3, sessionId: 'beta', sessionKey: buildServerScopedSessionKey('beta', 'server-a'), serverId: 'server-a' },
            { index: 4, sessionId: 'alpha', sessionKey: buildServerScopedSessionKey('alpha', 'server-b'), serverId: 'server-b' },
        ]);
    });

    it('moves through visible session order without using MRU order', () => {
        const visibleEntries = buildVisibleSessionNavigationEntries([
            session('alpha', 'server-a'),
            session('beta', 'server-a'),
            session('gamma', 'server-a'),
        ]);

        expect(resolveVisibleSessionNavigation({
            visibleEntries,
            activeSessionKey: buildServerScopedSessionKey('beta', 'server-a'),
            cursorOccurrenceKey: null,
            direction: 'next',
        })?.sessionKey).toBe(buildServerScopedSessionKey('gamma', 'server-a'));

        expect(resolveVisibleSessionNavigation({
            visibleEntries,
            activeSessionKey: buildServerScopedSessionKey('beta', 'server-a'),
            cursorOccurrenceKey: null,
            direction: 'previous',
        })?.sessionKey).toBe(buildServerScopedSessionKey('alpha', 'server-a'));
    });

    it('keeps repeated visible navigation anchored to the virtual cursor', () => {
        const visibleEntries = buildVisibleSessionNavigationEntries([
            session('alpha', 'server-a'),
            session('beta', 'server-a'),
            session('gamma', 'server-a'),
        ]);

        const first = resolveVisibleSessionNavigation({
            visibleEntries,
            activeSessionKey: buildServerScopedSessionKey('alpha', 'server-a'),
            cursorOccurrenceKey: null,
            direction: 'next',
        });
        const second = resolveVisibleSessionNavigation({
            visibleEntries,
            activeSessionKey: buildServerScopedSessionKey('alpha', 'server-a'),
            cursorOccurrenceKey: first?.occurrenceKey ?? null,
            direction: 'next',
        });

        expect(second?.sessionKey).toBe(buildServerScopedSessionKey('gamma', 'server-a'));
    });

    it('jumps to visible session list edges for Home and End', () => {
        const visibleEntries = buildVisibleSessionNavigationEntries([
            header('today'),
            session('alpha', 'server-a'),
            session('beta', 'server-a'),
            session('gamma', 'server-a'),
        ]);

        expect(resolveVisibleSessionEdgeNavigation({
            visibleEntries,
            edge: 'first',
        })?.sessionKey).toBe(buildServerScopedSessionKey('alpha', 'server-a'));

        expect(resolveVisibleSessionEdgeNavigation({
            visibleEntries,
            edge: 'last',
        })?.sessionKey).toBe(buildServerScopedSessionKey('gamma', 'server-a'));
    });

    it('moves an active session key to the MRU front while pruning missing entries and capping the list', () => {
        const knownSessionEntries = buildVisibleSessionNavigationEntries([
            session('alpha', 'server-a'),
            session('beta', 'server-a'),
            session('gamma', 'server-a'),
        ]);
        expect(moveSessionMruEntryToFront({
            order: [buildServerScopedSessionKey('stale', 'server-a'), buildServerScopedSessionKey('beta', 'server-a'), buildServerScopedSessionKey('alpha', 'server-a'), buildServerScopedSessionKey('gamma', 'server-a')],
            activeSessionKey: buildServerScopedSessionKey('beta', 'server-a'),
            knownSessionEntries,
            maxEntries: 2,
        })).toEqual([buildServerScopedSessionKey('beta', 'server-a'), buildServerScopedSessionKey('alpha', 'server-a')]);
    });

    it('cycles MRU without reshuffling the front entry during repeated navigation', () => {
        const knownSessionEntries = buildVisibleSessionNavigationEntries([
            session('alpha', 'server-a'),
            session('beta', 'server-a'),
            session('gamma', 'server-a'),
        ]);
        const order = knownSessionEntries.map((entry) => entry.sessionKey);
        const first = resolveSessionMruNavigation({
            order,
            knownSessionEntries,
            activeSessionKey: buildServerScopedSessionKey('alpha', 'server-a'),
            cursorSessionKey: null,
            direction: 'previous',
        });
        const second = resolveSessionMruNavigation({
            order,
            knownSessionEntries,
            activeSessionKey: buildServerScopedSessionKey('alpha', 'server-a'),
            cursorSessionKey: first?.sessionKey ?? null,
            direction: 'previous',
        });

        expect(first?.sessionKey).toBe(buildServerScopedSessionKey('beta', 'server-a'));
        expect(second?.sessionKey).toBe(buildServerScopedSessionKey('gamma', 'server-a'));
    });

    it('uses server-scoped MRU keys when the same session id appears on multiple servers', () => {
        const knownSessionEntries = buildVisibleSessionNavigationEntries([
            session('alpha', 'server-a'),
            session('alpha', 'server-b'),
            session('beta', 'server-a'),
        ]);
        expect(resolveSessionMruNavigation({
            order: knownSessionEntries.map((entry) => entry.sessionKey),
            knownSessionEntries,
            activeSessionKey: buildServerScopedSessionKey('alpha', 'server-a'),
            cursorSessionKey: null,
            direction: 'previous',
        })).toMatchObject({
            sessionId: 'alpha',
            sessionKey: buildServerScopedSessionKey('alpha', 'server-b'),
            serverId: 'server-b',
        });
    });

    it('reads an unambiguous legacy MRU key by comparing it with known addresses', () => {
        const knownSessionEntries = buildVisibleSessionNavigationEntries([
            { ...session('alpha', 'https://home.example'), occurrenceRole: 'needsYou' },
            session('alpha', 'https://home.example'),
            session('beta', 'https://other.example'),
        ]);

        expect(moveSessionMruEntryToFront({
            order: ['https://home.example:alpha'],
            activeSessionKey: null,
            knownSessionEntries,
        })).toEqual([buildServerScopedSessionKey('alpha', 'https://home.example')]);
    });

    it('drops a legacy MRU key when two known addresses serialize to the same value', () => {
        const knownSessionEntries = buildVisibleSessionNavigationEntries([
            session('c', 'a:b'),
            session('b:c', 'a'),
        ]);

        expect(moveSessionMruEntryToFront({
            order: ['a:b:c'],
            activeSessionKey: null,
            knownSessionEntries,
        })).toEqual([]);
    });
});
