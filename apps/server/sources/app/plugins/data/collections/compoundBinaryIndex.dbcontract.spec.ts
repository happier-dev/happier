import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    comparePluginCollectionIndexSortKeysV1,
    decodeBase64,
    encodePluginCollectionIndexSortKeyV1,
    type PluginCollectionContractRefV1,
    type PluginCollectionQueryRequestV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { materializePluginCollectionContractsFromManifestTx } from "./contracts";
import { getPluginCollection, queryPluginCollection, queryPluginCollectionUiQuery } from "./uiQuery";
import { createDbMaintenanceClient, db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

type ContractProvider = "postgres" | "mysql" | "sqlite";

const BINARY_INDEX_COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: "example.collection.binary-index-contract",
    version: "1.0.0",
    displayName: "Binary index contract fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: "binary-keys",
            schemaVersion: 1,
            rowIdField: "id",
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    first: { type: "string", maxLength: 256 },
                    second: { type: "string", maxLength: 256 },
                    third: { type: "string", maxLength: 256 },
                    fourth: { type: "string", maxLength: 256 },
                },
                required: ["id", "first", "second", "third", "fourth"],
                additionalProperties: false,
            },
            serverReadable: ["first", "second", "third", "fourth"],
            indexes: [{
                id: "by-four-strings",
                fields: [
                    { field: "first", direction: "asc" },
                    { field: "second", direction: "asc" },
                    { field: "third", direction: "asc" },
                    { field: "fourth", direction: "asc" },
                ],
            }],
            uiQueries: [{ id: "all", indexId: "by-four-strings", parameters: {}, prefix: [],
                order: "asc", pageSize: 10, projectedFields: ["first", "fourth"] }],
            relations: [],
            migrations: [],
            identityFields: [],
        }],
    },
} as const;

function resolveContractProvider(): ContractProvider {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    if (raw === "sqlite") return "sqlite";
    throw new Error(`Unsupported collection binary-index contract provider: ${raw}`);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Fixture JSON must be serializable.");
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function binaryIndexQueryRequest(
    readerContext: PluginCollectionContractRefV1,
    request: Omit<
        PluginCollectionQueryRequestV1,
        "pluginId" | "collectionId" | "readerContext"
    >,
): PluginCollectionQueryRequestV1 {
    return {
        pluginId: BINARY_INDEX_COLLECTION_MANIFEST.id,
        collectionId: BINARY_INDEX_COLLECTION_MANIFEST.contributes.accountCollections[0].id,
        readerContext,
        ...request,
    };
}

async function assertPhysicalColumnContract(provider: ContractProvider): Promise<void> {
    if (provider === "mysql") {
        const columns = await db.$queryRawUnsafe<Array<{
            DATA_TYPE: string;
            CHARACTER_MAXIMUM_LENGTH: bigint | number | null;
            COLUMN_TYPE: string;
            IS_NULLABLE: "YES" | "NO";
        }>>(
            "SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, COLUMN_TYPE, IS_NULLABLE "
            + "FROM INFORMATION_SCHEMA.COLUMNS "
            + "WHERE TABLE_SCHEMA = DATABASE() "
            + "AND TABLE_NAME = 'PluginCollectionIndexEntry' "
            + "AND COLUMN_NAME = 'encodedSortKey'",
        );
        expect(columns).toEqual([{
            DATA_TYPE: "varbinary",
            CHARACTER_MAXIMUM_LENGTH: expect.anything(),
            COLUMN_TYPE: "varbinary(2318)",
            IS_NULLABLE: "NO",
        }]);
        expect(Number(columns[0]!.CHARACTER_MAXIMUM_LENGTH)).toBe(2_318);
        return;
    }
    const columns = await db.$queryRawUnsafe<Array<{
        data_type: string;
        udt_name: string;
        is_nullable: "YES" | "NO";
    }>>(
        "SELECT data_type, udt_name, is_nullable "
        + "FROM information_schema.columns "
        + "WHERE table_schema = current_schema() "
        + "AND table_name = 'PluginCollectionIndexEntry' "
        + "AND column_name = 'encodedSortKey'",
    );
    expect(columns).toEqual([{
        data_type: "bytea",
        udt_name: "bytea",
        is_nullable: "NO",
    }]);
}

async function seedBinaryIndexCollectionAccount(accountId: string): Promise<Readonly<{
    firstRowId: string;
    secondRowId: string;
    rangedRowId: string;
    firstKey: Uint8Array;
    secondKey: Uint8Array;
    rangedKey: Uint8Array;
    readerContext: PluginCollectionContractRefV1;
}>> {
    const allNul = "\u0000".repeat(256);
    const rangedFourth = `${"\u0000".repeat(255)}\u0001`;
    const firstRowId = "r".repeat(256);
    const secondRowId = "s".repeat(256);
    const rangedRowId = "t".repeat(256);
    const rows = [
        { rowId: firstRowId, revision: 1, fourth: allNul },
        { rowId: secondRowId, revision: 2, fourth: allNul },
        { rowId: rangedRowId, revision: 3, fourth: rangedFourth },
    ] as const;
    const allNulFields = [
        { kind: "string" as const, value: allNul },
        { kind: "string" as const, value: allNul },
        { kind: "string" as const, value: allNul },
        { kind: "string" as const, value: allNul },
    ];
    const firstKey = encodePluginCollectionIndexSortKeyV1({ fields: allNulFields, rowId: firstRowId });
    const secondKey = encodePluginCollectionIndexSortKeyV1({ fields: allNulFields, rowId: secondRowId });
    const rangedKey = encodePluginCollectionIndexSortKeyV1({
        fields: [
            ...allNulFields.slice(0, 3),
            { kind: "string", value: rangedFourth },
        ],
        rowId: rangedRowId,
    });

    await db.account.create({
        data: {
            id: accountId,
            encryptionMode: "plain",
            seq: 91,
        },
    });
    const [ref] = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: BINARY_INDEX_COLLECTION_MANIFEST,
        })
    ));
    if (!ref) throw new Error("Fixture binary collection contract was not materialized.");
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
        select: { id: true },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId,
            pluginId: ref.pluginId,
            desiredVersion: BINARY_INDEX_COLLECTION_MANIFEST.version,
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson([ref]),
            revision: BigInt(1),
        },
    });
    await db.accountPluginRelease.create({
        data: {
            accountId,
            pluginId: ref.pluginId,
            version: BINARY_INDEX_COLLECTION_MANIFEST.version,
            archiveDigestSha256: `sha256:${"f".repeat(64)}`,
            normalizedManifest: toPrismaJson(BINARY_INDEX_COLLECTION_MANIFEST),
            collectionContracts: toPrismaJson([ref]),
            uiSlots: toPrismaJson([]),
        },
    });
    const indexState = await db.pluginCollectionIndexState.create({
        data: {
            accountId,
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            indexId: "by-four-strings",
            contractId: contract.id,
            contractDigest: ref.contractDigest,
            buildState: "ready",
            indexedThroughRevision: 3,
        },
        select: { id: true },
    });
    for (const row of rows) {
        const stored = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: row.rowId,
                schemaVersion: ref.schemaVersion,
                revision: row.revision,
                contractId: contract.id,
                contractDigest: ref.contractDigest,
                contentEnvelope: toPrismaJson({ t: "plain", v: { rowId: row.rowId } }),
            },
        });
        await db.pluginCollectionProjection.createMany({
            data: ["first", "second", "third", "fourth"].map((fieldId) => ({
                rowDbId: stored.id,
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: row.rowId,
                fieldId,
                typedEncodedValue: JSON.stringify(fieldId === "fourth" ? row.fourth : allNul),
                rowRevision: row.revision,
            })),
        });
        await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: indexState.id,
                encodedSortKey: copyBytes(encodePluginCollectionIndexSortKeyV1({
                    fields: [
                        { kind: "string", value: allNul },
                        { kind: "string", value: allNul },
                        { kind: "string", value: allNul },
                        { kind: "string", value: row.fourth },
                    ],
                    rowId: row.rowId,
                })),
                rowId: row.rowId,
                rowRevision: row.revision,
            },
        });
    }
    return { firstRowId, secondRowId, rangedRowId, firstKey, secondKey, rangedKey, readerContext: ref };
}

describe("PluginCollectionIndexEntry binary compound-key DB contract", () => {
    const provider = resolveContractProvider();
    let connected = false;
    let sqlite: LightSqliteHarness | undefined;

    beforeAll(async () => {
        if (provider === "sqlite") {
            sqlite = await createLightSqliteHarness({ tempDirPrefix: "happier-collection-prefix-set-" });
            return;
        }
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (sqlite) await sqlite.close();
        if (connected) await db.$disconnect();
    });

    it.skipIf(provider === "sqlite")("uses the exact native binary column definition", async () => {
        await assertPhysicalColumnContract(provider);
    });

    it("reads a prefix set in one indexed storage selection with set-bound paging", async () => {
        const accountId = `collection-prefix-set-${randomUUID()}`;
        const { readerContext, firstRowId, secondRowId } = await seedBinaryIndexCollectionAccount(accountId);
        const allNul = "\u0000".repeat(256);
        const prefixes = Array.from({ length: 1_000 }, (_, index) => [`missing-${index}`]);
        prefixes.push([allNul, allNul, allNul, allNul]);
        // Duplicate/overlapping predicates must not duplicate a stored row.
        prefixes.push([allNul, allNul, allNul, allNul]);
        let selections = 0;
        const transaction = db.$transaction;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== "$queryRaw") return Reflect.get(inner, property, innerReceiver);
                return (...queryArgs: unknown[]) => {
                    const statement = queryArgs[0];
                    if (typeof statement === "object" && statement !== null && "sql" in statement
                        && typeof statement.sql === "string" && statement.sql.includes("PluginCollectionIndexEntry")) selections++;
                    return Reflect.apply(inner.$queryRaw, inner, queryArgs);
                };
            } })), ...args.slice(1)]);
        } });
        try {
            const request = { indexId: "by-four-strings", prefix: [], prefixes, order: "asc" as const, limit: 1 };
            const first = await queryPluginCollection({ accountId, request: binaryIndexQueryRequest(readerContext, request) });
            expect(first.rows.map(row => row.rowId)).toEqual([firstRowId]);
            // SQLite's native snapshot connection bypasses Prisma's transaction
            // callback; the SQL count is measured on the pooled providers.
            if (provider !== "sqlite") expect(selections).toBe(1);
            const next = await queryPluginCollection({ accountId, request: binaryIndexQueryRequest(readerContext, {
                ...request, cursor: first.nextCursor,
            }) });
            expect(next.rows.map(row => row.rowId)).toEqual([secondRowId]);
            expect(next.nextCursor).toBeUndefined();
            await expect(queryPluginCollection({ accountId, request: binaryIndexQueryRequest(readerContext, {
                ...request, prefixes: [["different"]], cursor: first.nextCursor,
            }) })).rejects.toMatchObject({ code: "collection_cursor_invalid" });
        } finally {
            db.$transaction = transaction;
            await db.account.deleteMany({ where: { id: accountId } });
        }
    });

    it.skipIf(provider !== "postgres").each(["get", "query", "ui"] as const)(
        "captures %s Collection rows with their original cursor without predicate locks and rechecks availability", async kind => {
            const accountId = `collection-capture-${randomUUID()}`;
            const { readerContext, firstRowId } = await seedBinaryIndexCollectionAccount(accountId);
            const transaction = db.$transaction;
            const snapshotUrl = new URL(process.env.DATABASE_URL!);
            snapshotUrl.searchParams.set("connection_limit", "1");
            const snapshotClient = await createDbMaintenanceClient("postgres", snapshotUrl.toString());
            let releaseWriter!: () => void;
            const writerReleased = new Promise<void>(resolve => { releaseWriter = resolve; });
            let writerReady!: () => void;
            const ready = new Promise<void>(resolve => { writerReady = resolve; });
            const writer = Reflect.apply(transaction, db, [async (tx: Tx) => {
                await tx.account.update({ where: { id: accountId }, data: { seq: 92 } });
                await tx.pluginCollectionRow.updateMany({ where: { accountId, rowId: firstRowId }, data: { revision: 4 } });
                await tx.pluginCollectionProjection.updateMany({ where: { accountId, rowId: firstRowId }, data: { rowRevision: 4 } });
                await tx.pluginCollectionIndexEntry.updateMany({ where: { indexState: { accountId }, rowId: firstRowId }, data: { rowRevision: 4 } });
                writerReady();
                await writerReleased;
            }, { isolationLevel: "Serializable" }]) as Promise<void>;
            const writerOutcome = Promise.allSettled([writer]);
            await Promise.race([ready, writer]);
            let releaseKeeper!: () => void;
            const keeperReleased = new Promise<void>(resolve => { releaseKeeper = resolve; });
            let keeperReady!: () => void;
            const keeperStarted = new Promise<void>(resolve => { keeperReady = resolve; });
            // A prior overlapping Serializable reader retains the first
            // capture's SSI predicates after the publisher has committed.
            const keeper = Reflect.apply(transaction, db, [async (tx: Tx) => {
                await tx.account.count();
                keeperReady();
                await keeperReleased;
            }, { isolationLevel: "Serializable" }]) as Promise<void>;
            const keeperOutcome = Promise.allSettled([keeper]);
            await Promise.race([keeperStarted, keeper]);
            // Reuse a connection with retained SSI locks from an older transaction.
            // The capture must be measured by its own virtual transaction, not its PID.
            await snapshotClient.$transaction(tx => tx.account.count(), { isolationLevel: "Serializable" });
            let captured = false;
            let predicateLocks = -1;
            let retainedPredicateLocks = 0;
            db.$transaction = new Proxy(snapshotClient.$transaction, { apply(target, _receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, snapshotClient, args);
                return Reflect.apply(target, snapshotClient, [async (tx: Tx) => {
                    const result = await callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                        if (property !== "account") return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.account, { get(model, method, modelReceiver) {
                            if (method !== "findUnique") return Reflect.get(model, method, modelReceiver);
                            return async (...queryArgs: unknown[]) => {
                                const result = await Reflect.apply(model.findUnique, model, queryArgs);
                                if (!captured) { captured = true; releaseWriter(); await writer; }
                                return result;
                            };
                        } });
                    } }));
                    const [{ total, active }] = await tx.$queryRaw<Array<{ total: number; active: number }>>`
                        SELECT count(*)::int AS total,
                            count(*) FILTER (WHERE virtualtransaction IN (
                                SELECT virtualtransaction FROM pg_locks
                                WHERE pid = pg_backend_pid() AND locktype = 'virtualxid'
                                    AND mode = 'ExclusiveLock' AND granted
                            ))::int AS active
                        FROM pg_locks WHERE pid = pg_backend_pid() AND mode = 'SIReadLock'
                    `;
                    predicateLocks = Math.max(predicateLocks, active);
                    retainedPredicateLocks = Math.max(retainedPredicateLocks, total - active);
                    return result;
                }, ...args.slice(1)]);
            } });
            const request = { pluginId: readerContext.pluginId, collectionId: readerContext.collectionId, readerContext };
            const read = () => kind === "get"
                ? getPluginCollection({ accountId, request: { ...request, rowId: firstRowId } })
                : kind === "query"
                    ? queryPluginCollection({ accountId, request: { ...request, indexId: "by-four-strings", prefix: [], order: "asc", limit: 10 } })
                    : queryPluginCollectionUiQuery({ accountId, request: { ...request, uiQueryId: "all", parameters: {} } });
            try {
                const before = await read();
                const after = await read();
                if (kind === "get") {
                    expect(before).toMatchObject({ row: { rowId: firstRowId, revision: 1 } });
                    expect(after).toMatchObject({ row: { rowId: firstRowId, revision: 4 } });
                } else {
                    const field = kind === "ui" ? "context" : undefined;
                    expect(before).toMatchObject({ changeCursor: 91, rows: [field
                        ? { context: { rowId: firstRowId, revision: 1 } } : { rowId: firstRowId, revision: 1 }, {}, {}] });
                    expect(after).toMatchObject({ changeCursor: 92, rows: [field
                        ? { context: { rowId: firstRowId, revision: 4 } } : { rowId: firstRowId, revision: 4 }, {}, {}] });
                }
                console.info('W13_COLLECTION_PREDICATE_LOCKS', { kind, predicateLocks, retainedPredicateLocks });
                expect(retainedPredicateLocks).toBeGreaterThan(0);
                expect(predicateLocks).toBe(0);
                await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId: readerContext.pluginId } }, data: { enabled: false } });
                await expect(read()).rejects.toMatchObject({ code: "collection_unavailable" });
                await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId: readerContext.pluginId } }, data: { enabled: true } });
                // Commit a valid mode transition after materialization, before
                // the public reader's final currentness check may disclose it.
                db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        const result = await callback(tx);
                        await db.account.update({ where: { id: accountId }, data: {
                            encryptionMode: "e2ee", ...createSignedAccountContentBinding(),
                        } });
                        return result;
                    }, ...args.slice(1)]);
                } });
                await expect(read()).rejects.toMatchObject({ code: "collection_content_mode_mismatch" });
            } finally {
                releaseWriter();
                releaseKeeper();
                db.$transaction = transaction;
                await writerOutcome;
                await keeperOutcome;
                await snapshotClient.$disconnect();
                await db.account.deleteMany({ where: { id: accountId } });
            }
        },
    );

    it("persists raw ordinal compound keys byte-for-byte through the canonical reader", async () => {
        const suffix = randomUUID();
        const accountId = `collection-binary-index-account-${suffix}`;
        const allNul = "\u0000".repeat(256);
        const fullPrefix = [allNul, allNul, allNul, allNul];
        const shorterPrefix = fullPrefix.slice(0, 3);
        try {
            const {
                firstRowId,
                secondRowId,
                rangedRowId,
                firstKey,
                secondKey,
                rangedKey,
                readerContext,
            } = await seedBinaryIndexCollectionAccount(accountId);
            expect(firstKey.byteLength).toBe(2_318);
            expect(secondKey.byteLength).toBe(2_318);
            expect(rangedKey.byteLength).toBe(2_317);
            expect(comparePluginCollectionIndexSortKeysV1(firstKey, secondKey)).toBeLessThan(0);
            expect(comparePluginCollectionIndexSortKeysV1(secondKey, rangedKey)).toBeLessThan(0);

            const equality = await db.pluginCollectionIndexEntry.findMany({
                where: {
                    indexState: { accountId },
                    encodedSortKey: { equals: copyBytes(firstKey) },
                },
                select: { encodedSortKey: true, rowId: true },
            });
            expect(equality).toHaveLength(1);
            expect(equality[0]!.rowId).toBe(firstRowId);
            expect(Array.from(equality[0]!.encodedSortKey)).toEqual(Array.from(firstKey));

            const allEntries = await db.pluginCollectionIndexEntry.findMany({
                where: { indexState: { accountId } },
                orderBy: { encodedSortKey: "asc" },
                select: { encodedSortKey: true, rowId: true },
            });
            expect(allEntries.map((entry) => entry.rowId)).toEqual([firstRowId, secondRowId, rangedRowId]);
            expect(allEntries.map((entry) => Array.from(entry.encodedSortKey))).toEqual([
                Array.from(firstKey),
                Array.from(secondKey),
                Array.from(rangedKey),
            ]);

            const firstPage = await queryPluginCollection({
                accountId,
                request: binaryIndexQueryRequest(readerContext, {
                    indexId: "by-four-strings",
                    prefix: fullPrefix,
                    order: "asc",
                    limit: 1,
                }),
            });
            expect(firstPage.rows.map((row) => row.rowId)).toEqual([firstRowId]);
            expect(firstPage.nextCursor).toEqual(expect.any(String));
            if (!firstPage.nextCursor) throw new Error("Expected a maximum-key cursor.");
            expect(firstPage.nextCursor.length).toBeLessThanOrEqual(4_096);
            const rawCursor = decodeBase64(firstPage.nextCursor, "base64url");
            expect(rawCursor.byteLength).toBe(2_353);
            expect(rawCursor[0]).toBe(1);

            const resumed = await queryPluginCollection({
                accountId,
                request: binaryIndexQueryRequest(readerContext, {
                    indexId: "by-four-strings",
                    prefix: fullPrefix,
                    order: "asc",
                    limit: 1,
                    cursor: firstPage.nextCursor,
                }),
            });
            expect(resumed.rows.map((row) => row.rowId)).toEqual([secondRowId]);

            const prefix = await queryPluginCollection({
                accountId,
                request: binaryIndexQueryRequest(readerContext, {
                    indexId: "by-four-strings",
                    prefix: shorterPrefix,
                    order: "asc",
                    limit: 200,
                }),
            });
            expect(prefix.rows.map((row) => row.rowId)).toEqual([firstRowId, secondRowId, rangedRowId]);

            const range = await queryPluginCollection({
                accountId,
                request: binaryIndexQueryRequest(readerContext, {
                    indexId: "by-four-strings",
                    prefix: shorterPrefix,
                    range: { lower: allNul, upper: allNul },
                    order: "asc",
                    limit: 200,
                }),
            });
            expect(range.rows.map((row) => row.rowId)).toEqual([firstRowId, secondRowId]);

            const descending = await queryPluginCollection({
                accountId,
                request: binaryIndexQueryRequest(readerContext, {
                    indexId: "by-four-strings",
                    prefix: fullPrefix,
                    order: "desc",
                    limit: 1,
                }),
            });
            expect(descending.rows.map((row) => row.rowId)).toEqual([secondRowId]);
            if (!descending.nextCursor) throw new Error("Expected a descending maximum-key cursor.");
            const descendingResumed = await queryPluginCollection({
                accountId,
                request: binaryIndexQueryRequest(readerContext, {
                    indexId: "by-four-strings",
                    prefix: fullPrefix,
                    order: "desc",
                    limit: 1,
                    cursor: descending.nextCursor,
                }),
            });
            expect(descendingResumed.rows.map((row) => row.rowId)).toEqual([firstRowId]);
        } finally {
            await db.account.deleteMany({ where: { id: accountId } }).catch(() => undefined);
        }
    });
});
