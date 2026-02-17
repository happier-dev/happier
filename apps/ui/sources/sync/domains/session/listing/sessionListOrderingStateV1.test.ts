import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from './sessionListViewData';
import { normalizeSessionListGroupOrderV1ForSource, PINNED_GROUP_KEY_V1, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP } from './sessionListOrderingStateV1';

function makeSessionItem(opts: Readonly<{ serverId: string; sessionId: string; groupKey: string }>): SessionListViewItem {
    return {
        type: 'session',
        serverId: opts.serverId,
        session: { id: opts.sessionId } as any,
        groupKey: opts.groupKey,
    };
}

describe('sessionListOrderingStateV1', () => {
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
