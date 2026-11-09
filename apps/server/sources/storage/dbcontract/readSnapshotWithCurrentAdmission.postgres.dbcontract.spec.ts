import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from "@happier-dev/protocol";

import { readArtifactForCallerInTx } from "@/app/artifacts/artifactAccessService";
import { readHomeConfigEnv } from "@/app/home/settings/homeSettings";
import { readPluginAccountStorage } from "@/app/kv/pluginAccountStorage";
import { createPluginAvailabilityOperations } from "@/app/plugins/availability/operations";
import { buildPluginAccountStoragePhysicalKey, encodeAccountScopedKvJson } from "@/app/kv/accountScopedKv";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { createDiscussion } from "@/app/discussions/mutations";
import { listDiscussions } from "@/app/discussions/queries";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";

async function predicateLocks(pid: number): Promise<number> {
    const [row] = await db.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_locks WHERE mode = 'SIReadLock' AND pid = ${pid}
        AND virtualtransaction IN (
            SELECT virtualtransaction FROM pg_locks
            WHERE pid = ${pid} AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted
        )
    `;
    return row.count;
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL coherent read owners", () => {
    let connected = false;
    let originalDatabaseUrl: string | undefined;
    const applicationName = `serialaudit-coherent-${randomUUID()}`;
    beforeAll(async () => {
        const suppliedDatabaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!suppliedDatabaseUrl || process.env.DATABASE_URL !== suppliedDatabaseUrl) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        originalDatabaseUrl = suppliedDatabaseUrl;
        // Identify this file's real database clients: other concurrent suites
        // can also block on the test writer's singleton Home policy relation.
        const databaseUrl = new URL(suppliedDatabaseUrl);
        databaseUrl.searchParams.set("application_name", applicationName);
        process.env.DATABASE_URL = databaseUrl.toString();
        initDbPostgres();
        await db.$connect();
        connected = true;
        expect(await db.$queryRaw`SELECT current_setting('application_name') AS name`).toEqual([{ name: applicationName }]);
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
    });

    it.each([false, true])("captures coherent pre/post-commit data without predicate locks (materialize=%s)", async materialize => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const started = new Promise<void>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            await tx.account.update({ where: { id: account.id }, data: { seq: 1 } });
            await tx.session.update({ where: { id: session.id }, data: { seq: 1 } });
            ready();
            await released;
        }, { isolationLevel: "Serializable" });
        const writerOutcome = Promise.allSettled([writer]);
        const pair = async (tx: Tx) => [
            (await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq,
            (await tx.session.findUniqueOrThrow({ where: { id: session.id }, select: { seq: true } })).seq,
        ];
        const locks: number[] = [];
        try {
            await Promise.race([started, writer]);
            const capture = async (tx: Tx) => {
                const [{ pid, readOnly }] = await tx.$queryRaw<Array<{ pid: number; readOnly: string }>>`
                    SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS "readOnly"
                `;
                expect(readOnly).toBe("on");
                const before = await pair(tx);
                expect(before).toEqual([0, 0]);
                locks.push(await predicateLocks(pid));
                if (!materialize) {
                    release();
                    await writer;
                }
                expect(await pair(tx)).toEqual(before);
                return before;
            };
            const read = materialize ? { capture, materialize: async (captured: number[]) => {
                release();
                await writer;
                return captured;
            } } : capture;
            expect(await captureReadSnapshot(read)).toEqual([0, 0]);
            expect(await captureReadSnapshot(pair)).toEqual([1, 1]);
            expect(locks).toEqual([0]);
        } finally {
            release();
            await writerOutcome;
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("captures Home settings and policy across a writer commit without predicate locks", async () => {
        // Singleton fixtures are safe only in this explicitly disposable database.
        await db.homeSettings.upsert({ where: { id: "home" },
            create: { id: "home", values: { HAPPIER_HOME_DISPLAY_NAME: "before" } },
            update: { values: { HAPPIER_HOME_DISPLAY_NAME: "before" } } });
        await db.homeGovernancePolicy.upsert({ where: { id: "home" },
            create: { id: "home", authenticationPolicy: { v: 1, anonymousSignup: false } },
            update: { authenticationPolicy: { v: 1, anonymousSignup: false } } });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            // Hold only the policy relation: the reader captures settings, then waits
            // at its policy SELECT until this transaction commits both changes.
            await tx.$executeRaw`LOCK TABLE "HomeGovernancePolicy" IN ACCESS EXCLUSIVE MODE`;
            await tx.homeSettings.update({ where: { id: "home" }, data: { values: { HAPPIER_HOME_DISPLAY_NAME: "after" } } });
            await tx.homeGovernancePolicy.update({ where: { id: "home" }, data: { authenticationPolicy: { v: 1, anonymousSignup: true } } });
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        }, { isolationLevel: "Serializable" });
        const writerOutcome = Promise.allSettled([writer]);
        let reader: ReturnType<typeof readHomeConfigEnv> | undefined;
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error("Writer exited before rendezvous"); })]);
            let settled = false;
            reader = readHomeConfigEnv({});
            const readerOutcome = Promise.allSettled([reader]).finally(() => { settled = true; });
            let readerPid: number | undefined;
            while (!settled) {
                const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                    AND application_name = ${applicationName}
                    AND ${writerPid} = ANY(pg_blocking_pids(pid))
                `;
                if (blocked[0]) { readerPid = blocked[0].pid; break; }
            }
            expect(readerPid).toBeDefined();
            // Predicate locks can outlive a pooled backend's earlier transaction.
            const locks = await predicateLocks(readerPid!);
            release();
            await writer;
            const before = await reader;
            await readerOutcome;
            expect(before).toMatchObject({ HAPPIER_HOME_DISPLAY_NAME: "before", AUTH_ANONYMOUS_SIGNUP_ENABLED: "false" });
            expect(await readHomeConfigEnv({})).toMatchObject({ HAPPIER_HOME_DISPLAY_NAME: "after", AUTH_ANONYMOUS_SIGNUP_ENABLED: "true" });
            expect(locks).toBe(0);
        } finally {
            release();
            await writerOutcome;
            if (reader) await Promise.allSettled([reader]);
            await db.homeSettings.delete({ where: { id: "home" } });
            await db.homeGovernancePolicy.delete({ where: { id: "home" } });
        }
    });

    it("finishes an admitted Artifact read after revoke and refuses the next request", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const artifact = await db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: "private" })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: recipient.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        const input = { artifactId: artifact.id, actorAccountId: recipient.id };
        let admissions = 0;
        try {
            const result = await captureReadSnapshot({
                capture: async tx => {
                    admissions += 1;
                    return readArtifactForCallerInTx(tx, input);
                },
                materialize: async captured => {
                    expect(captured).toMatchObject({ ok: true, artifact: { access: "view" } });
                    await db.artifactAccountGrant.deleteMany({ where: { artifactId: artifact.id, accountId: recipient.id } });
                    return captured;
                },
            });
            expect(result).toMatchObject({ ok: true, artifact: { access: "view" } });
            expect(admissions).toBe(1);
            expect(await inTx(tx => readArtifactForCallerInTx(tx, input), { readOnly: true }))
                .toEqual({ ok: false, error: "artifact_not_found" });
            expect(await inTx(tx => readArtifactForCallerInTx(tx, { ...input, actorAccountId: owner.id }), { readOnly: true }))
                .toMatchObject({ ok: true, artifact: { access: "owner" } });
        } finally {
            await db.artifact.delete({ where: { id: artifact.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
        }
    });

    it("captures Discussion title and latest-message content across a commit without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const title = (value: string) => ({ t: "plain" as const, v: { v: 1 as const, title: value } });
        const content = (value: string) => ({ t: "plain" as const, v: { v: 1 as const, parts: [{ t: "text" as const, text: value }] } });
        const created = await createDiscussion({ actorAccountId: account.id, authentication, request: {
            creationLocalId: randomUUID(), titleContent: title("before"),
            firstMessage: { localId: randomUUID(), content: content("before"), mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            // Listing captures the Discussion row before its latest-message query.
            // Block the latter until both title and message changes commit.
            await tx.$executeRaw`LOCK TABLE "DiscussionMessage" IN ACCESS EXCLUSIVE MODE`;
            await tx.discussion.update({ where: { id: discussionId }, data: { titleContent: title("after") } });
            await tx.discussionMessage.updateMany({ where: { discussionId }, data: { content: content("after") } });
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        }, { isolationLevel: "Serializable" });
        const writerOutcome = Promise.allSettled([writer]);
        let reader: ReturnType<typeof listDiscussions> | undefined;
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error("Writer exited before rendezvous"); })]);
            let settled = false;
            reader = listDiscussions({ actorAccountId: account.id, authentication });
            const readerOutcome = Promise.allSettled([reader]).finally(() => { settled = true; });
            let readerPid: number | undefined;
            while (!settled) {
                const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                    AND application_name = ${applicationName}
                    AND ${writerPid} = ANY(pg_blocking_pids(pid))
                `;
                if (blocked[0]) { readerPid = blocked[0].pid; break; }
            }
            expect(readerPid).toBeDefined();
            const locks = await predicateLocks(readerPid!);
            release();
            await writer;
            const before = await reader;
            await readerOutcome;
            expect(before).toMatchObject({ ok: true, value: { discussions: [{
                id: discussionId, titleContent: title("before"), latestMessage: { content: content("before") },
            }] } });
            expect(await listDiscussions({ actorAccountId: account.id, authentication })).toMatchObject({
                ok: true, value: { discussions: [{ id: discussionId, titleContent: title("after"), latestMessage: { content: content("after") } }] },
            });
            expect(locks).toBe(0);
        } finally {
            release();
            await writerOutcome;
            if (reader) await Promise.allSettled([reader]);
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("captures the Availability cursor and current intent coherently without predicate locks", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const pluginId = "example.snapshot";
        const intent = await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId,
            enabled: true, writableCollections: [] } });
        const service = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }) });
        const input = { accountId: account.id, input: { pluginId } };
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            // The Account SELECT establishes the snapshot before the intent
            // SELECT can proceed. Commit both changed facts while it waits.
            await tx.$executeRaw`LOCK TABLE "AccountPluginIntent" IN ACCESS EXCLUSIVE MODE`;
            await tx.account.update({ where: { id: account.id }, data: { seq: 1 } });
            await tx.accountPluginIntent.update({ where: { id: intent.id }, data: { enabled: false } });
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        }, { isolationLevel: "Serializable" });
        const writerOutcome = Promise.allSettled([writer]);
        let reader: ReturnType<typeof service.readIntent> | undefined;
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error("Writer exited before rendezvous"); })]);
            let settled = false;
            reader = service.readIntent(input);
            const readerOutcome = Promise.allSettled([reader]).finally(() => { settled = true; });
            let readerPid: number | undefined;
            while (!settled) {
                const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                    AND application_name = ${applicationName}
                    AND ${writerPid} = ANY(pg_blocking_pids(pid))
                `;
                if (blocked[0]) { readerPid = blocked[0].pid; break; }
            }
            expect(readerPid).toBeDefined();
            const locks = await predicateLocks(readerPid!);
            release();
            await writer;
            expect(await reader).toMatchObject({ availabilityCursor: 0, intent: { enabled: true } });
            await readerOutcome;
            expect(await service.readIntent(input)).toMatchObject({ availabilityCursor: 1, intent: { enabled: false } });
            expect(locks).toBe(0);
        } finally {
            release();
            await writerOutcome;
            if (reader) await Promise.allSettled([reader]);
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("captures the Account mode and plugin row coherently without predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const input = { accountId: account.id, pluginId: "example.snapshot" };
        const key = buildPluginAccountStoragePhysicalKey(input.pluginId);
        const before = { t: "plain", v: { v: 1, values: { phase: { version: 0, value: "before" } } } } as const;
        const after = { t: "plain", v: { v: 1, values: { phase: { version: 1, value: "after" } } } } as const;
        const beforeValue = encodeAccountScopedKvJson(before);
        const afterValue = encodeAccountScopedKvJson(after);
        if (beforeValue === null || afterValue === null) throw new Error("Snapshot fixtures must contain an envelope");
        await db.userKVStore.create({ data: { accountId: account.id, key, value: privacyKit.decodeBase64(beforeValue), version: 0 } });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        const writer = inTx(async tx => {
            // The real reader captures Account mode before selecting the row.
            // Hold that second relation until a new version has committed.
            await tx.$executeRaw`LOCK TABLE "UserKVStore" IN ACCESS EXCLUSIVE MODE`;
            await tx.userKVStore.update({ where: { accountId_key: { accountId: account.id, key } },
                data: { value: privacyKit.decodeBase64(afterValue), version: 1 } });
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            ready(pid);
            await released;
        }, { isolationLevel: "Serializable" });
        const writerOutcome = Promise.allSettled([writer]);
        let reader: ReturnType<typeof readPluginAccountStorage> | undefined;
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error("Writer exited before rendezvous"); })]);
            let settled = false;
            reader = readPluginAccountStorage(input);
            const readerOutcome = Promise.allSettled([reader]).finally(() => { settled = true; });
            let readerPid: number | undefined;
            while (!settled) {
                const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                    SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                    AND application_name = ${applicationName}
                    AND ${writerPid} = ANY(pg_blocking_pids(pid))
                `;
                if (blocked[0]) { readerPid = blocked[0].pid; break; }
            }
            expect(readerPid).toBeDefined();
            const locks = await predicateLocks(readerPid!);
            release();
            await writer;
            expect(await reader).toEqual({ status: "present", revision: 0, envelope: before });
            await readerOutcome;
            expect(await readPluginAccountStorage(input)).toEqual({ status: "present", revision: 1, envelope: after });
            expect(locks).toBe(0);
        } finally {
            release();
            await writerOutcome;
            if (reader) await Promise.allSettled([reader]);
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
