import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { HomeAccountDeleteResultV1Schema } from "@happier-dev/protocol/home/governance";
import { PendingResetStartsReadResultV1Schema } from "@happier-dev/protocol/sessions/pending/pendingRequestedActionV1";
import { SessionListQueryResponseV1Schema } from "@happier-dev/protocol/sessions/listing/response";
import { ACCOUNT_ERASURE_CONFIRMATION_V1, AccountErasureResponseV1Schema } from "@happier-dev/protocol/auth/accountErasure";
import { withAuthenticatedTestApp as withAuthenticatedAppHarness } from "@/app/api/testkit/sqliteFastify";
import type { Fastify } from "@/app/api/types";
import { homeGovernanceRoutes } from "@/app/api/routes/home/homeGovernanceRoutes";
import { registerAccountErasureRoute } from "@/app/api/routes/auth/registerAccountErasureRoute";
import { sessionPendingRoutes } from "@/app/api/routes/session/pendingRoutes";
import { registerSessionFilteredListingRoute } from "@/app/api/routes/session/registerSessionFilteredListingRoute";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

const withAuthenticatedTestApp: (
    register: (app: Fastify) => void,
    run: (app: Fastify) => Promise<void>,
) => Promise<void> = withAuthenticatedAppHarness;

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("foreign Account transaction interference", () => {
    let connected = false;
    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_BASE_DELAY_MS", "0");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_MAX_DELAY_MS", "0");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_JITTER_FACTOR", "0");
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        vi.stubEnv("HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED", "1");
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", "srv_01234567890123456789012345678901");
        initDbPostgres();
        await db.$connect();
        connected = true;
        console.info("FIX91_POSTGRES", JSON.stringify(await db.$queryRaw`
            SELECT version(), current_setting('max_pred_locks_per_transaction') AS per_transaction,
                current_setting('max_pred_locks_per_relation') AS per_relation,
                current_setting('max_pred_locks_per_page') AS per_page
        `));
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        vi.unstubAllEnvs();
    });

    async function fixture(encryptionMode: "plain" | "e2ee" = "plain") {
        const actor = await db.account.create({ data: { encryptionMode: "plain", homeRole: "owner" } });
        const target = await db.account.create({ data: { encryptionMode,
            ...(encryptionMode === "e2ee" ? createSignedAccountContentBinding() : {}) } });
        const foreign = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: actor.id, encryptionMode: "plain", tag: randomUUID(),
            metadata: JSON.stringify({ t: "plain", v: { name: "own Session" } }) } });
        // Use actual small-table statistics, as autovacuum eventually does on
        // a retained database, rather than the fresh-migration estimates.
        await db.$executeRaw`ANALYZE "Account"`;
        return { actor, target, foreign, session };
    }

    /** Interleave at the actual database boundary; all route/domain logic stays real. */
    async function withForeignCommits<T>(input: Readonly<{
        foreignAccountId: string;
        after?: (tx: Tx) => Promise<boolean>;
        run: () => Promise<T>;
    }>) {
        const transaction = db.$transaction.bind(db);
        const measurements: Array<{ isolation: string; readOnly: string; locks: unknown; foreignCommits: number }> = [];
        db.$transaction = new Proxy(transaction, { apply(owner, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(owner, receiver, args);
            return Reflect.apply(owner, receiver, [async (tx: Tx) => {
                const result = await callback(tx);
                if (input.after && !await input.after(tx)) return result;
                const [mode] = await tx.$queryRaw<Array<{ isolation: string; readOnly: string }>>`
                    SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly"
                `;
                const locks = await tx.$queryRaw<Array<{ relation: string; locktype: string; page: number | null; tuple: number | null }>>`
                    SELECT relation::regclass::text AS relation, locktype, page, tuple FROM pg_locks
                    WHERE pid = pg_backend_pid() AND mode = 'SIReadLock'
                `;
                // The foreign transaction reads/writes only its own Account. On a
                // small table PostgreSQL's sequential scan creates relation-level
                // predicates, despite the SQL's exact primary-key condition.
                await transaction(async peer => {
                    await peer.account.findUniqueOrThrow({ where: { id: input.foreignAccountId } });
                    await peer.account.update({ where: { id: input.foreignAccountId }, data: { seq: { increment: 1 } } });
                }, { isolationLevel: "Serializable" });
                measurements.push({ ...mode!, locks: { count: locks.length,
                    account: locks.filter(lock => lock.relation === '"Account"' || lock.relation === '"Account_pkey"') }, foreignCommits: 1 });
                return result;
            }, ...args.slice(1)]);
        } });
        try { return { result: await input.run(), measurements }; }
        finally { db.$transaction = transaction; console.info("FIX91_FOREIGN_COMMITS", JSON.stringify(measurements)); }
    }

    it("keeps reset and listing snapshots readable during foreign Account commits", async () => {
        const f = await fixture();
        const plan = await db.$queryRaw`EXPLAIN (FORMAT JSON) SELECT id FROM "Account" WHERE id = ${f.foreign.id}`;
        console.info("FIX91_ACCOUNT_PLAN", JSON.stringify(plan));
        await withAuthenticatedTestApp(app => { sessionPendingRoutes(app); registerSessionFilteredListingRoute(app); }, async app => {
            const headers = { "x-test-user-id": f.actor.id, "x-happier-account-stored-content-protocol": "4" };
            const calls = await withForeignCommits({ foreignAccountId: f.foreign.id, run: async () => {
                const reset = await app.inject({ method: "POST", url: "/v2/pending/reset-starts/read", headers,
                    payload: { source: { bindingKind: "account", ref: { service: { pluginId: "example.external-agent", localId: "usage" }, accountId: "own-source" } } } });
                expect(reset.statusCode, reset.body).toBe(200);
                expect(PendingResetStartsReadResultV1Schema.parse(reset.json())).toEqual({ entries: [] });
                const listing = await app.inject({ method: "POST", url: "/v2/sessions/query", headers,
                    payload: { v: 1, storage: "active", includeInactive: true, scope: "my_work", attention: "any", audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, limit: 20 } });
                expect(listing.statusCode, listing.body).toBe(200);
                expect(SessionListQueryResponseV1Schema.parse(listing.json()).sessions.map(row => row.id)).toContain(f.session.id);
            } });
            expect(calls.measurements.length).toBeGreaterThan(0);
            expect(calls.measurements.every(row => row.isolation === "repeatable read" && row.readOnly === "on")).toBe(true);
        });
    });

    it.each(["self", "administrator"] as const)("finishes %s erasure despite a foreign Account commit before every final commit", async actor => {
        const f = await fixture();
        await withAuthenticatedTestApp(app => {
            app.decorate("disconnectAccountSockets", () => {});
            homeGovernanceRoutes(app);
            registerAccountErasureRoute(app);
        }, async app => {
            const outcome = await withForeignCommits({ foreignAccountId: f.foreign.id,
                after: async tx => await tx.account.findUnique({ where: { id: f.target.id } }) === null,
                run: () => app.inject({ method: "POST", url: actor === "self" ? "/v1/auth/account/delete" : "/v1/home/accounts/delete",
                    headers: { "x-test-user-id": actor === "self" ? f.target.id : f.actor.id },
                    payload: actor === "self" ? { confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1 } : { accountId: f.target.id } }) });
            if (outcome.result.statusCode === 503) {
                expect(await db.account.findUnique({ where: { id: f.target.id }, select: { status: true } })).toEqual({ status: "disabled" });
            }
            expect(outcome.result.statusCode, outcome.result.body).toBe(200);
            expect((actor === "self" ? AccountErasureResponseV1Schema : HomeAccountDeleteResultV1Schema).parse(outcome.result.json()))
                .toMatchObject({ status: "deleted" });
            expect(await db.account.findUnique({ where: { id: f.target.id } })).toBeNull();
            expect((await db.account.findUniqueOrThrow({ where: { id: f.foreign.id } })).seq).toBe(outcome.measurements.length);
        });
    });

    it("allows the existing administrator path to finish a terminally disabled Account and rejects a misbound actor", async () => {
        const f = await fixture("e2ee");
        expect(await inTx(tx => setAccountStatusInTx(tx, { actorAccountId: f.target.id, targetAccountId: f.target.id,
            status: "disabled", authority: "account_erasure" }), { isolationLevel: "Serializable" })).toMatchObject({ status: "applied" });
        await withAuthenticatedTestApp(homeGovernanceRoutes, async app => {
            const remove = (actorId: string) => app.inject({ method: "POST", url: "/v1/home/accounts/delete",
                headers: { "x-test-user-id": actorId }, payload: { accountId: f.target.id } });
            const denied = await remove(f.foreign.id);
            expect(denied.statusCode).toBe(403);
            expect(await db.account.findUnique({ where: { id: f.target.id }, select: { status: true } })).toEqual({ status: "disabled" });
            const result = await remove(f.actor.id);
            expect(result.statusCode, result.body).toBe(200);
            HomeAccountDeleteResultV1Schema.parse(result.json());
            expect(await db.account.findUnique({ where: { id: f.target.id } })).toBeNull();
        });
    });

    it.each(["self", "administrator"] as const)("finishes %s E2EE erasure while another administrator publishes an Account change before final admission", async actor => {
        const f = await fixture("e2ee");
        await db.account.update({ where: { id: f.foreign.id }, data: { homeRole: "admin" } });
        const transaction = db.$transaction.bind(db);
        let peerCommits = 0;
        db.$transaction = new Proxy(transaction, { apply(owner, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(owner, receiver, args);
            return Reflect.apply(owner, receiver, [async (tx: Tx) => {
                const query = tx.$queryRawUnsafe.bind(tx);
                let published = false;
                return callback(new Proxy(tx, { get(owner, property, proxyReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, proxyReceiver);
                    return async (sql: string, ...values: unknown[]) => {
                        // Final deletion admits every Home administrator exclusively.
                        // Commit the peer after retirement, before that complete fence.
                        if (!published && sql.includes('FROM "Account"') && sql.includes("FOR UPDATE")
                            && (await db.account.findUnique({ where: { id: f.target.id }, select: { status: true } }))?.status === "disabled") {
                            published = true;
                            await inTx(peer => markAccountChanged(peer, {
                                accountId: f.foreign.id, kind: "account", entityId: "self",
                            }), { isolationLevel: "ReadCommitted" });
                            peerCommits += 1;
                        }
                        return query(sql, ...values);
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(app => {
                app.decorate("disconnectAccountSockets", () => {});
                homeGovernanceRoutes(app);
                registerAccountErasureRoute(app);
            }, async app => {
                const result = await app.inject({ method: "POST",
                    url: actor === "self" ? "/v1/auth/account/delete" : "/v1/home/accounts/delete",
                    headers: { "x-test-user-id": actor === "self" ? f.target.id : f.actor.id },
                    payload: actor === "self" ? { confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1 } : { accountId: f.target.id } });
                console.info("FIX99_ERASURE_PEER_COMMITS", JSON.stringify({ actor, peerCommits, status: result.statusCode,
                    targetAccountId: f.target.id, writerAccountId: f.foreign.id }));
                expect(peerCommits).toBeGreaterThan(0);
                expect(result.statusCode, result.body).toBe(200);
                expect((actor === "self" ? AccountErasureResponseV1Schema : HomeAccountDeleteResultV1Schema).parse(result.json()))
                    .toEqual({ status: "deleted" });
                expect(await db.account.findUnique({ where: { id: f.target.id } })).toBeNull();
                expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                    accountId: f.foreign.id, kind: "account", entityId: "self",
                } } })).toMatchObject({ cursor: expect.any(Number) });
            });
        } finally { db.$transaction = transaction; }
    });

    it("retires an ordinary Account without being starved by foreign Account commits", async () => {
        const f = await fixture();
        await withAuthenticatedTestApp(app => {
            app.decorate("disconnectAccountSockets", () => {});
            registerAccountErasureRoute(app);
        }, async app => {
            const outcome = await withForeignCommits({ foreignAccountId: f.foreign.id,
                after: async tx => (await tx.account.findUnique({ where: { id: f.target.id }, select: { status: true } }))?.status === "disabled",
                run: () => app.inject({ method: "POST", url: "/v1/auth/account/delete",
                    headers: { "x-test-user-id": f.target.id }, payload: { confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1 } }) });
            expect(outcome.result.statusCode, outcome.result.body).toBe(200);
            expect(AccountErasureResponseV1Schema.parse(outcome.result.json())).toEqual({ status: "deleted" });
            expect(outcome.measurements.length).toBeGreaterThan(0);
            expect(await db.account.findUnique({ where: { id: f.target.id } })).toBeNull();
        });
    });

    it("keeps a surviving Session's authored grants and removes only the erased recipient's grant", async () => {
        const f = await fixture("e2ee");
        const authored = await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: f.session.id,
            createdByAccountId: f.target.id, accountId: f.foreign.id, accessLevel: "edit" } });
        const received = await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: f.session.id,
            createdByAccountId: f.actor.id, accountId: f.target.id, accessLevel: "view" } });
        await withAuthenticatedTestApp(homeGovernanceRoutes, async app => {
            const result = await app.inject({ method: "POST", url: "/v1/home/accounts/delete",
                headers: { "x-test-user-id": f.actor.id }, payload: { accountId: f.target.id } });
            expect(result.statusCode, result.body).toBe(200);
            expect(HomeAccountDeleteResultV1Schema.parse(result.json())).toEqual({ status: "deleted" });
        });
        expect(await db.sessionGrant.findUnique({ where: { principalKind: 'account', id: authored.id } })).toMatchObject({
            sessionId: f.session.id, accountId: f.foreign.id,
            createdByAccountId: f.actor.id, accessLevel: "edit",
        });
        expect(await db.sessionGrant.findUnique({ where: { principalKind: 'account', id: received.id } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: f.target.id } })).toBeNull();
    });

    it("finishes self erasure when another administrator erases itself after the final governance audience census", async () => {
        const f = await fixture("e2ee");
        await db.account.update({ where: { id: f.foreign.id }, data: { homeRole: "admin" } });
        const transaction = db.$transaction.bind(db);
        let peerDeleted = false;
        let erasePeer!: () => Promise<void>;
        db.$transaction = new Proxy(transaction, { apply(owner, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(owner, receiver, args);
            return Reflect.apply(owner, receiver, [async (tx: Tx) => {
                const account = new Proxy(tx.account, { get(owner, property, delegateReceiver) {
                    const operation = Reflect.get(owner, property, delegateReceiver);
                    if (property !== "findMany") return operation;
                    return async (query: Parameters<typeof tx.account.findMany>[0]) => {
                        const rows = await owner.findMany(query);
                        // Census precedes exclusive admission. An independent
                        // administrator may disappear here, never after its fence.
                        if (!peerDeleted && query?.where?.status === "active" && query.where.homeRole
                            && (await db.account.findUnique({ where: { id: f.target.id }, select: { status: true } }))?.status === "disabled") {
                            peerDeleted = true;
                            await erasePeer();
                        }
                        return rows;
                    };
                } });
                return callback(new Proxy(tx, { get(owner, property, proxyReceiver) {
                    return property === "account" ? account : Reflect.get(owner, property, proxyReceiver);
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(app => {
                app.decorate("disconnectAccountSockets", () => {});
                registerAccountErasureRoute(app);
            }, async app => {
                erasePeer = async () => {
                    const peer = await app.inject({ method: "POST", url: "/v1/auth/account/delete",
                        headers: { "x-test-user-id": f.foreign.id }, payload: { confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1 } });
                    expect(peer.statusCode, peer.body).toBe(200);
                    expect(AccountErasureResponseV1Schema.parse(peer.json())).toEqual({ status: "deleted" });
                };
                const result = await app.inject({ method: "POST", url: "/v1/auth/account/delete",
                    headers: { "x-test-user-id": f.target.id }, payload: { confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1 } });
                console.info("FIX99_ERASURE_REMOVED_VIEWER", JSON.stringify({ peerDeleted, status: result.statusCode,
                    targetAccountId: f.target.id, removedAccountId: f.foreign.id }));
                expect(peerDeleted).toBe(true);
                expect(await db.account.findUnique({ where: { id: f.foreign.id } })).toBeNull();
                expect(result.statusCode, result.body).toBe(200);
                expect(AccountErasureResponseV1Schema.parse(result.json())).toEqual({ status: "deleted" });
                expect(await db.account.findUnique({ where: { id: f.target.id } })).toBeNull();
            });
        } finally { db.$transaction = transaction; }
    });

    it.each(["creator", "recipient"] as const)("finishes after a foreign Session's share %s is erased while its owner removes that share", async erasedRole => {
        const f = await fixture();
        // A retained grant may outlive its creator's own access to the Session.
        const share = await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: f.session.id,
            createdByAccountId: erasedRole === "creator" ? f.target.id : f.actor.id,
            accountId: erasedRole === "creator" ? f.foreign.id : f.target.id, accessLevel: "view" } });
        const transaction = db.$transaction.bind(db);
        let removed = false;
        db.$transaction = new Proxy(transaction, { apply(owner, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(owner, receiver, args);
            return Reflect.apply(owner, receiver, [async (tx: Tx) => {
                const grants = new Proxy(tx.sessionGrant, { get(owner, property, delegateReceiver) {
                    const operation = Reflect.get(owner, property, delegateReceiver);
                    if (property !== "findMany") return operation;
                    return async (query: Parameters<typeof tx.sessionGrant.findMany>[0]) => {
                        const rows = await owner.findMany(query);
                        if (!removed && rows.some(row => row.id === share.id)
                            && query?.select?.session) {
                            removed = true;
                            await db.sessionGrant.delete({ where: { principalKind: 'account', id: share.id } });
                        }
                        return rows;
                    };
                } });
                return callback(new Proxy(tx, { get(owner, property, proxyReceiver) {
                    return property === "sessionGrant" ? grants : Reflect.get(owner, property, proxyReceiver);
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(homeGovernanceRoutes, async app => {
                const result = await app.inject({ method: "POST", url: "/v1/home/accounts/delete",
                    headers: { "x-test-user-id": f.actor.id }, payload: { accountId: f.target.id } });
                expect(removed).toBe(true);
                expect(result.statusCode, result.body).toBe(200);
                expect(HomeAccountDeleteResultV1Schema.parse(result.json())).toEqual({ status: "deleted" });
                expect(await db.account.findUnique({ where: { id: f.target.id } })).toBeNull();
                expect(await db.session.findUnique({ where: { id: f.session.id }, select: { accountId: true } })).toEqual({ accountId: f.actor.id });
            });
        } finally { db.$transaction = transaction; }
    });
});
