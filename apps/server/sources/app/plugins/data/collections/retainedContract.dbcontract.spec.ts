import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginCollectionContractRefV1 } from "@happier-dev/protocol/plugins/data/collectionContractRefV1";
import type { Prisma } from "@prisma/client";

import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { materializePluginCollectionContractsFromManifestTx } from "./contracts";
import { readCurrentPluginCollectionContract } from "./uiQuery";

function asJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Call through the real database boundary, measuring only retained-release results. */
async function measureRetainedRead<T>(read: () => Promise<T>) {
    const transfers: number[] = [];
    const encodedBytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result,
        (_property, value: unknown) => typeof value === "bigint" ? value.toString() : value));
    const transaction = db.$transaction;
    db.$transaction = new Proxy(transaction, {
        apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    const value = Reflect.get(inner, property, innerReceiver);
                    if (property === "accountPluginRelease") return new Proxy(value, {
                        get(delegate, operation, delegateReceiver) {
                            const method = Reflect.get(delegate, operation, delegateReceiver);
                            if (typeof method !== "function") return method;
                            return async (...queryArgs: unknown[]) => {
                                const result: unknown = await Reflect.apply(method, delegate, queryArgs);
                                transfers.push(encodedBytes(result));
                                return result;
                            };
                        },
                    });
                    if (property !== "$queryRaw") return value;
                    return async (...queryArgs: unknown[]) => {
                        const result: unknown = await Reflect.apply(inner.$queryRaw, inner, queryArgs);
                        const statement = queryArgs[0];
                        if (typeof statement === "object" && statement !== null && "sql" in statement
                            && typeof statement.sql === "string" && statement.sql.includes("AccountPluginRelease")) {
                            transfers.push(encodedBytes(result));
                        }
                        return result;
                    };
                },
            })), ...args.slice(1)]);
        },
    });
    try { return { result: await read(), transfers }; }
    finally { db.$transaction = transaction; }
}

describe("Collection retained-reader membership database contract", () => {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    let sqlite: LightSqliteHarness | undefined;

    beforeAll(async () => {
        if (provider === "sqlite") {
            sqlite = await createLightSqliteHarness({ tempDirPrefix: "happier-retained-contract-",
                initAuth: false, initEncrypt: false, initFiles: false });
            return;
        }
        const testUrl = provider === "mysql" ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
            : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!testUrl || process.env.DATABASE_URL !== testUrl) throw new Error("Use the disposable database contract harness");
        if (provider === "mysql") await initDbMysql(); else initDbPostgres();
        await db.$connect();
    }, 120_000);
    afterAll(async () => { if (sqlite) await sqlite.close(); else await db.$disconnect(); });

    it("admits an older exact reader while unrelated retained arrays do not increase result bytes", async () => {
        const pluginId = `example.retained.${randomUUID()}`;
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const other = await db.account.create({ data: { encryptionMode: "plain" } });
        const collection = (id: string, schemaVersion = 1) => ({ id, schemaVersion,
            rowIdField: "id", schema: { type: "object", properties: { id: { type: "string", maxLength: 256 } },
                required: ["id"], additionalProperties: false }, serverReadable: ["id"], indexes: [],
            ...(schemaVersion === 1 ? { readableSchemaVersions: [2] } : {}),
        });
        const manifest = (version: string, collections: ReturnType<typeof collection>[]) => ({ schemaVersion: 2,
            id: pluginId, version, displayName: "Retained reader fixture", engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 }, contributes: { accountCollections: collections } });
        const olderManifest = manifest("1.0.0", [collection("tasks")]);
        const writerManifest = manifest("2.0.0", [collection("tasks", 2)]);
        const unrelatedManifest = manifest("3.0.0", Array.from({ length: 24 }, (_, i) => collection(`unrelated-${i}`)));
        try {
            const materialize = (value: unknown) => inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: value }));
            const [older] = await materialize(olderManifest);
            const [writer] = await materialize(writerManifest);
            const unrelated = await materialize(unrelatedManifest);
            if (!older || !writer) throw new Error("Expected immutable reader and writer refs");
            const expandedOlderManifest = manifest("1.1.0", [collection("tasks"), ...unrelatedManifest.contributes.accountCollections]);
            const expandedOlder = await materialize(expandedOlderManifest);
            const release = (version: string, refs: readonly PluginCollectionContractRefV1[], normalizedManifest: unknown,
                accountId = account.id, retainedPluginId = pluginId) => ({ accountId, pluginId: retainedPluginId,
                version, archiveDigestSha256: `sha256:${"a".repeat(64)}`, normalizedManifest: asJson(normalizedManifest),
                collectionContracts: asJson(refs), uiSlots: [] });
            await db.accountPluginRelease.createMany({ data: [release("1.0.0", [older], olderManifest),
                release("2.0.0", [writer], writerManifest)] });
            await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId, desiredVersion: "2.0.0",
                enabled: true, offlineUiHosting: "disabled", writableCollections: asJson([writer]) } });
            const read = (ref = older) => readCurrentPluginCollectionContract({ accountId: account.id, request: { ref } });
            const baseline = await measureRetainedRead(() => read());
            expect(baseline.result).toMatchObject({ access: "readOnly", contract: older });
            await db.accountPluginRelease.createMany({ data: [release("1.1.0", expandedOlder, expandedOlderManifest),
                ...Array.from({ length: 998 }, (_, i) =>
                    release(`3.0.${i}`, unrelated, manifest(`3.0.${i}`, unrelatedManifest.contributes.accountCollections)))] });
            await db.accountPluginRelease.deleteMany({ where: { accountId: account.id, pluginId, version: "1.0.0" } });
            const scaled = await measureRetainedRead(() => read());
            expect(scaled.result).toEqual(baseline.result);
            // SQLite read snapshots use their separate connection; the pooled
            // PostgreSQL/MySQL boundary above supplies the transfer cost proof.
            if (provider !== "sqlite") {
                expect(baseline.transfers).toHaveLength(1);
                expect(scaled.transfers).toEqual(baseline.transfers);
            }
            expect(await read(writer)).toMatchObject({ access: "writable", contract: writer });
            if (provider === "postgres") {
                // PGlite speaks the same SQL dialect. Exercise that configured
                // provider against real PostgreSQL without replacing storage.
                const configuredProvider = process.env.HAPPIER_DB_PROVIDER;
                process.env.HAPPIER_DB_PROVIDER = "pglite";
                try { await expect(read()).resolves.toEqual(scaled.result); }
                finally {
                    if (configuredProvider === undefined) delete process.env.HAPPIER_DB_PROVIDER;
                    else process.env.HAPPIER_DB_PROVIDER = configuredProvider;
                }
            }
            const wrongDigest = { ...older, contractDigest: `${older.contractDigest[0] === "A" ? "B" : "A"}${older.contractDigest.slice(1)}` };
            await expect(read(wrongDigest)).rejects.toMatchObject({ code: "collection_unavailable" });
            await db.accountPluginRelease.deleteMany({ where: { accountId: account.id, pluginId, version: "1.1.0" } });
            // The same ref in another Account or another plugin must grant no membership.
            await db.accountPluginRelease.createMany({ data: [release("1.0.0", [older], olderManifest, other.id),
                release("1.0.0", [older], olderManifest, account.id, `${pluginId}.foreign`)] });
            await expect(read()).rejects.toMatchObject({ code: "collection_unavailable" });
            // A release-less intent continues to use the current writer's compatibility decision.
            await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId } },
                data: { desiredVersion: null } });
            await expect(read()).resolves.toMatchObject({ access: "readOnly", contract: older });
        } finally {
            await db.account.deleteMany({ where: { id: { in: [account.id, other.id] } } });
            await db.pluginCollectionContract.deleteMany({ where: { pluginId } });
        }
    });
});
