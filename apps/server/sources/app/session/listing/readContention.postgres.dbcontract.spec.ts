import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from "@happier-dev/protocol";
import { PendingResetStartsReadResultV1Schema } from "@happier-dev/protocol/sessions/pending/pendingRequestedActionV1";
import { SessionListQueryResponseV1Schema } from "@happier-dev/protocol/sessions/listing/response";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createSessionMachineAccessKeyInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { enqueuePendingMessage, updatePendingRequestedAction } from "@/app/session/pending/pendingMessageService";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { sessionPendingRoutes } from "@/app/api/routes/session/pendingRoutes";
import { registerSessionFilteredListingRoute } from "@/app/api/routes/session/registerSessionFilteredListingRoute";

const reset = {
    source: { bindingKind: "account", ref: { service: { pluginId: "happier.agent.codex", localId: "openai" }, accountId: "account" } },
    recordId: "paug_v1_abcdefgh", meterId: "weekly", witness: { id: "accepted-history-entry", observedAtMs: 1000 },
} as const;
const held = { v: 1, kind: "reset_start", reset } as const;
const query = { v: 1, storage: "active", includeInactive: true,
    scope: "my_work", attention: "any", audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, limit: 20 } as const;

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("HTTP read owners under PostgreSQL contention", () => {
    const applicationName = `fix88-read-${randomUUID()}`;
    let originalDatabaseUrl: string | undefined;
    let connected = false;
    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        originalDatabaseUrl = supplied;
        const url = new URL(supplied);
        url.searchParams.set("application_name", applicationName);
        process.env.DATABASE_URL = url.toString();
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        vi.stubEnv("HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED", "1");
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", "srv_01234567890123456789012345678901");
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        vi.unstubAllEnvs();
        if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
    });

    async function fixture() {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            metadata: JSON.stringify({ t: "plain", v: { name: "before" } }), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: "host", platform: "linux", happyCliVersion: "test", homeDir: "/home/test", happyHomeDir: "/home/test/.happier" }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionPendingResetStart: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: account.id, sessionId: session.id,
            machineId: machine.id, data: "key" }))).toMatchObject({ ok: true });
        const localId = randomUUID();
        const params = { actorUserId: account.id, authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id, localId };
        await db.providerAccountUsageRecord.create({ data: { accountId: account.id, recordId: reset.recordId,
            providerId: "openai", accountSubjectId: "account", subjectKind: "account", quotaScope: "account", quotaScopeIdKey: "",
            recordKeyJson: {}, payloadMode: "plain_json_v1", status: "ok",
            history: { create: { id: `${reset.witness.id}-${account.id}`, observedAt: new Date(reset.witness.observedAtMs), payload: {} } } } });
        expect(await enqueuePendingMessage({ ...params, targetMachineId: machine.id, requestedAction: { v: 1, kind: "enqueue" },
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "private pending content" } } } })).toMatchObject({ ok: true });
        expect(await updatePendingRequestedAction({ ...params, requestedAction: held })).toMatchObject({ ok: true });
        return { account, session, machine, localId, close: async () => {
            await db.accessKey.deleteMany({ where: { accountId: account.id, machineId: machine.id, sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        } };
    }

    // Hold the real later-query relation until the read has established its
    // earlier snapshot; no internal spies or production rendezvous hooks.
    async function acrossCommit<T>(table: "Machine" | "SessionPin", change: (tx: Tx) => Promise<unknown>, read: () => Promise<T>) {
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
        });
        const writerOutcome = Promise.allSettled([writer]);
        let reader: Promise<T> | undefined;
        try {
            const writerPid = await Promise.race([started, writer.then(() => { throw new Error("Writer exited before rendezvous"); })]);
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
            if (readerPid === undefined) await reader;
            expect(readerPid).toBeDefined();
            const [activity] = await db.$queryRaw<Array<{ backendXid: string | null; predicateLocks: number }>>`
                SELECT backend_xid::text AS "backendXid", (SELECT count(*)::int FROM pg_locks
                    WHERE pid = ${readerPid!} AND mode = 'SIReadLock'
                    AND virtualtransaction IN (SELECT virtualtransaction FROM pg_locks
                        WHERE pid = ${readerPid!} AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted)) AS "predicateLocks"
                FROM pg_stat_activity WHERE pid = ${readerPid!}
            `;
            release();
            await writer;
            const before = await reader;
            await readerOutcome;
            return { before, after: await read(), activity };
        } finally {
            release();
            await writerOutcome;
            if (reader) await Promise.allSettled([reader]);
        }
    }

    it("keeps reset metadata and installed-target authority coherent across a commit, without SSI locks", async () => {
        const f = await fixture();
        try {
            await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
                const read = async () => {
                    const response = await app.inject({ method: "POST", url: "/v2/pending/reset-starts/read",
                        headers: { "x-test-user-id": f.account.id }, payload: { source: reset.source } });
                    expect(response.statusCode).toBe(200);
                    return PendingResetStartsReadResultV1Schema.parse(response.json());
                };
                const result = await acrossCommit("Machine", async tx => {
                    await tx.machine.update({ where: { id: f.machine.id }, data: { installationId: randomUUID() } });
                    await tx.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: f.session.id, localId: f.localId } },
                        data: { requestedAction: { v: 1, kind: "enqueue" } } });
                }, read);
                expect(result.before).toEqual({ entries: [{ sessionId: f.session.id, localId: f.localId, reset, authorityCurrent: true }] });
                expect(result.after).toEqual({ entries: [], unboundEntries: [{ sessionId: f.session.id, localId: f.localId, authorityCurrent: false }] });
                expect(result.activity).toEqual({ backendXid: null, predicateLocks: 0 });
                expect(JSON.stringify(result)).not.toContain("private pending content");
                const outsider = await db.account.create({ data: { publicKey: randomUUID() } });
                try {
                    const denied = await app.inject({ method: "POST", url: "/v2/pending/reset-starts/read",
                        headers: { "x-test-user-id": outsider.id }, payload: { source: reset.source } });
                    expect(denied.statusCode).toBe(200);
                    expect(PendingResetStartsReadResultV1Schema.parse(denied.json())).toEqual({ entries: [] });
                } finally { await db.account.delete({ where: { id: outsider.id } }); }
            });
        } finally { await f.close(); }
    });

    it("keeps filtered-list metadata coherent through route/storage/schema and fresh admission without SSI locks", async () => {
        const f = await fixture();
        try {
            await withAuthenticatedTestApp(registerSessionFilteredListingRoute, async app => {
                const read = async () => {
                    const response = await app.inject({ method: "POST", url: "/v2/sessions/query",
                        headers: { "x-test-user-id": f.account.id, "x-happier-account-stored-content-protocol": "4" }, payload: query });
                    expect(response.statusCode).toBe(200);
                    return SessionListQueryResponseV1Schema.parse(response.json());
                };
                const result = await acrossCommit("SessionPin", tx => tx.session.update({ where: { id: f.session.id },
                    data: { metadata: JSON.stringify({ t: "plain", v: { name: "after" } }) } }), read);
                expect(result.before.sessions).toMatchObject([{ id: f.session.id, metadata: JSON.stringify({ t: "plain", v: { name: "before" } }) }]);
                expect(result.after.sessions).toMatchObject([{ id: f.session.id, metadata: JSON.stringify({ t: "plain", v: { name: "after" } }) }]);
                expect(result.activity).toEqual({ backendXid: null, predicateLocks: 0 });
                await db.session.update({ where: { id: f.session.id }, data: { archivedAt: new Date() } });
                expect((await read()).sessions).toEqual([]);
            });
        } finally { await f.close(); }
    });
});
