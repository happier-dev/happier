import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { encodePlainMachineStoredContent } from "@happier-dev/protocol/machines/machineStoredContent";
import { decodeBase64 } from "privacy-kit";

import { auth } from "@/app/auth/auth";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerAccountEncryptionRoutes } from "@/app/api/routes/account/registerAccountEncryptionRoutes";
import { changesRoutes } from "@/app/api/routes/changes/changesRoutes";
import { pluginDataRoutes } from "@/app/api/routes/plugins/data/pluginDataRoutes";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
import { registerSessionFollowSourceRoutes } from "@/app/api/routes/session/registerSessionFollowSourceRoutes";
import { materializePluginCollectionContractsFromManifestTx, preparePluginCollectionWritableContractsTx } from "@/app/plugins/data/collections/contracts";
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { readCurrentSessionInputMachineTargetInTx } from "@/app/session/messages/sessionInputAdmission";
import { SESSION_LIST_PAGE_MAX_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1 } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("authenticated hot-read SQL costs", () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, "query">;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let originalTransaction: typeof db.$transaction;
    let originalAccountRead: typeof db.account.findUnique;
    let accountId: string;
    let token: string;
    let sessionId: string;
    let machineId: string;
    let installationId: string;
    let ref: Awaited<ReturnType<typeof materializePluginCollectionContractsFromManifestTx>>[number];
    let resolveQueryBarrier: (() => void) | undefined;

    async function drainQueryEvents() {
        const observed = new Promise<void>(resolve => { resolveQueryBarrier = resolve; });
        try {
            // Prisma can deliver engine events after the query promise. Wait
            // for this client's ordered event stream as well as its SQL result.
            await Promise.all([client.$queryRaw`SELECT 1 AS "hot_read_cost_barrier"`, observed]);
        } finally { resolveQueryBarrier = undefined; }
    }

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("HANDY_MASTER_SECRET", "hot-read-disposable-fixture");
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", "srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        vi.stubEnv("HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED", "true");
        initDbPostgres();
        await db.$connect();
        await auth.init();
        accountId = (await db.account.create({ data: { encryptionMode: "plain" } })).id;
        token = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
        sessionId = (await db.session.create({ data: {
            accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: false,
        } })).id;
        machineId = randomUUID();
        installationId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, installationId,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), metadata: encodePlainMachineStoredContent({}),
        } });
        await db.accessKey.create({ data: { accountId, sessionId, machineId, data: "opaque" } });
        const target = await inTx(tx => readCurrentSessionInputMachineTargetInTx(tx, { accountId, sessionId, machineId }));
        expect(target).toBeDefined();
        await db.session.update({ where: { id: sessionId }, data: { runtimeMachineTarget: target } });
        const refs = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: {
            schemaVersion: 2, id: "example.hot-read", version: "1.0.0", displayName: "Hot read fixture",
            engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 },
            contributes: { accountCollections: [{ id: "rows", schemaVersion: 1, rowIdField: "id",
                schema: { type: "object", properties: { id: { type: "string", maxLength: 256 },
                    status: { type: "string", maxLength: 32 } },
                    required: ["id", "status"], additionalProperties: false }, serverReadable: ["status"],
                indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }], uiQueries: [],
            }] },
        } }));
        ref = refs[0]!;
        await inTx(tx => preparePluginCollectionWritableContractsTx({ tx, accountId, pluginId: ref.pluginId,
            contracts: [ref] }));
        await db.accountPluginIntent.create({ data: { accountId, pluginId: ref.pluginId,
            desiredVersion: null, enabled: true, offlineUiHosting: "disabled", writableCollections: [ref], revision: 1,
        } });
        client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        client.$on("query", event => {
            if (event.query.includes('"hot_read_cost_barrier"')) resolveQueryBarrier?.();
            else statements.push(event);
        });
        await client.$connect();
        // Rebind only the real database transport, including Collection's final
        // root-client mode read. All authentication/admission/SQL stays real.
        originalTransaction = db.$transaction;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        originalAccountRead = db.account.findUnique;
        Object.defineProperty(db.account, "findUnique", { configurable: true, writable: true,
            value: client.account.findUnique.bind(client.account) });
        app = createAuthenticatedTestApp({ authentication: "real" });
        registerAccountEncryptionRoutes(app);
        changesRoutes(app);
        pluginDataRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionFollowSourceRoutes(app);
        await app.ready();
    });

    afterAll(async () => {
        await app?.close();
        if (originalTransaction) db.$transaction = originalTransaction;
        if (originalAccountRead) Object.defineProperty(db.account, "findUnique", {
            configurable: true, writable: true, value: originalAccountRead,
        });
        await client?.$disconnect();
        await shutdownDbClient();
        vi.unstubAllEnvs();
    });

    it("counts real statements at authenticated hot-read owners while retaining fresh revocation", async () => {
        const headers = { authorization: `Bearer ${token}`, "x-happier-account-stored-content-protocol": "4" };
        const requests = [
            { name: "currentness", method: "GET" as const, url: "/v1/account/encryption/currentness" },
            { name: "changes", method: "GET" as const, url: "/v2/changes?after=0" },
            { name: "collection-get", method: "POST" as const, url: "/v1/plugins/data/get",
                payload: { pluginId: ref.pluginId, collectionId: ref.collectionId, readerContext: ref, rowId: "missing" } },
            { name: "collection-query", method: "POST" as const, url: "/v1/plugins/data/query",
                payload: { pluginId: ref.pluginId, collectionId: ref.collectionId, readerContext: ref,
                    indexId: "by-status", prefix: ["open"], order: "asc", limit: 50 } },
            { name: "session-detail", method: "GET" as const, url: `/v2/sessions/${sessionId}` },
            { name: "session-query", method: "POST" as const, url: "/v2/sessions/query", payload: {
                v: 1, storage: "active", includeInactive: true, scope: "all_accessible", attention: "any",
                audiences: [], tagIds: [], limit: 50, includeAttention: false,
            } },
            { name: "inactive-follow", method: "POST" as const, url: `/v2/sessions/${sessionId}/follows/inactive-observations`,
                payload: { v: 1, machineId, installationId } },
        ];
        const measurements: Array<{ name: string; transactions: number; statements: number; selects: number;
            models: Record<string, number>; commands: Record<string, number>; repeatedSelects: number;
            repeatedReadsInTransaction: number }> = [];
        for (const request of requests) {
            // Exclude one-time engine initialization, not authentication work.
            const warm = await app.inject({ ...request, headers });
            expect(warm.statusCode, `${request.name}: ${warm.body}`).toBe(200);
            await drainQueryEvents();
            statements.length = 0;
            const response = await app.inject({ ...request, headers });
            expect(response.statusCode, response.body).toBe(200);
            await drainQueryEvents();
            if (request.name === "inactive-follow") expect(response.json()).toMatchObject({ ok: true });
            const selects = statements.filter(({ query }) => /^\s*SELECT\b/i.test(query));
            const models: Record<string, number> = {};
            const identities = new Set<string>();
            let repeatedSelects = 0;
            for (const { query, params } of selects) {
                const model = query.match(/\bFROM\s+(?:"public"\.)?"([^"]+)"/i)?.[1] ?? "raw";
                models[model] = (models[model] ?? 0) + 1;
                const identity = JSON.stringify([query, params]);
                if (identities.has(identity)) repeatedSelects += 1;
                identities.add(identity);
            }
            const commands: Record<string, number> = {};
            const readsByTransaction = new Set<string>();
            let transaction = 0;
            let activeTransaction = 0;
            let repeatedReadsInTransaction = 0;
            for (const { query, params } of statements) {
                const command = query.match(/^\s*(\w+)/)?.[1]?.toUpperCase() ?? "other";
                commands[command] = (commands[command] ?? 0) + 1;
                if (command === "BEGIN") activeTransaction = ++transaction;
                if (command === "COMMIT" || command === "ROLLBACK") activeTransaction = 0;
                if (command !== "SELECT" && command !== "WITH") continue;
                const identity = JSON.stringify([activeTransaction, query, params]);
                if (readsByTransaction.has(identity)) repeatedReadsInTransaction += 1;
                readsByTransaction.add(identity);
            }
            expect(commands.BEGIN, request.name).toBe(commands.COMMIT);
            // Credential currentness at authentication, then mode and cursor inside
            // the snapshot that reads the rows they describe.
            if (request.name.startsWith("collection-")) expect(models.Account, request.name).toBe(2);
            // Persist only counts/model names, never SQL parameters or content.
            measurements.push({ name: request.name, statements: statements.length,
                transactions: statements.filter(({ query }) => /^BEGIN\b/.test(query)).length,
                selects: selects.length, models, commands, repeatedSelects, repeatedReadsInTransaction,
            });
        }
        console.info("HOT_READ_SQL_COSTS", JSON.stringify(measurements));
        // Requests emitting no gated diagnostics log do not read Home settings
        // (Coordination ruling, 2026-11-04 11:21 UTC).
        expect(measurements.find(row => row.name === "changes")!.transactions).toBe(2);
        for (const measurement of measurements) {
            // Changes deliberately rereads its retention floor under READ
            // COMMITTED. The race below proves that this fresh phase must stay.
            // Other repeated SELECTs cross transaction/disclosure boundaries.
            expect(measurement.repeatedReadsInTransaction, measurement.name)
                .toBe(measurement.name === "changes" ? 1 : 0);
        }
        await drainQueryEvents();
        statements.length = 0;
        expect(await auth.verifyToken(token)).toMatchObject({ userId: accountId });
        await drainQueryEvents();
        const authenticationReads = statements.filter(({ query }) => /^SELECT\b/.test(query));
        expect(authenticationReads).toHaveLength(1);
        expect(authenticationReads[0]!.query).toContain('"Account"');
        // Quiet reads must not hide real data changes at either sibling reader.
        const put = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate", headers, payload: {
            pluginId: ref.pluginId, collectionId: ref.collectionId,
            writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
            operations: [{ kind: "put", rowId: "missing", expectedRevision: "absent", expectedAbsenceEpoch: 0,
                content: { t: "plain", v: {} }, projection: { status: "open" } }],
        } });
        expect(put.statusCode, put.body).toBe(200);
        const getRequest = requests.find(row => row.name === "collection-get")!;
        expect((await app.inject({ ...getRequest, headers })).json()).toMatchObject({
            row: { rowId: "missing", revision: 1, projection: { status: "open" } },
        });
        const queryRequest = requests.find(row => row.name === "collection-query")!;
        expect((await app.inject({ ...queryRequest, headers })).json()).toMatchObject({
            rows: [{ rowId: "missing", revision: 1, projection: { status: "open" } }],
        });
        const changed = await db.session.update({ where: { id: sessionId }, data: {
            metadata: JSON.stringify({ changed: true }), metadataVersion: { increment: 1 },
        } });
        const detailRequest = requests.find(row => row.name === "session-detail")!;
        expect((await app.inject({ ...detailRequest, headers })).json()).toMatchObject({
            session: { id: sessionId, metadata: changed.metadata, metadataVersion: changed.metadataVersion },
        });
        const listRequest = requests.find(row => row.name === "session-query")!;
        expect((await app.inject({ ...listRequest, headers })).json()).toMatchObject({
            // Compact list rows carry the version; the detail read above carries the document.
            sessions: [expect.objectContaining({ id: sessionId, metadataVersion: changed.metadataVersion })],
        });
        // Revocation cannot be satisfied by the earlier Home snapshot.
        await db.account.update({ where: { id: accountId }, data: { tokenEpoch: { increment: 1 } } });
        for (const request of requests) {
            expect((await app.inject({ ...request, headers })).statusCode, request.name).toBe(401);
        }
    });

    it("keeps query statement work independent of returned page size", async () => {
        const currentToken = await auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
        const headers = { authorization: `Bearer ${currentToken}`, "x-happier-account-stored-content-protocol": "4" };
        await db.session.createMany({ data: Array.from({ length: 1_000 }, () => ({
            accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: false,
        })) });
        // Build actual index entries through the Data mutation owner, in its
        // protocol-defined batch size, rather than fabricating index rows.
        const rowCount = PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 + 1;
        for (let start = 0; start < rowCount; start += PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1) {
            const response = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate", headers, payload: {
                pluginId: ref.pluginId, collectionId: ref.collectionId,
                writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                operations: Array.from({ length: Math.min(PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1, rowCount - start) }, (_, i) => ({
                    kind: "put", rowId: `scale-${start + i}`, expectedRevision: "absent", expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: {} }, projection: { status: "scale" },
                })),
            } });
            expect(response.statusCode, response.body).toBe(200);
        }
        for (const family of ["session", "collection"] as const) {
            const max = family === "session" ? SESSION_LIST_PAGE_MAX_LIMIT : PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1;
            const counts: Array<{ limit: number; reads: number }> = [];
            for (const limit of [1, 50, max]) {
                const request = { method: "POST" as const, headers,
                    ...(family === "session" ? { url: "/v2/sessions/query", payload: {
                        v: 1, storage: "active", includeInactive: true, scope: "all_accessible", attention: "any",
                        audiences: [], tagIds: [], includeAttention: false, limit,
                    } } : { url: "/v1/plugins/data/query", payload: {
                        pluginId: ref.pluginId, collectionId: ref.collectionId, readerContext: ref,
                        indexId: "by-status", prefix: ["scale"], order: "asc", limit,
                    } }),
                };
                const warm = await app.inject(request);
                expect(warm.statusCode, warm.body).toBe(200);
                await drainQueryEvents();
                statements.length = 0;
                const response = await app.inject(request);
                expect(response.statusCode, response.body).toBe(200);
                await drainQueryEvents();
                const body = response.json();
                expect(family === "session" ? body.sessions : body.rows).toHaveLength(limit);
                expect(family === "session" ? body.hasNext : Boolean(body.nextCursor)).toBe(true);
                counts.push({ limit, reads: statements.filter(({ query }) => /^\s*(?:SELECT|WITH)\b/i.test(query)).length });
            }
            console.info("HOT_QUERY_PAGE_SQL_COSTS", JSON.stringify({ family, counts }));
            expect(counts[0]!.reads).toBeGreaterThan(0);
            expect(counts.map(row => row.reads)).toEqual(counts.map(() => counts[0]!.reads));
        }
    });

    it("rejects a page when retention commits after its rows but before the fresh floor read", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain", seq: 2 } });
        await db.accountChange.create({ data: { accountId: owner.id, cursor: 2, kind: "automation", entityId: "retained" } });
        const currentToken = await auth.createToken(owner.id, undefined, { kind: "account", authority: "present_user" });
        const transaction = db.$transaction;
        let advanced = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback: unknown = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const observed = new Proxy(tx, { get(client, property, txReceiver) {
                    if (property !== "accountChange") return Reflect.get(client, property, txReceiver);
                    return new Proxy(client.accountChange, { get(delegate, method, delegateReceiver) {
                        if (method !== "findMany") return Reflect.get(delegate, method, delegateReceiver);
                        return async (...readArgs: Parameters<typeof delegate.findMany>) => {
                            const rows = await delegate.findMany(...readArgs);
                            if (!advanced) {
                                advanced = true;
                                await db.account.update({ where: { id: owner.id }, data: { changesFloor: 1 } });
                            }
                            return rows;
                        };
                    } });
                } });
                return Reflect.apply(callback, undefined, [observed]);
            }, args[1]]);
        } });
        try {
            const response = await app.inject({ method: "GET", url: "/v2/changes?after=0",
                headers: { authorization: `Bearer ${currentToken}` } });
            expect(advanced).toBe(true);
            expect(response.statusCode, response.body).toBe(410);
            expect(response.json()).toMatchObject({ error: "cursor-gone", currentCursor: 2 });
        } finally { db.$transaction = transaction; }
    });
});
