import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

import {
    materializePluginCollectionContractsFromManifestTx,
    preparePluginCollectionWritableContractsTx,
    readMaterializedPluginCollectionContract,
} from "./contracts";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

const PLUGIN_ID = "example.collection-contract";
const COLLECTION_ID = "tasks";

const V1_MANIFEST = {
    schemaVersion: 2,
    id: PLUGIN_ID,
    version: "1.0.0",
    displayName: "Collection contract fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: COLLECTION_ID,
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["closed", "open"] },
                    title: { type: "string", maxLength: 256 },
                    dueAt: { type: "string", format: "date-time", maxLength: 64 },
                    projectId: { type: "string", maxLength: 256 },
                },
                required: ["id", "status", "title", "dueAt", "projectId"],
                additionalProperties: false,
            },
            serverReadable: ["status", "title", "dueAt", "projectId"],
            indexes: [{
                id: "byProjectAndStatus",
                fields: [
                    { field: "projectId", direction: "asc" },
                    { field: "status", direction: "asc" },
                    { field: "dueAt", direction: "asc" },
                ],
            }],
            uiQueries: [{
                id: "openByProject",
                indexId: "byProjectAndStatus",
                parameters: { projectId: { kind: "string", maxUtf8Bytes: 256 } },
                prefix: [
                    { kind: "parameter", parameterId: "projectId" },
                    { kind: "literal", value: "open" },
                ],
                order: "asc",
                pageSize: 50,
                projectedFields: ["title", "status", "dueAt"],
            }],
        }],
    },
} as const;

const V2_MANIFEST = {
    ...V1_MANIFEST,
    version: "2.0.0",
    contributes: {
        accountCollections: [{
            ...V1_MANIFEST.contributes.accountCollections[0],
            schemaVersion: 2,
            readableSchemaVersions: [1],
            migrations: [{
                id: "upgrade-v1-to-v2",
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
            }],
        }],
    },
} as const;

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Fixture JSON must be serializable.");
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

async function createPlainAccount(accountId: string): Promise<void> {
    await db.account.create({
        data: {
            id: accountId,
            publicKey: null,
            encryptionMode: "plain",
            seq: 0,
        },
    });
}

async function materialize(manifest: unknown) {
    return await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({ tx, manifest })
    ));
}

describe("plugin collection writable-contract readiness", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-collection-contract-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.pluginCollectionIndexEntry.deleteMany(),
            () => db.pluginCollectionProjection.deleteMany(),
            () => db.pluginCollectionRelation.deleteMany(),
            () => db.pluginCollectionRow.deleteMany(),
            () => db.pluginCollectionIndexState.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.pluginCollectionContract.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("materializes and reconstructs lower-camel members before readying the exact immutable contract ref", async () => {
        const accountId = "account-empty-contract";
        await createPlainAccount(accountId);
        const [ref] = await materialize(V1_MANIFEST);
        if (!ref) throw new Error("Expected one materialized contract ref.");

        const persisted = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
            },
        });
        expect(readMaterializedPluginCollectionContract(persisted)).toMatchObject({
            rowIdField: "id",
            serverReadable: ["dueAt", "projectId", "status", "title"],
            indexes: [{
                id: "byProjectAndStatus",
                fields: [
                    { field: "projectId", direction: "asc" },
                    { field: "status", direction: "asc" },
                    { field: "dueAt", direction: "asc" },
                ],
            }],
            uiQueries: [{
                id: "openByProject",
                indexId: "byProjectAndStatus",
                parameters: { projectId: { kind: "string", maxUtf8Bytes: 256 } },
                projectedFields: [
                    { field: "dueAt", kind: "instant" },
                    { field: "status", kind: "string" },
                    { field: "title", kind: "string" },
                ],
            }],
        });
        const malformedPrivacyProjection = JSON.parse(
            JSON.stringify(persisted.privacyProjection),
        ) as Record<string, unknown>;
        expect(() => readMaterializedPluginCollectionContract({
            ...persisted,
            privacyProjection: {
                ...malformedPrivacyProjection,
                serverReadable: ["dueAt", "projectId", "status", "title", "project_id"],
            },
        })).toThrowError(expect.objectContaining({ code: "collection_contract_inconsistent" }));

        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: PLUGIN_ID,
                contracts: [ref],
            })
        ))).resolves.toEqual({ contracts: [ref] });

        await expect(db.pluginCollectionIndexState.findMany({
            where: { accountId, pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
            select: {
                indexId: true,
                buildState: true,
                indexedThroughRevision: true,
                contractDigest: true,
            },
        })).resolves.toEqual([{
            indexId: "byProjectAndStatus",
            buildState: "ready",
            indexedThroughRevision: 0,
            contractDigest: ref.contractDigest,
        }]);

        const differentDigest = `${ref.contractDigest.slice(0, -1)}${
            ref.contractDigest.endsWith("A") ? "B" : "A"
        }`;
        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: PLUGIN_ID,
                contracts: [{ ...ref, contractDigest: differentDigest }],
            })
        ))).rejects.toMatchObject({ code: "collection_writer_contract_unavailable" });
    });

    it("retains the admitted finite migration identities when reconstructing a persisted target contract", async () => {
        const [ref] = await materialize(V2_MANIFEST);
        if (!ref) throw new Error("Expected one materialized target contract ref.");

        const persisted = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
            },
        });

        expect(readMaterializedPluginCollectionContract(persisted).migrations).toEqual([{
            id: "upgrade-v1-to-v2",
            fromSchemaVersion: 1,
            toSchemaVersion: 2,
        }]);
    });

    it("persists a target candidate stage separately from its incumbent canonical row", async () => {
        const accountId = "account-target-stage";
        await createPlainAccount(accountId);
        const [v1] = await materialize(V1_MANIFEST);
        const [v2] = await materialize(V2_MANIFEST);
        if (!v1 || !v2) throw new Error("Expected immutable source and target contract refs.");
        const sourceContract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: v1.pluginId,
                collectionId: v1.collectionId,
                schemaVersion: v1.schemaVersion,
                contractDigest: v1.contractDigest,
            },
            select: { id: true },
        });
        const targetContract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: v2.pluginId,
                collectionId: v2.collectionId,
                schemaVersion: v2.schemaVersion,
                contractDigest: v2.contractDigest,
            },
            select: { id: true },
        });
        const sourceRow = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "task-1",
                schemaVersion: v1.schemaVersion,
                revision: 7,
                contractId: sourceContract.id,
                contractDigest: v1.contractDigest,
                contentEnvelope: toPrismaJson({ t: "plain", v: {} }),
            },
            select: { id: true },
        });

        await db.$executeRaw`
            INSERT INTO "PluginCollectionCandidatePreparationStage" (
                "id",
                "accountId",
                "pluginId",
                "collectionId",
                "rowId",
                "candidateIdentity",
                "sourceRowDbId",
                "sourceContractId",
                "sourceSchemaVersion",
                "sourceContractDigest",
                "sourceRevision",
                "targetContractId",
                "targetSchemaVersion",
                "targetContractDigest",
                "candidateReleaseVersion",
                "candidateArtifactDigest",
                "targetContentEnvelope",
                "targetProjection",
                "createdAt",
                "updatedAt"
            ) VALUES (
                ${"target-stage-1"},
                ${accountId},
                ${PLUGIN_ID},
                ${COLLECTION_ID},
                ${"task-1"},
                ${"a".repeat(43)},
                ${sourceRow.id},
                ${sourceContract.id},
                ${v1.schemaVersion},
                ${v1.contractDigest},
                ${7},
                ${targetContract.id},
                ${v2.schemaVersion},
                ${v2.contractDigest},
                ${"2.0.0"},
                ${`sha256:${"a".repeat(64)}`},
                ${JSON.stringify({ t: "plain", v: { note: "target" } })},
                ${JSON.stringify({
                    id: "task-1",
                    status: "open",
                    title: "Target task",
                    dueAt: "2026-08-15T00:00:00.000Z",
                    projectId: "project-1",
                })},
                ${new Date()},
                ${new Date()}
            )
        `;

        const stages = await db.$queryRaw<Array<Readonly<{
            sourceRevision: number;
            sourceContractDigest: string;
            targetContractDigest: string;
            candidateReleaseVersion: string;
            candidateArtifactDigest: string;
        }>>>`
            SELECT
                "sourceRevision",
                "sourceContractDigest",
                "targetContractDigest",
                "candidateReleaseVersion",
                "candidateArtifactDigest"
            FROM "PluginCollectionCandidatePreparationStage"
            WHERE "accountId" = ${accountId}
        `;
        expect(stages).toEqual([{
            sourceRevision: 7,
            sourceContractDigest: v1.contractDigest,
            targetContractDigest: v2.contractDigest,
            candidateReleaseVersion: "2.0.0",
            candidateArtifactDigest: `sha256:${"a".repeat(64)}`,
        }]);
        await expect(db.pluginCollectionRow.findFirstOrThrow({
            where: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "task-1",
            },
            select: {
                schemaVersion: true,
                revision: true,
                contractDigest: true,
            },
        })).resolves.toEqual({
            schemaVersion: v1.schemaVersion,
            revision: 7,
            contractDigest: v1.contractDigest,
        });
    });

    it("rejects a writable contract that requests more than the active deployment quota without publishing index readiness", async () => {
        const accountId = "account-deployment-quota-incompatible";
        await createPlainAccount(accountId);
        const [ref] = await materialize({
            ...V1_MANIFEST,
            contributes: {
                accountCollections: [{
                    ...V1_MANIFEST.contributes.accountCollections[0],
                    quota: { maxRowEncodedBytes: 513 * 1024 },
                }],
            },
        });
        if (!ref) throw new Error("Expected one materialized contract ref.");

        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: PLUGIN_ID,
                contracts: [ref],
            })
        ))).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxRowEncodedBytes",
            effectiveMaximum: 512 * 1024,
        });
        await expect(db.pluginCollectionIndexState.count({
            where: { accountId, pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
        })).resolves.toBe(0);
    });

    it("preserves a provider timeout from the writable-contract activation census", async () => {
        harness.resetEnv({ HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const accountId = "account-activation-census-provider-timeout";
        await createPlainAccount(accountId);
        const [ref] = await materialize(V1_MANIFEST);
        if (!ref) throw new Error("Expected one materialized contract ref.");
        const providerTimeout = Object.assign(
            new Error("Timed out fetching a new connection during the activation census."),
            { code: "P2024" },
        );
        const originalTransaction = db.$transaction.bind(db);
        let censusReads = 0;
        let restored = false;
        Reflect.set(db, "$transaction", async (...args: Parameters<typeof db.$transaction>) => {
            const [callback, options] = args;
            if (typeof callback !== "function") {
                return await originalTransaction(...args);
            }
            return await originalTransaction(async (tx) => {
                const censusTx = Object.create(tx) as Tx;
                const censusRows = Object.create(tx.pluginCollectionRow);
                const originalFindMany = tx.pluginCollectionRow.findMany.bind(tx.pluginCollectionRow);
                Object.defineProperty(censusRows, "findMany", {
                    value: async (...findManyArgs: Parameters<typeof tx.pluginCollectionRow.findMany>) => {
                        const where = (findManyArgs[0] as Readonly<{
                            where?: Readonly<{ accountId?: unknown; deletedAt?: unknown }>;
                        }> | undefined)?.where;
                        if (
                            where?.accountId === accountId
                            && where.deletedAt === null
                            && Object.keys(where).length === 2
                        ) {
                            censusReads += 1;
                            throw providerTimeout;
                        }
                        return await originalFindMany(...findManyArgs);
                    },
                });
                Object.defineProperty(censusTx, "pluginCollectionRow", { value: censusRows });
                return await callback(censusTx);
            }, options);
        });

        try {
            await expect(inTx(async (tx) => (
                await preparePluginCollectionWritableContractsTx({
                    tx,
                    accountId,
                    pluginId: PLUGIN_ID,
                    contracts: [ref],
                })
            ))).rejects.toBe(providerTimeout);
            expect(censusReads).toBe(1);
        } finally {
            if (!restored) {
                restored = true;
                Reflect.set(db, "$transaction", originalTransaction);
            }
        }
    });

    it("refuses a contract switch before existing rows and all declared indexes are prepared", async () => {
        const accountId = "account-preparation-required";
        await createPlainAccount(accountId);
        const [v1] = await materialize(V1_MANIFEST);
        const [v2] = await materialize(V2_MANIFEST);
        if (!v1 || !v2) throw new Error("Expected both immutable contract refs.");
        const contract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: v1.pluginId,
                collectionId: v1.collectionId,
                schemaVersion: v1.schemaVersion,
                contractDigest: v1.contractDigest,
            },
        });
        await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "task-1",
                schemaVersion: v1.schemaVersion,
                revision: 1,
                contractId: contract.id,
                contractDigest: v1.contractDigest,
                contentEnvelope: toPrismaJson({ t: "plain", v: {} }),
            },
        });

        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: PLUGIN_ID,
                contracts: [v2],
            })
        ))).rejects.toMatchObject({ code: "collection_writer_contract_not_ready" });

        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: PLUGIN_ID,
                contracts: [v1],
            })
        ))).rejects.toMatchObject({ code: "collection_writer_contract_not_ready" });

        await db.pluginCollectionIndexState.create({
            data: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                indexId: "byProjectAndStatus",
                contractId: contract.id,
                contractDigest: v1.contractDigest,
                buildState: "building",
                indexedThroughRevision: null,
            },
        });
        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: PLUGIN_ID,
                contracts: [v1],
            })
        ))).rejects.toMatchObject({ code: "collection_writer_contract_not_ready" });

        await db.pluginCollectionIndexState.update({
            where: {
                accountId_pluginId_collectionId_indexId_contractDigest: {
                    accountId,
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "byProjectAndStatus",
                    contractDigest: v1.contractDigest,
                },
            },
            data: { buildState: "ready", indexedThroughRevision: 1 },
        });
        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: PLUGIN_ID,
                contracts: [v1],
            })
        ))).resolves.toEqual({ contracts: [v1] });
    });

    it("treats a retained tombstone as empty when readying a replacement contract index", async () => {
        const accountId = "account-tombstone-does-not-pin-index";
        await createPlainAccount(accountId);
        const [v1] = await materialize(V1_MANIFEST);
        const [v2] = await materialize(V2_MANIFEST);
        if (!v1 || !v2) throw new Error("Expected both immutable contract refs.");
        const source = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: v1.pluginId,
                collectionId: v1.collectionId,
                schemaVersion: v1.schemaVersion,
                contractDigest: v1.contractDigest,
            },
            select: { id: true },
        });
        await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "deleted-task",
                schemaVersion: v1.schemaVersion,
                revision: 2,
                contractId: source.id,
                contractDigest: v1.contractDigest,
                contentEnvelope: toPrismaJson({ t: "plain", v: {} }),
                deletedAt: new Date(),
            },
        });

        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: PLUGIN_ID,
                contracts: [v2],
            })
        ))).resolves.toEqual({ contracts: [v2] });

        await expect(db.pluginCollectionIndexState.findMany({
            where: { accountId, pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
            select: { contractDigest: true, buildState: true, indexedThroughRevision: true },
        })).resolves.toEqual([{
            contractDigest: v2.contractDigest,
            buildState: "ready",
            indexedThroughRevision: 0,
        }]);
    });

});
