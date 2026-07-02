import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import {
    buildSessionListRowStorePriorityKeys,
    resolveSessionListRowStoreScopeKey,
    resolveSessionListRowStoreSubscriptionItems,
    resolveSessionListRowStoreSubscriptionScopes,
} from './sessionListVisibleRowStoreScopes';

describe('session list visible row store scopes', () => {
    it('keeps the full subscription set until viewability is known', () => {
        const scopes = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's2' },
        ];

        expect(resolveSessionListRowStoreSubscriptionScopes(scopes, null)).toBe(scopes);
    });

    it('narrows subscriptions to viewable session rows', () => {
        const scopes = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's2' },
            { serverId: 'server-b', sessionId: 's1' },
        ];

        expect(resolveSessionListRowStoreSubscriptionScopes(
            scopes,
            new Set(['server-a:s1', 'server-b:s1']),
        )).toEqual([
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-b', sessionId: 's1' },
        ]);
    });

    it('uses the unscoped session id when a row has no server id', () => {
        expect(resolveSessionListRowStoreScopeKey({ sessionId: 'local-session', serverId: null })).toBe('local-session');
    });

    it('keeps full index items until viewability is known', () => {
        const items = [
            { type: 'header', title: 'Active', headerKind: 'active' },
            { type: 'session', serverId: 'server-a', sessionId: 's1' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        expect(resolveSessionListRowStoreSubscriptionItems(items, null)).toBe(items);
    });

    it('narrows index item subscriptions to visible session rows', () => {
        const items = [
            { type: 'header', title: 'Active', headerKind: 'active' },
            { type: 'session', serverId: 'server-a', sessionId: 's1' },
            { type: 'session', serverId: 'server-a', sessionId: 's2' },
            { type: 'session', serverId: 'server-b', sessionId: 's1' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        expect(resolveSessionListRowStoreSubscriptionItems(
            items,
            new Set(['server-a:s1', 'server-b:s1']),
        )).toEqual([
            { type: 'session', serverId: 'server-a', sessionId: 's1' },
            { type: 'session', serverId: 'server-b', sessionId: 's1' },
        ]);
    });

    it('keeps offscreen attention and working rows subscribed in viewability mode', () => {
        const items = [
            { type: 'header', title: 'Active', headerKind: 'active' },
            { type: 'session', serverId: 'server-a', sessionId: 'visible' },
            { type: 'session', serverId: 'server-a', sessionId: 'working', workingPlacementReason: 'working' },
            { type: 'session', serverId: 'server-a', sessionId: 'ready', attentionPlacementReason: 'ready' },
            { type: 'session', serverId: 'server-a', sessionId: 'quiet' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        const priorityKeys = buildSessionListRowStorePriorityKeys(items);

        expect(resolveSessionListRowStoreSubscriptionItems(
            items,
            new Set(['server-a:visible']),
            priorityKeys,
        )).toEqual([
            { type: 'session', serverId: 'server-a', sessionId: 'visible' },
            { type: 'session', serverId: 'server-a', sessionId: 'working', workingPlacementReason: 'working' },
            { type: 'session', serverId: 'server-a', sessionId: 'ready', attentionPlacementReason: 'ready' },
        ]);
    });

    it('does not subscribe offscreen priority rows unless priority keys are explicit', () => {
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'working', workingPlacementReason: 'working' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        expect(resolveSessionListRowStoreSubscriptionItems(
            items,
            new Set<string>(),
        )).toEqual([]);
    });
});
