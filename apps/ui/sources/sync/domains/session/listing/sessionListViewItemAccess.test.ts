import { describe, expect, it } from 'vitest';

import * as sessionListViewItemAccess from './sessionListViewItemAccess';
import { findSessionListViewItem, listSessionListViewItems } from './sessionListViewItemAccess';

describe('sessionListViewItemAccess', () => {
    it('lists only session rows and reuses a shared empty array for missing input', () => {
        const first = listSessionListViewItems(null);
        const second = listSessionListViewItems(undefined);
        const third = listSessionListViewItems([]);

        expect(first).toBe(second);
        expect(second).toBe(third);
        expect(first).toEqual([]);
    });

    it('returns the original array when every item is already a session row', () => {
        const items = [
            { type: 'session', session: { id: 's1', updatedAt: 1 } },
            { type: 'session', session: { id: 's2', updatedAt: 2 } },
        ] as const;

        expect(listSessionListViewItems(items)).toBe(items);
    });

    it('finds a session row by normalized id', () => {
        const items: any[] = [
            { type: 'header', title: 'Server A', headerKind: 'server' },
            { type: 'session', session: { id: ' s1 ', updatedAt: 1 } },
            { type: 'session', session: { id: 's2', updatedAt: 2 } },
        ];

        expect(findSessionListViewItem(items, ' s2 ')).toEqual({
            type: 'session',
            session: { id: 's2', updatedAt: 2 },
        });
        expect(findSessionListViewItem(items, 'missing')).toBeNull();
    });

    it('finds a session row from an already normalized id without changing the row object', () => {
        const items: any[] = [
            { type: 'header', title: 'Server A', headerKind: 'server' },
            { type: 'session', session: { id: 's1', updatedAt: 1 } },
            { type: 'session', session: { id: 's2', updatedAt: 2 } },
        ];

        const findByNormalizedId = (
            sessionListViewItemAccess as Record<string, unknown>
        ).findSessionListViewItemByNormalizedId as
            | ((items: ReadonlyArray<unknown> | null | undefined | unknown, sessionId: string) => unknown)
            | undefined;

        expect(findByNormalizedId).toBeTypeOf('function');
        expect(findByNormalizedId?.(items, 's2')).toBe(items[2]);
        expect(findByNormalizedId?.(items, 'missing')).toBeNull();
    });
});
