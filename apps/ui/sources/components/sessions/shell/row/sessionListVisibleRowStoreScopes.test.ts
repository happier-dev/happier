import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import {
    buildSessionListRuntimePriorityRowKeys,
    buildSessionListRowStorePriorityKeys,
    resolveSessionListRowStoreScopeKey,
    resolveSessionListRowStoreSubscriptionItems,
    resolveSessionListRowStoreSubscriptionKeys,
    resolveSessionListRowStoreSubscriptionKeysForViewport,
    resolveSessionListRowStoreSubscriptionScopes,
    reuseSessionListRowStoreKeySet,
    reuseSessionListRowStoreSubscriptionScopes,
    type SessionListRowStoreSubscriptionScope,
} from './sessionListVisibleRowStoreScopes';

describe('session list visible row store scopes', () => {
    it('keeps only priority subscriptions for large lists until viewability is known', () => {
        const scopes = Array.from({ length: 75 }, (_, index) => ({
            serverId: 'server-a',
            sessionId: `s${index + 1}`,
        }));

        expect(resolveSessionListRowStoreSubscriptionScopes(
            scopes,
            null,
            new Set(['server-a\u0000s2', 'server-a\u0000s50']),
        )).toEqual([
            { serverId: 'server-a', sessionId: 's2' },
            { serverId: 'server-a', sessionId: 's50' },
        ]);
        expect(resolveSessionListRowStoreSubscriptionScopes(scopes, null)).toEqual([]);
    });

    it('keeps bounded lists fully subscribed until viewability is known', () => {
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
            new Set(['server-a\u0000s1', 'server-b\u0000s1']),
        )).toEqual([
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-b', sessionId: 's1' },
        ]);
    });

    it('uses the unscoped session id when a row has no server id', () => {
        expect(resolveSessionListRowStoreScopeKey({ sessionId: 's1', serverId: 'server-a' })).toBe('server-a\u0000s1');
        expect(resolveSessionListRowStoreScopeKey({ sessionId: 'local-session', serverId: null })).toBe('local-session');
    });

    it('reuses row subscription scope arrays when scoped session identities are unchanged', () => {
        const previous: ReadonlyArray<SessionListRowStoreSubscriptionScope> = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: null, sessionId: 's2' },
        ];
        const nextEquivalent: ReadonlyArray<SessionListRowStoreSubscriptionScope> = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: undefined, sessionId: 's2' },
        ];
        const nextChanged: ReadonlyArray<SessionListRowStoreSubscriptionScope> = [
            { serverId: 'server-a', sessionId: 's1' },
            { serverId: 'server-a', sessionId: 's2' },
        ];

        expect(reuseSessionListRowStoreSubscriptionScopes(previous, nextEquivalent)).toBe(previous);
        expect(reuseSessionListRowStoreSubscriptionScopes(previous, nextChanged)).toBe(nextChanged);
    });

    it('reuses row subscription key sets when membership is unchanged', () => {
        const previous = new Set(['server-a\u0000s1', 'server-a\u0000s2']);
        const nextEquivalent = new Set(['server-a\u0000s2', 'server-a\u0000s1']);
        const nextChanged = new Set(['server-a\u0000s1']);

        expect(reuseSessionListRowStoreKeySet(previous, nextEquivalent)).toBe(previous);
        expect(reuseSessionListRowStoreKeySet(previous, nextChanged)).toBe(nextChanged);
        expect(reuseSessionListRowStoreKeySet(null, nextEquivalent)).toBe(nextEquivalent);
    });

    it('reuses visible subscription keys when priority keys are already visible', () => {
        const visibleKeys = new Set(['server-a\u0000s1', 'server-a\u0000s2']);

        expect(resolveSessionListRowStoreSubscriptionKeys(
            visibleKeys,
            new Set(['server-a\u0000s2']),
        )).toBe(visibleKeys);
    });

    it('keeps bounded native lists on all rendered row subscriptions when viewability changes', () => {
        const twentyVisibleRowKeys = new Set(
            Array.from({ length: 20 }, (_, index) => `server-a\u0000s${index + 1}`),
        );

        expect(resolveSessionListRowStoreSubscriptionKeysForViewport({
            platformOS: 'ios',
            renderedSessionRows: 145,
            nativeAllRenderedMaxRows: 200,
            visibleRowKeys: new Set(['server-a\u0000s1']),
        })).toBeNull();
        expect(resolveSessionListRowStoreSubscriptionKeysForViewport({
            platformOS: 'ios',
            renderedSessionRows: 10_000,
            nativeAllRenderedMaxRows: 200,
            visibleRowKeys: twentyVisibleRowKeys,
        })).toEqual(twentyVisibleRowKeys);
    });

    it('keeps only priority index items for large lists until viewability is known', () => {
        const items = [
            { type: 'header', title: 'Active', headerKind: 'active' },
            ...Array.from({ length: 75 }, (_, index) => ({
                type: 'session' as const,
                serverId: 'server-a',
                sessionId: `s${index + 1}`,
            })),
        ] satisfies ReadonlyArray<SessionListIndexItem>;

        expect(resolveSessionListRowStoreSubscriptionItems(
            items,
            null,
            new Set(['server-a\u0000s2', 'server-a\u0000s50']),
        )).toEqual([
            { type: 'session', serverId: 'server-a', sessionId: 's2' },
            { type: 'session', serverId: 'server-a', sessionId: 's50' },
        ]);
        expect(resolveSessionListRowStoreSubscriptionItems(items, null)).toEqual([]);
    });

    it('keeps bounded index items fully subscribed until viewability is known', () => {
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
            new Set(['server-a\u0000s1', 'server-b\u0000s1']),
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
            new Set(['server-a\u0000visible']),
            priorityKeys,
        )).toEqual([
            { type: 'session', serverId: 'server-a', sessionId: 'visible' },
            { type: 'session', serverId: 'server-a', sessionId: 'working', workingPlacementReason: 'working' },
            { type: 'session', serverId: 'server-a', sessionId: 'ready', attentionPlacementReason: 'ready' },
        ]);
    });

    it('derives offscreen runtime-priority keys from row state without treating unread-only rows as priority', () => {
        const nowMs = 1_000_000;
        const items = [
            { type: 'session', serverId: 'server-a', sessionId: 'visible' },
            { type: 'session', serverId: 'server-a', sessionId: 'active' },
            { type: 'session', serverId: 'server-a', sessionId: 'thinking' },
            { type: 'session', serverId: 'server-a', sessionId: 'in-progress' },
            { type: 'session', serverId: 'server-a', sessionId: 'permission' },
            { type: 'session', serverId: 'server-a', sessionId: 'action' },
            { type: 'session', serverId: 'server-a', sessionId: 'runtime-issue' },
            { type: 'session', serverId: 'server-a', sessionId: 'background' },
            { type: 'session', serverId: 'server-a', sessionId: 'unread-only' },
        ] satisfies ReadonlyArray<SessionListIndexItem>;
        const runtimePriorityKeys = buildSessionListRuntimePriorityRowKeys(items, {
            'server-a': {
                active: { active: true },
                thinking: {
                    active: true,
                    presence: 'online',
                    thinking: true,
                    thinkingAt: nowMs - 1_000,
                },
                'in-progress': {
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: nowMs - 1_000,
                },
                permission: { hasPendingPermissionRequests: true },
                action: { hasPendingUserActionRequests: true },
                'runtime-issue': { lastRuntimeIssue: { message: 'needs attention' } },
                background: {
                    presence: 'online',
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityRevision: 1,
                },
                'unread-only': { hasUnreadMessages: true, latestReadyEventSeq: 2 },
            },
        }, nowMs);

        expect(runtimePriorityKeys).toEqual(new Set([
            'server-a\u0000active',
            'server-a\u0000thinking',
            'server-a\u0000in-progress',
            'server-a\u0000permission',
            'server-a\u0000action',
            'server-a\u0000runtime-issue',
            'server-a\u0000background',
        ]));
        expect(resolveSessionListRowStoreSubscriptionItems(
            items,
            new Set(['server-a\u0000visible']),
            runtimePriorityKeys,
        )).toEqual([
            { type: 'session', serverId: 'server-a', sessionId: 'visible' },
            { type: 'session', serverId: 'server-a', sessionId: 'active' },
            { type: 'session', serverId: 'server-a', sessionId: 'thinking' },
            { type: 'session', serverId: 'server-a', sessionId: 'in-progress' },
            { type: 'session', serverId: 'server-a', sessionId: 'permission' },
            { type: 'session', serverId: 'server-a', sessionId: 'action' },
            { type: 'session', serverId: 'server-a', sessionId: 'runtime-issue' },
            { type: 'session', serverId: 'server-a', sessionId: 'background' },
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
