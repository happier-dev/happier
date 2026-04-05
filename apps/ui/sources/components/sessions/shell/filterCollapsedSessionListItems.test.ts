import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

import { filterCollapsedSessionListItems } from './filterCollapsedSessionListItems';

function makeSession(id: string, groupKey: string): SessionListViewItem {
    return {
        type: 'session',
        serverId: 'server-a',
        serverName: 'Server A',
        groupKey,
        groupKind: 'date',
        session: {
            id,
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: null,
            metadataVersion: 0,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        },
    };
}

describe('filterCollapsedSessionListItems', () => {
    it('returns the original array when there are no collapsed groups to apply', () => {
        const items: SessionListViewItem[] = [
            { type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: 'inactive:server-a', serverId: 'server-a', serverName: 'Server A' },
            makeSession('visible-session', 'server:server-a:day:2026-02-18'),
        ];

        const result = filterCollapsedSessionListItems(items, {});

        expect(result).toBe(items);
    });

    it('returns the original array when collapsed groups do not match any rendered rows', () => {
        const items: SessionListViewItem[] = [
            { type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: 'inactive:server-a', serverId: 'server-a', serverName: 'Server A' },
            makeSession('visible-session', 'server:server-a:day:2026-02-18'),
        ];

        const result = filterCollapsedSessionListItems(items, { 'server:server-a:day:2026-02-19': true });

        expect(result).toBe(items);
    });

    it('hides collapsed groups and skips subordinate headers until the next section header', () => {
        const activeSectionKey = 'active:server-a';
        const activeGroupKey = 'server:server-a:day:2026-02-17';
        const inactiveSectionKey = 'inactive:server-a';
        const inactiveGroupKey = 'server:server-a:day:2026-02-18';

        const items: SessionListViewItem[] = [
            { type: 'header', title: 'Active', headerKind: 'active', groupKey: activeSectionKey, serverId: 'server-a', serverName: 'Server A' },
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: activeGroupKey, serverId: 'server-a', serverName: 'Server A' },
            makeSession('hidden-session', activeGroupKey),
            { type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: inactiveSectionKey, serverId: 'server-a', serverName: 'Server A' },
            { type: 'header', title: 'Tomorrow', headerKind: 'date', groupKey: inactiveGroupKey, serverId: 'server-a', serverName: 'Server A' },
            makeSession('visible-session', inactiveGroupKey),
        ];

        const result = filterCollapsedSessionListItems(items, { [activeSectionKey]: true });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Active',
            'Inactive',
            'Tomorrow',
            'visible-session',
        ]);
    });

    it('drops only the rows from individually collapsed groups when the parent section remains expanded', () => {
        const collapsedGroupKey = 'server:server-a:day:2026-02-17';
        const openGroupKey = 'server:server-a:day:2026-02-18';

        const items: SessionListViewItem[] = [
            { type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: 'inactive:server-a', serverId: 'server-a', serverName: 'Server A' },
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: collapsedGroupKey, serverId: 'server-a', serverName: 'Server A' },
            makeSession('hidden-session', collapsedGroupKey),
            { type: 'header', title: 'Tomorrow', headerKind: 'date', groupKey: openGroupKey, serverId: 'server-a', serverName: 'Server A' },
            makeSession('visible-session', openGroupKey),
        ];

        const result = filterCollapsedSessionListItems(items, { [collapsedGroupKey]: true });

        expect(result.map((item) => item.type === 'session' ? item.session.id : item.title)).toEqual([
            'Inactive',
            'Today',
            'Tomorrow',
            'visible-session',
        ]);
    });
});
