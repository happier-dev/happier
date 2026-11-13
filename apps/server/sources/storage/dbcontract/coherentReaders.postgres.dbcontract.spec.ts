import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAccountHomeDirectory } from "@/app/accountDirectory/accountDirectoryService";
import { resolveCurrentSessionRecipientAccountIds } from "@/app/session/access/sessionRecipients";
import { readCurrentSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { registerAccountProfileRoute } from "@/app/api/routes/account/registerAccountProfileRoute";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { loadSessionViewerProjection } from "@/app/session/personal/projection";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("snapshot-only readers (PostgreSQL)", () => {
    const applicationName = `ovbfix-readers-${randomUUID()}`;
    let originalDatabaseUrl: string | undefined;
    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL harness");
        originalDatabaseUrl = supplied;
        const url = new URL(supplied);
        url.searchParams.set("application_name", applicationName);
        process.env.DATABASE_URL = url.toString();
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        await db.$disconnect();
        if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
    });

    // A real relation lock pauses a later query after the reader's first
    // snapshot has been taken. No production test hook or internal mock.
    async function acrossCommit<T>(table: "AccountHomeDirectoryEntry" | "SessionShare" | "AccountIdentity", change: (tx: Tx) => Promise<unknown>, read: () => Promise<T>) {
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            await tx.$executeRawUnsafe(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
            await change(tx);
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        }, { isolationLevel: "Serializable" });
        const writerOutcome = Promise.allSettled([writer]);
        let reader: Promise<T> | undefined;
        let keeper: Promise<void> | undefined;
        let releaseKeeper!: () => void;
        const keeperReleased = new Promise<void>(resolve => { releaseKeeper = resolve; });
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error("Writer exited before rendezvous"); })]);
            let keeperReady!: () => void;
            const keeperStarted = new Promise<void>(resolve => { keeperReady = resolve; });
            // It must precede the reader's snapshot: a later transaction does
            // not retain a committed read-only reader's SSI predicate locks.
            keeper = inTx(async tx => {
                await tx.account.count();
                keeperReady();
                await keeperReleased;
            }, { isolationLevel: "Serializable" });
            await Promise.race([keeperStarted, keeper]);
            let settled = false;
            reader = read();
            const readerOutcome = Promise.allSettled([reader]).finally(() => { settled = true; });
            let readerPid: number | undefined;
            while (!settled) {
                const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                    AND application_name = ${applicationName} AND ${writerPid} = ANY(pg_blocking_pids(pid))
                `;
                if (blocked[0]) { readerPid = blocked[0].pid; break; }
            }
            expect(readerPid).toBeDefined();
            const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_locks WHERE mode = 'SIReadLock' AND pid = ${readerPid!}
                AND virtualtransaction IN (SELECT virtualtransaction FROM pg_locks
                    WHERE pid = ${readerPid!} AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted)
            `;
            release();
            await writer;
            const before = await reader;
            await readerOutcome;
            const [{ retained }] = await db.$queryRaw<Array<{ retained: number }>>`
                SELECT count(*)::int AS retained FROM pg_locks WHERE mode = 'SIReadLock' AND pid = ${readerPid!}
            `;
            return { before, after: await read(), predicateLocks: count + retained };
        } finally {
            release();
            releaseKeeper();
            await writerOutcome;
            if (keeper) await Promise.allSettled([keeper]);
            if (reader) await Promise.allSettled([reader]);
        }
    }

    it("captures profile name and linked identities together without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), name: "before" } });
        await db.accountIdentity.create({ data: { accountId: account.id, provider: "github", providerUserId: randomUUID(),
            providerLogin: "before", profile: { login: "before" } } });
        try {
            await withAuthenticatedTestApp(registerAccountProfileRoute, async app => {
                const read = async () => {
                    const response = await app.inject({ method: "GET", url: "/v1/account/profile",
                        headers: { "x-test-user-id": account.id } });
                    expect(response.statusCode).toBe(200);
                    return response.json();
                };
                const result = await acrossCommit("AccountIdentity", async tx => {
                    await tx.account.update({ where: { id: account.id }, data: { name: "after" } });
                    await tx.accountIdentity.updateMany({ where: { accountId: account.id }, data: {
                        providerLogin: "after", profile: { login: "after" },
                    } });
                }, read);
                expect(result.before).toMatchObject({ name: "before", linkedProviders: [{ id: "github", login: "before" }] });
                expect(result.after).toMatchObject({ name: "after", linkedProviders: [{ id: "github", login: "after" }] });
                expect(result.predicateLocks).toBe(0);
            });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it("keeps personal projection access coherent and refuses committed suspension without predicate locks", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: viewer.id, accessLevel: "view" } });
        try {
            const result = await acrossCommit("SessionShare", async tx => {
                await tx.account.update({ where: { id: viewer.id }, data: { status: "suspended" } });
                await tx.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id } });
            }, () => loadSessionViewerProjection({ accountId: viewer.id, sessionId: session.id,
                authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] } }));
            expect(result.before).not.toBeNull();
            expect(result.after).toBeNull();
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
        }
    });

    it("keeps preferred Home and directory entries coherent across commit without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), preferredHomeServerIdentityId: "srv_before" } });
        const descriptor = (id: string) => ({ v: 1, homeServerIdentityId: id, canonicalServerUrl: `https://${id}.test`,
            revision: 1, endpoints: [{ kind: "https", url: `https://${id}.test` }] });
        await db.accountHomeDirectoryEntry.create({ data: { accountId: account.id, homeServerIdentityId: "srv_before",
            canonicalServerUrl: "https://srv_before.test", label: "before", connectionDescriptor: descriptor("srv_before") } });
        try {
            const result = await acrossCommit("AccountHomeDirectoryEntry", async tx => {
                await tx.account.update({ where: { id: account.id }, data: { preferredHomeServerIdentityId: "srv_after" } });
                await tx.accountHomeDirectoryEntry.deleteMany({ where: { accountId: account.id } });
                await tx.accountHomeDirectoryEntry.create({ data: { accountId: account.id, homeServerIdentityId: "srv_after",
                    canonicalServerUrl: "https://srv_after.test", label: "after", connectionDescriptor: descriptor("srv_after") } });
            }, () => listAccountHomeDirectory(account.id));
            expect(result.before).toMatchObject({ preferredHomeServerIdentityId: "srv_before", homes: [{ homeServerIdentityId: "srv_before", preferred: true }] });
            expect(result.after).toMatchObject({ preferredHomeServerIdentityId: "srv_after", homes: [{ homeServerIdentityId: "srv_after", preferred: true }] });
            expect(result.predicateLocks).toBe(0);
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });

    it("captures a coherent recipient census across publication and grant revocation without predicate locks", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}",
            encryptionMode: "plain", currentStorageState: "hosted" } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: recipient.id, accessLevel: "view" } });
        try {
            const result = await acrossCommit("SessionShare", async tx => {
                await tx.session.update({ where: { id: session.id }, data: { currentStorageState: "direct" } });
                await tx.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id } });
            }, () => resolveCurrentSessionRecipientAccountIds({ sessionId: session.id }));
            expect(result.before).toEqual([owner.id, recipient.id].sort());
            expect(result.after).toEqual([owner.id]);
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });

    it("readmits with a fresh coherent access snapshot and refuses committed revocation without predicate locks", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}",
            encryptionMode: "plain", currentStorageState: "hosted" } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: recipient.id, accessLevel: "view" } });
        try {
            const result = await acrossCommit("SessionShare", async tx => {
                await tx.session.update({ where: { id: session.id }, data: { currentStorageState: "direct" } });
                await tx.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id } });
            }, () => readCurrentSessionAccessForOperation({ accountId: recipient.id, sessionId: session.id,
                authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] }, capability: "readTranscript" }));
            expect(result.before).toMatchObject({ status: "allowed", access: { level: "view" } });
            expect(result.after).toEqual({ status: "unavailable" });
            expect(result.predicateLocks).toBe(0);
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });
});
