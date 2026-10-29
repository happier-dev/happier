import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Context } from '@/context';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { acrossAccountCursorCommit } from '@/testkit/postgresAccountCursorContention';
import { eventRouter } from '@/app/events/connectionEventRouter';

import { usernameRelease, usernameUpdate, UsernameTakenError } from './usernameUpdate';

function latch() {
    let resolve!: () => void;
    return { promise: new Promise<void>(release => { resolve = release; }), release: () => resolve() };
}

const provider = getDbProviderFromEnv(process.env, 'postgres');

describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('Username claim contention on a real provider', () => {
    const accountIds: string[] = [];
    const usernames: string[] = [];
    let connected = false;

    beforeAll(async () => {
        const supplied = provider === 'postgres' ? process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            : process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) {
            throw new Error('Use the disposable provider DB-contract harness');
        }
        if (provider === 'postgres') initDbPostgres();
        else await initDbMysql();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (!connected) return;
        await db.releasedUsername.deleteMany({ where: { username: { in: usernames } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        await db.$disconnect();
    });

    function freshUsername() {
        const username = `race_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        usernames.push(username);
        return username;
    }

    async function account(username?: string) {
        const row = await db.account.create({ data: { encryptionMode: 'plain', ...(username ? { username } : {}) } });
        accountIds.push(row.id);
        return row;
    }

    it.skipIf(provider !== 'postgres')('publishes genuine manual changes but performs no content writes or publications for repeated equal names', async () => {
        const username = freshUsername();
        const holder = await account(username);
        const statements: Prisma.QueryEvent[] = [];
        let releaseBarrier: (() => void) | undefined;
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => {
            if (event.query.includes('"username_cost_barrier"')) releaseBarrier?.();
            else statements.push(event);
        });
        const drain = async () => {
            const observed = new Promise<void>(resolve => { releaseBarrier = resolve; });
            try { await Promise.all([client.$queryRaw`SELECT 1 AS "username_cost_barrier"`, observed]); }
            finally { releaseBarrier = undefined; }
        };
        await client.$connect();
        const original = db.$transaction;
        // Only replace the persistent transport; admission, locks and publication remain real.
        db.$transaction = new Proxy(original, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        const emit = vi.spyOn(eventRouter, 'emitUpdate').mockImplementation(() => {});
        try {
            // The same name still changes automatic identity policy on its first manual claim.
            expect(await usernameUpdate(Context.create(holder.id), username)).toBe(username);
            const manual = await db.account.findUniqueOrThrow({ where: { id: holder.id } });
            expect(manual).toMatchObject({ username, usernameAutoFillEnabled: false, seq: holder.seq + 1 });
            expect(emit).toHaveBeenCalled();
            const writes: number[] = [];
            const sequences: number[] = [];
            const publications: number[] = [];
            for (const repetitions of [1, 100]) {
                await drain();
                statements.length = 0;
                emit.mockClear();
                for (let i = 0; i < repetitions; i++) {
                    expect(await usernameUpdate(Context.create(holder.id), ` ${username.toUpperCase()} `)).toBe(username);
                }
                await drain();
                writes.push(statements.filter(event => /^UPDATE\s+"public"\."Account"\s+SET\s+"username"\s*=/.test(event.query.trimStart())).length);
                sequences.push((await db.account.findUniqueOrThrow({ where: { id: holder.id } })).seq);
                publications.push(emit.mock.calls.length);
            }
            console.info('USERNAME_NOOP_CONTENT_WRITES', JSON.stringify({ requests: [1, 100], writes, publications }));
            expect(writes).toEqual([0, 0]);
            expect(sequences).toEqual([manual.seq, manual.seq]);
            expect(publications).toEqual([0, 0]);
            const next = freshUsername();
            expect(await usernameUpdate(Context.create(holder.id), next)).toBe(next);
            const renamed = await db.account.findUniqueOrThrow({ where: { id: holder.id } });
            expect(renamed).toMatchObject({ username: next, usernameAutoFillEnabled: false, seq: manual.seq + 1 });
            expect(await db.accountChange.findMany({ where: { accountId: holder.id }, select: { cursor: true } }))
                .toEqual([{ cursor: renamed.seq }]);
            expect(emit).toHaveBeenCalledWith(expect.objectContaining({ userId: holder.id,
                payload: expect.objectContaining({ body: expect.objectContaining({ username: next }) }) }));
        } finally {
            emit.mockRestore();
            db.$transaction = original;
            await client.$disconnect();
        }
    });

    it.skipIf(provider !== 'postgres')('releases across a cursor commit and preserves the original hold on repeat', async () => {
        const username = freshUsername();
        const holder = await account(username);
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        try {
            const result = await acrossAccountCursorCommit(holder.id, () => usernameRelease(Context.create(holder.id)));
            expect(result).toMatchObject({ username: null, released: true });
            const hold = await db.releasedUsername.findUniqueOrThrow({ where: { username } });
            expect(hold.expiresAt.getTime()).toBe(result.reservedUntilMs);
            expect(await db.account.findUniqueOrThrow({ where: { id: holder.id } }))
                .toMatchObject({ username: null, usernameAutoFillEnabled: false, seq: holder.seq + 2 });
            expect(await usernameRelease(Context.create(holder.id)))
                .toEqual({ username: null, released: false, reservedUntilMs: null });
            expect((await db.releasedUsername.findUniqueOrThrow({ where: { username } })).expiresAt).toEqual(hold.expiresAt);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('acknowledges exactly one simultaneous claim and returns a domain conflict for the other', async () => {
        const username = freshUsername();
        const first = await account();
        const second = await account();
        const outcomes = await Promise.allSettled([
            usernameUpdate(Context.create(first.id), username),
            usernameUpdate(Context.create(second.id), username),
        ]);
        expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
        const failures = outcomes.filter(outcome => outcome.status === 'rejected');
        expect(failures).toHaveLength(1);
        expect(failures[0].reason).toBeInstanceOf(UsernameTakenError);
        const accounts = [first, second];
        const winner = accounts[outcomes.findIndex(outcome => outcome.status === 'fulfilled')];
        const loser = accounts[outcomes.findIndex(outcome => outcome.status === 'rejected')];
        expect(await db.account.findMany({ where: { username }, select: { id: true, usernameAutoFillEnabled: true } }))
            .toEqual([{ id: winner.id, usernameAutoFillEnabled: false }]);
        expect(await db.account.findUniqueOrThrow({ where: { id: loser.id } }))
            .toMatchObject({ username: null, usernameAutoFillEnabled: true });
    });

    it('serializes a release racing a claim and retains the hold through Account deletion', async () => {
        const username = freshUsername();
        const holder = await account(username);
        const claimant = await account();
        const read = latch();
        const resume = latch();
        const releaseEntered = latch();
        const claimantScope = new AsyncLocalStorage<boolean>();
        const original = db.$transaction;
        let paused = false;

        // This OS/database boundary instrumentation preserves the real read,
        // locks, transaction isolation, retry and constraint behavior.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            if (!claimantScope.getStore()) return Reflect.apply(target, receiver, [(tx: Tx) => {
                releaseEntered.release();
                return callback(tx);
            }, ...args.slice(1)]);
            const scheduleThisAttempt = !paused;
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(transaction, property, transactionReceiver) {
                if (property === 'account' && scheduleThisAttempt) {
                    return new Proxy(transaction.account, { get(model, method, modelReceiver) {
                        if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                        return async (...queryArgs: Parameters<typeof model.findUnique>) => {
                            // The hold read and holder lookup may complete on
                            // opposite sides of a concurrent release commit.
                            if (queryArgs[0].where.username === username) await resume.promise;
                            return model.findUnique(...queryArgs);
                        };
                    } });
                }
                if (property !== 'releasedUsername') return Reflect.get(transaction, property, transactionReceiver);
                return new Proxy(transaction.releasedUsername, { get(model, method, modelReceiver) {
                    if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                    return async (...queryArgs: Parameters<typeof model.findUnique>) => {
                        const result = await model.findUnique(...queryArgs);
                        if (!paused) {
                            paused = true;
                            read.release();
                            await resume.promise;
                        }
                        return result;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        const claim = claimantScope.run(true, () => usernameUpdate(Context.create(claimant.id), username));
        const outcome = Promise.allSettled([claim]);
        let releaseOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof usernameRelease>>>[]> | undefined;
        try {
            await Promise.race([read.promise, claim.then(() => { throw new Error('Claim bypassed hold admission'); })]);
            const releasePromise = usernameRelease(Context.create(holder.id));
            releaseOutcome = Promise.allSettled([releasePromise]);
            // MySQL Serializable uses predicate locks for the missing hold;
            // allow the claimant to finish once the competing transaction has
            // entered instead of demanding an impossible intervening commit.
            if (provider === 'mysql') {
                await Promise.race([releaseEntered.promise, releasePromise]);
                resume.release();
            }
            const release = await releasePromise;
            expect(release).toMatchObject({ username: null, released: true });
            expect(release.reservedUntilMs).toEqual(expect.any(Number));
            resume.release();
            await expect(claim).rejects.toBeInstanceOf(UsernameTakenError);
            expect(await db.account.findMany({ where: { username } })).toEqual([]);
            expect(await db.account.findUniqueOrThrow({ where: { id: claimant.id } })).toMatchObject({ username: null });
            const hold = await db.releasedUsername.findUniqueOrThrow({ where: { username } });
            expect(hold.expiresAt.getTime()).toBe(release.reservedUntilMs);
            await expect(usernameUpdate(Context.create(holder.id), username)).rejects.toBeInstanceOf(UsernameTakenError);
            expect(await usernameRelease(Context.create(holder.id))).toEqual({ username: null, released: false, reservedUntilMs: null });
            expect((await db.releasedUsername.findUniqueOrThrow({ where: { username } })).expiresAt).toEqual(hold.expiresAt);
            await db.account.delete({ where: { id: holder.id } });
            expect(await db.releasedUsername.findUniqueOrThrow({ where: { username } })).toEqual(hold);
        } finally {
            resume.release();
            await outcome;
            await releaseOutcome;
            db.$transaction = original;
        }
    });
});
