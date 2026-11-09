import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import { MACHINE_PLAIN_DATA_KEY_MARKER } from "@happier-dev/protocol";
import { encodePlainMachineStoredContent } from "@happier-dev/protocol/machines/machineStoredContent";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from "@happier-dev/protocol/storage/artifactStoredContent";
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from "@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1";

import { auth } from "@/app/auth/auth";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerAccountEncryptionRoutes } from "@/app/api/routes/account/registerAccountEncryptionRoutes";
import { changesRoutes } from "@/app/api/routes/changes/changesRoutes";
import { pluginDataRoutes } from "@/app/api/routes/plugins/data/pluginDataRoutes";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
import { registerSessionReadBatchRoute } from "@/app/api/routes/session/registerSessionReadBatchRoute";
import { registerSessionOrganizationRoutes } from "@/app/api/routes/session/registerSessionOrganizationRoutes";
import { registerSessionFollowRoutes } from "@/app/api/routes/session/registerSessionFollowRoutes";
import { machinesRoutes } from "@/app/api/routes/machines/machinesRoutes";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";
import { registerSessionDraftRoutes } from "@/app/account/sessionDrafts/registerSessionDraftRoutes";
import { taskRoutes } from "@/app/api/routes/todos/taskRoutes";
import { materializePluginCollectionContractsFromManifestTx, preparePluginCollectionWritableContractsTx } from "@/app/plugins/data/collections/contracts";
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { observePrismaRequests } from "@/testkit/observeSqliteRequests";

interface PlanNode {
    "Node Type": string;
    "Relation Name"?: string;
    "Actual Rows": number;
    "Actual Loops": number;
    "Rows Removed by Filter"?: number;
    "Rows Removed by Index Recheck"?: number;
    Plans?: PlanNode[];
}

/** Prisma logs Date parameters as text; inline them with their SQL types for EXPLAIN. */
function inlineParams(sql: string, params: unknown[]): string {
    const literal = (value: unknown): string => value === null ? "NULL"
        : typeof value === "number" || typeof value === "boolean" ? String(value)
        : Array.isArray(value) ? `ARRAY[${value.map(literal).join(",")}]`
        : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)
            ? `'${value}'::timestamptz::timestamp`
            : `'${String(typeof value === "object" ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
    let result = sql;
    for (let index = params.length; index >= 1; index -= 1) {
        result = result.replaceAll(`$${index}`, literal(params[index - 1]));
    }
    return result;
}

/** Rows each relation's scan nodes read (returned + filtered) and its Seq Scans. */
function scanShape(plan: PlanNode): { scanned: Record<string, number>; seqScans: string[] } {
    const scanned: Record<string, number> = {};
    const seqScans: string[] = [];
    const visit = (node: PlanNode) => {
        const relation = node["Relation Name"];
        if (relation) {
            scanned[relation] = (scanned[relation] ?? 0) + (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)
                + (node["Rows Removed by Index Recheck"] ?? 0)) * node["Actual Loops"];
            // Includes "Parallel Seq Scan", which reads the same whole table.
            if (node["Node Type"].includes("Seq Scan")) seqScans.push(relation);
        }
        for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan);
    return { scanned, seqScans };
}

const JIT_OFF_STATEMENT = "SET LOCAL jit = off";

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function planNodes(plan: PlanNode): string[] {
    return [`${plan["Node Type"]}:${plan["Relation Name"] ?? ""}`, ...(plan.Plans ?? []).flatMap(planNodes)];
}

const scale = {
    viewerSessions: Number(process.env.HAPPIER_TEST_HOT_SCALE_SESSIONS ?? 5_000),
    viewerMachines: Number(process.env.HAPPIER_TEST_HOT_SCALE_MACHINES ?? 150),
    viewerArtifacts: Number(process.env.HAPPIER_TEST_HOT_SCALE_ARTIFACTS ?? 3_000),
    /** Every other Account's corpus, as a multiple of the viewer's. */
    bystanderFactor: Number(process.env.HAPPIER_TEST_HOT_SCALE_BYSTANDER_FACTOR ?? 10),
    viewerTeamSessions: Number(process.env.HAPPIER_TEST_HOT_SCALE_TEAM_SESSIONS ?? 9_000),
};

/**
 * Hot authenticated routes on a heavy Account inside a much larger Home.
 * Every SQL statement a request issues is captured on a logging transport and
 * replayed under EXPLAIN ANALYZE: a viewer-scoped read must never Seq Scan a
 * large table, nor read more rows of one relation than the viewer's own corpus.
 */
describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("hot route cost at scale (PostgreSQL)", () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, "query">;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let originalTransaction: typeof db.$transaction;
    let originalAccountRead: typeof db.account.findUnique;
    let resolveQueryBarrier: (() => void) | undefined;
    let keepJitForComparison = false;
    /** When set, each transaction records PostgreSQL's effective `jit` after its callback. */
    let observedJitSettings: string[] | undefined;

    async function drainQueryEvents() {
        const observed = new Promise<void>(resolve => { resolveQueryBarrier = resolve; });
        try {
            await Promise.all([client.$queryRaw`SELECT 1 AS "hot_scale_cost_barrier"`, observed]);
        } finally { resolveQueryBarrier = undefined; }
    }

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("HANDY_MASTER_SECRET", "hot-scale-disposable-fixture");
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", "srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        vi.stubEnv("HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED", "true");
        vi.stubEnv("HAPPIER_FEATURE_SHARING_SESSION__ENABLED", "1");
        initDbPostgres();
        await db.$connect();
        await auth.init();
        client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
        client.$on("query", event => {
            if (event.query.includes('"hot_scale_cost_barrier"')) resolveQueryBarrier?.();
            else statements.push(event);
        });
        await client.$connect();
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

    async function seedAccountCorpus(params: Readonly<{ accountId: string; prefix: string; sessions: number; machines: number;
        artifacts: number; messagesPerSession: number; seqStart: number }>) {
        const { accountId, prefix } = params;
        const sessionIds = Array.from({ length: params.sessions }, (_, index) => `${prefix}-s-${String(index).padStart(7, "0")}`);
        for (let offset = 0; offset < sessionIds.length; offset += 5_000) {
            await db.session.createMany({ data: sessionIds.slice(offset, offset + 5_000).map((id, slot) => {
                const index = offset + slot;
                return { id, accountId, tag: id, encryptionMode: "plain", metadataLayoutVersion: 1,
                    metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}', currentStorageState: "hosted",
                    active: index % 33 === 0,
                    // A fifth of each corpus is archived.
                    archivedAt: index % 5 === 4 ? new Date(1_700_000_000_000 + index * 1_000) : null,
                    projectKey: `project-${index % 200}`,
                    meaningfulActivityAt: new Date(1_700_000_000_000 + index * 60_000) };
            }) });
        }
        const content = { t: "plain", v: { role: "user", content: { type: "text", text: "hi" } } } satisfies PrismaJson.SessionMessageContent;
        for (let offset = 0; offset < sessionIds.length; offset += 2_000) {
            await db.sessionMessage.createMany({ data: sessionIds.slice(offset, offset + 2_000).flatMap(sessionId =>
                Array.from({ length: params.messagesPerSession }, (_, seq) => ({ sessionId, seq: seq + 1,
                    localId: `${sessionId}-m${seq}`, authorAccountId: accountId, createdAt: new Date(seq), content }))) });
        }
        const machineIds = Array.from({ length: params.machines }, () => randomUUID());
        for (let offset = 0; offset < machineIds.length; offset += 2_000) {
            await db.machine.createMany({ data: machineIds.slice(offset, offset + 2_000).map(id => ({ id, accountId,
                installationId: randomUUID(), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                metadata: encodePlainMachineStoredContent({}) })) });
        }
        const header = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "account_notice.v1" }));
        const artifactIds = Array.from({ length: params.artifacts }, () => randomUUID());
        for (let offset = 0; offset < artifactIds.length; offset += 2_000) {
            await db.artifact.createMany({ data: artifactIds.slice(offset, offset + 2_000).map(id => ({ id, accountId, header,
                body: new Uint8Array([0xff]), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
                headerVersion: 1, bodyVersion: 1, kind: "v1:other:account_notice.v1" })) });
        }
        // One durable change per entity, in cursor order, like a long-lived Account.
        const changes = [
            ...sessionIds.map(id => ({ kind: "session", entityId: id, sessionId: id })),
            ...machineIds.map(id => ({ kind: "machine", entityId: id, machineId: id })),
            ...artifactIds.map(id => ({ kind: "artifact", entityId: id, artifactId: id })),
        ];
        for (let offset = 0; offset < changes.length; offset += 5_000) {
            await db.accountChange.createMany({ data: changes.slice(offset, offset + 5_000).map((change, slot) => ({
                accountId, cursor: params.seqStart + offset + slot + 1, changedAt: new Date(1_700_000_000_000 + offset + slot), ...change,
            })) });
        }
        await db.account.update({ where: { id: accountId }, data: { seq: params.seqStart + changes.length } });
        // Tasks live among every other Account-scoped KV row.
        const task = (id: string) => new TextEncoder().encode(JSON.stringify({ t: "plain", v: { id, title: "t", done: false, linkedSessions: [] } }));
        const kvRows = [
            ...Array.from({ length: Math.ceil(params.artifacts / 6) }, () => {
                const id = randomUUID();
                return { key: `todo.${id}`, value: task(id) };
            }),
            ...Array.from({ length: params.artifacts }, (_, index) => ({ key: `draft.${prefix}-${index}`, value: new Uint8Array([0xff]) })),
        ];
        for (let offset = 0; offset < kvRows.length; offset += 5_000) {
            await db.userKVStore.createMany({ data: kvRows.slice(offset, offset + 5_000).map(row => ({ accountId, ...row })) });
        }
        return { sessionIds, machineIds, artifactIds, seq: params.seqStart + changes.length };
    }

    it("serves hot routes from the viewer's indexes, never another Account's corpus", async () => {
        const prefix = `hot-scale-${randomUUID().slice(0, 8)}`;
        const viewer = (await db.account.create({ data: { encryptionMode: "plain" } })).id;
        const bystander = (await db.account.create({ data: { encryptionMode: "plain" } })).id;
        const factor = scale.bystanderFactor;
        const bystanderCorpus = await seedAccountCorpus({ accountId: bystander, prefix: `${prefix}-b`, sessions: scale.viewerSessions * factor,
            machines: scale.viewerMachines * factor, artifacts: scale.viewerArtifacts * factor, messagesPerSession: 1, seqStart: 0 });
        const corpus = await seedAccountCorpus({ accountId: viewer, prefix: `${prefix}-v`, sessions: scale.viewerSessions,
            machines: scale.viewerMachines, artifacts: scale.viewerArtifacts, messagesPerSession: 2, seqStart: 0 });
        const refs = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: {
            schemaVersion: 2, id: "example.hot-scale", version: "1.0.0", displayName: "Hot scale fixture",
            engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 },
            contributes: { accountCollections: [{ id: "rows", schemaVersion: 1, rowIdField: "id",
                schema: { type: "object", properties: { id: { type: "string", maxLength: 256 },
                    status: { type: "string", maxLength: 32 } },
                    required: ["id", "status"], additionalProperties: false }, serverReadable: ["status"],
                indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }], uiQueries: [],
            }] },
        } }));
        const ref = refs[0]!;
        for (const accountId of [viewer, bystander]) {
            await inTx(tx => preparePluginCollectionWritableContractsTx({ tx, accountId, pluginId: ref.pluginId, contracts: [ref] }));
            await db.accountPluginIntent.create({ data: { accountId, pluginId: ref.pluginId,
                desiredVersion: null, enabled: true, offlineUiHosting: "disabled", writableCollections: [ref], revision: 1 } });
        }
        // Collection rows of the same plugin collection across Accounts; none are shared with the viewer.
        const contract = await db.pluginCollectionContract.findFirstOrThrow({ where: { pluginId: ref.pluginId,
            collectionId: ref.collectionId, contractDigest: ref.contractDigest }, select: { id: true } });
        for (const [accountId, count] of [[viewer, scale.viewerArtifacts], [bystander, scale.viewerArtifacts * factor]] as const) {
            for (let offset = 0; offset < count; offset += 5_000) {
                await db.pluginCollectionRow.createMany({ data: Array.from({ length: Math.min(5_000, count - offset) }, (_, slot) => ({
                    accountId, pluginId: ref.pluginId, collectionId: ref.collectionId, rowId: `row-${offset + slot}`,
                    schemaVersion: ref.schemaVersion, revision: 1, contractId: contract.id, contractDigest: ref.contractDigest,
                    contentEnvelope: { t: "plain", v: {} } })) });
            }
        }
        await db.$executeRawUnsafe('ANALYZE');
        const large = new Set((await db.$queryRawUnsafe<Array<{ relname: string }>>(
            "SELECT relname FROM pg_class WHERE relkind = 'r' AND reltuples >= 10000")).map(row => row.relname));

        // Rebind only the database transport; authentication, admission and SQL stay real.
        originalTransaction = db.$transaction;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args: unknown[]) {
            const callback: unknown = args[0];
            if (typeof callback !== "function") return Reflect.apply(client.$transaction, client, args);
            // A/B only: drop the listing's JIT setting at the database boundary so
            // both variants run interleaved on one fixture, one process and one load window.
            return Reflect.apply(client.$transaction, client, [async (tx: Prisma.TransactionClient) => {
                const result: unknown = await Reflect.apply(callback, undefined, [
                    new Proxy(tx, { get(target, property) {
                        const value: unknown = Reflect.get(target, property, target);
                        if (property !== "$executeRawUnsafe" || typeof value !== "function") return value;
                        return (sql: string, ...rest: unknown[]) => keepJitForComparison && sql === JIT_OFF_STATEMENT
                            ? Promise.resolve(0) : Reflect.apply(value, target, [sql, ...rest]);
                    } }),
                ]);
                // Same connection and transaction as the route's statements: the setting they ran under.
                if (observedJitSettings) {
                    const [setting] = await tx.$queryRawUnsafe<Array<{ jit: string }>>("SHOW jit");
                    observedJitSettings.push(setting?.jit ?? "missing");
                }
                return result;
            }, args[1]]);
        } });
        originalAccountRead = db.account.findUnique;
        Object.defineProperty(db.account, "findUnique", { configurable: true, writable: true,
            value: client.account.findUnique.bind(client.account) });
        app = createAuthenticatedTestApp({ authentication: "real" });
        registerAccountEncryptionRoutes(app);
        changesRoutes(app);
        pluginDataRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionReadBatchRoute(app);
        registerSessionOrganizationRoutes(app);
        registerSessionFollowRoutes(app);
        machinesRoutes(app);
        artifactsRoutes(app);
        registerSessionDraftRoutes(app);
        taskRoutes(app);
        await app.ready();

        const token = await auth.createToken(viewer, undefined, { kind: "account", authority: "present_user" });
        const headers = { authorization: `Bearer ${token}`,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        const newestSessions = corpus.sessionIds.slice(-20);
        const machineId = corpus.machineIds.at(-1)!;
        const requests: Array<{ name: string; method: "GET" | "POST"; url: string; payload?: Record<string, unknown> }> = [
            { name: "currentness", method: "GET", url: "/v1/account/encryption/currentness" },
            { name: "changes-incremental", method: "GET", url: `/v2/changes?after=${corpus.seq - 20}` },
            { name: "changes-catch-up", method: "GET", url: "/v2/changes?after=0" },
            { name: "machine-get", method: "GET", url: `/v1/machines/${machineId}` },
            { name: "machine-envelopes", method: "GET", url: `/v1/machines/${machineId}/data-key-envelopes` },
            { name: "machines-read-batch", method: "POST", url: "/v1/machines/read-batch",
                payload: { machineIds: corpus.machineIds.slice(-20) } },
            { name: "machines-list", method: "GET", url: "/v1/machines" },
            { name: "sessions-read-batch", method: "POST", url: "/v2/sessions/read-batch",
                payload: { sessionIds: newestSessions, includeTurns: false } },
            { name: "sessions-active", method: "GET", url: "/v2/sessions/active" },
            { name: "sessions-archived", method: "GET", url: "/v2/sessions/archived" },
            { name: "sessions-query", method: "POST", url: "/v2/sessions/query", payload: {
                v: 1, storage: "active", scope: "my_work", attention: "any", audiences: [], tagIds: [], limit: 50,
                includeInactive: false, includeAttention: true } },
            { name: "sessions-query-all", method: "POST", url: "/v2/sessions/query", payload: {
                v: 1, storage: "active", scope: "all_accessible", attention: "any", audiences: [], tagIds: [], limit: 50,
                includeInactive: true, includeAttention: false } },
            { name: "session-organization", method: "GET", url: "/v2/session-organization" },
            { name: "session-follows", method: "GET", url: "/v2/account/session-follows" },
            { name: "drafts-list", method: "POST", url: "/v2/account/session-drafts/list", payload: { limit: 100 } },
            { name: "plugin-contract", method: "POST", url: "/v1/plugins/data/contract",
                payload: { ref: { pluginId: ref.pluginId, collectionId: ref.collectionId,
                    schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest } } },
            { name: "plugin-query", method: "POST", url: "/v1/plugins/data/query",
                payload: { pluginId: ref.pluginId, collectionId: ref.collectionId, readerContext: ref,
                    indexId: "by-status", prefix: ["open"], order: "asc", limit: 50 } },
            { name: "artifacts-list", method: "GET", url: "/v1/artifacts" },
            { name: "tasks-list", method: "GET", url: "/v1/tasks" },
            { name: "collection-shared-with-me", method: "POST", url: "/v1/plugins/data/sharing/shared-with-me",
                payload: { pluginId: ref.pluginId, collectionId: ref.collectionId, readerContext: { pluginId: ref.pluginId,
                    collectionId: ref.collectionId, schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest }, limit: 50 } },
            { name: "artifacts-read", method: "POST", url: "/v1/artifacts/read",
                payload: { artifactIds: corpus.artifactIds.slice(-20), projection: "headers" } },
        ];
        // A viewer read may touch at most the viewer's own corpus of one relation.
        const viewerBound = Math.max(scale.viewerSessions * 2, scale.viewerArtifacts, scale.viewerMachines) + 100;
        const rows: Array<Record<string, unknown>> = [];
        const violations: string[] = [];
        const measure = async (request: (typeof requests)[number], recordAllPlans = false) => {
            const warm = await app.inject({ ...request, headers });
            await drainQueryEvents();
            statements.length = 0;
            let prismaOps = 0;
            const stop = observePrismaRequests(db, { before() { prismaOps += 1; } });
            const started = performance.now();
            let response;
            try { response = await app.inject({ ...request, headers }); } finally { stop(); }
            const elapsedMs = Math.round(performance.now() - started);
            await drainQueryEvents();
            const captured = [...statements];
            const selects = captured.filter(({ query }) => /^\s*(?:SELECT|WITH)\b/i.test(query));
            const plans: Array<Record<string, unknown>> = [];
            let unexplained = 0;
            for (const { query, params } of selects) {
                let plan: PlanNode;
                let executionMs: number;
                let jitMs: number | undefined;
                try {
                    const [explained] = await client.$queryRawUnsafe<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode; "Execution Time": number; JIT?: { Timing?: { Total?: number } } }> }>>(
                        `EXPLAIN (ANALYZE, FORMAT JSON) ${inlineParams(query, JSON.parse(params))}`);
                    plan = explained["QUERY PLAN"][0]!.Plan;
                    executionMs = explained["QUERY PLAN"][0]!["Execution Time"];
                    jitMs = explained["QUERY PLAN"][0]!.JIT?.Timing?.Total;
                } catch { unexplained += 1; continue; }
                const shape = scanShape(plan);
                const relation = query.match(/\bFROM\s+(?:"public"\.)?"([^"]+)"/i)?.[1] ?? "raw";
                const largeSeq = shape.seqScans.filter(name => large.has(name));
                const overRead = Object.entries(shape.scanned).filter(([, count]) => count > viewerBound);
                if (recordAllPlans) {
                    // Name where a slow statement spends its time: planning, JIT, or scanning.
                    const replayed = executionMs < 100 ? null : await client.$transaction(async tx => {
                        await tx.$executeRawUnsafe("SET LOCAL jit = off");
                        const [noJit] = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode; "Execution Time": number; "Planning Time": number }> }>>(
                            `EXPLAIN (ANALYZE, FORMAT JSON) ${inlineParams(query, JSON.parse(params))}`);
                        return { noJitExecutionMs: Math.round(noJit["QUERY PLAN"][0]!["Execution Time"]), planningMs: Math.round(noJit["QUERY PLAN"][0]!["Planning Time"]),
                            planUnchangedWithoutJit: JSON.stringify(planNodes(noJit["QUERY PLAN"][0]!.Plan)) === JSON.stringify(planNodes(plan)) };
                    });
                    plans.push({ relation, executionMs: Math.round(executionMs), jitMs: jitMs === undefined ? null : Math.round(jitMs),
                        ...replayed, scanned: shape.scanned, seqScans: shape.seqScans,
                        ...(replayed && process.env.HAPPIER_TEST_HOT_SCALE_SQL === "1" ? { sql: query.slice(0, 6000) } : {}) });
                } else if (largeSeq.length || overRead.length) {
                    violations.push(`${request.name}: ${relation} seq=${JSON.stringify(largeSeq)} scanned=${JSON.stringify(Object.fromEntries(overRead))}`);
                    plans.push({ relation, executionMs: Math.round(executionMs), scanned: shape.scanned, seqScans: shape.seqScans,
                        ...(process.env.HAPPIER_TEST_HOT_SCALE_SQL === "1" ? { sql: query.slice(0, 3000) } : {}) });
                }
            }
            const row = { name: request.name, warm: warm.statusCode, status: response.statusCode, elapsedMs, prismaOps,
                ...(response.statusCode === 200 ? {} : { error: response.body.slice(0, 300) }),
                statements: captured.length, transactions: captured.filter(({ query }) => /^BEGIN\b/.test(query)).length,
                selects: selects.length, unexplained, plans };
            return { row, body: response.body };
        };
        for (const request of requests) rows.push((await measure(request)).row);
        // Route-level A/B: interleaved so load drifts hit both variants. Each pass gets
        // fresh backends (cold: no plan/catalog cache, JIT library unloaded), then repeats on them.
        const compareJit = async (label: string, candidates: ReadonlyArray<(typeof requests)[number]>) => {
            const samples = new Map<string, Record<"on" | "off", { cold: number[]; warm: number[] }>>();
            for (const variant of ["on", "off", "off", "on", "on", "off", "off", "on", "on", "off"] as const) {
                keepJitForComparison = variant === "on";
                try {
                    for (const request of candidates) {
                        await client.$disconnect();
                        await client.$connect();
                        const entry = samples.get(request.name) ?? { on: { cold: [], warm: [] }, off: { cold: [], warm: [] } };
                        samples.set(request.name, entry);
                        for (const phase of ["cold", "warm"] as const) {
                            const started = performance.now();
                            const response = await app.inject({ ...request, headers });
                            expect(response.statusCode, response.body).toBe(200);
                            entry[variant][phase].push(Math.round(performance.now() - started));
                        }
                    }
                } finally { keepJitForComparison = false; }
            }
            await drainQueryEvents();
            statements.length = 0;
            console.info("HOT_ROUTE_JIT_AB", JSON.stringify({ label, routes: [...samples].map(([name, entry]) => ({ name, ...entry,
                medians: { on: { cold: median(entry.on.cold), warm: median(entry.on.warm) }, off: { cold: median(entry.off.cold), warm: median(entry.off.warm) } } })) }));
        };
        const listingRequests = requests.filter(({ name }) => ["sessions-active", "sessions-archived", "sessions-query", "sessions-query-all"].includes(name));
        // Every listing transaction runs with JIT off in PostgreSQL itself, and an unrelated read
        // keeps the server default. Dropping the listing's setting must leave JIT on, so the
        // probe distinguishes the effect from its absence.
        const readJitSettings = async (request: (typeof requests)[number], dropListingSetting = false) => {
            observedJitSettings = [];
            keepJitForComparison = dropListingSetting;
            try {
                const response = await app.inject({ ...request, headers });
                expect(response.statusCode, response.body).toBe(200);
                return observedJitSettings;
            } finally { observedJitSettings = undefined; keepJitForComparison = false; }
        };
        for (const request of listingRequests) {
            expect(await readJitSettings(request), request.name).toContain("off");
        }
        expect(await readJitSettings(listingRequests[0]!, true)).not.toContain("off");
        const currentness = await readJitSettings(requests.find(({ name }) => name === "currentness")!);
        expect(currentness.every(setting => setting === "on"), JSON.stringify(currentness)).toBe(true);
        await drainQueryEvents();
        statements.length = 0;
        await compareJit("no-team", listingRequests);
        console.info("HOT_ROUTE_SCALE", JSON.stringify({ scale, large: [...large].sort(), rows }));
        for (const row of rows) expect(row.status, String(row.name)).toBe(200);
        // Known, measured exception: My work's transcript-authorship read must
        // examine every Session the viewer authored to find the few it does not
        // own; no existing index separates them, so PostgreSQL hashes the Session
        // table. Its schema decision is recorded in P03-SERVER-SCALE.
        const deferred = violations.filter(entry => entry.startsWith('sessions-query: SessionMessage '));
        expect(deferred.length).toBeLessThanOrEqual(1);
        expect(violations.filter(entry => !deferred.includes(entry))).toEqual([]);

        // The same viewer joins a few Teams holding thousands of another Account's
        // Sessions: the Team arms stay EXISTS inside the access OR, a Seq Scan whose
        // candidate-page redesign is deferred with its trigger in P03-SERVER-SCALE.
        const teamIds = Array.from({ length: 3 }, (_, index) => `${prefix}-team-${index}`);
        await db.team.createMany({ data: teamIds.map(id => ({ id, name: id })) });
        await db.teamMembership.createMany({ data: teamIds.map(teamId => ({ teamId, accountId: viewer, role: "member" as const, sessionAccessStartsAt: null })) });
        const teamSessions = bystanderCorpus.sessionIds.filter((_, index) => index % 5 !== 4).slice(-scale.viewerTeamSessions);
        for (let offset = 0; offset < teamSessions.length; offset += 5_000) {
            await db.sessionTeamGrant.createMany({ data: teamSessions.slice(offset, offset + 5_000).map((sessionId, slot) => ({
                sessionId, teamId: teamIds[(offset + slot) % teamIds.length]!, effectiveAt: new Date(1), accessLevel: "view" as const })) });
        }
        await db.$executeRawUnsafe('ANALYZE "Team", "TeamMembership", "SessionTeamGrant"');
        const teamQuery = (name: string, payload: Record<string, unknown>) => ({ name, method: "POST" as const, url: "/v2/sessions/query", payload: {
            v: 1, storage: "active", scope: "all_accessible", attention: "any", audiences: [], tagIds: [], limit: 50, ...payload } });
        const teamRows = [];
        const teamIdSet = new Set(teamSessions);
        for (const request of [
            teamQuery("team-all-accessible", { includeInactive: true, includeAttention: false }),
            teamQuery("team-all-accessible-attention", { includeInactive: true, includeAttention: true }),
            teamQuery("team-all-accessible-hide-inactive", { includeInactive: false, includeAttention: true }),
        ]) {
            const { row, body } = await measure(request, true);
            teamRows.push(row);
            expect(row.status, row.error).toBe(200);
            if (request.name === "team-all-accessible") {
                // The measured path really reaches Team access, not only owned rows.
                const ids: string[] = JSON.parse(body).sessions.map((session: { id: string }) => session.id);
                expect(ids.some(id => teamIdSet.has(id))).toBe(true);
            }
        }
        await compareJit("team", [
            teamQuery("team-all-accessible", { includeInactive: true, includeAttention: false }),
            teamQuery("team-all-accessible-attention", { includeInactive: true, includeAttention: true }),
            teamQuery("team-all-accessible-hide-inactive", { includeInactive: false, includeAttention: true }),
        ]);
        console.info("HOT_ROUTE_SCALE_TEAM", JSON.stringify({ scale, teams: teamIds.length, teamSessions: teamSessions.length,
            rows: teamRows.map(row => ({ ...row, sessionExecutionMs: row.plans.reduce((sum, plan) => sum + (plan.seqScans as string[] | undefined ? Number(plan.executionMs) : 0), 0) })) }));
    }, 1_200_000);
});
