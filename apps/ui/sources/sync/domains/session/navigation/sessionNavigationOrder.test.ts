import { describe, expect, it } from 'vitest';

import {
    buildServerScopedSessionKey,
    buildVisibleSessionNavigationEntries,
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
    it('builds server-scoped keys without treating blank server ids as scope', () => {
        expect(buildServerScopedSessionKey(' sess-a ', ' server-a ')).toBe('server-a:sess-a');
        expect(buildServerScopedSessionKey(' sess-a ', '   ')).toBe('sess-a');
    });

    it('builds visible navigation entries from session rows only', () => {
        const items: TestItem[] = [
            header('today'),
            session('alpha', 'server-a'),
            header('yesterday'),
            session('beta', 'server-a'),
            session('alpha', 'server-b'),
        ];

        expect(buildVisibleSessionNavigationEntries(items)).toEqual([
            { index: 1, sessionId: 'alpha', sessionKey: 'server-a:alpha', serverId: 'server-a' },
            { index: 3, sessionId: 'beta', sessionKey: 'server-a:beta', serverId: 'server-a' },
            { index: 4, sessionId: 'alpha', sessionKey: 'server-b:alpha', serverId: 'server-b' },
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
            activeSessionKey: 'server-a:beta',
            cursorSessionKey: null,
            direction: 'next',
        })?.sessionKey).toBe('server-a:gamma');

        expect(resolveVisibleSessionNavigation({
            visibleEntries,
            activeSessionKey: 'server-a:beta',
            cursorSessionKey: null,
            direction: 'previous',
        })?.sessionKey).toBe('server-a:alpha');
    });

    it('keeps repeated visible navigation anchored to the virtual cursor', () => {
        const visibleEntries = buildVisibleSessionNavigationEntries([
            session('alpha', 'server-a'),
            session('beta', 'server-a'),
            session('gamma', 'server-a'),
        ]);

        const first = resolveVisibleSessionNavigation({
            visibleEntries,
            activeSessionKey: 'server-a:alpha',
            cursorSessionKey: null,
            direction: 'next',
        });
        const second = resolveVisibleSessionNavigation({
            visibleEntries,
            activeSessionKey: 'server-a:alpha',
            cursorSessionKey: first?.sessionKey ?? null,
            direction: 'next',
        });

        expect(second?.sessionKey).toBe('server-a:gamma');
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
        })?.sessionKey).toBe('server-a:alpha');

        expect(resolveVisibleSessionEdgeNavigation({
            visibleEntries,
            edge: 'last',
        })?.sessionKey).toBe('server-a:gamma');
    });

    it('moves an active session key to the MRU front while pruning missing entries and capping the list', () => {
        expect(moveSessionMruEntryToFront({
            order: ['server-a:stale', 'server-a:beta', 'server-a:alpha', 'server-a:gamma'],
            activeSessionKey: 'server-a:beta',
            knownSessionKeys: ['server-a:alpha', 'server-a:beta', 'server-a:gamma'],
            maxEntries: 2,
        })).toEqual(['server-a:beta', 'server-a:alpha']);
    });

    it('cycles MRU without reshuffling the front entry during repeated navigation', () => {
        const order = ['server-a:alpha', 'server-a:beta', 'server-a:gamma'];
        const first = resolveSessionMruNavigation({
            order,
            activeSessionKey: 'server-a:alpha',
            cursorSessionKey: null,
            direction: 'previous',
        });
        const second = resolveSessionMruNavigation({
            order,
            activeSessionKey: 'server-a:alpha',
            cursorSessionKey: first?.sessionKey ?? null,
            direction: 'previous',
        });

        expect(first?.sessionKey).toBe('server-a:beta');
        expect(second?.sessionKey).toBe('server-a:gamma');
    });

    it('uses server-scoped MRU keys when the same session id appears on multiple servers', () => {
        expect(resolveSessionMruNavigation({
            order: ['server-a:alpha', 'server-b:alpha', 'server-a:beta'],
            activeSessionKey: 'server-a:alpha',
            cursorSessionKey: null,
            direction: 'previous',
        })).toMatchObject({
            sessionId: 'alpha',
            sessionKey: 'server-b:alpha',
            serverId: 'server-b',
        });
    });
});
