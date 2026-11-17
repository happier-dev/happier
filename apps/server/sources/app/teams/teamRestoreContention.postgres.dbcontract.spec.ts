import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { HOME_GOVERNANCE_POLICY_ID } from '@/app/home/governance/governancePolicy';
import { initEncrypt } from '@/modules/encrypt';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx, readPostgresTransactionSqlState, type Tx } from '@/storage/inTx';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { restoreTeamInTx } from './lifecycle';
import { registerTeamRoutes } from './registerTeamRoutes';
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from '@/storage/prisma';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Team restore busy Account admission (PostgreSQL)', () => {
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let observer: PrismaClientType;
    let transaction: typeof db.$transaction;
    let connected = false;
    const previousEnv = new Map<string, string | undefined>();
    const accounts: string[] = [];
    const teams: string[] = [];
    const queries: Array<{ statement: string; duration: number }> = [];

    beforeAll(async () => {
        const url = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!url || process.env.DATABASE_URL !== url) throw new Error('Use the disposable PostgreSQL DB-contract harness');
        for (const [key, value] of Object.entries({
            HANDY_MASTER_SECRET: 'team-restore-disposable', HAPPIER_FEATURE_TEAMS__ENABLED: '1',
            HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test', HAPPIER_DB_CONNECTION_LIMIT: '10',
        })) {
            previousEnv.set(key, process.env[key]);
            process.env[key] = value;
        }
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        transaction = db.$transaction;
        connected = true;
        await db.homeGovernancePolicy.upsert({ where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy: 'self_service' },
            update: { teamCreationPolicy: 'self_service' } });
        // Count actual SQL at the genuine Prisma transport, without retaining
        // parameters or replacing any route, admission, or domain decision.
        const observed = await createDbMaintenanceClient('postgres', url, { log: [{ emit: 'event', level: 'query' }] });
        onDbClientQuery(observed, event => { queries.push({ statement: event.query, duration: event.duration }); });
        observer = observed;
        db.$transaction = observer.$transaction.bind(observer);
        app = createAuthenticatedTestApp();
        registerTeamRoutes(app);
        await app.ready();
    });

    afterAll(async () => {
        if (connected) db.$transaction = transaction;
        if (app) await app.close();
        if (observer) await observer.$disconnect();
        if (connected) {
            await db.session.deleteMany({ where: { accountId: { in: accounts } } });
            await db.machine.deleteMany({ where: { accountId: { in: accounts } } });
            await db.team.deleteMany({ where: { id: { in: teams } } });
            await db.account.deleteMany({ where: { id: { in: accounts } } });
            await shutdownDbClient();
        }
        for (const [key, value] of previousEnv) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    async function fixture(populated = false) {
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        accounts.push(actor.id);
        const team = await db.team.create({ data: { name: 'Restore contention', archivedAt: new Date() } });
        teams.push(team.id);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'owner' } });
        if (populated) {
            await db.machine.createMany({ data: Array.from({ length: 100 }, () => ({
                id: randomUUID(), accountId: actor.id, metadata: '{}', kind: 'persistent',
            })) });
            await db.session.createMany({ data: Array.from({ length: 1400 }, () => ({
                accountId: actor.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted',
            })) });
        }
        const post = (operation: 'restore' | 'archive' = 'restore') => app.inject({ method: 'POST',
            url: `/v1/teams/${operation}`, headers: { 'x-test-user-id': actor.id }, payload: { v: 1, teamId: team.id } });
        return { actor, team, post };
    }

    function measured() {
        const locks = queries.filter(row => /FOR (?:KEY SHARE|NO KEY UPDATE|UPDATE)/u.test(row.statement));
        return { sqlStatements: queries.length,
            selects: queries.filter(row => /^SELECT/iu.test(row.statement)).length,
            locks: locks.map(row => ({ relation: /FROM "(Account|Team|Session|Machine)"/u.exec(row.statement)?.[1] ?? 'other',
                mode: /FOR (KEY SHARE|NO KEY UPDATE|UPDATE)/u.exec(row.statement)?.[1], durationMs: row.duration })) };
    }

    it('does constant SQL work for unrelated actor inventory and preserves restore/archive semantics', async () => {
        const counts: number[] = [];
        for (const populated of [false, true]) {
            const input = await fixture(populated);
            queries.length = 0;
            const response = await input.post();
            expect(response.statusCode, response.body).toBe(200);
            expect((await db.team.findUniqueOrThrow({ where: { id: input.team.id } })).archivedAt).toBeNull();
            const measurement = measured();
            // SET LOCAL refresh count depends on elapsed time; only semantic
            // reads express the inventory-size cost contract.
            counts.push(measurement.selects);
            console.info('TEAM_RESTORE_SQL', JSON.stringify({ populated, ...measurement }));
            const archived = await input.post('archive');
            expect(archived.statusCode, archived.body).toBe(200);
            expect((await db.team.findUniqueOrThrow({ where: { id: input.team.id } })).archivedAt).not.toBeNull();
        }
        expect(counts[1]).toBe(counts[0]);
    });

    it.each(['KEY SHARE', 'NO KEY UPDATE'] as const)('waits before Team locking for a busy actor holding %s, then commits after release', async mode => {
        const input = await fixture(true);
        const ready = deferred<number>();
        const release = deferred<void>();
        const root = transaction(async tx => {
            const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            await tx.$queryRawUnsafe(`SELECT "id" FROM "Account" WHERE "id" = $1 FOR ${mode}`, input.actor.id);
            if (mode === 'NO KEY UPDATE') await tx.account.update({ where: { id: input.actor.id }, data: { seq: { increment: 1 } } });
            ready.resolve(pid);
            await release.promise;
        }, { timeout: 60_000 }); // Existing DB-contract test lifecycle, not a product budget.
        const rootOutcome = Promise.allSettled([root]);
        let request: ReturnType<typeof input.post> | undefined;
        try {
            const rootPid = await Promise.race([ready.promise, root.then(() => { throw new Error('Holder missed rendezvous'); })]);
            queries.length = 0;
            let finished = false;
            request = input.post().finally(() => { finished = true; });
            let blocked: Array<{ account_entry: boolean; holder_age_ms: number }> = [];
            while (!finished && blocked.length === 0) {
                blocked = await db.$queryRawUnsafe<Array<{ account_entry: boolean; holder_age_ms: number }>>(
                    `SELECT w.query ~ 'Account.*FOR UPDATE' AS account_entry,
                        EXTRACT(EPOCH FROM (clock_timestamp() - h.xact_start))::float8 * 1000 AS holder_age_ms
                    FROM pg_stat_activity w JOIN pg_stat_activity h ON h.pid = $1::int
                    WHERE w.datname = current_database() AND $1::int = ANY(pg_blocking_pids(w.pid))`, rootPid);
            }
            expect(blocked).toHaveLength(1);
            expect(blocked[0].account_entry).toBe(true);
            // A governance waiter must not hold the Team while an earlier
            // content writer can still own resources needed by its effects.
            await transaction(async tx => {
                await tx.$queryRawUnsafe('SELECT "id" FROM "Team" WHERE "id" = $1 FOR UPDATE NOWAIT', input.team.id);
            });
            release.resolve();
            const response = await request;
            expect(response.statusCode, response.body).toBe(200);
            expect((await db.team.findUniqueOrThrow({ where: { id: input.team.id } })).archivedAt).toBeNull();
            console.info('TEAM_RESTORE_BUSY_ACTOR', JSON.stringify({ mode, ...blocked[0], ...measured() }));
        } finally {
            release.resolve();
            await rootOutcome;
            await request;
        }
    });

    it('settles a restore at the transaction deadline while an earlier content admission remains held', async () => {
        const input = await fixture(true);
        const ready = deferred<number>();
        const release = deferred<void>();
        const root = transaction(async tx => {
            const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE', input.actor.id);
            ready.resolve(pid);
            await release.promise;
        }, { timeout: 60_000 });
        const rootOutcome = Promise.allSettled([root]);
        try {
            const pid = await Promise.race([ready.promise, root.then(() => { throw new Error('Holder missed rendezvous'); })]);
            queries.length = 0;
            const started = performance.now();
            const response = await input.post();
            const elapsedMs = performance.now() - started;
            expect(response.statusCode).toBe(503);
            expect(response.json()).toMatchObject({ error: 'database_transaction_timeout' });
            expect((await db.team.findUniqueOrThrow({ where: { id: input.team.id } })).archivedAt).not.toBeNull();
            const [holder] = await db.$queryRawUnsafe<Array<{ age_ms: number }>>(
                'SELECT EXTRACT(EPOCH FROM (clock_timestamp() - xact_start))::float8 * 1000 AS age_ms FROM pg_stat_activity WHERE pid = $1', pid);
            console.info('TEAM_RESTORE_DEADLINE', JSON.stringify({ elapsedMs, holderAgeMs: holder.age_ms,
                error: response.json().error, ...measured() }));
        } finally {
            release.resolve();
            await rootOutcome;
        }
    });

    it.each(['UPDATE', 'NO KEY UPDATE', 'SHARE', 'KEY SHARE'] as const)('exercises Session deletion against %s governance admission', async mode => {
        const input = await fixture();
        const session = await db.session.create({ data: { accountId: input.actor.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted', active: false,
            grants: { create: { principalKind: 'team', teamId: input.team.id, accessLevel: 'view', effectiveAt: new Date() } } } });
        const scope = new AsyncLocalStorage<'delete' | 'restore'>();
        const deletionReady = deferred<number>();
        const releaseDeletion = deferred<void>();
        const original = db.$transaction;
        const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        let paused = false;
        let restoreFinished = false;
        // The alternative changes only SQL sent to real disposable Postgres.
        // This is a constructed lock-mode experiment, not a shipped second path.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const run = args[0];
            if (typeof run !== 'function') return Reflect.apply(target, receiver, args);
            const role = scope.getStore();
            return Reflect.apply(target, receiver, [async (tx: Tx) => run(new Proxy(tx, {
                get(owner, property, ownerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(owner, property, ownerReceiver);
                    return (sql: string, ...values: unknown[]) => {
                        const execute = async () => {
                            const sent = role === 'restore' && /FROM "Account".*FOR UPDATE$/u.test(sql)
                                ? sql.replace(/FOR UPDATE$/u, `FOR ${mode}`) : sql;
                            const result = await owner.$queryRawUnsafe(sent, ...values);
                            if (role === 'delete' && !paused && /FROM "Session".*FOR NO KEY UPDATE$/u.test(sql)) {
                                paused = true;
                                const [{ pid }] = await owner.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
                                deletionReady.resolve(pid);
                                await releaseDeletion.promise;
                            }
                            return result;
                        };
                        // Prisma queries are lazy. Preserve that boundary so the
                        // transaction budget installs its rejection handler and
                        // statement timeout before the deadlock-producing SQL.
                        let pending: Promise<unknown> | undefined;
                        const query: PromiseLike<unknown> = {
                            then(resolve, reject) { return (pending ??= execute()).then(resolve, reject); },
                        };
                        return query;
                    };
                },
            })), ...args.slice(1)]);
        } });
        const deletion = scope.run('delete', () => deleteOwnedSession({ sessionId: session.id,
            ownerAccountId: input.actor.id, reason: 'user_request' }));
        const deletionOutcome = Promise.allSettled([deletion]);
        let restoration: ReturnType<typeof restoreTeamInTx> | undefined;
        let restoreOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof restoreTeamInTx>>>[]> | undefined;
        try {
            const holderPid = await Promise.race([deletionReady.promise,
                deletion.then(() => { throw new Error('Session deletion missed its resource rendezvous'); })]);
            restoration = scope.run('restore', () => inTx(tx => restoreTeamInTx(tx, {
                teamId: input.team.id, actorAccountId: input.actor.id,
            }), { isolationLevel: 'ReadCommitted', transactionClass: 'teams.restore' }));
            restoreOutcome = Promise.allSettled([restoration.finally(() => { restoreFinished = true; })]);
            let blocked: Array<{ account_entry: boolean; session_entry: boolean }> = [];
            while (!restoreFinished && blocked.length === 0) {
                blocked = await db.$queryRawUnsafe<Array<{ account_entry: boolean; session_entry: boolean }>>(
                    `SELECT query ~ 'Account.*FOR UPDATE' AS account_entry,
                        query ~ 'Session.*FOR NO KEY UPDATE' AS session_entry FROM pg_stat_activity
                    WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))`, holderPid);
            }
            expect(blocked).toHaveLength(1);
            expect(blocked[0]).toEqual({ account_entry: mode === 'UPDATE', session_entry: mode !== 'UPDATE' });
            releaseDeletion.resolve();
            const outcomes = [...await deletionOutcome, ...await restoreOutcome];
            const failures = outcomes.filter(outcome => outcome.status === 'rejected');
            const states = failures.map(outcome => readPostgresTransactionSqlState(
                outcome.reason instanceof Error && 'cause' in outcome.reason ? outcome.reason.cause : outcome.reason));
            console.info('TEAM_RESTORE_DELETE_RACE', JSON.stringify({ mode, failures: failures.length, sqlStates: states }));
            if (mode === 'UPDATE' || mode === 'KEY SHARE') {
                expect(failures).toEqual([]);
                expect(await deletion).toEqual({ ok: true });
                expect(await restoration).toMatchObject({ ok: true });
                expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
                expect((await db.team.findUniqueOrThrow({ where: { id: input.team.id } })).archivedAt).toBeNull();
            } else {
                expect(states).toContain('40P01');
            }
        } finally {
            releaseDeletion.resolve();
            await deletionOutcome;
            await restoreOutcome;
            db.$transaction = original;
            if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
        }
    });
});
