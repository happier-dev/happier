import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { db, initDbPostgres } from '@/storage/db';
import { inTx, transactionResult, type Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { afterAccountChangePublication, beforeAccountChangePublication, markAccountChanged, markAccountsChanged, markSessionAccountsChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountSessionOwnerMetadataFenceInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { observeLazyPrismaQuery } from './accountPublicationContention.testkit';

function latch() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Terminal Account publication concurrency', () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        // Two overlapping writers plus the reserved HTTP/SQL observer slot.
        // Do not let the driver's host-core default open 100 test connections.
        vi.stubEnv('HAPPIER_DB_CONNECTION_LIMIT', '3');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it.each(['content', 'serializing', 'exclusive'] as const)('uses only the necessary Account lock statements after %s admission', async intent => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const original = db.$transaction;
        const locks: string[] = [];
        // Observe consumed SQL at the real Prisma transport boundary. Keep
        // admission, transaction budgets and terminal publication unchanged.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(owner, property, proxyReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(owner, property, proxyReceiver);
                    return (sql: string, ...values: unknown[]) => observeLazyPrismaQuery(owner.$queryRawUnsafe(sql, ...values), () => ({
                        started: () => { if (sql.startsWith('SELECT "id" FROM "Account"') && sql.includes('FOR ')) locks.push(sql); },
                        settled: () => {},
                    }));
                },
            })), ...args.slice(1)]);
        } });
        try {
            const publication = await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, intent);
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, intent);
                return markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'cost-contract' });
            }, { isolationLevel: 'ReadCommitted', transactionClass: 'publication-cost-contract' });
            expect(publication.resolveCursor()).toBe(1);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(1);
            const expectedLocks = intent === 'content' ? 2 : 1;
            console.info('PERFACCT_LOCK_COUNT', JSON.stringify({ intent, statements: locks.length, expected: expectedLocks }));
            expect(locks).toHaveLength(expectedLocks);
        } finally {
            db.$transaction = original;
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('performs no cursor allocation or wake for admitted no-op work while still running currentness and projection callbacks', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const emitted = vi.spyOn(eventRouter, 'emitUpdate');
        let validations = 0, projections = 0;
        try {
            for (let index = 0; index < 20; index++) await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, 'content');
                beforeAccountChangePublication(tx, [account.id], async () => { validations++; });
                afterAccountChangePublication(tx, async () => { projections++; });
            }, { isolationLevel: 'ReadCommitted' });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
            expect(emitted.mock.calls.filter(([event]) => event.userId === account.id)).toHaveLength(0);
            expect({ validations, projections }).toEqual({ validations: 20, projections: 20 });
        } finally {
            emitted.mockRestore();
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('coalesces mixed-writer wakes per committed Account without dropping feed cursors or hints', async () => {
        const accounts = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
        const accountIds = accounts.map(account => account.id);
        const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: accounts[0].id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } })));
        const app = createAuthenticatedTestApp();
        changesRoutes(app);
        const readCommitted = async (accountId: string) => ({
            seq: (await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).seq,
            changes: await db.accountChange.findMany({ where: { accountId }, orderBy: { cursor: 'asc' },
                select: { kind: true, entityId: true, cursor: true, hint: true } }),
        });
        const emissions: Array<{ room: string | string[]; eventName: string; payload: unknown;
            committed: Promise<Awaited<ReturnType<typeof readCommitted>>> }> = [];
        // Socket.IO is the outward system boundary; independent SQL here must
        // already see every feed row when the real router publishes the wake.
        eventRouter.setIo({ to: room => ({ disconnectSockets: () => {}, emit: (eventName, payload) => {
            const accountId = accountIds.find(id => room === `account-stored-content-v3:${id}`);
            const committed = accountId ? readCommitted(accountId) : Promise.reject(new Error(`Unexpected room: ${room}`));
            void committed.catch(() => {});
            emissions.push({ room, eventName, payload, committed });
        } }) });
        try {
            const cursors = await inTx(async tx => {
                const point = await markAccountChanged(tx, { accountId: accounts[0].id, kind: 'account',
                    entityId: 'settings', hint: { keys: ['theme'] } });
                const set = await markAccountsChanged(tx, { accountIds, entityId: 'profile' });
                const sessionSet = await markSessionAccountsChanged(tx, new Map([
                    [sessions[0].id, accountIds], [sessions[1].id, [accounts[0].id]],
                ]));
                expect(emissions).toHaveLength(0);
                return transactionResult(() => [point, ...set, ...sessionSet]
                    .map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() })));
            });
            expect(emissions).toHaveLength(2);
            expect(emissions.map(emission => emission.room).sort()).toEqual(accountIds
                .map(id => `account-stored-content-v3:${id}`).sort());
            for (const [index, accountId] of accountIds.entries()) {
                const expectedSeq = index === 0 ? 4 : 2;
                expect(cursors.filter(cursor => cursor.accountId === accountId).map(cursor => cursor.cursor).sort())
                    .toEqual(Array.from({ length: expectedSeq }, (_, cursor) => cursor + 1));
                const emission = emissions.find(value => value.room === `account-stored-content-v3:${accountId}`)!;
                expect(emission.eventName).toBe('update');
                expect(emission.payload).toEqual(expect.objectContaining({ seq: expectedSeq,
                    body: { t: 'account-change', changeKinds: ['account', 'session'],
                        entityIds: index === 0 ? ['settings', 'profile', ...sessions.map(session => session.id).sort()]
                            : ['profile', sessions[0].id] },
                }));
                const committed = await emission.committed;
                expect(committed.seq).toBe(expectedSeq);
                expect(committed.changes.map(change => change.cursor)).toEqual(Array.from({ length: expectedSeq }, (_, cursor) => cursor + 1));
                expect(committed.changes.map(({ cursor: _cursor, ...change }) => change)).toEqual(expect.arrayContaining([
                    { kind: 'account', entityId: 'profile', hint: null },
                    { kind: 'session', entityId: sessions[0].id, hint: null },
                    ...(index === 0 ? [
                        { kind: 'account', entityId: 'settings', hint: { keys: ['theme'] } },
                        { kind: 'session', entityId: sessions[1].id, hint: null },
                    ] : []),
                ]));
                const response = await app.inject({ method: 'GET', url: '/v2/changes?after=0&limit=7',
                    headers: { 'x-test-user-id': accountId } });
                expect(response.statusCode).toBe(200);
                const page = ChangesResponseSchema.parse(response.json());
                expect(page.changes.map(change => ({ kind: change.kind, entityId: change.entityId, cursor: change.cursor, hint: change.hint })))
                    .toEqual(committed.changes.map(change => ({ ...change,
                        hint: change.kind === 'session' ? { pendingExecutionRunIds: [] } : change.hint,
                    })));
                expect(page.nextCursor).toBe(expectedSeq);
            }

            const failure = new Error('discard terminal wake and allocation');
            await expect(inTx(async tx => {
                const publications = await markAccountsChanged(tx, { accountIds, entityId: 'rolled-back' });
                return transactionResult(() => {
                    expect(publications.map(publication => publication.resolveCursor()).sort()).toEqual([3, 5]);
                    throw failure;
                });
            })).rejects.toBe(failure);
            expect(emissions).toHaveLength(2);
            expect(await db.accountChange.count({ where: { accountId: { in: accountIds }, entityId: 'rolled-back' } })).toBe(0);

            await inTx(async tx => {
                await markAccountsChanged(tx, { accountIds, entityId: 'next-transaction' });
                await markAccountsChanged(tx, { accountIds, entityId: 'next-transaction-tail' });
            });
            expect(emissions).toHaveLength(4);
            for (const accountId of accountIds) {
                const next = emissions.slice(2).filter(emission => emission.room === `account-stored-content-v3:${accountId}`);
                expect(next).toHaveLength(1);
                const committed = await next[0].committed;
                expect(committed.seq).toBe(accountId === accounts[0].id ? 6 : 4);
                expect(next[0].payload).toEqual(expect.objectContaining({ seq: committed.seq,
                    body: { t: 'account-change', changeKinds: ['account'],
                        entityIds: ['next-transaction', 'next-transaction-tail'] },
                }));
                expect(committed.changes.filter(change => change.entityId.startsWith('next-transaction'))).toHaveLength(2);
            }
        } finally {
            eventRouter.clearIo();
            await Promise.allSettled(emissions.map(emission => emission.committed));
            await app.close();
            await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
        }
    });

    it('overlaps unrelated Session domain writes before either transaction publishes', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessions = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } })));
        const releaseFirst = latch();
        const firstInDomain = latch();
        let firstPid = 0;
        let secondPid = 0;
        let secondInDomain = false;
        let secondSettled = false;
        const first = inTx(async tx => {
            [{ pid: firstPid }] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
            await acquireSessionAccountCursorLocksInTx(tx, [sessions[0].id]);
            await tx.session.update({ where: { id: sessions[0].id }, data: { metadata: '{"writer":1}' } });
            firstInDomain.release();
            // Test-only rendezvous: hold the real first domain transaction open.
            await releaseFirst.promise;
            await markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: sessions[0].id });
        });
        const firstOutcome = Promise.allSettled([first]);
        let secondOutcome: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
            await firstInDomain.promise;
            const second = inTx(async tx => {
                [{ pid: secondPid }] = await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
                await acquireSessionAccountCursorLocksInTx(tx, [sessions[1].id]);
                await tx.session.update({ where: { id: sessions[1].id }, data: { metadata: '{"writer":2}' } });
                secondInDomain = true;
                await markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: sessions[1].id });
            }).finally(() => { secondSettled = true; });
            secondOutcome = Promise.allSettled([second]);
            let blocker: { query: string; blockers: number[] } | undefined;
            while (!secondInDomain && !secondSettled) {
                const [sample] = await db.$queryRawUnsafe<{ query: string; blockers: number[] }[]>(
                    'SELECT query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1::int', secondPid,
                );
                if (sample?.blockers.includes(firstPid)) { blocker = sample; break; }
            }
            console.info('ACCTLOCK_OWN_DOMAIN_OVERLAP', JSON.stringify({ firstPid, secondPid,
                secondInDomain, blockedByFirst: blocker?.blockers.includes(firstPid) ?? false,
                blockedQuery: blocker?.query ?? null }));
            expect(secondInDomain, `Second writer blocked during domain work: ${blocker?.query}`).toBe(true);
        } finally {
            releaseFirst.release();
            for (const result of [...await firstOutcome, ...(await secondOutcome ?? [])]) {
                if (result.status === 'rejected') throw result.reason;
            }
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('delivers every concurrent identity through the real paged HTTP reader without late prefix rows', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.session.createMany({ data: Array.from({ length: 100 }, () => ({
            id: randomUUID(), accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain',
        })) });
        const sessions = await db.session.findMany({ where: { accountId: account.id }, select: { id: true } });
        const app = createAuthenticatedTestApp();
        changesRoutes(app);
        let settled = false;
        let checkpoint = 0;
        const observed = new Set<string>();
        const writers = Promise.allSettled(sessions.map(session => inTx(async tx => {
            await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
            await tx.session.update({ where: { id: session.id }, data: { metadata: '{"written":true}' } });
            await markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id });
        }))).finally(() => { settled = true; });
        try {
            while (true) {
                const settledBeforeRead = settled;
                const response = await app.inject({ method: 'GET', url: `/v2/changes?after=${checkpoint}&limit=7`,
                    headers: { 'x-test-user-id': account.id } });
                expect(response.statusCode).toBe(200);
                const page = ChangesResponseSchema.parse(response.json());
                for (const change of page.changes) {
                    expect(change.cursor).toBeGreaterThan(checkpoint);
                    observed.add(change.entityId);
                }
                const durablePrefix = await db.accountChange.findMany({ where: { accountId: account.id,
                    cursor: { lte: checkpoint } }, select: { entityId: true } });
                // Independent durable census catches a lower cursor committed
                // after a prior HTTP request already checkpointed past it.
                expect(durablePrefix.every(row => observed.has(row.entityId))).toBe(true);
                expect(page.nextCursor).toBeGreaterThanOrEqual(checkpoint);
                checkpoint = page.nextCursor;
                if (settledBeforeRead && page.changes.length === 0) break;
            }
            for (const result of await writers) if (result.status === 'rejected') throw result.reason;
            expect([...observed].sort()).toEqual(sessions.map(session => session.id).sort());
            expect(checkpoint).toBe(100);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(100);
            console.info('ACCTLOCK_OWN_READER_PREFIX', JSON.stringify({ submittedWriters: 100,
                delivered: observed.size, checkpoint, latePrefixRows: 0 }));
        } finally {
            await writers;
            await app.close();
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
