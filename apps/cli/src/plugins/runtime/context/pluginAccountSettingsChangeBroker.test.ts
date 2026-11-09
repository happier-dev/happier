import { describe, expect, it, vi } from 'vitest';

import {
    publishPluginAccountCollectionWatchInvalidation,
    publishPluginAccountSettingsWatchInvalidation,
    readPluginAccountCollectionWatchInvalidations,
    readPluginAccountSettingsWatchInvalidations,
    retirePluginAccountCollectionWatchScope,
    subscribePluginAccountCollectionWatchInvalidation,
    subscribePluginAccountSettingsWatchInvalidation,
    publishPluginAccountAvailabilityChanges,
    subscribePluginAccountAvailabilityChanges,
} from './pluginAccountSettingsChangeBroker';

describe('Account plugin Settings watch broker', () => {
    it('publishes Account readability without requiring an availability change or waking ordinary empty pages', () => {
        const listener = vi.fn();
        const unsubscribe = subscribePluginAccountAvailabilityChanges(listener);
        try {
            publishPluginAccountAvailabilityChanges('readable-scope', []);
            expect(listener).not.toHaveBeenCalled();
            publishPluginAccountAvailabilityChanges('readable-scope', [], { accountReadable: true });
            expect(listener).toHaveBeenCalledExactlyOnceWith('readable-scope', []);
        } finally { unsubscribe(); retirePluginAccountCollectionWatchScope('readable-scope'); }
    });
    it('wakes availability consumers once per changed Account page and skips duplicate cursors', () => {
        const listener = vi.fn();
        const unsubscribe = subscribePluginAccountAvailabilityChanges(listener);
        const change = { cursor: 41, kind: 'pluginDomain' as const, entityId: 'pluginDomain/example.tasks/availability', changedAt: 1,
            hint: { pluginDomain: 'availability' as const, pluginId: 'example.tasks' } };
        try {
            publishPluginAccountAvailabilityChanges('availability-scope', [change]);
            publishPluginAccountAvailabilityChanges('availability-scope', [change, { ...change, cursor: 40 }]);
            expect(listener).toHaveBeenCalledExactlyOnceWith('availability-scope', ['example.tasks']);
            publishPluginAccountAvailabilityChanges('availability-scope', [{ ...change, cursor: 42 }]);
            expect(listener).toHaveBeenCalledTimes(2);
            publishPluginAccountCollectionWatchInvalidation({ accountScopeKey: 'availability-scope', kind: 'reset', changeCursor: 10 });
            expect(listener).toHaveBeenLastCalledWith('availability-scope', null);
            publishPluginAccountAvailabilityChanges('availability-scope', [{ ...change, cursor: 11 }]);
            expect(listener).toHaveBeenCalledTimes(4);
        } finally { unsubscribe(); retirePluginAccountCollectionWatchScope('availability-scope'); }
    });
    it('admits only the closed settings AccountChange arm and carries no settings content', () => {
        expect(readPluginAccountSettingsWatchInvalidations([
            {
                cursor: 4,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/settings',
                changedAt: 1,
                hint: {
                    pluginDomain: 'settings',
                    pluginId: 'example.tasks',
                    scope: 'account',
                    revision: 7,
                },
            },
            {
                cursor: 5,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-kv',
                changedAt: 2,
                hint: {
                    pluginDomain: 'dataKv',
                    pluginId: 'example.tasks',
                    full: true,
                },
            },
        ])).toEqual([{
            kind: 'record',
            pluginId: 'example.tasks',
            revision: 7,
        }]);
    });

    it('publishes content-free exact and full reread invalidations to active watchers', () => {
        const listener = vi.fn();
        const unsubscribe = subscribePluginAccountSettingsWatchInvalidation(listener);
        try {
            publishPluginAccountSettingsWatchInvalidation({
                kind: 'record',
                pluginId: 'example.tasks',
                revision: 7,
            });
            publishPluginAccountSettingsWatchInvalidation({ kind: 'full' });
            expect(listener).toHaveBeenCalledWith({
                kind: 'record',
                pluginId: 'example.tasks',
                revision: 7,
            });
            expect(listener).toHaveBeenCalledWith({ kind: 'full' });
        } finally {
            unsubscribe();
        }
    });
});

describe('Account plugin Collection watch broker', () => {
    const accountScopeKey = 'account-scope-default';

    it('uses index keys only across an observed predecessor and keeps missed, full and reset catch-up', async () => {
        const scope = 'account-scope-index-predecessor';
        const listener = vi.fn();
        const subscription = { accountScopeKey: scope, pluginId: 'example.tasks', collectionId: 'tasks',
            contractDigest: 'a'.repeat(43), startingCursor: 10,
            indexSelection: { indexId: 'by-kind', prefixes: ['aa'] } };
        const dispose = subscribePluginAccountCollectionWatchInvalidation(subscription, listener);
        const publish = (changeCursor: number, previousCursor: number, key: string) => {
            const hint = { kind: 'collection' as const, accountScopeKey: scope, pluginId: subscription.pluginId,
                collectionId: subscription.collectionId, contractDigest: subscription.contractDigest,
                rowIds: ['row-1'], indexChanges: { previousCursor, keys: [{ indexId: 'by-kind', key }] }, changeCursor };
            publishPluginAccountCollectionWatchInvalidation(hint);
        };
        try {
            publish(11, 10, 'bb01');
            publish(12, 11, 'bb02');
            await Promise.resolve();
            expect(listener).not.toHaveBeenCalled();
            publish(13, 12, 'aa01');
            publish(14, 13, 'bb03');
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ changeCursor: 13 }));
            listener.mockClear();
            publish(16, 15, 'bb04');
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ full: true, changeCursor: 16 }));
            listener.mockClear();
            const successor = { kind: 'collection' as const, accountScopeKey: scope,
                pluginId: subscription.pluginId, collectionId: subscription.collectionId,
                contractDigest: 'b'.repeat(43), rowIds: ['row-2'], changeCursor: 17,
                indexChanges: { previousCursor: 16, keys: [{ indexId: 'by-kind', key: 'bb05' }] } };
            publishPluginAccountCollectionWatchInvalidation(successor);
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ full: true,
                contractDigest: subscription.contractDigest, changeCursor: 17 }));
            const late = vi.fn();
            const disposeLate = subscribePluginAccountCollectionWatchInvalidation({ ...subscription, startingCursor: 16 }, late);
            try {
                await Promise.resolve();
                expect(late).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ full: true,
                    contractDigest: subscription.contractDigest, changeCursor: 17 }));
            } finally { disposeLate(); }
            listener.mockClear();
            publishPluginAccountCollectionWatchInvalidation({ kind: 'collection', accountScopeKey: scope,
                pluginId: subscription.pluginId, collectionId: subscription.collectionId,
                contractDigest: 'b'.repeat(43), full: true, changeCursor: 18 });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ full: true, changeCursor: 18 }));
            listener.mockClear();
            publishPluginAccountCollectionWatchInvalidation({ kind: 'reset', accountScopeKey: scope, changeCursor: 1 });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'reset', changeCursor: 1 }));
        } finally { dispose(); retirePluginAccountCollectionWatchScope(scope); }
    });

    it('wakes declaration-only presence watchers across retained contract versions and catches up after the read', async () => {
        const listener = vi.fn();
        const hint = { kind: 'collection' as const, accountScopeKey, pluginId: 'example.tasks',
            collectionId: 'tasks', contractDigest: 'old-contract', changeCursor: 90 };
        publishPluginAccountCollectionWatchInvalidation(hint);
        const dispose = subscribePluginAccountCollectionWatchInvalidation({
            accountScopeKey, pluginId: hint.pluginId, collectionId: hint.collectionId,
            startingCursor: 89,
        }, listener);
        try {
            await Promise.resolve();
            expect(listener).toHaveBeenCalledTimes(1);
            publishPluginAccountCollectionWatchInvalidation({ ...hint, contractDigest: 'new-contract', changeCursor: 91 });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledTimes(2);
        } finally {
            dispose();
            retirePluginAccountCollectionWatchScope(accountScopeKey);
        }
    });

    it('admits only the closed dataCollection AccountChange arm without carrying row content', () => {
        expect(readPluginAccountCollectionWatchInvalidations([
            {
                cursor: 8,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                changedAt: 2,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    contractDigest: 'a'.repeat(43),
                    revision: 7,
                    rowIds: ['task-1'],
                },
            },
            {
                cursor: 9,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-kv',
                changedAt: 3,
                hint: {
                    pluginDomain: 'dataKv',
                    pluginId: 'example.tasks',
                    full: true,
                },
            },
        ])).toEqual([{
            kind: 'collection',
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: 'a'.repeat(43),
            rowIds: ['task-1'],
            changeCursor: 8,
        }]);
    });

    it('filters intrinsic row observers before coalescing while preserving full reset and conservative catch-up', async () => {
        const scope = 'account-scope-exact-row';
        const digest = 'a'.repeat(43);
        const listener = vi.fn();
        const subscription = { accountScopeKey: scope, pluginId: 'example.tasks', collectionId: 'tasks',
            contractDigest: digest, rowId: 'task-1' };
        const publish = (cursor: number, rowIds: string[]) => {
            const [hint] = readPluginAccountCollectionWatchInvalidations([{
                cursor, kind: 'pluginDomain', entityId: 'pluginDomain/example.tasks/data-collection/tasks', changedAt: cursor,
                hint: { pluginDomain: 'dataCollection', pluginId: 'example.tasks', collectionId: 'tasks',
                    contractDigest: digest, revision: cursor, rowIds },
            }]);
            if (!hint) throw new Error('Expected admitted Collection hint');
            publishPluginAccountCollectionWatchInvalidation({ accountScopeKey: scope, ...hint });
        };
        const unsubscribe = subscribePluginAccountCollectionWatchInvalidation(subscription, listener);
        let unsubscribeLate: (() => void) | undefined;
        try {
            for (let cursor = 1; cursor <= 5; cursor++) publish(cursor, [`unrelated-${cursor}`]);
            await Promise.resolve();
            expect(listener).not.toHaveBeenCalled();
            publish(6, ['task-1', 'other']);
            publish(7, ['other']);
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ changeCursor: 6 }));
            listener.mockClear();
            publishPluginAccountCollectionWatchInvalidation({ accountScopeKey: scope, kind: 'collection',
                pluginId: 'example.tasks', collectionId: 'tasks', contractDigest: digest, full: true, changeCursor: 8 });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ full: true, changeCursor: 8 }));
            listener.mockClear();
            publishPluginAccountCollectionWatchInvalidation({ accountScopeKey: scope, kind: 'reset', changeCursor: 9 });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith({ accountScopeKey: scope, kind: 'reset', changeCursor: 9 });

            publish(10, ['task-1']);
            publish(11, ['other']);
            const late = vi.fn();
            unsubscribeLate = subscribePluginAccountCollectionWatchInvalidation({ ...subscription, startingCursor: 9 }, late);
            await Promise.resolve();
            expect(late).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ full: true, changeCursor: 11 }));
            unsubscribe();
            listener.mockClear();
            publish(12, ['task-1']);
            await Promise.resolve();
            expect(listener).not.toHaveBeenCalled();
        } finally {
            unsubscribeLate?.();
            unsubscribe();
            retirePluginAccountCollectionWatchScope(scope);
        }
    });

    it('publishes content-free collection reread invalidations to active watchers', async () => {
        const listener = vi.fn();
        const unsubscribe = subscribePluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: 'a'.repeat(43),
        }, listener);
        try {
            publishPluginAccountCollectionWatchInvalidation({
                accountScopeKey,
                kind: 'collection',
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                contractDigest: 'a'.repeat(43),
                changeCursor: 8,
            });
            publishPluginAccountCollectionWatchInvalidation({ accountScopeKey, kind: 'reset', changeCursor: 9 });
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith({ accountScopeKey, kind: 'reset', changeCursor: 9 });
        } finally {
            unsubscribe();
        }
    });

    it('fans one durable full Collection invalidation out to every compatible contract reader', async () => {
        const firstDigest = 'a'.repeat(43);
        const secondDigest = 'b'.repeat(43);
        const [fullInvalidation] = readPluginAccountCollectionWatchInvalidations([
            {
                cursor: 10,
                kind: 'pluginDomain',
                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                changedAt: 3,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId: 'example.tasks',
                    collectionId: 'tasks',
                    contractDigest: firstDigest,
                    revision: 8,
                    full: true,
                },
            },
        ]);
        expect(fullInvalidation).toEqual({
            kind: 'collection',
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: firstDigest,
            full: true,
            changeCursor: 10,
        });
        if (!fullInvalidation) throw new Error('Expected full Collection invalidation.');

        const firstListener = vi.fn();
        const secondListener = vi.fn();
        const lateListener = vi.fn();
        const unsubscribeFirst = subscribePluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: firstDigest,
        }, firstListener);
        const unsubscribeSecond = subscribePluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: secondDigest,
        }, secondListener);
        let unsubscribeLate: (() => void) | undefined;
        try {
            publishPluginAccountCollectionWatchInvalidation({
                accountScopeKey,
                ...fullInvalidation,
            });
            await Promise.resolve();
            expect(firstListener).toHaveBeenCalledExactlyOnceWith({
                accountScopeKey,
                ...fullInvalidation,
            });
            expect(secondListener).toHaveBeenCalledExactlyOnceWith({
                accountScopeKey,
                ...fullInvalidation,
                contractDigest: secondDigest,
            });

            unsubscribeLate = subscribePluginAccountCollectionWatchInvalidation({
                accountScopeKey,
                pluginId: 'example.tasks',
                collectionId: 'tasks',
                contractDigest: secondDigest,
                startingCursor: 9,
            }, lateListener);
            await Promise.resolve();
            expect(lateListener).toHaveBeenCalledExactlyOnceWith({
                accountScopeKey,
                ...fullInvalidation,
                contractDigest: secondDigest,
            });
        } finally {
            unsubscribeLate?.();
            unsubscribeSecond();
            unsubscribeFirst();
        }
    });

    it('coalesces the latest matching change published after initial query C but before watch registration', async () => {
        const initialCursor = 5_000_000;
        const listener = vi.fn();
        publishPluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            kind: 'collection',
            pluginId: 'example.catch-up',
            collectionId: 'rows',
            contractDigest: 'b'.repeat(43),
            changeCursor: initialCursor + 1,
        });
        publishPluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            kind: 'collection',
            pluginId: 'example.catch-up',
            collectionId: 'rows',
            contractDigest: 'b'.repeat(43),
            changeCursor: initialCursor + 2,
        });

        const unsubscribe = subscribePluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            pluginId: 'example.catch-up',
            collectionId: 'rows',
            contractDigest: 'b'.repeat(43),
            startingCursor: initialCursor,
        }, listener);
        try {
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith({
                accountScopeKey,
                kind: 'collection',
                pluginId: 'example.catch-up',
                collectionId: 'rows',
                contractDigest: 'b'.repeat(43),
                changeCursor: initialCursor + 2,
            });
        } finally {
            unsubscribe();
        }
    });

    it('catches up with one reset when the retention-floor reset follows initial query C', async () => {
        const initialCursor = 6_000_000;
        const listener = vi.fn();
        publishPluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            kind: 'reset',
            changeCursor: initialCursor + 1,
        });

        const unsubscribe = subscribePluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            pluginId: 'example.catch-up',
            collectionId: 'rows',
            contractDigest: 'b'.repeat(43),
            startingCursor: initialCursor,
        }, listener);
        try {
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith({
                accountScopeKey,
                kind: 'reset',
                changeCursor: initialCursor + 1,
            });
        } finally {
            unsubscribe();
        }
    });

    it('rebases retained same-scope state when an authoritative reset moves the cursor backward', async () => {
        const rebaseScopeKey = 'account-scope-cursor-rebase';
        const subscription = Object.freeze({
            accountScopeKey: rebaseScopeKey,
            pluginId: 'example.cursor-rebase',
            collectionId: 'rows',
            contractDigest: 'd'.repeat(43),
            startingCursor: 100,
        });
        const lowerReset = Object.freeze({
            accountScopeKey: rebaseScopeKey,
            kind: 'reset' as const,
            changeCursor: 1,
        });
        const lowerChange = Object.freeze({
            accountScopeKey: rebaseScopeKey,
            kind: 'collection' as const,
            pluginId: subscription.pluginId,
            collectionId: subscription.collectionId,
            contractDigest: subscription.contractDigest,
            changeCursor: 2,
        });
        const activeListener = vi.fn();
        const replayListener = vi.fn();

        // This is a previously retained cursor from the same Account scope.
        // A cursor-gone response after restore/rebase is authoritative even
        // when its current cursor is lower than this old domain's value.
        publishPluginAccountCollectionWatchInvalidation({
            accountScopeKey: rebaseScopeKey,
            kind: 'reset',
            changeCursor: 100,
        });
        const unsubscribeActive = subscribePluginAccountCollectionWatchInvalidation(subscription, activeListener);
        let unsubscribeReplay: (() => void) | undefined;
        try {
            publishPluginAccountCollectionWatchInvalidation(lowerReset);
            await Promise.resolve();
            expect(activeListener).toHaveBeenCalledExactlyOnceWith(lowerReset);

            publishPluginAccountCollectionWatchInvalidation(lowerChange);
            await Promise.resolve();
            expect(activeListener).toHaveBeenCalledTimes(2);
            expect(activeListener).toHaveBeenLastCalledWith(lowerChange);

            unsubscribeReplay = subscribePluginAccountCollectionWatchInvalidation({
                ...subscription,
                startingCursor: lowerReset.changeCursor,
            }, replayListener);
            await Promise.resolve();
            expect(replayListener).toHaveBeenCalledExactlyOnceWith(lowerChange);
        } finally {
            unsubscribeReplay?.();
            unsubscribeActive();
        }
    });

    it('does not let a retained account A reset suppress account B\'s lower cursor', async () => {
        const accountAReset = Object.freeze({
            accountScopeKey: 'account-scope-a',
            kind: 'reset' as const,
            changeCursor: 7_000_001,
        });
        const accountBSubscription = Object.freeze({
            accountScopeKey: 'account-scope-b',
            pluginId: 'example.account-isolation',
            collectionId: 'rows',
            contractDigest: 'c'.repeat(43),
            startingCursor: 1,
        });
        const accountBChange = Object.freeze({
            accountScopeKey: 'account-scope-b',
            kind: 'collection' as const,
            pluginId: 'example.account-isolation',
            collectionId: 'rows',
            contractDigest: 'c'.repeat(43),
            changeCursor: 2,
        });
        const listener = vi.fn();

        // Retained cursors are scoped to the Account lifetime, so Account A's
        // reset cannot be replayed to or suppress Account B below.
        publishPluginAccountCollectionWatchInvalidation(accountAReset);
        const unsubscribe = subscribePluginAccountCollectionWatchInvalidation(accountBSubscription, listener);
        try {
            await Promise.resolve();
            expect(listener).not.toHaveBeenCalled();

            publishPluginAccountCollectionWatchInvalidation(accountBChange);
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith(accountBChange);
        } finally {
            unsubscribe();
        }
    });

    it('retires retained collection cursors and active watchers with the Account lifetime', async () => {
        const retiredScopeKey = 'account-scope-retired';
        const subscription = Object.freeze({
            accountScopeKey: retiredScopeKey,
            pluginId: 'example.retired',
            collectionId: 'rows',
            contractDigest: 'e'.repeat(43),
            startingCursor: 1,
        });
        const staleListener = vi.fn();
        const freshListener = vi.fn();
        const staleUnsubscribe = subscribePluginAccountCollectionWatchInvalidation(subscription, staleListener);

        try {
            publishPluginAccountCollectionWatchInvalidation({
                accountScopeKey: retiredScopeKey,
                kind: 'collection',
                pluginId: subscription.pluginId,
                collectionId: subscription.collectionId,
                contractDigest: subscription.contractDigest,
                changeCursor: 2,
            });

            // Retirement must neutralize a callback already queued in this
            // Account lifetime as well as forget its retained cursor.
            retirePluginAccountCollectionWatchScope(retiredScopeKey);
            retirePluginAccountCollectionWatchScope(retiredScopeKey);
            await Promise.resolve();
            expect(staleListener).not.toHaveBeenCalled();

            const freshUnsubscribe = subscribePluginAccountCollectionWatchInvalidation(subscription, freshListener);
            try {
                await Promise.resolve();
                expect(freshListener).not.toHaveBeenCalled();

                publishPluginAccountCollectionWatchInvalidation({
                    accountScopeKey: retiredScopeKey,
                    kind: 'collection',
                    pluginId: subscription.pluginId,
                    collectionId: subscription.collectionId,
                    contractDigest: subscription.contractDigest,
                    changeCursor: 3,
                });
                await Promise.resolve();

                expect(staleListener).not.toHaveBeenCalled();
                expect(freshListener).toHaveBeenCalledExactlyOnceWith({
                    accountScopeKey: retiredScopeKey,
                    kind: 'collection',
                    pluginId: subscription.pluginId,
                    collectionId: subscription.collectionId,
                    contractDigest: subscription.contractDigest,
                    changeCursor: 3,
                });
            } finally {
                freshUnsubscribe();
            }
        } finally {
            staleUnsubscribe();
        }
    });
});
