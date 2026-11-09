import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginAccountCollectionContributionV1Schema } from "@happier-dev/protocol/plugins/data/collectionContributionV1";

import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { pluginDataRoutes } from "@/app/api/routes/plugins/data/pluginDataRoutes";
import { materializePluginCollectionContractsTx } from "./contracts";

const provider = getDbProviderFromEnv(process.env, "postgres");

describe.skipIf(provider === "sqlite")("Collection presence pooled-provider contract", () => {
    beforeAll(async () => {
        const testUrl = provider === "mysql"
            ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!testUrl || process.env.DATABASE_URL !== testUrl) {
            throw new Error("Use the disposable database contract harness");
        }
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("returns only requested existence facts across retained schemas and isolates Account ownership", async () => {
        const pluginId = `example.presence.${randomUUID()}`;
        const account = await db.account.create({ data: { encryptionMode: "plain", seq: 43 } });
        const other = await db.account.create({ data: { encryptionMode: "plain", seq: 99 } });
        const contribution = (id: string, schemaVersion = 1) => PluginAccountCollectionContributionV1Schema.parse({
            id, schemaVersion, rowIdField: "id", schema: { type: "object",
                properties: { id: { type: "string", maxLength: 256 } }, required: ["id"], additionalProperties: false },
            serverReadable: ["id"], indexes: [],
        });
        await inTx(tx => materializePluginCollectionContractsTx({ tx, pluginId,
            contributions: [contribution("retained"), contribution("deleted"), contribution("foreign"), contribution("unrelated")] }));
        await inTx(tx => materializePluginCollectionContractsTx({ tx, pluginId, contributions: [contribution("retained", 2)] }));
        const contracts = await db.pluginCollectionContract.findMany({ where: { pluginId } });
        const row = (collectionId: string, index: number, accountId = account.id, deletedAt: Date | null = null) => {
            const contract = contracts.find(candidate => candidate.collectionId === collectionId && candidate.schemaVersion === 1)!;
            return { accountId, pluginId, collectionId, rowId: `row-${index}`, schemaVersion: contract.schemaVersion,
                revision: 1, contractId: contract.id, contractDigest: contract.contractDigest,
                contentEnvelope: { t: "plain", v: { id: `row-${index}` } }, deletedAt };
        };
        try {
            await db.pluginCollectionRow.createMany({ data: [row("retained", 0), row("deleted", 1, account.id, new Date()),
                row("foreign", 2, other.id), ...Array.from({ length: 1005 }, (_, index) => row("unrelated", index))] });
            const selections: Array<{ returned: number; parameters: number }> = [];
            let databaseFailure: unknown;
            const transaction = db.$transaction;
            // Observe actual database transfers without substituting storage.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== "$queryRaw") return Reflect.get(inner, property, innerReceiver);
                    return async (...queryArgs: unknown[]) => {
                        let result: unknown;
                        try { result = await Reflect.apply(inner.$queryRaw, inner, queryArgs); }
                        catch (error) { databaseFailure = error; throw error; }
                        const statement = queryArgs[0];
                        if (typeof statement === "object" && statement !== null && "sql" in statement
                            && typeof statement.sql === "string" && statement.sql.includes("PluginCollectionRow")
                            && "values" in statement && Array.isArray(statement.values) && Array.isArray(result)) {
                            expect(statement.sql).not.toContain("contentEnvelope");
                            selections.push({ returned: result.length, parameters: statement.values.length });
                        }
                        return result;
                    };
                } })), ...args.slice(1)]);
            } });
            try { await withAuthenticatedTestApp(pluginDataRoutes, async app => {
                const response = await app.inject({ method: "POST", url: "/v1/plugins/data/presence",
                    headers: { "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "3" },
                    payload: { collections: ["retained", "deleted", "foreign", "empty"].map(collectionId => ({ pluginId, collectionId })) } });
                if (response.statusCode >= 500 && databaseFailure) throw databaseFailure;
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ changeCursor: 43, collections: [
                    { pluginId, collectionId: "retained", present: true }, { pluginId, collectionId: "deleted", present: false },
                    { pluginId, collectionId: "foreign", present: false }, { pluginId, collectionId: "empty", present: false },
                ] });
            }); } finally { db.$transaction = transaction; }
            expect(selections).toEqual([{ returned: 4, parameters: 2 }]);
        } finally {
            await db.account.deleteMany({ where: { id: { in: [account.id, other.id] } } });
            await db.pluginCollectionContract.deleteMany({ where: { pluginId } });
        }
    });
});
