import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, createSessionSubagentCustodyKeyV1 } from "@happier-dev/protocol";
import { decodeBase64 } from "privacy-kit";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionCreateOrLoadRoute } from "@/app/api/routes/session/registerSessionCreateOrLoadRoute";
import { registerSessionLookupByTagsRoute } from "@/app/api/routes/session/registerSessionLookupByTagsRoute";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { sourceKeyForSessionFollowSourceV1 } from "@/app/session/follow/sessionFollowSourceIdentity";
import { createSessionHumanPresenceService } from "@/app/session/humanPresence/sessionHumanPresenceService";
import { mutateSessionSubagentCustody } from "@/app/session/subagents/sessionSubagentCustodyService";
import { readSessionSystemRecordV1, upsertSessionSystemRecordV1 } from "@/app/session/systemRecords/sessionSystemRecordService";
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from "@/app/session/systemRecords/sessionSystemRecordProtocolContract";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { db, getDbProviderFromEnv, initDbPostgres, isPrismaErrorCode } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

type QueryBoundary = Readonly<{ model: string; method: string; args: readonly unknown[] }>;

// Observe the genuine Prisma boundary, following the existing SystemRecord
// DB-contract harness. Every delegate call and transaction executes real SQL;
// peers only commit at a named query boundary, never replace domain decisions.
async function observeReadSnapshots<T>(input: Readonly<{
    run: () => Promise<T>;
    relevant: (query: QueryBoundary) => boolean;
    beforeSnapshot?: () => Promise<void>;
    before?: (query: QueryBoundary) => Promise<void>;
    after?: (query: QueryBoundary) => Promise<void>;
    error?: (query: QueryBoundary, error: unknown) => void;
}>): Promise<Readonly<{ result: T; predicateLocks: readonly number[] }>> {
    const originalTransaction = db.$transaction;
    const keeperAccount = await db.account.create({ data: { publicKey: randomUUID() } });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const keeper = inTx(async tx => {
        await tx.account.update({ where: { id: keeperAccount.id }, data: { name: "concurrent writer" } });
        await tx.session.count();
        ready();
        await released;
    }, { isolationLevel: "Serializable" });
    const keeperOutcome = Promise.allSettled([keeper]);
    await Promise.race([started, keeper]);
    const predicateLocks: number[] = [];
    const observedModels = new Set(["session", "automationRun", "sessionFollowEdge", "sessionSystemRecord", "sessionSubagentCustodyReceipt"]);
    let peer = false;
    const atBoundary = async (callback: (() => Promise<void>) | undefined) => {
        if (!callback) return;
        peer = true;
        try { await callback(); } finally { peer = false; }
    };
    db.$transaction = new Proxy(originalTransaction, {
        apply(transaction, receiver, args: unknown[]) {
            const operation: unknown = args[0];
            if (typeof operation !== "function" || peer) return Reflect.apply(transaction, receiver, args);
            return Reflect.apply(transaction, receiver, [async (tx: Tx) => {
                let relevant = false;
                let wrote = false;
                const duringReads: number[] = [];
                const countPredicateLocks = async () => {
                    const [locks] = await tx.$queryRaw<Array<{ count: number }>>`
                        SELECT count(*)::int AS count FROM pg_locks
                        WHERE mode = 'SIReadLock' AND pid = pg_backend_pid()
                        AND virtualtransaction IN (
                            SELECT virtualtransaction FROM pg_locks WHERE pid = pg_backend_pid()
                            AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted
                        )
                    `;
                    return locks.count;
                };
                const observed = new Proxy(tx, {
                    get(client, property, txReceiver) {
                        const delegate: unknown = Reflect.get(client, property, txReceiver);
                        if (typeof property !== "string" || !observedModels.has(property)
                            || delegate === null || typeof delegate !== "object") return delegate;
                        return new Proxy(delegate, {
                            get(owner, method, delegateReceiver) {
                                const call: unknown = Reflect.get(owner, method, delegateReceiver);
                                if (typeof method !== "string" || typeof call !== "function") return call;
                                return (...queryArgs: unknown[]) => {
                                    const query = { model: property, method, args: queryArgs };
                                    relevant ||= input.relevant(query);
                                    wrote ||= /^(create|update|delete|upsert)/u.test(method);
                                    // Prisma queries are lazy. Keep that contract so
                                    // the real statement-budget owner attaches its
                                    // rejection handler before SQL can execute.
                                    let running: Promise<unknown> | undefined;
                                    const execute = () => running ??= (async () => {
                                        await atBoundary(input.before ? () => input.before!(query) : undefined);
                                        try {
                                            const result: unknown = await Reflect.apply(call, owner, queryArgs);
                                            if (input.relevant(query)) duringReads.push(await countPredicateLocks());
                                            await atBoundary(input.after ? () => input.after!(query) : undefined);
                                            return result;
                                        } catch (error) {
                                            input.error?.(query, error);
                                            throw error;
                                        }
                                    })();
                                    return { then: <TResult1 = unknown, TResult2 = never>(
                                        fulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
                                        rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
                                    ) => execute().then(fulfilled, rejected) };
                                };
                            },
                        });
                    },
                });
                const result: unknown = await Reflect.apply(operation, undefined, [observed]);
                if (relevant && !wrote) {
                    predicateLocks.push(...duringReads, await countPredicateLocks());
                }
                return result;
            }, args[1]]);
        },
    });
    try {
        await atBoundary(input.beforeSnapshot);
        return { result: await input.run(), predicateLocks };
    }
    finally {
        db.$transaction = originalTransaction;
        release();
        await keeperOutcome;
        await db.account.delete({ where: { id: keeperAccount.id } });
    }
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session projection and recovery read snapshots", () => {
    let connected = false;
    const authentication = createPresentUserSessionAccessAuthentication();
    beforeAll(async () => {
        const url = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!url || process.env.DATABASE_URL !== url || !process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) {
            throw new Error("Run against the disposable PostgreSQL DB-contract container");
        }
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        initDbPostgres();
        await db.$connect();
        connected = true;
        expect(await initializeSessionSystemRecordsProtocolV1Activation(db)).toBe(true);
    });
    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        if (connected) await db.$disconnect();
        vi.unstubAllEnvs();
    });

    it("keeps tag lookup metadata and owning Account mode coherent without predicate locks", async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "before",
            metadataLayoutVersion: 1, ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }) } });
        const app = createAuthenticatedTestApp();
        registerSessionLookupByTagsRoute(app);
        await app.ready();
        const read = async () => {
            const response = await app.inject({ method: "POST", url: "/v2/sessions/lookup-by-tags",
                headers: { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" }, payload: { tags: [session.tag] } });
            return { status: response.statusCode, body: response.json() as unknown };
        };
        let committed = false;
        try {
            const observed = await observeReadSnapshots({
                run: read,
                relevant: query => query.model === "session" && query.method === "findMany",
                // Establish an unsafe read-only SSI snapshot: the long keeper
                // read this Session before a separate SSI writer committed.
                // Preserve all semantic fixture values while forming that edge.
                beforeSnapshot: () => inTx(async tx => {
                    await tx.session.update({ where: { id: session.id }, data: { metadata: "before" } });
                }, { isolationLevel: "Serializable" }),
                after: async query => {
                    if (committed || query.model !== "session" || query.method !== "findMany") return;
                    committed = true;
                    await inTx(async tx => {
                        await tx.account.update({ where: { id: owner.id }, data: { encryptionMode: "e2ee" } });
                        await tx.session.update({ where: { id: session.id }, data: { metadata: "after",
                            ownerMetadata: JSON.stringify({ t: "encrypted", c: "oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==" }) } });
                    }, { isolationLevel: "Serializable" });
                },
            });
            expect(committed).toBe(true);
            expect(observed.result).toMatchObject({ status: 200, body: { sessions: [{ id: session.id, metadata: "before", ownerMetadata: { t: "plain", v: { v: 1 } } }] } });
            expect(await read()).toMatchObject({ status: 200, body: { sessions: [{ id: session.id, metadata: "after", ownerMetadata: { t: "encrypted" } }] } });
            expect(observed.predicateLocks.length).toBeGreaterThan(0);
            expect(observed.predicateLocks).toEqual(observed.predicateLocks.map(() => 0));
        } finally {
            await app.close();
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it("captures create/rejoin manager relations and report facts coherently without predicate locks", async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const foreignOwner = await db.account.create({ data: { publicKey: randomUUID() } });
        const manager = await db.session.create({ data: { accountId: foreignOwner.id, tag: randomUUID(), metadata: "manager" } });
        const nextManager = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "next-manager" } });
        const report = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "report", archivedAt: null } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: manager.id, createdByAccountId: foreignOwner.id, accountId: owner.id, accessLevel: "view" } });
        await db.sessionFollowEdge.create({ data: { sourceKey: sourceKeyForSessionFollowSourceV1({ kind: "session", sessionId: report.id }),
            sourceSessionId: report.id, managerSourceSessionId: report.id, destinationSessionId: manager.id, relation: "manager", policyJson: JSON.stringify({ preset: "quiet" }) } });
        const app = createAuthenticatedTestApp();
        registerSessionCreateOrLoadRoute(app);
        await app.ready();
        const read = async () => {
            const response = await app.inject({ method: "POST", url: "/v1/sessions", headers: { "x-test-user-id": owner.id },
                payload: { tag: report.tag, metadata: "report" } });
            return { status: response.statusCode, body: response.json() as unknown };
        };
        let projection = false;
        let committed = false;
        try {
            const observed = await observeReadSnapshots({
                run: read,
                relevant: query => query.model === "automationRun" && query.method === "groupBy",
                after: async query => {
                    if (query.model === "automationRun" && query.method === "groupBy") projection = true;
                    if (!projection || committed || query.model !== "sessionFollowEdge" || query.method !== "findMany") return;
                    committed = true;
                    await inTx(async tx => {
                        await tx.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: manager.id } });
                        await tx.sessionFollowEdge.updateMany({ where: { sourceSessionId: report.id, relation: "manager" }, data: { destinationSessionId: nextManager.id } });
                    }, { isolationLevel: "Serializable" });
                },
            });
            expect(committed).toBe(true);
            expect(observed.result).toMatchObject({ status: 200, body: { session: { id: report.id, manager: { sessionId: manager.id } } } });
            expect(await read()).toMatchObject({ status: 200, body: { session: { id: report.id, manager: { sessionId: nextManager.id } } } });
            expect(observed.predicateLocks.length).toBeGreaterThan(0);
            expect(observed.predicateLocks).toEqual(observed.predicateLocks.map(() => 0));
        } finally {
            await app.close();
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: manager.id } });
            await db.session.deleteMany({ where: { id: { in: [manager.id, nextManager.id, report.id] } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, foreignOwner.id] } } });
        }
    });

    it("replaces Session and Discussion presence from one access snapshot without predicate locks", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const other = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const discussion = await db.discussion.create({ data: { ownerAccountId: owner.id, encryptionMode: "plain",
            dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)), creationLocalId: randomUUID(),
            creationEqualityEvidenceV1: {}, createdByAccountId: owner.id, titleContent: { t: "plain", v: { v: 1, title: "Presence" } }, lastMessageAt: new Date() } });
        // Socket registry/room methods are the genuine external transport
        // boundary; admission and room replacement remain the real service.
        const rooms = new Set<string>();
        const socket = { id: randomUUID(), connected: true,
            data: { clientType: "user-scoped", userId: owner.id, authAuthority: "present_user" }, rooms,
            async join(values: string | readonly string[]) { for (const room of typeof values === "string" ? [values] : values) rooms.add(room); },
            async leave(room: string) { rooms.delete(room); },
        } as unknown as Socket;
        const io = { in: () => ({ fetchSockets: async () => [] }), to: () => ({ emit: () => {} }),
            sockets: { sockets: new Map([[socket.id, socket]]) } } as unknown as Server;
        const presence = createSessionHumanPresenceService({ io });
        const read = () => presence.replaceVisible(socket, owner.id, [session.id], [{ discussionId: discussion.id }]);
        let committed = false;
        try {
            const observed = await observeReadSnapshots({
                run: read,
                relevant: query => query.model === "session" && query.method === "findMany",
                after: async query => {
                    if (committed || query.model !== "session" || query.method !== "findMany") return;
                    committed = true;
                    await inTx(async tx => {
                        await tx.session.update({ where: { id: session.id }, data: { accountId: other.id } });
                        await tx.discussion.update({ where: { id: discussion.id }, data: { ownerAccountId: other.id } });
                    }, { isolationLevel: "Serializable" });
                },
            });
            expect(committed).toBe(true);
            expect(observed.result).toMatchObject({ admittedSessionIds: [session.id], admittedLocations: [{ discussionId: discussion.id }] });
            expect(await read()).toMatchObject({ admittedSessionIds: [], admittedLocations: [] });
            expect(observed.predicateLocks.length).toBeGreaterThan(0);
            expect(observed.predicateLocks).toEqual(observed.predicateLocks.map(() => 0));
        } finally {
            presence.close();
            await db.discussion.delete({ where: { id: discussion.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
        }
    });

    it("settles a losing SystemRecord CAS against coherent current content and access without predicate locks", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const actor = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: actor.id, accessLevel: "edit" } });
        const address = { owner: "plugin" as const, namespace: "notes", kind: "entry.v1", localId: "cas-snapshot" };
        const params = { actorUserId: actor.id, sessionId: session.id, pluginId: "acme.notes", address, authentication };
        const created = await upsertSessionSystemRecordV1({ ...params, content: { t: "plain", v: { title: "before" } }, expectedRevision: null });
        if (!created.ok) throw new Error(created.code);
        const row = await db.sessionSystemRecord.findFirstOrThrow({ where: { sessionId: session.id, localId: address.localId } });
        const content = { t: "plain" as const, v: { title: "after" } };
        let lostCas = false;
        let revoked = false;
        try {
            const observed = await observeReadSnapshots({
                run: () => upsertSessionSystemRecordV1({ ...params, content, expectedRevision: created.record.revision }),
                relevant: query => query.model === "sessionSystemRecord" && query.method === "findFirst",
                before: async query => {
                    if (lostCas || query.model !== "sessionSystemRecord" || query.method !== "updateMany") return;
                    lostCas = true;
                    await db.sessionSystemRecord.update({ where: { id: row.id }, data: { content, version: { increment: 1 } } });
                },
                after: async query => {
                    if (!lostCas || revoked || query.model !== "sessionSystemRecord" || query.method !== "findFirst") return;
                    revoked = true;
                    await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id, accountId: actor.id } });
                },
            });
            expect(lostCas && revoked).toBe(true);
            expect(observed.result).toMatchObject({ ok: true, record: { content } });
            expect(observed.result).not.toMatchObject({ record: { revision: created.record.revision } });
            expect(await readSessionSystemRecordV1(params)).toMatchObject({ ok: false });
            expect((await db.sessionSystemRecord.findUniqueOrThrow({ where: { id: row.id } })).content).toEqual(content);
            expect(observed.predicateLocks.length).toBeGreaterThan(0);
            expect(observed.predicateLocks).toEqual(observed.predicateLocks.map(() => 0));
        } finally {
            await db.sessionSystemRecord.deleteMany({ where: { sessionId: session.id } });
            await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, actor.id] } } });
        }
    });

    it("recovers a real custody receipt uniqueness race without predicate locks and rolls back the losing record", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const scope = { pluginId: "acme.agent", contributionId: "assistant",
            sourceCustody: { kind: "managed" as const, immutableGenerationId: randomUUID(), installSource: "npm" as const } };
        const base = { scope, custodyKey: createSessionSubagentCustodyKeyV1({ ...scope, sessionId: session.id }),
            groupId: null, status: "running" as const, content: { t: "encrypted" as const, c: "b3BhcXVlLWNpcGhlcnRleHQ=" },
            contentFingerprint: `hmac-sha256:${"a".repeat(64)}` };
        const mutate = (request: Parameters<typeof mutateSessionSubagentCustody>[0]["request"]) => mutateSessionSubagentCustody({ actorUserId: account.id, sessionId: session.id, authentication, request });
        const initialA = { ...base, subagentId: "winner", operationId: "seed-winner", expectedRevision: null };
        const initialB = { ...base, subagentId: "loser", operationId: "seed-loser", expectedRevision: null };
        expect(await mutate(initialA)).toMatchObject({ ok: true });
        expect(await mutate(initialB)).toMatchObject({ ok: true });
        const oldA = await db.sessionSubagentCustody.findFirstOrThrow({ where: { sessionId: session.id, subagentId: "winner" } });
        const winnerRequest = { ...initialA, operationId: "shared-operation", expectedRevision: 0 };
        expect(await mutate(winnerRequest)).toMatchObject({ ok: true, replayed: false });
        // Capture the winner's exact producer-created receipt and row. Restore
        // only these disposable fixture rows, then let that valid commit win
        // after the losing transaction has read receipt absence.
        const winner = await db.sessionSubagentCustody.findUniqueOrThrow({ where: { id: oldA.id } });
        const receipt = await db.sessionSubagentCustodyReceipt.findFirstOrThrow({ where: { sessionId: session.id, operationId: winnerRequest.operationId } });
        await db.sessionSubagentCustody.update({ where: { id: oldA.id }, data: { revision: oldA.revision, content: oldA.content, updatedAt: oldA.updatedAt } });
        await db.sessionSubagentCustodyReceipt.delete({ where: { id: receipt.id } });
        let committed = false;
        let uniqueConflict = false;
        try {
            const observed = await observeReadSnapshots({
                run: () => mutate({ ...winnerRequest, subagentId: "loser" }),
                relevant: query => query.model === "sessionSubagentCustodyReceipt" && query.method === "findUnique",
                before: async query => {
                    if (committed || query.model !== "sessionSubagentCustodyReceipt" || query.method !== "create") return;
                    committed = true;
                    await db.$transaction(async tx => {
                        await tx.sessionSubagentCustody.update({ where: { id: winner.id }, data: { revision: winner.revision, content: winner.content, updatedAt: winner.updatedAt } });
                        await tx.sessionSubagentCustodyReceipt.create({ data: receipt });
                    });
                },
                error: (query, error) => {
                    if (query.model === "sessionSubagentCustodyReceipt" && query.method === "create" && isPrismaErrorCode(error, "P2002")) uniqueConflict = true;
                },
            });
            expect(committed && uniqueConflict).toBe(true);
            expect(observed.result).toEqual({ ok: false, error: "idempotency-conflict" });
            expect(await db.sessionSubagentCustody.findFirstOrThrow({ where: { sessionId: session.id, subagentId: "loser" } })).toMatchObject({ revision: 0 });
            expect(await db.sessionSubagentCustody.findUniqueOrThrow({ where: { id: winner.id } })).toMatchObject({ revision: 1 });
            expect(observed.predicateLocks.length).toBeGreaterThan(0);
            expect(observed.predicateLocks).toEqual(observed.predicateLocks.map(() => 0));
        } finally {
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
