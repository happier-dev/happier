import { describe, expect, it, vi } from 'vitest';

import {
    publishPluginAccountCollectionWatchInvalidation,
    publishPluginAccountSettingsWatchInvalidation,
    readPluginAccountCollectionWatchInvalidations,
    readPluginAccountSettingsWatchInvalidations,
    retirePluginAccountCollectionWatchScope,
    subscribePluginAccountCollectionWatchInvalidation,
    subscribePluginAccountSettingsWatchInvalidation,
} from './pluginAccountSettingsChangeBroker';

describe('Account plugin Settings watch broker', () => {
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
            changeCursor: 8,
        }]);
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
