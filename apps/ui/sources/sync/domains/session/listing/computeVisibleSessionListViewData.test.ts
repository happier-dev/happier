import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from './sessionListViewData';
import { computeVisibleSessionListViewData } from './computeVisibleSessionListViewData';

type AnySession = any;

function makeSession(id: string, partial?: Partial<AnySession>): AnySession {
    return {
        id,
        active: false,
        updatedAt: 0,
        ...partial,
    };
}

describe('computeVisibleSessionListViewData', () => {
    it('keeps pinned sessions in their existing list order and normalizes pinned variants to default', () => {
        const source: SessionListViewItem[] = [
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: 'server:s1:project:m1:/repo' },
            { type: 'session', session: makeSession('a'), serverId: 's1', section: 'inactive', groupKey: 'server:s1:project:m1:/repo', groupKind: 'project', variant: 'no-path' },
            { type: 'session', session: makeSession('b'), serverId: 's1', section: 'inactive', groupKey: 'server:s1:project:m1:/repo', groupKind: 'project', variant: 'no-path' },
        ];

        const result = computeVisibleSessionListViewData({
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:a', 's1:b'],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result[0]).toMatchObject({ type: 'header', headerKind: 'pinned' });
        const pinnedSessions = result.filter((i) => i.type === 'session' && (i as any).pinned === true) as any[];
        expect(pinnedSessions.map((s) => s.session.id)).toEqual(['a', 'b']);
        expect(pinnedSessions.map((s) => s.variant)).toEqual(['default', 'default']);
    });

    it('applies group ordering overrides only within the same group', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListViewItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', session: makeSession('s1'), serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', session: makeSession('s2'), serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', session: makeSession('s3'), serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListViewData({
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: ['s1:s2', 's1:s1'] },
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((i) => i.type === 'session') as any[];
        expect(sessions.map((s) => s.session.id)).toEqual(['s2', 's1', 's3']);
    });

    it('keeps pinned inactive sessions visible when hideInactiveSessions is enabled', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListViewItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', session: makeSession('p'), serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', session: makeSession('u'), serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListViewData({
            source,
            hideInactiveSessions: true,
            pinnedSessionKeysV1: ['s1:p'],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        const sessions = result.filter((i) => i.type === 'session') as any[];
        expect(sessions.map((s) => s.session.id)).toEqual(['p']);
    });

    it('hides archived sessions even when they are pinned', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListViewItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: g },
            { type: 'session', session: makeSession('a', { archivedAt: 10 }), serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
            { type: 'session', session: makeSession('b'), serverId: 's1', section: 'inactive', groupKey: g, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListViewData({
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['s1:a'],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.some((i) => i.type === 'header' && i.headerKind === 'pinned')).toBe(false);
        const sessions = result.filter((i) => i.type === 'session') as any[];
        expect(sessions.map((s) => s.session.id)).toEqual(['b']);
    });

    it('keeps pinned section above server presentation headers when grouped', () => {
        const source: SessionListViewItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 'a', groupKey: 'server:a:day:2026-02-17' },
            { type: 'session', session: makeSession('pa'), serverId: 'a', section: 'inactive', groupKey: 'server:a:day:2026-02-17', groupKind: 'date' },
            { type: 'session', session: makeSession('ua'), serverId: 'a', section: 'inactive', groupKey: 'server:a:day:2026-02-17', groupKind: 'date' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 'b', groupKey: 'server:b:day:2026-02-17' },
            { type: 'session', session: makeSession('ub'), serverId: 'b', section: 'inactive', groupKey: 'server:b:day:2026-02-17', groupKind: 'date' },
        ];

        const result = computeVisibleSessionListViewData({
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: ['a:pa'],
            sessionListGroupOrderV1: {},
            presentation: { enabled: true, presentation: 'grouped', selectedServerIds: ['a', 'b'] },
        })!;

        expect(result[0]).toMatchObject({ type: 'header', headerKind: 'pinned' });
        expect(result.some((i) => i.type === 'header' && i.headerKind === 'server')).toBe(true);
    });

    it('preserves section headers when they are followed by group headers', () => {
        const activeGroupKey = 'server:s1:active:project:abc123';
        const inactiveGroupKey = 'server:s1:inactive:day:2026-02-17';
        const source: SessionListViewItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 's1' },
            { type: 'header', headerKind: 'project', title: '~/repo', serverId: 's1', groupKey: activeGroupKey },
            { type: 'session', session: makeSession('a', { active: true }), serverId: 's1', section: 'active', groupKey: activeGroupKey, groupKind: 'project', variant: 'no-path' },
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 's1' },
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey: inactiveGroupKey },
            { type: 'session', session: makeSession('b'), serverId: 's1', section: 'inactive', groupKey: inactiveGroupKey, groupKind: 'date' },
        ];

        const result = computeVisibleSessionListViewData({
            source,
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
        })!;

        expect(result.map((i) => (i.type === 'header' ? `h:${i.headerKind}:${i.title}` : `s:${(i as any).session.id}`))).toEqual([
            'h:active:Active',
            'h:project:~/repo',
            's:a',
            'h:inactive:Inactive',
            'h:date:Today',
            's:b',
        ]);
    });
});
