import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    comparePluginCollectionIndexSortKeysV1,
    decodeBase64,
    encodePluginCollectionIndexSortKeyV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { materializePluginCollectionContractsFromManifestTx } from "./contracts";
import { queryPluginCollection } from "./uiQuery";
import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";

type ContractProvider = "postgres" | "mysql";

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
        }],
    },
} as const;

function resolveContractProvider(): ContractProvider {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
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
    return { firstRowId, secondRowId, rangedRowId, firstKey, secondKey, rangedKey };
}

describe("PluginCollectionIndexEntry binary compound-key DB contract", () => {
    const provider = resolveContractProvider();
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
    });

    it("uses the exact native binary column definition", async () => {
        await assertPhysicalColumnContract(provider);
    });

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
                request: {
                    pluginId: BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: fullPrefix,
                    order: "asc",
                    limit: 1,
                },
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
                request: {
                    pluginId: BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: fullPrefix,
                    order: "asc",
                    limit: 1,
                    cursor: firstPage.nextCursor,
                },
            });
            expect(resumed.rows.map((row) => row.rowId)).toEqual([secondRowId]);

            const prefix = await queryPluginCollection({
                accountId,
                request: {
                    pluginId: BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: shorterPrefix,
                    order: "asc",
                    limit: 200,
                },
            });
            expect(prefix.rows.map((row) => row.rowId)).toEqual([firstRowId, secondRowId, rangedRowId]);

            const range = await queryPluginCollection({
                accountId,
                request: {
                    pluginId: BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: shorterPrefix,
                    range: { lower: allNul, upper: allNul },
                    order: "asc",
                    limit: 200,
                },
            });
            expect(range.rows.map((row) => row.rowId)).toEqual([firstRowId, secondRowId]);

            const descending = await queryPluginCollection({
                accountId,
                request: {
                    pluginId: BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: fullPrefix,
                    order: "desc",
                    limit: 1,
                },
            });
            expect(descending.rows.map((row) => row.rowId)).toEqual([secondRowId]);
            if (!descending.nextCursor) throw new Error("Expected a descending maximum-key cursor.");
            const descendingResumed = await queryPluginCollection({
                accountId,
                request: {
                    pluginId: BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: fullPrefix,
                    order: "desc",
                    limit: 1,
                    cursor: descending.nextCursor,
                },
            });
            expect(descendingResumed.rows.map((row) => row.rowId)).toEqual([firstRowId]);
        } finally {
            await db.account.deleteMany({ where: { id: accountId } }).catch(() => undefined);
        }
    });
});
