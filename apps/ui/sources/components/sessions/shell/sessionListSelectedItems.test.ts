import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

import { buildSessionListSelectedItems, type SessionListSelectedItem } from './sessionListSelectedItems';

const session = { id: 'session-a', active: false } as unknown as Extract<SessionListViewItem, { type: 'session' }>['session'];

function sessionItem(overrides: Partial<Extract<SessionListViewItem, { type: 'session' }>>): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        session,
        section: 'inactive',
        groupKey: 'group-a',
        groupKind: 'date',
        variant: 'default',
        pinned: false,
        serverId: 'server-a',
        ...overrides,
    };
}

describe('buildSessionListSelectedItems', () => {
    it('rebuilds a reused row when only its attention placement reason changed', () => {
        const previousItems: ReadonlyArray<SessionListSelectedItem> = [
            { ...sessionItem({}), selected: false },
        ];

        const next = buildSessionListSelectedItems({
            items: [sessionItem({ attentionPromotionReason: 'standing' })],
            pathname: '/sessions',
            selectable: true,
            previousItems,
        });

        expect(next?.[0]).toBeTruthy();
        expect(next?.[0]?.type).toBe('session');
        expect(next?.[0] && next[0].type === 'session' ? next[0].attentionPromotionReason : null).toBe('standing');
    });

    it('rebuilds a reused row when only its working placement reason changed', () => {
        const previousItems: ReadonlyArray<SessionListSelectedItem> = [
            { ...sessionItem({}), selected: false },
        ];

        const next = buildSessionListSelectedItems({
            items: [sessionItem({ workingPlacementReason: 'working' })],
            pathname: '/sessions',
            selectable: true,
            previousItems,
        });

        expect(next?.[0] && next[0].type === 'session' ? next[0].workingPlacementReason : null).toBe('working');
    });

    it('rebuilds a reused row when only its folder placement changed', () => {
        const previousItems: ReadonlyArray<SessionListSelectedItem> = [
            { ...sessionItem({ folderId: null, folderDepth: 0 }), selected: false },
        ];

        const next = buildSessionListSelectedItems({
            items: [sessionItem({ folderId: 'folder-a', folderDepth: 1 })],
            pathname: '/sessions',
            selectable: true,
            previousItems,
        });

        expect(next?.[0] && next[0].type === 'session' ? next[0].folderId : null).toBe('folder-a');
    });

    it('still reuses the previous row object when nothing changed', () => {
        const previous: SessionListSelectedItem = { ...sessionItem({ attentionPromotionReason: 'standing' }), selected: false };

        const next = buildSessionListSelectedItems({
            items: [sessionItem({ attentionPromotionReason: 'standing' })],
            pathname: '/sessions',
            selectable: true,
            previousItems: [previous],
        });

        expect(next?.[0]).toBe(previous);
    });
});
