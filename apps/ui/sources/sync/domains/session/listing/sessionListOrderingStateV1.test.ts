import { describe, expect, it, vi } from 'vitest';

import type { SessionListViewItem } from './sessionListViewData';
import {
    normalizeSessionListGroupOrderV1ForSource,
    PINNED_GROUP_KEY_V1,
    SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP,
    sortSessionListViewItemsByOrderingMode,
} from './sessionListOrderingStateV1';

function makeSessionItem(
    opts: Readonly<{ serverId: string; sessionId: string; groupKey: string }>,
): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        serverId: opts.serverId,
        session: { id: opts.sessionId } as any,
        groupKey: opts.groupKey,
    };
}

describe('sessionListOrderingStateV1', () => {
    it('returns the original array when custom ordering is a no-op', () => {
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: 'g' }),
        ];

        expect(sortSessionListViewItemsByOrderingMode(source, 'custom')).toBe(source);
    });

    it('returns the original array when created ordering is already satisfied', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        (firstSession.session as any).createdAt = 20;
        (secondSession.session as any).createdAt = 10;

        expect(sortSessionListViewItemsByOrderingMode(source, 'created')).toBe(source);
    });

    it('does not sort already ordered updated-mode groups', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        Object.assign(firstSession.session, { createdAt: 20, updatedAt: 20, meaningfulActivityAt: 650_000 });
        Object.assign(secondSession.session, { createdAt: 10, updatedAt: 10, meaningfulActivityAt: 100 });

        const sortSpy = vi.spyOn(Array.prototype, 'sort');
        try {
            expect(sortSessionListViewItemsByOrderingMode(source, 'updated')).toBe(source);
            expect(sortSpy).not.toHaveBeenCalled();
        } finally {
            sortSpy.mockRestore();
        }
    });

    it('keeps updated-mode groups ordered when meaningful activity remains in the same bucket', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'stable-first', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'raw-newer', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        Object.assign(firstSession.session, {
            createdAt: 200,
            updatedAt: 100,
            meaningfulActivityAt: 650_000,
        });
        Object.assign(secondSession.session, {
            createdAt: 100,
            updatedAt: 900_000,
            meaningfulActivityAt: 640_000,
        });

        expect(sortSessionListViewItemsByOrderingMode(source, 'updated')).toBe(source);
    });

    it('sorts updated-mode groups when meaningful activity crosses a bucket boundary', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'older-bucket', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'newer-bucket', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        Object.assign(firstSession.session, {
            createdAt: 200,
            updatedAt: 900_000,
            meaningfulActivityAt: 590_000,
        });
        Object.assign(secondSession.session, {
            createdAt: 100,
            updatedAt: 100,
            meaningfulActivityAt: 610_000,
        });

        const result = sortSessionListViewItemsByOrderingMode(source, 'updated');

        expect(result.map((item) => (item.type === 'session' ? item.session.id : item.type))).toEqual([
            'header',
            'newer-bucket',
            'older-bucket',
        ]);
    });

    it('reuses the same reordered array for repeated sorting of the same source and mode', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        Object.assign(firstSession.session, { createdAt: 10, updatedAt: 10, meaningfulActivityAt: 100 });
        Object.assign(secondSession.session, { createdAt: 20, updatedAt: 20, meaningfulActivityAt: 650_000 });

        const first = sortSessionListViewItemsByOrderingMode(source, 'updated');
        const second = sortSessionListViewItemsByOrderingMode(source, 'updated');

        expect(first).toBe(second);
        expect(first).not.toBe(source);
        expect(first.map((item) => (item.type === 'session' ? item.session.id : item.type))).toEqual([
            'header',
            'b',
            'a',
        ]);
    });

    it('removes missing session keys from group order when the group is present in the source', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: ['s1:a', 's1:missing'] },
        });

        expect(normalized).toEqual({ [g]: ['s1:a'] });
    });

    it('preserves folder keys that are direct children of the ordered group', () => {
        const rootFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:root';
        const planningFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:planning';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Repo', headerKind: 'project', groupKey: 'server:s1:project:repo', serverId: 's1' },
            {
                type: 'header',
                title: 'Planning',
                headerKind: 'folder',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                serverId: 's1',
            },
            makeSessionItem({ serverId: 's1', sessionId: 'root', groupKey: rootFolderGroupKey }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {
                [rootFolderGroupKey]: ['s1:root', 'folder:planning', 'folder:missing'],
            },
        });

        expect(normalized).toEqual({
            [rootFolderGroupKey]: ['s1:root', 'folder:planning'],
        });
    });

    it('returns the original map when group order is already normalized for the source', () => {
        const g = 'server:s1:day:2026-02-17';
        const normalizedOrder = { [g]: ['s1:a', 's1:b'] };
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
            makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: g }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: normalizedOrder,
        });

        expect(normalized).toBe(normalizedOrder);
    });

    it('reuses already-normalized group arrays when other entries still need normalization', () => {
        const g = 'server:s1:day:2026-02-17';
        const normalizedKeys = ['s1:a', 's1:b'];
        const groupOrder = {
            [g]: normalizedKeys,
            '   ': [' s1:c '],
        };
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
            makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: g }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: groupOrder,
        });

        expect(normalized).not.toBe(groupOrder);
        expect(normalized[g]).toBe(normalizedKeys);
        expect(normalized).toEqual({ [g]: normalizedKeys });
    });

    it('reuses the same normalized group order object for repeated normalization of the same source and inputs', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
            makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: g }),
        ];
        const pinnedSessionKeysV1: string[] = [];
        const groupOrder = {
            [g]: [' s1:b ', 's1:a', 's1:missing'],
        };

        const first = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1: groupOrder,
        });
        const second = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1: groupOrder,
        });

        expect(first).toBe(second);
        expect(first).toEqual({ [g]: ['s1:b', 's1:a'] });
    });

    it('reuses a shared empty map when normalization removes all group order entries', () => {
        const source: SessionListViewItem[] = [];

        const firstNormalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
        });
        const secondNormalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
        });

        expect(firstNormalized).toBe(secondNormalized);
        expect(firstNormalized).toEqual({});
    });

    it('returns the shared empty map without scanning the source when both pinned keys and group order are empty', () => {
        const source = [
            {
                type: 'session' as const,
                get groupKey() {
                    throw new Error('source should not be inspected');
                },
                get serverId() {
                    throw new Error('source should not be inspected');
                },
                get session() {
                    throw new Error('source should not be inspected');
                },
            },
        ] as unknown as SessionListViewItem[];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
        });
        const secondNormalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
        });

        expect(normalized).toEqual({});
        expect(normalized).toBe(secondNormalized);
    });

    it('caps per-group order lists to the configured max', () => {
        const g = 'server:s1:active';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Active', headerKind: 'active', groupKey: g, serverId: 's1' },
        ];
        for (let i = 0; i < SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP + 10; i++) {
            source.push(makeSessionItem({ serverId: 's1', sessionId: `s${i}`, groupKey: g }));
        }

        const order = source
            .filter((i): i is Extract<SessionListViewItem, { type: 'session' }> => i.type === 'session')
            .map((i) => `s1:${i.session.id}`);

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: order },
        });

        expect(normalized[g]).toHaveLength(SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);
        expect(normalized[g][0]).toBe('s1:s0');
    });

    it('prunes pinned group ordering keys to only pinned sessions that exist in the source', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
            makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: g }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: ['s1:a'],
            sessionListGroupOrderV1: { [PINNED_GROUP_KEY_V1]: ['s1:b', 's1:a', 's1:missing'] },
        });

        expect(normalized).toEqual({ [PINNED_GROUP_KEY_V1]: ['s1:a'] });
    });
});
