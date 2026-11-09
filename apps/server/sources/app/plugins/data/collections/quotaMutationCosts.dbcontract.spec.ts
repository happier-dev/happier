import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginCollectionMutationOperationV1, PluginCollectionPutMutationV1 } from "@happier-dev/protocol/plugins/data/collectionsV1";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { createPluginAvailabilityOperations } from "@/app/plugins/availability/operations";
import { initEncrypt } from "@/modules/encrypt";
import { db, getDbProviderFromEnv } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createDatabaseIntegrationHarness } from "@/testkit/databaseIntegrationHarness";
import { observePrismaReads } from "@/testkit/observePrismaReads";

import { materializePluginCollectionContractsFromManifestTx, preparePluginCollectionWritableContractsTx,
    readMaterializedPluginCollectionContract } from "./contracts";
import { stagePluginCollectionCandidatePreparation } from "./candidatePreparation";
import { buildPluginCollectionIndexValues, forgetPluginCollection, mutatePluginCollection, updateIndexReadinessInTx } from "./mutation";
import { readPluginCollectionAccountUsageInTx } from "./quota";
import { backfillPluginCollectionUsageTotalsInTx } from "./usageTotals";
import { assertPluginCollectionUsageTotalsMatchRows } from "./usageTotals.testkit";
import { runPostgresMigrationDeploy } from '../../../../../scripts/migrate.full.deploy';
import { PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION } from '../../../../../scripts/pluginCollectionUsageBackfill';

const authentication = createPresentUserSessionAccessAuthentication();

async function seedAccount(rowCount: number, retainedCollectionId: "changed" | "unrelated" = "unrelated",
    options: Readonly<{ prefixMaxRows?: number; backfill?: boolean }> = {}) {
    const pluginId = `example.quota-cost.${randomUUID()}`;
    const manifest = {
        schemaVersion: 2, id: pluginId, version: "1.0.0", displayName: "Quota mutation contract",
        engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 },
        contributes: { accountCollections: ["changed", "unrelated"].map(id => ({
            id, schemaVersion: 1, rowIdField: "id",
            schema: { type: "object", properties: {
                id: { type: "string", maxLength: 256 }, body: { type: "string", maxLength: 4096 },
                amount: { type: "number" }, status: { type: "string", enum: ["open", "closed"] }, score: { type: "number" },
            }, required: ["id", "body", "status", "score"], additionalProperties: false },
            serverReadable: ["id", "status", "score"],
            indexes: options.prefixMaxRows === undefined ? [] : [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }],
            quota: { maxRowEncodedBytes: 512, ...(options.prefixMaxRows === undefined ? {} : {
                maxRowsByIndexPrefix: [{ indexId: "by-status", prefix: ["open"], maxRows: options.prefixMaxRows }],
            }) },
        })) },
    };
    const refs = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest }));
    const contracts = await db.pluginCollectionContract.findMany({ where: { pluginId } });
    const ref = refs.find(value => value.collectionId === "changed");
    if (!ref) throw new Error("Expected materialized mutation contract");
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain", seq: 0 } });
    await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId,
        desiredVersion: "1.0.0", enabled: true, offlineUiHosting: "disabled", writableCollections: [...refs] } });
    await db.accountPluginRelease.create({ data: { accountId: account.id, pluginId, version: "1.0.0",
        archiveDigestSha256: `sha256:${"a".repeat(64)}`, normalizedManifest: manifest,
        collectionContracts: [...refs], uiSlots: [] } });
    await db.pluginCollectionRow.createMany({ data: Array.from({ length: rowCount }, (_, index) => {
        const contract = contracts.find(value => value.collectionId === (index === 0 ? "changed" : retainedCollectionId));
        if (!contract) throw new Error("Expected stored mutation contract");
        const rowId = `row-${index}`;
        return { accountId: account.id, pluginId, collectionId: contract.collectionId, rowId,
            schemaVersion: 1, revision: 1, contractId: contract.id, contractDigest: contract.contractDigest,
            contentEnvelope: { t: "plain", v: { body: "initial" } } };
    }) });
    const storedRows = await db.pluginCollectionRow.findMany({ where: { accountId: account.id },
        select: { id: true, rowId: true, collectionId: true } });
    await db.pluginCollectionProjection.createMany({ data: storedRows.flatMap(row => Object.entries({ id: row.rowId, status: "open", score: 0 })
        .map(([fieldId, value]) => ({ rowDbId: row.id, accountId: account.id, pluginId, collectionId: row.collectionId,
            rowId: row.rowId, fieldId, typedEncodedValue: JSON.stringify(value), rowRevision: 1 }))) });
    for (const persisted of contracts) {
        const contract = readMaterializedPluginCollectionContract(persisted);
        for (const index of contract.indexes) {
            const state = await db.pluginCollectionIndexState.create({ data: { accountId: account.id, pluginId,
                collectionId: contract.collectionId, indexId: index.id, contractId: persisted.id,
                contractDigest: contract.contractDigest, buildState: "ready", indexedThroughRevision: 1 } });
            const entries = storedRows.filter(row => row.collectionId === contract.collectionId).flatMap(row =>
                buildPluginCollectionIndexValues({ contract, rowId: row.rowId,
                    projection: { id: row.rowId, status: "open", score: 0 } })
                    .filter(value => value.indexId === index.id)
                    .map(value => ({ indexStateId: state.id, encodedSortKey: value.encodedSortKey, rowId: row.rowId, rowRevision: 1 })));
            if (entries.length > 0) await db.pluginCollectionIndexEntry.createMany({ data: entries });
        }
    }
    const backfill = async () => {
        await inTx(async tx => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, account.id, "serializing");
            expect(fence.status).toBe("ready");
            await backfillPluginCollectionUsageTotalsInTx({ tx, accountId: account.id });
        });
    };
    if (options.backfill !== false) await backfill();
    return {
        accountId: account.id, pluginId, contracts, refs, manifest, backfill,
        mutate: (operations: PluginCollectionMutationOperationV1[]) => mutatePluginCollection({
            accountId: account.id, authentication, request: { pluginId, collectionId: ref.collectionId,
                writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest }, operations },
        }),
        forget: (rowId: string, expectedRevision: number) => forgetPluginCollection({ accountId: account.id,
            request: { pluginId, collectionId: ref.collectionId, rowId, expectedRevision,
                writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest } } }),
        close: async () => {
            await db.account.delete({ where: { id: account.id } });
            await db.pluginCollectionContract.deleteMany({ where: { pluginId } });
        },
    };
}

function put(rowId: string, expectedRevision: number | "absent" = "absent", body = "updated",
    options: Readonly<{ status?: "open" | "closed"; score?: number; amount?: number; absenceEpoch?: number }> = {}): PluginCollectionPutMutationV1 {
    const base = { kind: "put", rowId,
        content: { t: "plain", v: { body, ...(options.amount === undefined ? {} : { amount: options.amount }) } },
        projection: { id: rowId, status: options.status ?? "open", score: options.score ?? 0 } } as const;
    return expectedRevision === "absent"
        ? { ...base, expectedRevision, expectedAbsenceEpoch: options.absenceEpoch ?? 0 }
        : { ...base, expectedRevision };
}

/** Observe real row transfers beneath inTx; keep admission, queries and commits intact. */
async function measureMutation(run: () => ReturnType<typeof mutatePluginCollection>) {
    const observations: ReturnType<typeof observePrismaReads>[] = [];
    const usageIO: string[][] = [];
    const field = (value: unknown, name: string): unknown => value !== null && typeof value === "object"
        ? Reflect.get(value, name) : undefined;
    const original = db.$transaction;
    db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            const observed = observePrismaReads(tx, ["pluginCollectionRow"]);
            observations.push(observed);
            const events: string[] = [];
            usageIO.push(events);
            const tracked = new Proxy(observed.tx, { get(target, model, txReceiver) {
                const delegate: unknown = Reflect.get(target, model, txReceiver);
                if (!["account", "pluginCollectionUsage", "pluginCollectionContractUsage", "pluginCollectionIndexState"].includes(String(model))
                    || delegate === null || typeof delegate !== "object") return delegate;
                return new Proxy(delegate, { get(owner, operation, delegateReceiver) {
                    const method: unknown = Reflect.get(owner, operation, delegateReceiver);
                    if (typeof method !== "function") return method;
                    return async (...queryArgs: unknown[]) => {
                        const request = queryArgs[0];
                        const select = field(request, "select");
                        const data = field(request, "data");
                        const reading = String(operation).startsWith("find");
                        if (model === "account") {
                            if (reading && field(select, "pluginCollectionRows") === true
                                && field(select, "pluginCollectionEncodedBytes") === true) events.push("account:read");
                            else if (!reading && (field(data, "pluginCollectionRows") !== undefined
                                || field(data, "pluginCollectionEncodedBytes") !== undefined)) events.push("account:write");
                        } else if (model === "pluginCollectionIndexState") {
                            if (reading && (select === undefined || field(select, "quotaPrefixCounts") === true)) events.push("prefix:read");
                            else if (!reading && field(data, "quotaPrefixCounts") !== undefined) events.push("prefix:write");
                        } else events.push(`${model === "pluginCollectionUsage" ? "collection" : "contract"}:${reading ? "read" : "write"}`);
                        return await Reflect.apply(method, owner, queryArgs);
                    };
                } });
            } });
            return await callback(tracked);
        }, ...args.slice(1)]);
    } });
    try {
        const result = await run();
        return { result, rowTransfers: observations.flatMap(value => value.rows).reduce((sum, value) => sum + value.count, 0),
            rowQueries: observations.reduce((sum, value) => sum + value.reads.length, 0), attempts: observations.length, usageIO };
    } finally { db.$transaction = original; }
}

function expectOneUsageBaseline(measured: Awaited<ReturnType<typeof measureMutation>>, withPrefixes = false): void {
    expect(measured.usageIO.length).toBeGreaterThan(0);
    for (const events of measured.usageIO) {
        for (const owner of ["account", "collection", "contract"]) {
            expect(events.filter(event => event === `${owner}:read`)).toHaveLength(1);
        }
        if (withPrefixes) expect(events.filter(event => event === "prefix:read")).toHaveLength(1);
        const written = new Set<string>();
        for (const event of events) {
            const [owner, operation] = event.split(":");
            if (operation === "write") written.add(owner!);
            else expect(written.has(owner!)).toBe(false);
        }
    }
}

describe("Collection mutation quota cost and accounting contract", () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: "happier-quota-mutation-", initAuth: false,
            env: { HANDY_MASTER_SECRET: "quota-mutation-contract-fixture" } });
        await initEncrypt();
    });
    afterAll(async () => { await harness?.close(); });

    it("keeps put and delete row transfers independent of unrelated Account rows", async () => {
        const transfers: { put: number; delete: number }[] = [];
        for (const rows of [10, 1_000]) {
            const fixture = await seedAccount(rows, "unrelated", { prefixMaxRows: rows });
            const sample = { put: 0, delete: 0 };
            try {
                for (const operation of [put("row-0", 1), { kind: "delete", rowId: "row-0", expectedRevision: 2 } as const]) {
                    const measured = await measureMutation(() => fixture.mutate([operation]));
                    expect(measured.result).toMatchObject({ status: "updated", results: [{ rowId: "row-0",
                        revision: operation.kind === "put" ? 2 : 3, deleted: operation.kind === "delete" }] });
                    expectOneUsageBaseline(measured, true);
                    sample[operation.kind] = measured.rowTransfers;
                    console.log("[PL07-QUOTA] " + JSON.stringify({ provider: getDbProviderFromEnv(process.env, "postgres"),
                        rows, operation: operation.kind, rowTransfers: measured.rowTransfers,
                        rowQueries: measured.rowQueries, attempts: measured.attempts }));
                }
                expect(await db.pluginCollectionRow.count({ where: { accountId: fixture.accountId, deletedAt: null } })).toBe(rows - 1);
                transfers.push(sample);
            } finally { await fixture.close(); }
        }
        // Equal changed rows and outcomes must cost the same at both sizes;
        // this asserts the shape without inventing a numeric read budget.
        expect(transfers[1]).toEqual(transfers[0]);
    });

    it("rolls back an over-quota insert and credits a committed delete", async () => {
        const fixture = await seedAccount(2);
        harness.resetEnv({ HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: "2", HAPPIER_COLLECTION_MAX_BATCH_ROWS: "2" });
        try {
            await expect(fixture.mutate([put("new")])).rejects.toMatchObject({ code: "collection_quota_incompatible", dimension: "maxAccountRows" });
            expect(await db.pluginCollectionRow.count({ where: { accountId: fixture.accountId, deletedAt: null } })).toBe(2);
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            await expect(fixture.mutate([{ kind: "delete", rowId: "row-0", expectedRevision: 1 }])).resolves.toMatchObject({ status: "updated" });
            await expect(fixture.mutate([put("new")])).resolves.toMatchObject({ status: "updated" });
            expect(await db.pluginCollectionRow.count({ where: { accountId: fixture.accountId, deletedAt: null } })).toBe(2);
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
        } finally { harness.resetEnv(); await fixture.close(); }
    });

    it("serializes concurrent admissions against the same remaining Account quota", async () => {
        const fixture = await seedAccount(2);
        harness.resetEnv({ HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: "3", HAPPIER_COLLECTION_MAX_BATCH_ROWS: "3" });
        try {
            const outcomes = await Promise.allSettled([fixture.mutate([put("first")]), fixture.mutate([put("second")])]);
            expect(outcomes.filter(value => value.status === "fulfilled")).toHaveLength(1);
            const rejected = outcomes.find(value => value.status === "rejected");
            expect(rejected).toMatchObject({ status: "rejected", reason: { code: "collection_quota_incompatible", dimension: "maxAccountRows" } });
            expect(await db.pluginCollectionRow.count({ where: { accountId: fixture.accountId, deletedAt: null } })).toBe(3);
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
        } finally { harness.resetEnv(); await fixture.close(); }
    });

    it.each(["changed", "unrelated"] as const)("requires an oversized changed row to shrink but admits a small write beside an unchanged oversized row in %s", async retainedCollectionId => {
        const fixture = await seedAccount(2, retainedCollectionId);
        try {
            await db.pluginCollectionRow.updateMany({ where: { accountId: fixture.accountId, rowId: "row-0" },
                data: { contentEnvelope: { t: "plain", v: { body: "x".repeat(700) } } } });
            await fixture.backfill();
            await expect(fixture.mutate([put("row-0", 1, "x".repeat(600))])).resolves.toMatchObject({ status: "updated" });
            await expect(fixture.mutate([put("row-0", 2, "x".repeat(600))])).rejects.toMatchObject({
                code: "collection_quota_incompatible", dimension: "maxRowEncodedBytes" });
            await expect(fixture.mutate([put("row-0", 2)])).resolves.toMatchObject({ status: "updated" });
            await db.pluginCollectionRow.updateMany({ where: { accountId: fixture.accountId, rowId: "row-1" },
                data: { contentEnvelope: { t: "plain", v: { body: "x".repeat(700) } } } });
            await fixture.backfill();
            // Same-sized writes still count as changed rows; the oversized
            // neighbour must not veto a valid update in either Collection.
            await expect(fixture.mutate([put("row-0", 3)])).resolves.toMatchObject({ status: "updated" });
            expect(await db.pluginCollectionRow.findFirst({ where: { accountId: fixture.accountId, rowId: "row-0" }, select: { revision: true } }))
                .toEqual({ revision: 4 });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
        } finally { await fixture.close(); }
    });

    it.skipIf(!["postgres", "sqlite"].includes(getDbProviderFromEnv(process.env, "postgres")))("reads indexed readiness maxima without scanning the retained Collection", async () => {
        const provider = getDbProviderFromEnv(process.env, "postgres");
        if (provider === "postgres") {
            const url = new URL(process.env.DATABASE_URL ?? "");
            if (!/^[a-f0-9]{64}$/.test(process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ?? "")
                || !/^\d+$/.test(process.env.VITEST_POOL_ID ?? "")
                || url.pathname !== `/happier_contract_${process.env.VITEST_POOL_ID}`) {
                throw new Error("Index-plan test requires its disposable PostgreSQL worker database");
            }
        }
        const migrationRoot = provider === "sqlite" ? "sqlite/" : "";
        const createIndexFromMigration = async (name: string) => {
            const sql = await readFile(new URL(`../../../../../prisma/${migrationRoot}migrations/${name}/migration.sql`, import.meta.url), "utf8");
            const statement = sql.match(/CREATE INDEX "PluginCollectionRow_account_live_idx"[\s\S]*?;/)?.[0];
            if (!statement) throw new Error("Expected the canonical live-row index migration");
            return statement;
        };
        const canonicalIndex = await createIndexFromMigration("20261030193000_plugin_collection_usage_totals");
        const legacyIndex = await createIndexFromMigration("20260809170000_add_plugin_data_and_message_admission");
        const loaded: unknown = createRequire(import.meta.url)(provider === "sqlite"
            ? "../../../../../generated/sqlite-client/index.js" : "@prisma/client");
        if (!loaded || typeof loaded !== "object" || !("PrismaClient" in loaded) || typeof loaded.PrismaClient !== "function") {
            throw new Error("Expected the provider-generated Prisma transport");
        }
        // Generated provider modules are a genuine untyped module boundary; their clients share this API.
        const PrismaClient = loaded.PrismaClient as typeof import("@prisma/client").PrismaClient;
        const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } },
            log: [{ emit: "event", level: "query" }] });
        const statements: Prisma.QueryEvent[] = [];
        let finishBarrier: (() => void) | undefined;
        client.$on("query", event => {
            if (event.query.includes("readiness_cost_barrier")) finishBarrier?.();
            else statements.push(event);
        });
        await client.$connect();
        const replaceIndex = async (statement: string) => {
            await db.$executeRawUnsafe('DROP INDEX IF EXISTS "PluginCollectionRow_account_live_idx"');
            await db.$executeRawUnsafe(statement);
        };
        interface PostgresPlanNode {
            "Node Type": string;
            "Relation Name"?: string;
            "Actual Rows": number;
            "Actual Loops": number;
            "Rows Removed by Filter"?: number;
            "Index Name"?: string;
            "Scan Direction"?: string;
            "Plan Rows"?: number;
            "Startup Cost"?: number;
            "Total Cost"?: number;
            Plans?: PostgresPlanNode[];
        }
        const flattenPlan = (node: PostgresPlanNode): PostgresPlanNode[] => [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
        const canonicalVisits: Array<{ rows: number; rowVisits: number }> = [];
        try {
            for (const rows of [10, 1_000]) {
                const fixture = await seedAccount(rows, "changed", { prefixMaxRows: rows });
                try {
                    await db.pluginCollectionRow.updateMany({ where: { accountId: fixture.accountId, rowId: "row-0" }, data: { revision: rows } });
                    const persisted = fixture.contracts.find(value => value.collectionId === "changed");
                    if (!persisted) throw new Error("Expected the changed Collection contract");
                    const indexStates = await db.pluginCollectionIndexState.findMany({ where: { accountId: fixture.accountId, collectionId: "changed" } });
                    for (const [kind, statement] of [["legacy", legacyIndex], ["canonical", canonicalIndex]] as const) {
                        await replaceIndex(statement);
                        if (provider === "postgres") await db.$executeRawUnsafe('ANALYZE "PluginCollectionRow"');
                        statements.length = 0;
                        await updateIndexReadinessInTx({ tx: client, accountId: fixture.accountId,
                            resolved: { encryptionMode: "plain", contractId: persisted.id,
                                contract: readMaterializedPluginCollectionContract(persisted), indexStates } });
                        const emitted = new Promise<void>(resolve => { finishBarrier = resolve; });
                        await Promise.all([client.$queryRaw`SELECT 1 AS "readiness_cost_barrier"`, emitted]);
                        finishBarrier = undefined;
                        const query = statements.filter(event => event.query.includes("PluginCollectionRow")
                            && /\bORDER\s+BY\b[\s\S]*?\brevision["`\]]?\s+DESC\b/i.test(event.query)).at(-1);
                        if (!query) {
                            console.log("[PL07-READINESS-CAPTURE] " + JSON.stringify({ provider,
                                statements: statements.filter(event => event.query.includes("PluginCollectionRow")).map(event => event.query) }));
                            throw new Error("Readiness did not emit its ordered maximum-revision lookup");
                        }
                        const parsed: unknown = JSON.parse(query.params);
                        if (!Array.isArray(parsed)) throw new Error("Expected readiness SQL parameters");
                        const parameters: unknown[] = parsed;
                        const limit = query.query.match(/\bLIMIT\s+(\$\d+|\?)/i);
                        if (!limit) throw new Error("Expected the bounded readiness lookup");
                        const limitPosition = limit[1] === "?"
                            ? (query.query.slice(0, limit.index).match(/\?/g)?.length ?? 0) : Number(limit[1]!.slice(1)) - 1;
                        expect(parameters[limitPosition]).toBe(1);
                        expect(await db.pluginCollectionIndexState.findUniqueOrThrow({ where: { id: indexStates[0]!.id },
                            select: { indexedThroughRevision: true } })).toEqual({ indexedThroughRevision: rows });
                        if (provider === "postgres") {
                            const result = await db.$queryRawUnsafe<Array<{ "QUERY PLAN": Array<{ Plan: PostgresPlanNode }> }>>(
                                `EXPLAIN (ANALYZE, FORMAT JSON) ${query.query}`, ...parameters);
                            const plan = result[0]?.["QUERY PLAN"][0]?.Plan;
                            if (!plan) throw new Error("Expected PostgreSQL's executed readiness plan");
                            const nodes = flattenPlan(plan);
                            const scans = nodes.filter(node => node["Relation Name"] === "PluginCollectionRow");
                            expect(scans.length).toBeGreaterThan(0);
                            const rowVisits = scans.reduce((sum, node) => sum
                                + (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"], 0);
                            console.log("[PL07-READINESS] " + JSON.stringify({ provider, rows, kind, rowVisits, sql: query.query,
                                nodes: nodes.map(node => ({ type: node["Node Type"], relation: node["Relation Name"],
                                    index: node["Index Name"], direction: node["Scan Direction"], rows: node["Actual Rows"],
                                    loops: node["Actual Loops"], removed: node["Rows Removed by Filter"] ?? 0,
                                    estimatedRows: node["Plan Rows"], startupCost: node["Startup Cost"], totalCost: node["Total Cost"] })) }));
                            if (kind === "legacy") expect(rowVisits).toBeGreaterThanOrEqual(rows);
                            else {
                                canonicalVisits.push({ rows, rowVisits });
                                if (rows === 1_000) {
                                    const orderedIndex = scans.some(node => node["Index Name"] === "PluginCollectionRow_account_live_idx"
                                        && /Index(?: Only)? Scan/.test(node["Node Type"]) && node["Scan Direction"] === "Backward");
                                    const sorts = nodes.some(node => /Sort/.test(node["Node Type"]));
                                    expect(orderedIndex).toBe(true);
                                    expect(sorts).toBe(false);
                                    expect(rowVisits).toBe(1);
                                }
                            }
                        } else {
                            const plan = await db.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${query.query}`, ...parameters);
                            const sortsRetainedRows = plan.some(value => /USE TEMP B-TREE.*ORDER BY/i.test(value.detail));
                            console.log("[PL07-READINESS] " + JSON.stringify({ provider, rows, kind, sortsRetainedRows,
                                plan: plan.map(value => value.detail), sql: query.query }));
                            expect(sortsRetainedRows).toBe(kind === "legacy");
                            if (kind === "canonical") expect(plan.some(value => /USING (?:COVERING )?INDEX PluginCollectionRow_account_live_idx\b/.test(value.detail))).toBe(true);
                        }
                    }
                } finally { await fixture.close(); }
            }
            if (provider === "postgres") {
                const small = canonicalVisits.find(value => value.rows === 10);
                const large = canonicalVisits.find(value => value.rows === 1_000);
                if (!small || !large) throw new Error("Expected both readiness scale controls");
                // A tiny-table scan is a valid planner choice; growing the
                // retained Collection must not grow physical work with it.
                expect(large.rowVisits).toBeLessThanOrEqual(small.rowVisits);
            }
        } finally {
            try { await replaceIndex(canonicalIndex); } finally { await client.$disconnect(); }
        }
    });

    it("keeps all persisted totals equal to a full scan through seeded mutations, assertions, conflicts, forgets and rollbacks", async () => {
        const fixture = await seedAccount(4, "unrelated", { prefixMaxRows: 100 });
        let seed = 0x5eeda11;
        const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
        const exercised = new Set<string>();
        try {
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            for (let step = 0; step < 48; step++) {
                const kind = step % 6;
                const retained = await db.pluginCollectionRow.findMany({ where: { accountId: fixture.accountId, collectionId: "changed" },
                    select: { rowId: true, deletedAt: true }, orderBy: { rowId: "asc" } });
                const candidates = kind === 1 || kind === 2 ? retained.filter(value => value.deletedAt === null) : retained;
                const rowId = kind === 0 || kind === 5 || candidates.length === 0
                    ? `random-${(next() >>> 8) % 8}` : candidates[(next() >>> 8) % candidates.length]!.rowId;
                const row = await db.pluginCollectionRow.findFirst({ where: { accountId: fixture.accountId, rowId },
                    select: { revision: true, deletedAt: true } });
                if (kind === 5) {
                    const liveRows = await db.pluginCollectionRow.count({ where: { accountId: fixture.accountId, deletedAt: null } });
                    const epoch = await db.pluginCollectionAbsenceEpoch.findUnique({ where: { accountId_pluginId_collectionId: {
                        accountId: fixture.accountId, pluginId: fixture.pluginId, collectionId: "changed",
                    } }, select: { epoch: true } });
                    harness.resetEnv({ HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: String(liveRows), HAPPIER_COLLECTION_MAX_BATCH_ROWS: "1" });
                    try {
                        await expect(fixture.mutate([put(`rollback-${step}`, "absent", "rejected", { absenceEpoch: epoch?.epoch ?? 0 })]))
                            .rejects.toMatchObject({ code: "collection_quota_incompatible", dimension: "maxAccountRows" });
                    } finally { harness.resetEnv(); }
                    expect(await db.pluginCollectionRow.count({ where: { accountId: fixture.accountId, rowId: `rollback-${step}` } })).toBe(0);
                    exercised.add("rollback");
                } else if (kind === 0 || !row) {
                    const epoch = await db.pluginCollectionAbsenceEpoch.findUnique({ where: { accountId_pluginId_collectionId: {
                        accountId: fixture.accountId, pluginId: fixture.pluginId, collectionId: "changed",
                    } }, select: { epoch: true } });
                    await expect(fixture.mutate([put(rowId, row?.revision ?? "absent", `雪-${next()}`, {
                        status: next() % 2 === 0 ? "open" : "closed", score: next() / 1e7, absenceEpoch: epoch?.epoch ?? 0,
                    })])).resolves.toMatchObject({ status: "updated" });
                    exercised.add("put");
                } else if (kind === 1) {
                    await expect(fixture.mutate([{ kind: "delete", rowId, expectedRevision: row.revision }]))
                        .resolves.toMatchObject({ status: "updated" });
                    exercised.add("delete");
                } else if (kind === 2) {
                    const epoch = await db.pluginCollectionAbsenceEpoch.findUnique({ where: { accountId_pluginId_collectionId: {
                        accountId: fixture.accountId, pluginId: fixture.pluginId, collectionId: "changed",
                    } }, select: { epoch: true } });
                    await expect(fixture.mutate([{ kind: "assert", rowId, expectedRevision: row.revision },
                        put(`assert-write-${step}`, "absent", "guarded write", { absenceEpoch: epoch?.epoch ?? 0 })]))
                        .resolves.toMatchObject({ status: "updated" });
                    exercised.add("assert");
                } else if (kind === 3) {
                    await expect(fixture.mutate([put(rowId, row.revision + 100)]))
                        .resolves.toMatchObject({ status: "conflict" });
                    exercised.add("conflict");
                } else if (kind === 4) {
                    await expect(fixture.forget(rowId, row.revision)).resolves.toMatchObject({ status: "forgotten" });
                    exercised.add("forget");
                }
                await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            }
            expect([...exercised].sort()).toEqual(["assert", "conflict", "delete", "forget", "put", "rollback"]);
        } finally { harness.resetEnv(); await fixture.close(); }
    });

    it("enforces declared-prefix quota transitions and serializes the final prefix slot", async () => {
        const fixture = await seedAccount(0, "changed", { prefixMaxRows: 2 });
        try {
            const admission = await measureMutation(() => fixture.mutate([put("open-1"), put("open-2")]));
            expect(admission.result).toMatchObject({ status: "updated" });
            expectOneUsageBaseline(admission, true);
            expect(admission.usageIO.flat()).toContain("prefix:write");
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            await expect(fixture.mutate([put("over")])).rejects.toMatchObject({
                code: "collection_quota_incompatible", dimension: "maxRows", effectiveMaximum: 2,
            });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            await expect(fixture.mutate([put("closed", "absent", "outside prefix", { status: "closed" })]))
                .resolves.toMatchObject({ status: "updated" });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            await expect(fixture.mutate([{ kind: "delete", rowId: "open-1", expectedRevision: 1 }]))
                .resolves.toMatchObject({ status: "updated" });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            const admissions = await Promise.allSettled([fixture.mutate([put("contender-1")]), fixture.mutate([put("contender-2")])]);
            expect(admissions.filter(value => value.status === "fulfilled")).toHaveLength(1);
            expect(admissions.find(value => value.status === "rejected")).toMatchObject({
                status: "rejected", reason: { code: "collection_quota_incompatible", dimension: "maxRows", effectiveMaximum: 2 },
            });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
        } finally { await fixture.close(); }
    });

    it("admits strict prefix-count reductions while a retained prefix remains above its declared quota", async () => {
        const fixture = await seedAccount(3, "changed", { prefixMaxRows: 1 });
        try {
            await expect(fixture.mutate([put("row-0", 1)])).rejects.toMatchObject({
                code: "collection_quota_incompatible", dimension: "maxRows", effectiveMaximum: 1,
            });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            await expect(fixture.mutate([put("row-0", 1, "leave prefix", { status: "closed" })]))
                .resolves.toMatchObject({ status: "updated" });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            await expect(fixture.mutate([{ kind: "delete", rowId: "row-1", expectedRevision: 1 }]))
                .resolves.toMatchObject({ status: "updated" });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            await expect(fixture.mutate([put("new")])).rejects.toMatchObject({
                code: "collection_quota_incompatible", dimension: "maxRows", effectiveMaximum: 1,
            });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
        } finally { await fixture.close(); }
    });

    it.each(["materializing", "compatible"] as const)("keeps retained index prefix facts exact through %s promotion and subsequent mutations", async variant => {
        const pluginId = `example.quota-promotion.${randomUUID()}`;
        const collection = { id: "tasks", schemaVersion: 1, rowIdField: "id",
            schema: { type: "object", properties: { id: { type: "string", maxLength: 256 },
                status: { type: "string", enum: ["open", "closed"] }, title: { type: "string", maxLength: 256 } },
                required: ["id", "status", "title"], additionalProperties: false },
            serverReadable: ["id", "status", "title"],
            indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }],
            quota: { maxRowsByIndexPrefix: [{ indexId: "by-status", prefix: ["open"], maxRows: 20 }] },
        };
        const sourceManifest = { schemaVersion: 2, id: pluginId, version: "1.0.0", displayName: "Promoted prefix totals contract",
            engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 }, contributes: { accountCollections: [collection] } };
        const targetManifest = { ...sourceManifest, version: "2.0.0", contributes: { accountCollections: [{ ...collection,
            ...(variant === "materializing" ? { schemaVersion: 2, readableSchemaVersions: [1],
                migrations: [{ id: "upgrade-v1-to-v2", fromSchemaVersion: 1, toSchemaVersion: 2 }] } : {}),
            schema: { ...collection.schema, properties: { ...collection.schema.properties,
                title: { type: "string", maxLength: variant === "materializing" ? 128 : 512 } } },
        }] } };
        const [source] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: sourceManifest }));
        const [target] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: targetManifest }));
        if (!source || !target) throw new Error("Expected source and target promotion contracts");
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        const request = { pluginId, collectionId: "tasks",
            writerContext: { schemaVersion: target.schemaVersion, contractDigest: target.contractDigest } };
        const write = (expectedRevision: number | "absent", title: string, status: "open" | "closed" = "open", absenceEpoch = 0): PluginCollectionPutMutationV1 => {
            const base = { kind: "put", rowId: "task-1", content: { t: "plain", v: {} },
                projection: { id: "task-1", status, title } } as const;
            return expectedRevision === "absent"
                ? { ...base, expectedRevision, expectedAbsenceEpoch: absenceEpoch } : { ...base, expectedRevision };
        };
        const mutateTarget = (operations: PluginCollectionMutationOperationV1[]) => mutatePluginCollection({
            accountId: account.id, authentication, request: { ...request, operations },
        });
        const storedRow = () => db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: account.id, rowId: "task-1" },
            select: { revision: true, contractDigest: true, contentEnvelope: true } });
        const stateSnapshot = (id: string) => db.pluginCollectionIndexState.findUniqueOrThrow({ where: { id },
            select: { id: true, contractId: true, contractDigest: true, quotaPrefixCounts: true,
                entries: { orderBy: { rowId: "asc" }, select: { id: true, encodedSortKey: true, rowId: true, rowRevision: true } } } });
        try {
            for (const [manifest, ref, digest] of [[sourceManifest, source, "a"], [targetManifest, target, "b"]] as const) {
                await db.accountPluginRelease.create({ data: { accountId: account.id, pluginId, version: manifest.version,
                    archiveDigestSha256: `sha256:${digest.repeat(64)}`, normalizedManifest: manifest,
                    collectionContracts: [ref], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${"c".repeat(64)}`, resources: [] } } });
            }
            await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId, desiredVersion: "1.0.0",
                enabled: true, offlineUiHosting: "disabled", writableCollections: [source], revision: 0n } });
            await inTx(tx => preparePluginCollectionWritableContractsTx({ tx, accountId: account.id, pluginId, contracts: [source] }));
            await expect(mutatePluginCollection({ accountId: account.id, authentication, request: { pluginId, collectionId: "tasks",
                writerContext: { schemaVersion: source.schemaVersion, contractDigest: source.contractDigest },
                operations: [write("absent", "Source title")] } })).resolves.toMatchObject({ status: "updated" });
            await assertPluginCollectionUsageTotalsMatchRows(account.id);
            const originalState = await db.pluginCollectionIndexState.findFirstOrThrow({ where: { accountId: account.id,
                contractDigest: source.contractDigest }, select: { id: true } });
            const originalUsage = await db.account.findUniqueOrThrow({ where: { id: account.id },
                select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } });
            if (variant === "materializing") {
                await stagePluginCollectionCandidatePreparation({ accountId: account.id, request: {
                    binding: { source, target, candidate: { releaseVersion: "2.0.0", artifactDigest: `sha256:${"b".repeat(64)}` } },
                    items: [{ source: { rowId: "task-1", revision: 1 }, target: { content: { t: "plain", v: {} },
                        projection: { id: "task-1", status: "open", title: "Materialized title" } } }],
                } });
                await assertPluginCollectionUsageTotalsMatchRows(account.id);
            }
            const availability = createPluginAvailabilityOperations({
                resolveHostingCapability: () => ({ enabled: true, maxArtifactBytes: 1024 * 1024, maxAccountBytes: 4 * 1024 * 1024 }),
                resolveServerIdentityId: async () => "quota-promotion-contract-server",
            });
            await availability.setIntent({ accountId: account.id, input: { pluginId, desiredVersion: "2.0.0", enabled: true,
                offlineUiHosting: "disabled", writableCollections: [target], expectedRevision: "0" } });
            const states = await db.pluginCollectionIndexState.findMany({ where: { accountId: account.id },
                select: { id: true, contractDigest: true, _count: { select: { entries: true } } } });
            const promoted = await storedRow();
            expect(promoted).toMatchObject({ contractDigest: target.contractDigest, revision: variant === "materializing" ? 2 : 1 });
            expect(states.find(state => state.contractDigest === target.contractDigest)?._count.entries).toBe(1);
            let historical: Awaited<ReturnType<typeof stateSnapshot>> | undefined;
            if (variant === "materializing") {
                expect(states).toHaveLength(2);
                expect(states.find(state => state.contractDigest === source.contractDigest)).toMatchObject({ id: originalState.id, _count: { entries: 1 } });
                historical = await stateSnapshot(originalState.id);
            } else {
                expect(states).toEqual([{ id: originalState.id, contractDigest: target.contractDigest, _count: { entries: 1 } }]);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id },
                    select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } })).toEqual(originalUsage);
            }
            const assertFacts = async () => {
                await assertPluginCollectionUsageTotalsMatchRows(account.id);
                if (historical) expect(await stateSnapshot(originalState.id)).toEqual(historical);
            };
            await assertFacts();

            // Fail only after a real prefix-summary write. Both the row and all
            // already-executed counter writes must roll back with this transaction.
            const originalTransaction = db.$transaction;
            const failure = Object.assign(new Error("Injected provider failure after a prefix counter write"), { code: "P2024" });
            let counterWrites = 0;
            harness.resetEnv({ HAPPIER_DB_TX_MAX_RETRIES: "0" });
            db.$transaction = new Proxy(originalTransaction, { apply(owner, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(owner, receiver, args);
                return Reflect.apply(owner, receiver, [async (tx: Tx) => {
                    const observedTx: Tx = Object.create(tx);
                    const stateDelegate = Object.create(tx.pluginCollectionIndexState);
                    const update = tx.pluginCollectionIndexState.update.bind(tx.pluginCollectionIndexState);
                    Object.defineProperty(stateDelegate, "update", { configurable: true, writable: true, value: async (...updateArgs: Parameters<typeof update>) => {
                        const result = await update(...updateArgs);
                        if (updateArgs[0].data.quotaPrefixCounts !== undefined) { counterWrites++; throw failure; }
                        return result;
                    } });
                    Object.defineProperty(observedTx, "pluginCollectionIndexState", { configurable: true, writable: true, value: stateDelegate });
                    return await callback(observedTx);
                }, ...args.slice(1)]);
            } });
            try {
                await expect(mutateTarget([write(promoted.revision, "Rejected changed title", "closed")])).rejects.toBe(failure);
                expect(counterWrites).toBe(1);
            } finally { db.$transaction = originalTransaction; harness.resetEnv(); }
            expect(await storedRow()).toEqual(promoted);
            await assertFacts();

            let revision = promoted.revision;
            for (const title of ["Updated first", "Updated second"]) {
                await expect(mutateTarget([write(revision, title)])).resolves.toMatchObject({
                    status: "updated", results: [{ rowId: "task-1", revision: revision + 1, deleted: false }],
                });
                revision++;
                await assertFacts();
            }
            await expect(mutateTarget([{ kind: "delete", rowId: "task-1", expectedRevision: revision }])).resolves.toMatchObject({
                status: "updated", results: [{ rowId: "task-1", revision: revision + 1, deleted: true }],
            });
            revision++;
            await assertFacts();
            await expect(forgetPluginCollection({ accountId: account.id, request: { ...request, rowId: "task-1", expectedRevision: revision } }))
                .resolves.toMatchObject({ status: "forgotten" });
            await assertFacts();
            expect(await db.pluginCollectionRow.count({ where: { accountId: account.id, rowId: "task-1" } })).toBe(0);
            const epoch = await db.pluginCollectionAbsenceEpoch.findUniqueOrThrow({ where: { accountId_pluginId_collectionId: {
                accountId: account.id, pluginId, collectionId: "tasks",
            } }, select: { epoch: true } });
            expect(epoch.epoch).toBeGreaterThan(revision);
            await expect(mutateTarget([write("absent", "Stale recreation", "open", 0)])).resolves.toMatchObject({ status: "conflict" });
            await assertFacts();
            await expect(mutateTarget([write("absent", "Recreated", "open", epoch.epoch)])).resolves.toMatchObject({
                status: "updated", results: [{ rowId: "task-1", revision: epoch.epoch + 1, deleted: false }],
            });
            revision = epoch.epoch + 1;
            await assertFacts();
            // Live forget reaches the same admitted delete owner before physical retirement.
            await expect(forgetPluginCollection({ accountId: account.id, request: { ...request, rowId: "task-1", expectedRevision: revision } }))
                .resolves.toMatchObject({ status: "forgotten" });
            await assertFacts();
            const nextEpoch = await db.pluginCollectionAbsenceEpoch.findUniqueOrThrow({ where: { accountId_pluginId_collectionId: {
                accountId: account.id, pluginId, collectionId: "tasks",
            } }, select: { epoch: true } });
            await expect(mutateTarget([write("absent", "Recreated again", "open", nextEpoch.epoch)])).resolves.toMatchObject({ status: "updated" });
            await assertFacts();
        } finally {
            harness.resetEnv();
            await db.account.delete({ where: { id: account.id } });
            await db.pluginCollectionContract.deleteMany({ where: { pluginId } });
        }
    });

    it("backfills existing rows idempotently and repairs old-writer insert, update, delete and projection drift", async () => {
        const fixture = await seedAccount(3, "changed", { prefixMaxRows: 20, backfill: false });
        const reference = () => inTx(tx => readPluginCollectionAccountUsageInTx({ tx, accountId: fixture.accountId,
            deployment: readPluginsFeatureEnv(process.env).collectionLimits }));
        const persisted = () => db.account.findUniqueOrThrow({ where: { id: fixture.accountId },
            select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } });
        try {
            expect((await persisted()).pluginCollectionRows).toBe(0n);
            expect((await reference()).rows).toBe(3);
            for (let repeat = 0; repeat < 2; repeat++) {
                await fixture.backfill();
                await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            }
            await expect(fixture.mutate([put("metric-雪-🙂", "absent", "é雪\u2028\\\"\n", { amount: 1e-7, score: 1e21 })]))
                .resolves.toMatchObject({ status: "updated" });
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            const newerManifest = { ...fixture.manifest, version: "2.0.0", contributes: {
                accountCollections: fixture.manifest.contributes.accountCollections.map(value => ({ ...value, schemaVersion: 2 })),
            } };
            await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: newerManifest }));
            const alternate = await db.pluginCollectionContract.findFirstOrThrow({ where: { pluginId: fixture.pluginId,
                collectionId: "changed", schemaVersion: 2 } });
            const alternateContract = readMaterializedPluginCollectionContract(alternate);
            const state = await db.pluginCollectionIndexState.create({ data: { accountId: fixture.accountId,
                pluginId: fixture.pluginId, collectionId: "changed", indexId: "by-status", contractId: alternate.id,
                contractDigest: alternate.contractDigest, buildState: "ready", indexedThroughRevision: 1 } });
            // These are the pre-totals writer's actual storage operations: they deliberately skip usage maintenance.
            const rowId = "legacy-雪-🙂";
            const legacy = await db.pluginCollectionRow.create({ data: { accountId: fixture.accountId, pluginId: fixture.pluginId,
                collectionId: "changed", rowId, schemaVersion: 2, revision: 1, contractId: alternate.id,
                contractDigest: alternate.contractDigest, contentEnvelope: { t: "plain", v: { body: "é雪\u2028\\\"\n", amount: 1e-7 } } } });
            await db.pluginCollectionProjection.createMany({ data: Object.entries({ score: 1e21, status: "open", id: rowId })
                .map(([fieldId, value]) => ({ rowDbId: legacy.id, accountId: fixture.accountId, pluginId: fixture.pluginId,
                    collectionId: "changed", rowId, fieldId, typedEncodedValue: JSON.stringify(value), rowRevision: 1 })) });
            await db.pluginCollectionIndexEntry.createMany({ data: buildPluginCollectionIndexValues({ contract: alternateContract,
                rowId, projection: { id: rowId, status: "open", score: 1e21 } }).map(value => ({ indexStateId: state.id,
                    encodedSortKey: value.encodedSortKey, rowId, rowRevision: 1 })) });
            await db.pluginCollectionRow.updateMany({ where: { accountId: fixture.accountId, rowId: "row-0" },
                data: { contentEnvelope: { t: "plain", v: { body: "changed 雪", amount: 1e21 } }, revision: 2 } });
            await db.pluginCollectionProjection.updateMany({ where: { accountId: fixture.accountId, rowId: "row-0", fieldId: "score" },
                data: { typedEncodedValue: JSON.stringify(1e-7), rowRevision: 2 } });
            await db.pluginCollectionProjection.updateMany({ where: { accountId: fixture.accountId, rowId: "row-0" },
                data: { rowRevision: 2 } });
            await db.pluginCollectionIndexEntry.updateMany({ where: { rowId: "row-0", indexState: { accountId: fixture.accountId } },
                data: { rowRevision: 2 } });
            await db.pluginCollectionIndexEntry.deleteMany({ where: { rowId: { in: ["row-1", "row-2"] },
                indexState: { accountId: fixture.accountId } } });
            await db.pluginCollectionRow.deleteMany({ where: { accountId: fixture.accountId, rowId: "row-1" } });
            await db.pluginCollectionRow.updateMany({ where: { accountId: fixture.accountId, rowId: "row-2" },
                data: { deletedAt: new Date(), revision: 2 } });
            await db.pluginCollectionProjection.deleteMany({ where: { accountId: fixture.accountId, rowId: "row-2" } });
            expect((await persisted()).pluginCollectionRows).not.toBe(BigInt((await reference()).rows));
            for (let repeat = 0; repeat < 2; repeat++) {
                await fixture.backfill();
                await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            }
            // Projection-only drift leaves row count unchanged and still changes the complete stored-row metric.
            await db.pluginCollectionProjection.updateMany({ where: { rowDbId: legacy.id, fieldId: "score" },
                data: { typedEncodedValue: JSON.stringify(-0.000000123) } });
            expect((await persisted()).pluginCollectionRows).toBe(BigInt((await reference()).rows));
            expect((await persisted()).pluginCollectionEncodedBytes).not.toBe(BigInt((await reference()).encodedBytes));
            for (let repeat = 0; repeat < 2; repeat++) {
                await fixture.backfill();
                await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            }
        } finally { await fixture.close(); }
    });
    it.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('repairs a pending totals backfill through the real PostgreSQL migration deployment', async () => {
        const containerId = process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ?? '';
        const poolId = process.env.VITEST_POOL_ID ?? '';
        const databaseUrl = process.env.DATABASE_URL ?? '';
        const url = new URL(databaseUrl);
        if (!/^[a-f0-9]{64}$/.test(containerId) || !/^\d+$/.test(poolId)
            || url.protocol !== 'postgresql:' || url.pathname !== `/happier_contract_${poolId}`) {
            throw new Error('Migration recovery test requires its disposable PostgreSQL worker database');
        }
        const fixture = await seedAccount(3, 'changed', { prefixMaxRows: 20, backfill: false });
        try {
            expect((await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { pluginCollectionRows: true } })).pluginCollectionRows).toBe(0n);
            // Simulates interruption after schema expansion, before the completion migration.
            await db.$executeRawUnsafe('DELETE FROM _prisma_migrations WHERE migration_name = $1', PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION);
            const env = { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, HAPPIER_DB_PROVIDER: 'postgres' };
            await runPostgresMigrationDeploy(env);
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
            const repaired = await db.account.findUniqueOrThrow({ where: { id: fixture.accountId },
                select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } });
            expect(repaired.pluginCollectionRows).toBe(3n);
            await runPostgresMigrationDeploy(env);
            expect(await db.account.findUniqueOrThrow({ where: { id: fixture.accountId },
                select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } })).toEqual(repaired);
            await assertPluginCollectionUsageTotalsMatchRows(fixture.accountId);
        } finally { await fixture.close(); }
    });
});
