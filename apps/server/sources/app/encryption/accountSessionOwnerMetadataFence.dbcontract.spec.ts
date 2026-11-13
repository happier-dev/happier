import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import { randomUUID } from "node:crypto";

import {
    db,
    initDbMysql,
    initDbPostgres,
} from "@/storage/db";
import { inTx, readPostgresTransactionSqlState } from "@/storage/inTx";
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    acquireAccountSessionOwnerMetadataFencesInTx,
} from "./accountSessionOwnerMetadataFence";
import { acquireAccountChangePublicationLocksInTx, markAccountChanged, markAccountsChanged } from "@/app/changes/markAccountChanged";
import { readTeamChangePublicationAudienceInTx, TEAM_CHANGE_ENTITY_ID } from '@/app/teams/teamChanges';
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createDiscussion } from '@/app/discussions/mutations';
import { acquireDiscussionMutationAccountsInTx } from '@/app/discussions/access';
import { setDiscussionGrantInTx } from '@/app/discussions/accessService';
import { markDiscussionReadersChangedInTx } from '@/app/discussions/changes';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';

function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const raw = (
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres"
    ).toString().trim().toLowerCase();
    if (raw === "postgresql" || raw === "postgres") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql (or HAPPY_DB_PROVIDER=postgres|mysql)`,
    );
}

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

const provider = resolveContractProviderFromEnv();
const publicKeyPrefix = "dbcontract-account-session-owner-fence-";

describe("Account Session owner-metadata fence database contract", () => {
    let dbConnected = false;
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;

    beforeAll(async () => {
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        if (!process.env.DATABASE_URL) {
            throw new Error(
                "Missing DATABASE_URL (required for db contract tests).",
            );
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        const accounts = await db.account.findMany({
            where: { publicKey: { startsWith: publicKeyPrefix } }, select: { id: true },
        });
        const accountIds = accounts.map(account => account.id);
        await db.accountChange.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.account.deleteMany({
            where: { publicKey: { startsWith: publicKeyPrefix } },
        });
    });

    afterAll(async () => {
        if (dbConnected) {
            await db.$disconnect();
        }
        if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
    });

    it(`admits the complete sorted existing audience on ${provider}`, async () => {
        const accounts = await Promise.all([0, 1].map(() => db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` }, select: { id: true },
        })));
        const ids = accounts.map(account => account.id).sort();
        await expect(inTx(tx => acquireAccountSessionOwnerMetadataFencesInTx(
            tx, [ids[1], "missing-account", ids[0], ids[1]], "content",
        ))).resolves.toEqual(ids);
    });

    it.skipIf(provider !== "postgres")("serializes aggregate writers while admitting unrelated content", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        await inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "serializing");
            // NOWAIT is a test-only conflict probe, not a production deadline.
            await expect(db.$transaction(peer => peer.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE NOWAIT', account.id,
            ))).resolves.toEqual([{ id: account.id }]);
            for (const mode of ["NO KEY UPDATE", "UPDATE"]) {
                await expect(db.$transaction(peer => peer.$queryRawUnsafe(
                    `SELECT "id" FROM "Account" WHERE "id" = $1 FOR ${mode} NOWAIT`, account.id,
                ))).rejects.toMatchObject({ meta: { code: "55P03" } });
            }
        });
    });

    it.skipIf(provider !== "postgres").each([
        ["content", "serializing"], ["serializing", "exclusive"],
    ] as const)("replays %s to %s instead of upgrading after domain work", async (entry, stronger) => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        await expect(inTx(async tx => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, entry);
            await tx.account.update({ where: { id: account.id }, data: { settingsVersion: 99 } });
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, stronger);
        })).rejects.toMatchObject({ code: "database_transaction_conflict_exhausted",
            cause: { reason: "transaction-account-audience-changed" } });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(0);
    });

    it.skipIf(provider !== "postgres")("publishes admitted Session writers while an exclusive lifecycle transition waits", async () => {
        const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        const account = await db.account.create({ data: {
            publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
        } });
        const sessions = await Promise.all(["first", "second"].map(tag => db.session.create({
            data: { accountId: account.id, tag, metadata: "{}", responsibleAccountId: account.id }, select: { id: true },
        })));
        const firstEntered = deferred();
        const secondStarted = deferred();
        const releaseWriters = deferred();
        const lifecycleStarted = deferred();
        const writerPids: number[] = [];
        let secondEntered = false;
        let lifecyclePid = 0;
        let lifecycle: Promise<unknown> | undefined;
        const writer = (index: number) => inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            writerPids[index] = backend.pid;
            if (index === 1) secondStarted.resolve();
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
            expect((await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { status: true } })).status).toBe("active");
            await tx.session.update({ where: { id: sessions[index].id }, data: { metadata: JSON.stringify({ writer: index }) } });
            if (index === 0) firstEntered.resolve();
            else secondEntered = true;
            await releaseWriters.promise;
            await markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: sessions[index].id });
        });
        const firstOutcome = Promise.allSettled([writer(0)]);
        await firstEntered.promise;
        const secondOutcome = Promise.allSettled([writer(1)]);
        try {
            await secondStarted.promise;
            while (!secondEntered) {
                const [observation] = await db.$queryRawUnsafe<Array<{ blockers: number[] }>>(
                    'SELECT pg_blocking_pids($1::int) AS blockers', writerPids[1],
                );
                if (observation.blockers.length > 0) break;
            }
            expect(secondEntered).toBe(true);

            lifecycle = inTx(async tx => {
                const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
                lifecyclePid = backend.pid;
                lifecycleStarted.resolve();
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
                expect((await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq).toBe(2);
                expect(await setAccountStatusInTx(tx, {
                    actorAccountId: account.id, targetAccountId: account.id,
                    status: "suspended", authority: "account_erasure",
                })).toEqual({ status: "applied" });
            });
            const lifecycleOutcome = Promise.allSettled([lifecycle]);
            await lifecycleStarted.promise;
            let blockers: number[] = [];
            while (blockers.length === 0) {
                const [observation] = await db.$queryRawUnsafe<Array<{ blockers: number[] }>>(
                    'SELECT pg_blocking_pids($1::int) AS blockers', lifecyclePid,
                );
                blockers = observation.blockers;
            }
            expect(blockers.some(pid => writerPids.includes(pid))).toBe(true);
            releaseWriters.resolve();
            for (const outcome of [...await firstOutcome, ...await secondOutcome, ...await lifecycleOutcome]) {
                if (outcome.status === "rejected") throw outcome.reason;
            }
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { status: true } }))
                .toEqual({ status: "suspended" });
            expect(await db.session.findMany({
                where: { id: { in: sessions.map(session => session.id) } },
                select: { responsibleAccountId: true },
            })).toEqual([{ responsibleAccountId: null }, { responsibleAccountId: null }]);
        } finally {
            releaseWriters.resolve();
            await Promise.allSettled([firstOutcome, secondOutcome, ...(lifecycle ? [lifecycle] : [])]);
            if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
        }
    });

    it(`serializes concurrent Account fences on ${provider}`, async () => {
        const initialUpdatedAt = new Date("2020-01-02T03:04:05.000Z");
        const account = await db.account.create({
            data: {
                publicKey: `${publicKeyPrefix}${randomUUID()}`,
                settingsVersion: 7,
                updatedAt: initialUpdatedAt,
            },
            select: { id: true },
        });
        const firstAcquired = deferred();
        const releaseFirst = deferred();
        let secondAcquired = false;
        let firstFenceQueries = 0;

        const first = inTx(async (tx) => {
            // Observe the real SQL boundary; admission and publication stay real.
            const observed = new Proxy(tx, {
                get(target, property) {
                    if (property === "$queryRawUnsafe") return (sql: string, ...values: unknown[]) => {
                        if (/FOR (?:KEY SHARE|UPDATE)/u.test(sql)) firstFenceQueries += 1;
                        return target.$queryRawUnsafe(sql, ...values);
                    };
                    return Reflect.get(target, property, target);
                },
            });
            await acquireAccountSessionOwnerMetadataFenceInTx(observed, account.id, "exclusive");
            // Nested owners request an already-held admission. None should add
            // another SQL/control round trip while the Account is held.
            await acquireAccountSessionOwnerMetadataFenceInTx(observed, account.id, "content");
            await acquireAccountSessionOwnerMetadataFenceInTx(observed, account.id, "exclusive");
            firstAcquired.resolve();
            await releaseFirst.promise;
        });
        await firstAcquired.promise;

        const second = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
            secondAcquired = true;
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(secondAcquired).toBe(false);
        } finally {
            releaseFirst.resolve();
        }

        await first;
        await second;
        expect(firstFenceQueries).toBe(1);
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: {
                settingsVersion: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            settingsVersion: 7,
            updatedAt: initialUpdatedAt,
        });
    });

    it.skipIf(provider !== "postgres")("rejects a shared stability fence followed by concurrent cursor allocation", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const bothShared = deferred();
        let acquired = 0;
        const publish = (entityId: string) => inTx(async tx => {
            // Experimental alternative, deliberately outside the production owner:
            // both writers can enter, but both subsequently need Account.seq.
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR SHARE', account.id);
            if (++acquired === 2) bothShared.resolve();
            await bothShared.promise;
            return markAccountChanged(tx, { accountId: account.id, kind: "account", entityId });
        });
        const outcomes = await Promise.allSettled([publish("shared-first"), publish("shared-second")]);
        const rejected = outcomes.filter(outcome => outcome.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatchObject({
            code: "database_transaction_conflict_exhausted", cause: { meta: { code: "40P01" } },
        });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
            .toEqual({ seq: 1 });
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(1);
    });

    it.skipIf(provider !== "postgres")("does not mistake a key-share lock for non-key Account mode stability", async () => {
        const account = await db.account.create({ data: {
            publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "e2ee",
        } });
        const locked = deferred();
        const release = deferred();
        const holder = db.$transaction(async tx => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE', account.id);
            locked.resolve();
            await release.promise;
        });
        const holderOutcome = Promise.allSettled([holder]);
        try {
            await Promise.race([locked.promise, holder.then(() => { throw new Error("Key-share holder ended before acquisition"); })]);
            // Fail immediately if blocked; this is a lock-conflict probe, not a
            // production deadline. The real transition updates these non-key columns.
            await expect(db.$transaction(async tx => {
                await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', account.id);
                await tx.account.update({ where: { id: account.id }, data: { encryptionMode: "plain" } });
            })).resolves.toBeUndefined();
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { encryptionMode: true } }))
                .toEqual({ encryptionMode: "plain" });
            await expect(db.$transaction(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', account.id,
            ))).rejects.toMatchObject({ meta: { code: "55P03" } });
        } finally {
            release.resolve();
            for (const outcome of await holderOutcome) if (outcome.status === "rejected") throw outcome.reason;
        }
    });

    it.skipIf(provider !== "postgres")("cannot acquire the existing exclusive metadata owner after concurrent key-share entry", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const bothShared = deferred();
        let acquired = 0;
        const write = () => inTx(async tx => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE', account.id);
            if (++acquired === 2) bothShared.resolve();
            await bothShared.promise;
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
        });
        const outcomes = await Promise.allSettled([write(), write()]);
        const rejected = outcomes.filter(outcome => outcome.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatchObject({
            code: "database_transaction_conflict_exhausted", cause: { meta: { code: "40P01" } },
        });
    });

    it.skipIf(provider !== "postgres")("requires exclusive entry for a username unique-key assignment", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        let pending: Promise<unknown> | undefined;
        let assigned = false;
        try {
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                pending = db.account.update({ where: { id: account.id }, data: { username: `key-${randomUUID()}` } })
                    .then(() => { assigned = true; });
                void pending.catch(() => undefined);
                let blocked = false;
                while (!assigned && !blocked) {
                    [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                }
                expect(blocked, "PostgreSQL implicitly locks a changed unique key against KEY SHARE").toBe(true);
                expect(assigned).toBe(false);
            });
        } finally { await pending; }
        expect(assigned).toBe(true);
    });

    it.skipIf(provider !== 'postgres')('admits a projection-only lower recipient before an exclusive lifecycle entry', async () => {
        const fixtureId = randomUUID();
        const recipient = await db.account.create({ data: {
            id: `a-${fixtureId}`, publicKey: `${publicKeyPrefix}${fixtureId}-recipient`, homeRole: 'admin',
        } });
        const actor = await db.account.create({ data: {
            id: `z-${fixtureId}`, publicKey: `${publicKeyPrefix}${fixtureId}-actor`,
        } });
        const team = await db.team.create({ data: { name: `publication-cycle-${fixtureId}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'owner' } });
        const entered = deferred();
        const release = deferred();
        const lifecycleStarted = deferred();
        let writerPid = 0;
        let lifecyclePid = 0;
        let lifecycleFinished = false;
        const writerOutcome = Promise.allSettled([inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            writerPid = backend.pid;
            const admissionAccountIds = await readTeamChangePublicationAudienceInTx(tx, { teamIds: [team.id] });
            await acquireAccountChangePublicationLocksInTx(tx, admissionAccountIds, { includeSingleAccount: true });
            entered.resolve();
            await release.promise;
            const accountIds = await readTeamChangePublicationAudienceInTx(tx, { teamIds: [team.id] });
            await markAccountsChanged(tx, { accountIds, entityId: TEAM_CHANGE_ENTITY_ID });
        })]);
        let lifecycleOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
            await Promise.race([entered.promise, writerOutcome.then(() => { throw new Error('Writer did not enter'); })]);
            lifecycleOutcome = Promise.allSettled([inTx(async tx => {
                const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
                lifecyclePid = backend.pid;
                lifecycleStarted.resolve();
                await acquireAccountChangePublicationLocksInTx(tx, [recipient.id, actor.id], { intent: 'exclusive' });
            }).finally(() => { lifecycleFinished = true; })]);
            await lifecycleStarted.promise;
            let blockers: number[] = [];
            while (!lifecycleFinished && blockers.length === 0) {
                const [observation] = await db.$queryRawUnsafe<Array<{ blockers: number[] }>>(
                    'SELECT pg_blocking_pids($1::int) AS blockers', lifecyclePid,
                );
                blockers = observation.blockers;
            }
            expect(blockers).toContain(writerPid);
            release.resolve();
            const outcomes = [...await writerOutcome, ...await lifecycleOutcome];
            const failures = outcomes.flatMap(outcome => {
                if (outcome.status === 'fulfilled') return [];
                const error: unknown = outcome.reason;
                const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : error;
                return [{ sqlState: readPostgresTransactionSqlState(cause) }];
            });
            console.info('account-projection-entry-cycle', { writerPid, lifecyclePid, blockers, failures });
            expect(failures).toEqual([]);
        } finally {
            release.resolve();
            await writerOutcome;
            if (lifecycleOutcome) await lifecycleOutcome;
            await db.team.delete({ where: { id: team.id } });
        }
    });

    it.skipIf(provider !== 'postgres')('replays an expanded Discussion publication audience before terminal Account locking', async () => {
        const owner = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, recipient.id);
        const authentication = createPresentUserSessionAccessAuthentication();
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: {
            creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Stable audience' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'First' }] } }, mentionedAccountIds: [] },
        } });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const discussionId = created.value.discussion.id;
        let grantCommitted = false;
        // A grant shares the Discussion parent lock. Expand after the audience
        // census but before that lock; expansion after domain entry is excluded.
        const writerOutcome = Promise.allSettled([inTx(async tx => {
            const observed = new Proxy(tx, {
                get(target, property) {
                    if (property === "$queryRawUnsafe") return async (sql: string, ...values: unknown[]) => {
                        if (!grantCommitted && sql.includes('FROM "Discussion"') && sql.includes("FOR NO KEY UPDATE")) {
                            await inTx(async peer => {
                                const result = await setDiscussionGrantInTx(peer, { actorAccountId: owner.id, authentication, discussionId,
                                    request: { principal: { kind: "account", accountId: recipient.id }, accessLevel: "view" } });
                                expect(result.ok).toBe(true);
                            });
                            grantCommitted = true;
                        }
                        return target.$queryRawUnsafe(sql, ...values);
                    };
                    return Reflect.get(target, property, target);
                },
            });
            await acquireDiscussionMutationAccountsInTx(observed, { actorAccountId: owner.id, discussionId });
            await tx.discussion.update({ where: { id: discussionId }, data: {
                titleContent: { t: 'plain', v: { v: 1, title: 'Must roll back' } },
            } });
            await markDiscussionReadersChangedInTx({ tx, discussionId });
        })]);
        expect(await writerOutcome).toMatchObject([{ status: 'rejected', reason: {
            code: 'database_transaction_conflict_exhausted', cause: { reason: 'transaction-account-audience-changed' },
        } }]);
        expect(grantCommitted).toBe(true);
        expect(await db.discussion.findUniqueOrThrow({ where: { id: discussionId }, select: { titleContent: true } }))
            .toEqual({ titleContent: { t: 'plain', v: { v: 1, title: 'Stable audience' } } });
        const beforeReplay = await db.account.findUniqueOrThrow({ where: { id: recipient.id }, select: { seq: true } });
        await inTx(async tx => {
            await acquireDiscussionMutationAccountsInTx(tx, { actorAccountId: owner.id, discussionId });
            await markDiscussionReadersChangedInTx({ tx, discussionId });
        });
        expect(await db.account.findUniqueOrThrow({ where: { id: recipient.id }, select: { seq: true } }))
            .toEqual({ seq: beforeReplay.seq + 1 });
        expect(await db.discussionGrant.count({ where: { principalKind: 'account', discussionId, accountId: recipient.id } })).toBe(1);
    });
});
