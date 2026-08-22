import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function deletedExactlyOneRow(result: unknown): boolean {
    return typeof result === 'object'
        && result !== null
        && 'count' in result
        && (result as { count?: unknown }).count === 1;
}

/**
 * Pauses at the genuine persistence boundary immediately after an aged
 * AccountChange deletion. It instruments both the direct delegate used by
 * the old implementation and the transaction delegate required by the
 * atomic implementation, while preserving all real database work below it.
 */
function installPauseAfterAccountChangeDeletion(): Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const deletionReached = deferred();
    const releaseDeletion = deferred();
    const directDelegate = db.accountChange;
    const originalDirectDeleteMany = directDelegate.deleteMany.bind(directDelegate);
    const originalTransaction = db.$transaction;
    let paused = false;
    let restored = false;

    const pauseAfterDeletion = async <T>(result: T): Promise<T> => {
        if (!paused && deletedExactlyOneRow(result)) {
            paused = true;
            deletionReached.resolve();
            await releaseDeletion.promise;
        }
        return result;
    };

    Object.defineProperty(directDelegate, 'deleteMany', {
        configurable: true,
        writable: true,
        value: async (...args: unknown[]) => (
            await pauseAfterDeletion(await Reflect.apply(
                originalDirectDeleteMany,
                directDelegate,
                args,
            ))
        ),
    });

    db.$transaction = (async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== 'function') {
            return await Reflect.apply(originalTransaction, undefined, args);
        }

        return await Reflect.apply(originalTransaction, undefined, [
            async (tx: object) => {
                const transactionDelegate = Reflect.get(tx, 'accountChange') as object;
                const originalTransactionDeleteMany = Reflect.get(
                    transactionDelegate,
                    'deleteMany',
                ) as (...args: unknown[]) => Promise<unknown>;
                const wrappedDelegate = new Proxy(transactionDelegate, {
                    get(target, property, receiver) {
                        if (property !== 'deleteMany') {
                            return Reflect.get(target, property, receiver);
                        }
                        return async (...deleteManyArgs: unknown[]) => (
                            await pauseAfterDeletion(await Reflect.apply(
                                originalTransactionDeleteMany,
                                target,
                                deleteManyArgs,
                            ))
                        );
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === 'accountChange') return wrappedDelegate;
                        return Reflect.get(target, property, receiver);
                    },
                });
                return await operation(wrappedTx);
            },
            ...args.slice(1),
        ]);
    }) as typeof db.$transaction;

    return {
        reached: deletionReached.promise,
        release: releaseDeletion.resolve,
        restore: () => {
            if (restored) return;
            restored = true;
            releaseDeletion.resolve();
            Object.defineProperty(directDelegate, 'deleteMany', {
                configurable: true,
                writable: true,
                value: originalDirectDeleteMany,
            });
            db.$transaction = originalTransaction;
        },
    };
}

function isChangesCursorRead(args: unknown, accountId: string): boolean {
    if (!args || typeof args !== 'object') return false;
    const input = args as Readonly<{
        where?: Readonly<{ id?: unknown }>;
        select?: Readonly<{ seq?: unknown; changesFloor?: unknown }>;
    }>;
    return input.where?.id === accountId
        && input.select?.seq === true
        && input.select?.changesFloor === true;
}

/** Pauses the route after its first (now potentially stale) cursor read. */
function installPauseAfterChangesCursorRead(accountId: string): Readonly<{
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const cursorRead = deferred();
    const releaseRead = deferred();
    const delegate = db.account;
    const originalFindUnique = delegate.findUnique.bind(delegate);
    let paused = false;
    let restored = false;

    Object.defineProperty(delegate, 'findUnique', {
        configurable: true,
        writable: true,
        value: async (args: unknown) => {
            const result = await Reflect.apply(originalFindUnique, delegate, [args]);
            if (!paused && isChangesCursorRead(args, accountId)) {
                paused = true;
                cursorRead.resolve();
                await releaseRead.promise;
            }
            return result;
        },
    });

    return {
        reached: cursorRead.promise,
        release: releaseRead.resolve,
        restore: () => {
            if (restored) return;
            restored = true;
            releaseRead.resolve();
            Object.defineProperty(delegate, 'findUnique', {
                configurable: true,
                writable: true,
                value: originalFindUnique,
            });
        },
    };
}

describe('accountChangeRetentionRule', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'retention-account-change-rule-',
            sqliteConnectionLimit: 2,
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('deletes aged account changes per account and advances changesFloor to the highest pruned cursor', async () => {
        await db.account.createMany({
            data: [
                { id: 'owner-a' },
                { id: 'owner-b' },
            ],
        });

        await db.accountChange.createMany({
            data: [
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-1',
                    cursor: 1,
                    changedAt: new Date('2024-01-01T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-2',
                    cursor: 2,
                    changedAt: new Date('2024-01-02T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-3',
                    cursor: 3,
                    changedAt: new Date('2026-01-01T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-b',
                    kind: 'session',
                    entityId: 'b-1',
                    cursor: 4,
                    changedAt: new Date('2024-01-03T00:00:00.000Z'),
                },
            ],
        });

        const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
        const result = await runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
        });

        expect(result.deleted).toBe(3);
        expect(await db.accountChange.count()).toBe(1);
        expect(await db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-3',
                },
            },
        })).toBeTruthy();
        expect(await db.account.findUnique({ where: { id: 'owner-a' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 2,
        });
        expect(await db.account.findUnique({ where: { id: 'owner-b' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 4,
        });
    });

    it('reports aged account changes in dry-run mode without deleting rows or changing floors', async () => {
        await db.account.create({
            data: { id: 'owner-a' },
        });
        await db.accountChange.create({
            data: {
                accountId: 'owner-a',
                kind: 'session',
                entityId: 'a-1',
                cursor: 1,
                changedAt: new Date('2024-01-01T00:00:00.000Z'),
            },
        });

        const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
        const result = await runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: true,
            maxDeletesPerRulePerRun: 10,
        });

        expect(result.deleted).toBe(1);
        expect(await db.accountChange.count()).toBe(1);
        expect(await db.account.findUnique({ where: { id: 'owner-a' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 0,
        });
    });

    it('respects maxDeletesPerRulePerRun with deterministic oldest-first per-account windows', async () => {
        await db.account.createMany({
            data: [
                { id: 'owner-a' },
                { id: 'owner-b' },
            ],
        });

        await db.accountChange.createMany({
            data: [
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-1',
                    cursor: 1,
                    changedAt: new Date('2024-01-01T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-2',
                    cursor: 2,
                    changedAt: new Date('2024-01-02T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-a',
                    kind: 'session',
                    entityId: 'a-3',
                    cursor: 3,
                    changedAt: new Date('2024-01-03T00:00:00.000Z'),
                },
                {
                    accountId: 'owner-b',
                    kind: 'session',
                    entityId: 'b-1',
                    cursor: 4,
                    changedAt: new Date('2024-01-04T00:00:00.000Z'),
                },
            ],
        });

        const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
        const result = await runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 2,
        });

        expect(result.deleted).toBe(2);
        expect(await db.accountChange.findMany({
            orderBy: [{ accountId: 'asc' }, { cursor: 'asc' }],
            select: { accountId: true, entityId: true, cursor: true },
        })).toEqual([
            { accountId: 'owner-a', entityId: 'a-3', cursor: 3 },
            { accountId: 'owner-b', entityId: 'b-1', cursor: 4 },
        ]);
        expect(await db.account.findUnique({ where: { id: 'owner-a' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 2,
        });
        expect(await db.account.findUnique({ where: { id: 'owner-b' }, select: { changesFloor: true } })).toEqual({
            changesFloor: 0,
        });
    });

    it('never serves an exact successor after pruning its required full hint', async () => {
        const account = await db.account.create({
            data: {
                publicKey: 'pk-retention-full-hint-race',
                seq: 1,
            },
            select: { id: true },
        });
        const pluginId = 'example.tasks';
        const collectionId = 'tasks';
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        const firstDigest = 'a'.repeat(43);
        const exactDigest = 'b'.repeat(43);
        await db.accountChange.create({
            data: {
                accountId: account.id,
                kind: 'pluginDomain',
                entityId,
                cursor: 1,
                changedAt: new Date('2024-01-01T00:00:00.000Z'),
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId,
                    collectionId,
                    contractDigest: firstDigest,
                    revision: 1,
                    full: true,
                },
            },
        });

        const pause = installPauseAfterAccountChangeDeletion();
        let retention: Promise<{ deleted: number }> | undefined;
        let exactChange: Promise<number> | undefined;
        try {
            const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
            retention = runAccountChangeRetentionRule({
                cutoff: new Date('2025-01-01T00:00:00.000Z'),
                batchSize: 1,
                dryRun: false,
                maxDeletesPerRulePerRun: 1,
            });
            await pause.reached;

            let exactCommitted = false;
            exactChange = inTx(async (tx) => await markAccountChanged(tx, {
                accountId: account.id,
                kind: 'pluginDomain',
                entityId,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId,
                    collectionId,
                    contractDigest: exactDigest,
                    revision: 2,
                    rowIds: ['task-1'],
                },
            }));
            exactChange.then(
                () => { exactCommitted = true; },
                () => undefined,
            );

            // With the old split delete/floor path the exact write commits in
            // this window and /v2/changes answers 200 with only F+1. The
            // Account-first transaction must keep that write blocked instead.
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (exactCommitted) {
                await withAuthenticatedTestApp(
                    (app) => changesRoutes(app),
                    async (app) => {
                        const response = await app.inject({
                            method: 'GET',
                            url: '/v2/changes?after=0&limit=50',
                            headers: {
                                'x-test-user-id': account.id,
                                'x-happier-account-stored-content-protocol': '3',
                            },
                        });
                        expect(response.statusCode).toBe(410);
                    },
                );
            }
            expect(exactCommitted).toBe(false);

            pause.release();
            await expect(retention).resolves.toEqual({
                deleted: 1,
                candidatesExamined: 1,
                hasMore: true,
            });
            expect(await exactChange).toBe(2);

            await withAuthenticatedTestApp(
                (app) => changesRoutes(app),
                async (app) => {
                    const response = await app.inject({
                        method: 'GET',
                        url: '/v2/changes?after=0&limit=50',
                        headers: {
                            'x-test-user-id': account.id,
                            'x-happier-account-stored-content-protocol': '3',
                        },
                    });
                    expect(response.statusCode).toBe(410);
                    expect(response.json()).toEqual({
                        error: 'cursor-gone',
                        currentCursor: 2,
                    });
                },
            );
        } finally {
            pause.release();
            await retention?.catch(() => undefined);
            await exactChange?.catch(() => undefined);
            pause.restore();
        }
    }, 30_000);

    it('rechecks the floor after rows so a stale cursor read cannot return an exact-only page', async () => {
        const account = await db.account.create({
            data: {
                publicKey: 'pk-retention-reader-floor-race',
                seq: 1,
            },
            select: { id: true },
        });
        const pluginId = 'example.tasks';
        const collectionId = 'tasks';
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        await db.accountChange.create({
            data: {
                accountId: account.id,
                kind: 'pluginDomain',
                entityId,
                cursor: 1,
                changedAt: new Date('2024-01-01T00:00:00.000Z'),
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId,
                    collectionId,
                    contractDigest: 'a'.repeat(43),
                    revision: 1,
                    full: true,
                },
            },
        });

        const pause = installPauseAfterChangesCursorRead(account.id);
        let response: Readonly<{
            statusCode: number;
            json: () => unknown;
        }> | undefined;
        let poll: Promise<void> | undefined;
        try {
            poll = withAuthenticatedTestApp(
                (app) => changesRoutes(app),
                async (app) => {
                    response = await app.inject({
                        method: 'GET',
                        url: '/v2/changes?after=0&limit=50',
                        headers: {
                            'x-test-user-id': account.id,
                            'x-happier-account-stored-content-protocol': '3',
                        },
                    });
                },
            );
            await pause.reached;

            const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
            await expect(runAccountChangeRetentionRule({
                cutoff: new Date('2025-01-01T00:00:00.000Z'),
                batchSize: 1,
                dryRun: false,
                maxDeletesPerRulePerRun: 1,
            })).resolves.toEqual({
                deleted: 1,
                candidatesExamined: 1,
                hasMore: true,
            });
            await expect(inTx(async (tx) => await markAccountChanged(tx, {
                accountId: account.id,
                kind: 'pluginDomain',
                entityId,
                hint: {
                    pluginDomain: 'dataCollection',
                    pluginId,
                    collectionId,
                    contractDigest: 'b'.repeat(43),
                    revision: 2,
                    rowIds: ['task-1'],
                },
            }))).resolves.toBe(2);

            pause.release();
            await poll;
            expect(response?.statusCode).toBe(410);
            expect(response?.json()).toEqual({
                error: 'cursor-gone',
                currentCursor: 2,
            });
        } finally {
            pause.release();
            await poll?.catch(() => undefined);
            pause.restore();
        }
    }, 30_000);
});
