import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginCollectionProjectionV1Schema } from "@happier-dev/protocol/plugins/data/collectionsV1";

import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { materializePluginCollectionContractsFromManifestTx } from "./contracts";
import { pagePluginCollectionCandidatePreparationSource, stagePluginCollectionCandidatePreparation } from "./candidatePreparation";
import { measurePluginCollectionStoredRowEncodedBytes, readPluginCollectionAccountActivationUsageInTx,
    readPluginCollectionAccountCandidateStageUsageInTx } from "./quota";

async function seedFixture(rowCount: number) {
    const suffix = randomUUID();
    const accountId = `candidate-stage-${suffix}`;
    const pluginId = `example.candidate-stage.${suffix}`;
    const sourceManifest = {
        schemaVersion: 2,
        id: pluginId,
        version: "1.0.0",
        displayName: "Candidate stage database contract",
        engines: { happier: "^1.0.0" },
        runtime: { apiVersion: 1 },
        contributes: { accountCollections: [{
            id: "tasks", schemaVersion: 1, rowIdField: "id",
            schema: { type: "object", properties: { id: { type: "string", maxLength: 256 },
                value: { type: "number" }, label: { type: "string", maxLength: 256 }, text: { type: "string", maxLength: 256 },
                nested: { type: "object", properties: { values: { type: "array", items: { type: "number" }, maxItems: 16 } },
                    required: ["values"], additionalProperties: false } },
                required: ["id", "value", "label"], additionalProperties: false },
            serverReadable: ["id", "value", "label"], indexes: [], relations: [],
        }] },
    } as const;
    const targetManifest = { ...sourceManifest, version: "2.0.0", contributes: { accountCollections: [{
        ...sourceManifest.contributes.accountCollections[0], schemaVersion: 2, readableSchemaVersions: [1],
        migrations: [{ id: "upgrade", fromSchemaVersion: 1, toSchemaVersion: 2 }],
    }] } } as const;
    const [source, target] = await inTx(async tx => {
        const [source] = await materializePluginCollectionContractsFromManifestTx({ tx, manifest: sourceManifest });
        const [target] = await materializePluginCollectionContractsFromManifestTx({ tx, manifest: targetManifest });
        if (!source || !target) throw new Error("Expected fixture contracts");
        return [source, target] as const;
    });
    const contracts = await db.pluginCollectionContract.findMany({ where: { pluginId } });
    const sourceContract = contracts.find(contract => contract.contractDigest === source.contractDigest);
    if (!sourceContract) throw new Error("Expected stored source contract");
    await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
    await db.accountPluginIntent.create({ data: { accountId, pluginId, desiredVersion: "1.0.0", enabled: true,
        offlineUiHosting: "disabled", writableCollections: [source], revision: 0n } });
    await db.accountPluginRelease.createMany({ data: [sourceManifest, targetManifest].map((manifest, index) => ({
        accountId, pluginId, version: manifest.version, archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: JSON.parse(JSON.stringify(manifest)) as Prisma.InputJsonValue,
        collectionContracts: [index === 0 ? source : target], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${"a".repeat(64)}`, resources: [] },
    })) });
    const rowIds = Array.from({ length: rowCount }, (_, index) => `task-${String(index).padStart(6, "0")}`);
    await db.pluginCollectionRow.createMany({ data: rowIds.map(rowId => ({ accountId, pluginId, collectionId: "tasks",
        rowId, schemaVersion: 1, revision: 1, contractId: sourceContract.id, contractDigest: source.contractDigest,
        contentEnvelope: { t: "plain", v: { text: "x".repeat(sourceManifest.contributes.accountCollections[0].schema.properties.text.maxLength) } },
    })) });
    const rows = await db.pluginCollectionRow.findMany({ where: { accountId }, select: { id: true, rowId: true } });
    await db.pluginCollectionProjection.createMany({ data: rows.flatMap(row => [
        { fieldId: "id", typedEncodedValue: JSON.stringify(row.rowId) }, { fieldId: "value", typedEncodedValue: "0" },
        { fieldId: "label", typedEncodedValue: JSON.stringify("fixture") },
    ].map(projection => ({ ...projection, rowDbId: row.id, accountId, pluginId, collectionId: "tasks", rowId: row.rowId, rowRevision: 1 }))) });
    const binding = { source, target, candidate: { releaseVersion: "2.0.0", artifactDigest: `sha256:${"a".repeat(64)}` } };
    return { accountId, contracts, binding, rowIds,
        request: (ids: readonly string[]) => ({ binding, items: ids.map(rowId => ({ source: { rowId, revision: 1 },
            target: { content: { t: "plain", v: {} }, projection: { id: rowId, value: 0, label: "fixture" } },
        })) }),
    };
}

/** Call through the actual PostgreSQL boundary; observe cost and inject one post-write driver failure. */
async function observeStage<T>(run: () => Promise<T>, failAfterInsert = false) {
    const original = db.$transaction;
    const observations = { transactions: 0, inserts: 0, rowBodies: 0, stageBodies: 0, aggregateQueries: 0,
        domainStatements: 0, elapsedMilliseconds: 0 };
    const transaction = async (callback: (tx: Tx) => Promise<unknown>, options?: {
        maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel;
    }) => {
        observations.transactions += 1;
        return await original(async real => callback(new Proxy(real, {
            get(tx, name) {
                const delegate: unknown = Reflect.get(tx, name);
                if (typeof name === "string" && name.startsWith("$") && typeof delegate === "function") {
                    return (...args: unknown[]) => {
                        const sql = typeof args[0] === "string" ? args[0] : Array.isArray(args[0]) ? args[0].join("") : "";
                        if (!/^\s*(SET|SHOW)\b/i.test(sql)) observations.domainStatements += 1;
                        if (sql.includes('WITH "quotaRows"')) observations.aggregateQueries += 1;
                        return Reflect.apply(delegate, tx, args);
                    };
                }
                if (typeof delegate !== "object" || delegate === null) return delegate;
                return new Proxy(delegate, { get(model, operation) {
                    const fn: unknown = Reflect.get(model, operation);
                    if (typeof fn !== "function") return fn;
                    return (...args: unknown[]) => {
                        observations.domainStatements += 1;
                        const query: unknown = Reflect.apply(fn, model, args);
                        if (!query || typeof query !== "object") return query;
                        // Preserve Prisma's lazy query: the production transaction
                        // wrapper must install its remaining SQL budget first.
                        return new Proxy(query, { get(pending, property) {
                            const value: unknown = Reflect.get(pending, property);
                            if (property !== "then" || typeof value !== "function") return value;
                            return (...callbacks: unknown[]) => {
                                const observed: Promise<unknown> = Reflect.apply(value, pending, [(result: unknown) => {
                                    if (operation === "findMany" && Array.isArray(result)) {
                                        for (const row of result) {
                                            if (row && typeof row === "object" && "contentEnvelope" in row) observations.rowBodies += 1;
                                            if (row && typeof row === "object" && "targetContentEnvelope" in row) observations.stageBodies += 1;
                                        }
                                    }
                                    if (name === "pluginCollectionCandidatePreparationStage" && (operation === "create" || operation === "createMany")) {
                                        observations.inserts += 1;
                                        if (failAfterInsert) throw new Error("injected stage database failure after insert");
                                    }
                                    return result;
                                }]);
                                return Reflect.apply(observed.then, observed, callbacks);
                            };
                        } });
                    };
                } });
            },
        })), options);
    };
    // Narrow database-boundary fixture: retain Prisma's public overloaded signature.
    db.$transaction = transaction as typeof db.$transaction;
    const started = performance.now();
    try {
        const result = await run();
        observations.elapsedMilliseconds = performance.now() - started;
        return { result, observations };
    }
    finally { db.$transaction = original; }
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Collection candidate stage PostgreSQL contract", () => {
    const fixtures: Awaited<ReturnType<typeof seedFixture>>[] = [];
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        await db.account.deleteMany({ where: { id: { in: fixtures.map(fixture => fixture.accountId) } } });
        await db.pluginCollectionContract.deleteMany({ where: { id: { in: fixtures.flatMap(fixture => fixture.contracts.map(contract => contract.id)) } } });
        await db.$disconnect();
    });

    it("uses PostgreSQL activation aggregates for pglite without hydrating row bodies", async () => {
        const fixture = await seedFixture(1);
        fixtures.push(fixture);
        const previous = process.env.HAPPIER_DB_PROVIDER;
        process.env.HAPPIER_DB_PROVIDER = "pglite";
        try {
            const measured = await observeStage(() => inTx(tx => readPluginCollectionAccountActivationUsageInTx({
                tx, accountId: fixture.accountId, deployment: readPluginsFeatureEnv(process.env).collectionLimits,
            })));
            expect(measured.result.rows).toBe(1);
            expect(measured.observations.rowBodies).toBe(0);
            expect(measured.observations.aggregateQueries).toBe(1);
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
            else process.env.HAPPIER_DB_PROVIDER = previous;
        }
    });

    it("uses PostgreSQL candidate-stage aggregates for pglite without rereading row bodies", async () => {
        const fixture = await seedFixture(1);
        fixtures.push(fixture);
        const previous = process.env.HAPPIER_DB_PROVIDER;
        process.env.HAPPIER_DB_PROVIDER = "pglite";
        try {
            const measured = await observeStage(() => stagePluginCollectionCandidatePreparation({
                accountId: fixture.accountId, request: fixture.request(fixture.rowIds),
            }));
            expect(measured.result.results).toMatchObject([{ status: "staged" }]);
            expect(measured.observations.rowBodies).toBe(1);
            expect(measured.observations.stageBodies).toBe(0);
            expect(measured.observations.aggregateQueries).toBe(1);
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
            else process.env.HAPPIER_DB_PROVIDER = previous;
        }
    });

    it("stages one configured maximum batch with one setwise insert in one transaction", async () => {
        const limits = readPluginsFeatureEnv(process.env).collectionLimits;
        const batchRows = limits.maxBatchRows;
        const samples = [];
        for (const unrelatedRows of [0, 2_000, limits.maxAccountRows - 2 * batchRows]) {
            const fixture = await seedFixture(batchRows + unrelatedRows);
            fixtures.push(fixture);
            const measured = await observeStage(() => stagePluginCollectionCandidatePreparation({
                accountId: fixture.accountId, request: fixture.request(fixture.rowIds.slice(0, batchRows)),
            }));
            expect(measured.result.results).toHaveLength(batchRows);
            expect(measured.result.results.every(result => result.status === "staged")).toBe(true);
            expect(measured.observations.transactions).toBe(1);
            const retained = await inTx(tx => readPluginCollectionAccountCandidateStageUsageInTx({ tx, accountId: fixture.accountId }));
            console.info("candidate-stage PostgreSQL cost", { batchRows, unrelatedRows, sourcePrivateTextCharacters: 256,
                projectionFields: 3, retainedEncodedBytes: retained.encodedBytes, ...measured.observations });
            samples.push(measured.observations);
            await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: fixture.accountId } })).resolves.toBe(batchRows);
            if (unrelatedRows === limits.maxAccountRows - 2 * batchRows) {
                await expect(stagePluginCollectionCandidatePreparation({ accountId: fixture.accountId,
                    request: fixture.request(fixture.rowIds.slice(batchRows, batchRows + 2)),
                })).rejects.toMatchObject({ code: "collection_quota_incompatible", dimension: "maxRows",
                    effectiveMaximum: limits.maxAccountRows });
                await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: fixture.accountId } })).resolves.toBe(batchRows);
            }
        }
        expect(samples.map(sample => sample.inserts)).toEqual([1, 1, 1]);
        expect(samples.map(sample => sample.rowBodies + sample.stageBodies)).toEqual([0, 0, 0]);
        expect(samples.map(sample => sample.aggregateQueries)).toEqual([1, 1, 1]);
        expect(new Set(samples.map(sample => sample.domainStatements)).size).toBe(1);
    });

    it("matches the JavaScript byte metric for admitted numeric, escaped and nested JSON in live rows and staged targets", async () => {
        const values = [1e21, 1e20, 1e-7, 1e-6, -0, 5e-324, Number.MAX_VALUE, 1000000000000000100, 0.30000000000000004];
        const fixture = await seedFixture(values.length);
        fixtures.push(fixture);
        const request = fixture.request(fixture.rowIds);
        for (const [index, rowId] of fixture.rowIds.entries()) {
            const value = values[index];
            const nestedValues = index === 0 ? [] : index === 1 ? [value] : [value, 0, -value];
            const content = { t: "plain", v: { text: 'spaces : , [1e21] " \\ \b\f\n\r\t é 😀 \u2028',
                nested: { values: nestedValues } } };
            const projection = { id: rowId, value, label: content.v.text };
            // Same admitted finite JS values and JSON round trip as Collection's
            // first-party content writers; Prisma persists the actual jsonb.
            const envelope = JSON.parse(JSON.stringify(content)) as Prisma.InputJsonValue;
            await db.pluginCollectionRow.updateMany({ where: { accountId: fixture.accountId, rowId }, data: { contentEnvelope: envelope } });
            await db.pluginCollectionProjection.updateMany({ where: { accountId: fixture.accountId, rowId, fieldId: "value" },
                data: { typedEncodedValue: JSON.stringify(value) } });
            await db.pluginCollectionProjection.updateMany({ where: { accountId: fixture.accountId, rowId, fieldId: "label" },
                data: { typedEncodedValue: JSON.stringify(projection.label) } });
            request.items[index] = { source: { rowId, revision: 1 }, target: { content, projection } };
        }
        const deployment = readPluginsFeatureEnv(process.env).collectionLimits;
        const live = await inTx(tx => readPluginCollectionAccountActivationUsageInTx({ tx, accountId: fixture.accountId, deployment }));
        const storedRows = await db.pluginCollectionRow.findMany({ where: { accountId: fixture.accountId },
            select: { rowId: true, contentEnvelope: true, projections: { select: { fieldId: true, typedEncodedValue: true } } } });
        const rawRows = await db.$queryRawUnsafe<Array<{ rowId: string; envelopeText: string }>>(
            'SELECT "rowId", "contentEnvelope"::text AS "envelopeText" FROM "PluginCollectionRow" WHERE "accountId" = $1', fixture.accountId,
        );
        for (const row of storedRows) {
            expect(row.contentEnvelope).toEqual(JSON.parse(rawRows.find(raw => raw.rowId === row.rowId)!.envelopeText));
        }
        const liveMeasurements = storedRows.map(measurePluginCollectionStoredRowEncodedBytes);
        const expectedBytes = liveMeasurements.reduce((sum, bytes) => sum + bytes, 0);
        const maximumRowEncodedBytes = Math.max(...liveMeasurements);
        expect(live.encodedBytes).toBe(expectedBytes);
        expect([...live.collections.values()]).toEqual([{ rows: values.length, encodedBytes: expectedBytes, maximumRowEncodedBytes }]);
        await stagePluginCollectionCandidatePreparation({ accountId: fixture.accountId, request });
        const retained = await inTx(tx => readPluginCollectionAccountCandidateStageUsageInTx({ tx, accountId: fixture.accountId }));
        const staged = await db.pluginCollectionCandidatePreparationStage.findMany({ where: { accountId: fixture.accountId },
            select: { rowId: true, targetContentEnvelope: true, targetProjection: true } });
        const stagedMeasurements = staged.map(row => measurePluginCollectionStoredRowEncodedBytes({ rowId: row.rowId,
            contentEnvelope: row.targetContentEnvelope,
            projections: Object.entries(PluginCollectionProjectionV1Schema.parse(row.targetProjection))
                .map(([fieldId, value]) => ({ fieldId, typedEncodedValue: JSON.stringify(value) })),
        }));
        const retainedBytes = expectedBytes + stagedMeasurements.reduce((sum, bytes) => sum + bytes, 0);
        expect(retained.encodedBytes).toBe(retainedBytes);
        expect([...retained.collections.values()]).toEqual([{ rows: 2 * values.length, encodedBytes: retainedBytes,
            maximumRowEncodedBytes: Math.max(maximumRowEncodedBytes, ...stagedMeasurements) }]);
    });

    it("rolls back only a failed batch and resumes prior committed stages at the exact binding", async () => {
        const fixture = await seedFixture(3);
        fixtures.push(fixture);
        await stagePluginCollectionCandidatePreparation({ accountId: fixture.accountId, request: fixture.request(fixture.rowIds.slice(0, 1)) });
        await expect(observeStage(() => stagePluginCollectionCandidatePreparation({
            accountId: fixture.accountId, request: fixture.request(fixture.rowIds.slice(1)),
        }), true)).rejects.toThrow("injected stage database failure after insert");
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: fixture.accountId } })).resolves.toBe(1);
        const page = await pagePluginCollectionCandidatePreparationSource({ accountId: fixture.accountId,
            request: { binding: fixture.binding, limit: 3 },
        });
        expect(page.rows.map(row => [row.rowId, row.alreadyStaged])).toEqual(fixture.rowIds.map((rowId, index) => [rowId, index === 0]));
        const pending = page.rows.filter(row => !row.alreadyStaged).map(row => row.rowId);
        await stagePluginCollectionCandidatePreparation({ accountId: fixture.accountId, request: fixture.request(pending) });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: fixture.accountId } })).resolves.toBe(3);
        await expect(stagePluginCollectionCandidatePreparation({ accountId: fixture.accountId,
            request: fixture.request(fixture.rowIds),
        })).resolves.toEqual({ results: [{ status: "staged" }, { status: "staged" }, { status: "staged" }] });
    });
});
