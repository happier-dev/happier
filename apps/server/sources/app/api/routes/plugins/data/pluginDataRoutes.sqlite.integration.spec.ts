import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import {
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    PluginCollectionContractReadResultV1Schema,
    PluginCollectionGetResultV1Schema,
    PluginCollectionQueryResultV1Schema,
    PluginCollectionUiQueryResultV1Schema,
    decodeBase64,
    encodeBase64,
    encodePluginCollectionIndexSortKeyV1,
    sealPluginCollectionPrivatePayloadV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import {
    materializePluginCollectionContractsFromManifestTx,
    preparePluginCollectionWritableContractsTx,
} from "@/app/plugins/data/collections/contracts";
import { mutatePluginCollection } from "@/app/plugins/data/collections/mutation";
import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../../testkit/sqliteFastify";
import { pluginDataRoutes } from "./pluginDataRoutes";

const PLUGIN_ID = "example.tasks";
const COLLECTION_ID = "tasks";
const QUERY_ID = "open-by-status";
const V3_HEADERS = {
    "x-happier-account-stored-content-protocol": String(
        ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    ),
} as const;

const COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: PLUGIN_ID,
    version: "1.0.0",
    displayName: "Tasks fixture",
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
                    privateNote: { type: "string", maxLength: 256 },
                },
                required: ["id", "status", "title"],
                additionalProperties: false,
            },
            serverReadable: ["status", "title"],
            indexes: [{
                id: "by-status",
                fields: [{ field: "status", direction: "asc" }],
            }],
            uiQueries: [{
                id: QUERY_ID,
                indexId: "by-status",
                parameters: {
                    status: {
                        kind: "string",
                        maxUtf8Bytes: 16,
                        enum: ["closed", "open"],
                    },
                },
                prefix: [{ kind: "parameter", parameterId: "status" }],
                order: "asc",
                pageSize: 1,
                projectedFields: ["status", "title"],
            }],
        }],
    },
} as const;

const PREFIX_QUOTA_COLLECTION_MANIFEST = {
    ...COLLECTION_MANIFEST,
    id: "example.tasks.prefix-quota",
    displayName: "Prefix quota fixture",
    contributes: {
        accountCollections: [{
            ...COLLECTION_MANIFEST.contributes.accountCollections[0],
            quota: {
                maxRowsByIndexPrefix: [{
                    indexId: "by-status",
                    prefix: ["open"],
                    maxRows: 32,
                }],
            },
        }],
    },
} as const;

const LOWERED_PREFIX_QUOTA_COLLECTION_MANIFEST = {
    ...PREFIX_QUOTA_COLLECTION_MANIFEST,
    id: "example.tasks.lowered-prefix-quota",
    displayName: "Lowered prefix quota fixture",
    contributes: {
        accountCollections: [{
            ...PREFIX_QUOTA_COLLECTION_MANIFEST.contributes.accountCollections[0],
            quota: {
                maxRowsByIndexPrefix: [{
                    indexId: "by-status",
                    prefix: ["open"],
                    maxRows: 1,
                }],
            },
        }],
    },
} as const;

const ROW_AND_COUNT_QUOTA_COLLECTION_MANIFEST = {
    ...COLLECTION_MANIFEST,
    id: "example.tasks.row-and-count-quota",
    displayName: "Row and count quota fixture",
    contributes: {
        accountCollections: [{
            ...COLLECTION_MANIFEST.contributes.accountCollections[0],
            quota: {
                maxRows: 100,
                maxRowEncodedBytes: 256,
            },
        }],
    },
} as const;

const LARGE_ROW_QUOTA_COLLECTION_MANIFEST = {
    ...COLLECTION_MANIFEST,
    id: "example.tasks.large-row-quota",
    displayName: "Large row quota fixture",
    contributes: {
        accountCollections: [{
            ...COLLECTION_MANIFEST.contributes.accountCollections[0],
            schema: {
                ...COLLECTION_MANIFEST.contributes.accountCollections[0].schema,
                properties: {
                    ...COLLECTION_MANIFEST.contributes.accountCollections[0].schema.properties,
                    privateNote: { type: "string", maxLength: 2 * 1024 * 1024 },
                },
            },
            quota: { maxRowEncodedBytes: 1024 * 1024 },
        }],
    },
} as const;

const INSTANT_COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: "example.events",
    version: "1.0.0",
    displayName: "Events fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: "events",
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    "occurred-at": { type: "string", format: "date-time" },
                },
                required: ["id", "occurred-at"],
                additionalProperties: false,
            },
            serverReadable: ["occurred-at"],
            indexes: [{
                id: "by-occurred-at",
                fields: [{ field: "occurred-at", direction: "asc" }],
            }],
            uiQueries: [{
                id: "at",
                indexId: "by-occurred-at",
                parameters: { at: { kind: "instant" } },
                prefix: [{ kind: "parameter", parameterId: "at" }],
                order: "asc",
                pageSize: 1,
                projectedFields: ["occurred-at"],
            }],
        }],
    },
} as const;

const NON_INDEXED_INSTANT_COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: "example.non-indexed-events",
    version: "1.0.0",
    displayName: "Non-indexed events fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: "events",
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["closed", "open"] },
                    "occurred-at": { type: "string", format: "date-time" },
                },
                required: ["id", "status", "occurred-at"],
                additionalProperties: false,
            },
            serverReadable: ["status", "occurred-at"],
            indexes: [{
                id: "by-status",
                fields: [{ field: "status", direction: "asc" }],
            }],
            uiQueries: [{
                id: "open",
                indexId: "by-status",
                parameters: {
                    status: {
                        kind: "string",
                        maxUtf8Bytes: 16,
                        enum: ["closed", "open"],
                    },
                },
                prefix: [{ kind: "parameter", parameterId: "status" }],
                order: "asc",
                pageSize: 1,
                projectedFields: ["status", "occurred-at"],
            }],
        }],
    },
} as const;

const MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: "example.maximum-binary-index",
    version: "1.0.0",
    displayName: "Maximum binary collection index fixture",
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

const RELATION_COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: "example.projects-tasks",
    version: "1.0.0",
    displayName: "Projects and Tasks fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: "projects",
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    title: { type: "string", maxLength: 256 },
                },
                required: ["id", "title"],
                additionalProperties: false,
            },
            serverReadable: ["id", "title"],
            indexes: [],
        }, {
            id: "tasks",
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    title: { type: "string", maxLength: 256 },
                    "project-id": { type: "string", maxLength: 256 },
                },
                required: ["id", "title", "project-id"],
                additionalProperties: false,
            },
            serverReadable: ["id", "title", "project-id"],
            indexes: [{
                id: "by-project-id",
                fields: [{ field: "project-id", direction: "asc" }],
            }],
            relations: [{
                id: "project",
                kind: "collection",
                field: "project-id",
                collectionId: "projects",
                required: true,
                unique: true,
                onDelete: "restrict",
            }],
        }],
    },
} as const;

const RELATION_REMOVED_COLLECTION_MANIFEST = {
    ...RELATION_COLLECTION_MANIFEST,
    version: "2.0.0",
    contributes: {
        accountCollections: [
            RELATION_COLLECTION_MANIFEST.contributes.accountCollections[0],
            {
                ...RELATION_COLLECTION_MANIFEST.contributes.accountCollections[1],
                schemaVersion: 2,
                readableSchemaVersions: [1],
                migrations: [{
                    id: "remove-task-project-relation-v1-to-v2",
                    fromSchemaVersion: 1,
                    toSchemaVersion: 2,
                }],
                relations: [],
            },
        ],
    },
} as const;

const NULLIFY_RELATION_COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: "example.optional-projects-tasks",
    version: "1.0.0",
    displayName: "Optional projects and tasks fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: "projects",
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    title: { type: "string", maxLength: 256 },
                },
                required: ["id", "title"],
                additionalProperties: false,
            },
            serverReadable: ["id", "title"],
            indexes: [],
        }, {
            id: "tasks",
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    title: { type: "string", maxLength: 256 },
                    "project-id": { type: "string", maxLength: 256 },
                },
                required: ["id", "title"],
                additionalProperties: false,
            },
            serverReadable: ["id", "title", "project-id"],
            indexes: [{
                id: "by-project-id",
                fields: [{ field: "project-id", direction: "asc" }],
            }],
            relations: [{
                id: "project",
                kind: "collection",
                field: "project-id",
                collectionId: "projects",
                required: false,
                onDelete: "nullify",
            }],
        }],
    },
} as const;

const HOST_MACHINE_RELATION_COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: "example.machine-tasks",
    version: "1.0.0",
    displayName: "Machine relation fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: "tasks",
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    title: { type: "string", maxLength: 256 },
                    "machine-id": { type: "string", maxLength: 256 },
                },
                required: ["id", "title", "machine-id"],
                additionalProperties: false,
            },
            serverReadable: ["id", "title", "machine-id"],
            indexes: [],
            relations: [{
                id: "machine",
                kind: "host",
                field: "machine-id",
                hostKind: "machine",
            }],
        }],
    },
} as const;

type SeedRow = Readonly<{
    rowId: string;
    status: "closed" | "open";
    title: string;
    revision: number;
    contentEnvelope?: Readonly<{ t: "plain"; v: unknown }> | Readonly<{ t: "encrypted"; c: string }>;
}>;

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

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function validE2eeAccountFields(): Readonly<{
    publicKey: string;
    contentPublicKey: Uint8Array<ArrayBuffer>;
    contentPublicKeySig: Uint8Array<ArrayBuffer>;
}> {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const contentBinding = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(content.publicKey),
    ]);
    return {
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(Array.from(content.publicKey)),
        contentPublicKeySig: new Uint8Array(Array.from(tweetnacl.sign.detached(
            contentBinding,
            signing.secretKey,
        ))),
    };
}

async function createAccount(params: Readonly<{
    id: string;
    mode: "plain" | "e2ee";
    seq: number;
}>): Promise<void> {
    if (params.mode === "plain") {
        await db.account.create({
            data: {
                id: params.id,
                publicKey: null,
                encryptionMode: "plain",
                seq: params.seq,
            },
        });
        return;
    }

    await db.account.create({
        data: {
            id: params.id,
            encryptionMode: "e2ee",
            seq: params.seq,
            ...validE2eeAccountFields(),
        },
    });
}

async function commitValidE2eeAccountModeForTest(input: Readonly<{
    accountId: string;
    seq: number;
}>): Promise<void> {
    await inTx(async (tx) => {
        await tx.account.update({
            where: { id: input.accountId },
            data: {
                encryptionMode: "e2ee",
                encryptionModeUpdatedAt: new Date(),
                seq: input.seq,
                ...validE2eeAccountFields(),
            },
        });
    });
}

async function seedCurrentCollectionAccount(params: Readonly<{
    accountId: string;
    mode?: "plain" | "e2ee";
    seq?: number;
    rows: readonly SeedRow[];
    manifest?: unknown;
}>) {
    await createAccount({
        id: params.accountId,
        mode: params.mode ?? "plain",
        seq: params.seq ?? 41,
    });
    const contracts = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: params.manifest ?? COLLECTION_MANIFEST,
        })
    ));
    const ref = contracts[0];
    if (!ref) throw new Error("Fixture collection contract was not materialized.");
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId: params.accountId,
            pluginId: ref.pluginId,
            desiredVersion: "1.0.0",
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson([ref]),
            revision: BigInt(1),
        },
    });
    const indexState = await db.pluginCollectionIndexState.create({
        data: {
            accountId: params.accountId,
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            indexId: "by-status",
            contractId: contract.id,
            contractDigest: ref.contractDigest,
            buildState: "ready",
            indexedThroughRevision: Math.max(0, ...params.rows.map((row) => row.revision)),
        },
    });

    for (const row of params.rows) {
        const stored = await db.pluginCollectionRow.create({
            data: {
                accountId: params.accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: row.rowId,
                schemaVersion: ref.schemaVersion,
                revision: row.revision,
                contractId: contract.id,
                contractDigest: ref.contractDigest,
                contentEnvelope: toPrismaJson(row.contentEnvelope ?? {
                    t: "plain",
                    v: { privateNote: `secret-${row.rowId}` },
                }),
            },
        });
        await db.pluginCollectionProjection.createMany({
            data: [
                {
                    rowDbId: stored.id,
                    accountId: params.accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: row.rowId,
                    fieldId: "status",
                    typedEncodedValue: JSON.stringify(row.status),
                    rowRevision: row.revision,
                },
                {
                    rowDbId: stored.id,
                    accountId: params.accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: row.rowId,
                    fieldId: "title",
                    typedEncodedValue: JSON.stringify(row.title),
                    rowRevision: row.revision,
                },
            ],
        });
        await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: indexState.id,
                encodedSortKey: copyBytes(encodePluginCollectionIndexSortKeyV1({
                    fields: [{ kind: "string", value: row.status }],
                    rowId: row.rowId,
                })),
                rowId: row.rowId,
                rowRevision: row.revision,
            },
        });
    }

    return { ref, contract, indexState };
}

/** Adds a second current Collection contract and one live row for Account-wide quota tests. */
async function seedAdditionalCurrentCollectionRow(params: Readonly<{
    accountId: string;
    manifest: unknown;
    row: SeedRow;
}>): Promise<Readonly<{ ref: Readonly<{
    pluginId: string;
    collectionId: string;
    schemaVersion: number;
    contractDigest: string;
}> }>> {
    const [ref] = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: params.manifest,
        })
    ));
    if (!ref) throw new Error("Fixture aggregate Collection contract was not materialized.");
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId: params.accountId,
            pluginId: ref.pluginId,
            desiredVersion: "1.0.0",
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson([ref]),
            revision: BigInt(1),
        },
    });
    const indexState = await db.pluginCollectionIndexState.create({
        data: {
            accountId: params.accountId,
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            indexId: "by-status",
            contractId: contract.id,
            contractDigest: ref.contractDigest,
            buildState: "ready",
            indexedThroughRevision: params.row.revision,
        },
    });
    const row = await db.pluginCollectionRow.create({
        data: {
            accountId: params.accountId,
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            rowId: params.row.rowId,
            schemaVersion: ref.schemaVersion,
            revision: params.row.revision,
            contractId: contract.id,
            contractDigest: ref.contractDigest,
            contentEnvelope: toPrismaJson(params.row.contentEnvelope ?? {
                t: "plain",
                v: { privateNote: `secret-${params.row.rowId}` },
            }),
        },
    });
    await db.pluginCollectionProjection.createMany({
        data: [
            {
                rowDbId: row.id,
                accountId: params.accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: params.row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify(params.row.status),
                rowRevision: params.row.revision,
            },
            {
                rowDbId: row.id,
                accountId: params.accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: params.row.rowId,
                fieldId: "title",
                typedEncodedValue: JSON.stringify(params.row.title),
                rowRevision: params.row.revision,
            },
        ],
    });
    await db.pluginCollectionIndexEntry.create({
        data: {
            indexStateId: indexState.id,
            encodedSortKey: copyBytes(encodePluginCollectionIndexSortKeyV1({
                fields: [{ kind: "string", value: params.row.status }],
                rowId: params.row.rowId,
            })),
            rowId: params.row.rowId,
            rowRevision: params.row.revision,
        },
    });
    return { ref };
}

/**
 * Injects a provider timeout at the persisted quota-census boundary while
 * keeping every other operation on the real SQLite transaction path.
 */
function failPluginCollectionQuotaCensusRead(input: Readonly<{
    accountId: string;
    occurrence: number;
    error: Error;
}>) {
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
                        where?.accountId === input.accountId
                        && where.deletedAt === null
                        && Object.keys(where).length === 2
                    ) {
                        censusReads += 1;
                        if (censusReads === input.occurrence) throw input.error;
                    }
                    return await originalFindMany(...findManyArgs);
                },
            });
            Object.defineProperty(censusTx, "pluginCollectionRow", { value: censusRows });
            return await callback(censusTx);
        }, options);
    });

    return {
        censusReads: () => censusReads,
        restore: () => {
            if (restored) return;
            restored = true;
            Reflect.set(db, "$transaction", originalTransaction);
        },
    };
}

async function seedMaximumBinaryIndexCollectionAccount(accountId: string): Promise<Readonly<{
    firstRowId: string;
    secondRowId: string;
    rangedRowId: string;
    indexStateId: string;
}>> {
    const indexedValue = "\u0000".repeat(256);
    const firstRowId = "r".repeat(256);
    const secondRowId = "s".repeat(256);
    const rangedRowId = "t".repeat(256);
    const rows = [
        { rowId: firstRowId, revision: 1, fourth: indexedValue },
        { rowId: secondRowId, revision: 2, fourth: indexedValue },
        { rowId: rangedRowId, revision: 3, fourth: `${"\u0000".repeat(255)}\u0001` },
    ] as const;
    await createAccount({ id: accountId, mode: "plain", seq: 91 });
    const [ref] = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST,
        })
    ));
    if (!ref) throw new Error("Fixture maximum binary collection contract was not materialized.");
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId,
            pluginId: ref.pluginId,
            desiredVersion: "1.0.0",
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
                typedEncodedValue: JSON.stringify(fieldId === "fourth" ? row.fourth : indexedValue),
                rowRevision: row.revision,
            })),
        });
        await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: indexState.id,
                encodedSortKey: copyBytes(encodePluginCollectionIndexSortKeyV1({
                    fields: [
                        { kind: "string", value: indexedValue },
                        { kind: "string", value: indexedValue },
                        { kind: "string", value: indexedValue },
                        { kind: "string", value: row.fourth },
                    ],
                    rowId: row.rowId,
                })),
                rowId: row.rowId,
                rowRevision: row.revision,
            },
        });
    }
    return { firstRowId, secondRowId, rangedRowId, indexStateId: indexState.id };
}

async function seedReadyEmptyInstantCollectionAccount(accountId: string): Promise<void> {
    await createAccount({ id: accountId, mode: "plain", seq: 0 });
    const contracts = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: INSTANT_COLLECTION_MANIFEST,
        })
    ));
    const ref = contracts[0];
    if (!ref) throw new Error("Fixture instant collection contract was not materialized.");
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId,
            pluginId: ref.pluginId,
            desiredVersion: "1.0.0",
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson([ref]),
            revision: BigInt(1),
        },
    });
    await db.pluginCollectionIndexState.create({
        data: {
            accountId,
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            indexId: "by-occurred-at",
            contractId: contract.id,
            contractDigest: ref.contractDigest,
            buildState: "ready",
            indexedThroughRevision: 0,
        },
    });
}

async function seedReadyNonIndexedInstantCollectionAccount(accountId: string): Promise<Readonly<{
    schemaVersion: number;
    contractDigest: string;
}>> {
    await createAccount({ id: accountId, mode: "plain", seq: 0 });
    const contracts = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: NON_INDEXED_INSTANT_COLLECTION_MANIFEST,
        })
    ));
    const ref = contracts[0];
    if (!ref) throw new Error("Fixture non-indexed instant collection contract was not materialized.");
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
            desiredVersion: NON_INDEXED_INSTANT_COLLECTION_MANIFEST.version,
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson([ref]),
            revision: BigInt(1),
        },
    });
    await db.pluginCollectionIndexState.create({
        data: {
            accountId,
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            indexId: "by-status",
            contractId: contract.id,
            contractDigest: ref.contractDigest,
            buildState: "ready",
            indexedThroughRevision: 0,
        },
    });
    return ref;
}

async function seedReadyRelationCollectionAccount(accountId: string) {
    await createAccount({ id: accountId, mode: "plain", seq: 0 });
    const refs = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: RELATION_COLLECTION_MANIFEST,
        })
    ));
    const refsByCollectionId = new Map(refs.map((ref) => [ref.collectionId, ref]));
    const projectRef = refsByCollectionId.get("projects");
    const taskRef = refsByCollectionId.get("tasks");
    if (!projectRef || !taskRef) throw new Error("Fixture relation contracts were not materialized.");
    await db.accountPluginIntent.create({
        data: {
            accountId,
            pluginId: RELATION_COLLECTION_MANIFEST.id,
            desiredVersion: "1.0.0",
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson(refs),
            revision: BigInt(1),
        },
    });
    const taskContract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: taskRef.pluginId,
            collectionId: taskRef.collectionId,
            schemaVersion: taskRef.schemaVersion,
            contractDigest: taskRef.contractDigest,
        },
        select: { id: true },
    });
    await db.pluginCollectionIndexState.create({
        data: {
            accountId,
            pluginId: taskRef.pluginId,
            collectionId: taskRef.collectionId,
            indexId: "by-project-id",
            contractId: taskContract.id,
            contractDigest: taskRef.contractDigest,
            buildState: "ready",
            indexedThroughRevision: 0,
        },
    });
    return { projectRef, taskRef };
}

async function seedReadyNullifyRelationCollectionAccount(accountId: string) {
    await createAccount({ id: accountId, mode: "plain", seq: 0 });
    const refs = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: NULLIFY_RELATION_COLLECTION_MANIFEST,
        })
    ));
    const refsByCollectionId = new Map(refs.map((ref) => [ref.collectionId, ref]));
    const projectRef = refsByCollectionId.get("projects");
    const taskRef = refsByCollectionId.get("tasks");
    if (!projectRef || !taskRef) throw new Error("Fixture nullify relation contracts were not materialized.");
    await db.accountPluginIntent.create({
        data: {
            accountId,
            pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
            desiredVersion: "1.0.0",
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson(refs),
            revision: BigInt(1),
        },
    });
    const taskContract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: taskRef.pluginId,
            collectionId: taskRef.collectionId,
            schemaVersion: taskRef.schemaVersion,
            contractDigest: taskRef.contractDigest,
        },
        select: { id: true },
    });
    const taskIndexState = await db.pluginCollectionIndexState.create({
        data: {
            accountId,
            pluginId: taskRef.pluginId,
            collectionId: taskRef.collectionId,
            indexId: "by-project-id",
            contractId: taskContract.id,
            contractDigest: taskRef.contractDigest,
            buildState: "ready",
            indexedThroughRevision: 0,
        },
        select: { id: true },
    });
    return { projectRef, taskRef, taskIndexState };
}

async function seedReadyHostMachineRelationCollectionAccount(
    accountId: string,
    mode: "plain" | "e2ee" = "plain",
) {
    await createAccount({ id: accountId, mode, seq: 0 });
    const refs = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: HOST_MACHINE_RELATION_COLLECTION_MANIFEST,
        })
    ));
    const ref = refs[0];
    if (!ref) throw new Error("Fixture host relation contract was not materialized.");
    await db.accountPluginIntent.create({
        data: {
            accountId,
            pluginId: HOST_MACHINE_RELATION_COLLECTION_MANIFEST.id,
            desiredVersion: "1.0.0",
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson([ref]),
            revision: BigInt(1),
        },
    });
    return { ref };
}

async function withPluginDataApp(run: Parameters<typeof withAuthenticatedTestApp>[1]): Promise<void> {
    await withAuthenticatedTestApp(
        (app) => pluginDataRoutes(app),
        run,
    );
}

function queryRequest(overrides: Partial<{
    pluginId: string;
    collectionId: string;
    uiQueryId: string;
    parameters: Record<string, string | number | boolean>;
    cursor: string;
}> = {}) {
    return {
        pluginId: PLUGIN_ID,
        collectionId: COLLECTION_ID,
        uiQueryId: QUERY_ID,
        parameters: { status: "open" },
        ...overrides,
    };
}

const ACCOUNT_MODE_CURRENTNESS_QUERY_CASES = [{
    name: "direct",
    url: "/v1/plugins/data/query",
    payload: {
        pluginId: PLUGIN_ID,
        collectionId: COLLECTION_ID,
        indexId: "by-status",
        prefix: ["open"],
        order: "asc",
        limit: 1,
    },
}, {
    name: "static",
    url: "/v1/plugins/data/ui-query",
    payload: queryRequest(),
}] as const;

/**
 * A query's row snapshot commits before its required global Account
 * currentness recheck. Model a valid mode flip exactly in that gap, rather
 * than pausing a global row delegate that transaction-scoped readers no
 * longer use.
 */
function flipAccountModeBeforePostQueryCurrentnessRead(input: Readonly<{
    accountId: string;
    seq: number;
}>) {
    const accountDelegate = db.account;
    const originalFindUnique = accountDelegate.findUnique.bind(accountDelegate);
    const originalTransaction = db.$transaction.bind(db);
    let querySnapshotCommitted = false;
    let flipped = false;
    let restored = false;

    // `db` is a proxy over the live Prisma client. `defineProperty` only
    // mutates the proxy target, which its getter intentionally ignores; set
    // through the proxy so this boundary hook reaches the real client.
    Reflect.set(db, "$transaction", async (...args: Parameters<typeof db.$transaction>) => {
        const result = await originalTransaction(...args);
        querySnapshotCommitted = true;
        return result;
    });
    Object.defineProperty(accountDelegate, "findUnique", {
        configurable: true,
        writable: true,
        value: async (...args: Parameters<typeof accountDelegate.findUnique>) => {
            if (!flipped && querySnapshotCommitted) {
                flipped = true;
                await commitValidE2eeAccountModeForTest(input);
            }
            return await originalFindUnique(...args);
        },
    });

    return {
        wasFlipped: () => flipped,
        restore: () => {
            if (restored) return;
            restored = true;
            Reflect.set(db, "$transaction", originalTransaction);
            Object.defineProperty(accountDelegate, "findUnique", {
                configurable: true,
                writable: true,
                value: originalFindUnique,
            });
        },
    };
}

/**
 * Models a database snapshot at the genuine persistence boundary. The
 * mutation advances the global database after that snapshot is captured.
 * A query that takes every read from the transaction returns the pre-mutation
 * row/cursor pair; a query that lets any row read escape to `db` produces the
 * forbidden mixed pair. The snapshot fixture keeps that proof deterministic
 * without coupling it to interactive-read scheduling in SQLite.
 */
function racePluginCollectionQuerySnapshot(input: Readonly<{
    snapshot: Readonly<{
        account: unknown;
        intent: unknown;
        contract: unknown;
        indexState: unknown;
        entries: unknown;
        rows: unknown;
    }>;
    mutate: () => Promise<void>;
}>) {
    const indexStateDelegate = db.pluginCollectionIndexState;
    const originalIndexStateFindFirst = indexStateDelegate.findFirst.bind(indexStateDelegate);
    const originalTransaction = db.$transaction.bind(db);
    let mutationPromise: Promise<void> | null = null;
    let restored = false;

    const mutateOnce = async (): Promise<void> => {
        if (!mutationPromise) mutationPromise = input.mutate();
        await mutationPromise;
    };

    // This is a narrow test-only database-boundary fixture: all reads used by
    // this query receive the captured transaction snapshot, while unrelated
    // Prisma delegates retain their real behavior through the prototype.
    const snapshotTx: Tx = Object.create(db);
    const snapshotAccount = Object.create(db.account);
    const snapshotIntent = Object.create(db.accountPluginIntent);
    const snapshotContract = Object.create(db.pluginCollectionContract);
    const snapshotIndexState = Object.create(db.pluginCollectionIndexState);
    const snapshotIndexEntry = Object.create(db.pluginCollectionIndexEntry);
    const snapshotRow = Object.create(db.pluginCollectionRow);
    Object.defineProperty(snapshotAccount, "findUnique", { value: async () => input.snapshot.account });
    Object.defineProperty(snapshotIntent, "findUnique", { value: async () => input.snapshot.intent });
    Object.defineProperty(snapshotContract, "findFirst", { value: async () => input.snapshot.contract });
    Object.defineProperty(snapshotIndexState, "findFirst", { value: async () => input.snapshot.indexState });
    Object.defineProperty(snapshotIndexEntry, "findMany", { value: async () => input.snapshot.entries });
    Object.defineProperty(snapshotRow, "findMany", { value: async () => input.snapshot.rows });
    Object.defineProperties(snapshotTx, {
        $queryRaw: { value: async () => input.snapshot.entries },
        account: { value: snapshotAccount },
        accountPluginIntent: { value: snapshotIntent },
        pluginCollectionContract: { value: snapshotContract },
        pluginCollectionIndexState: { value: snapshotIndexState },
        pluginCollectionIndexEntry: { value: snapshotIndexEntry },
        pluginCollectionRow: { value: snapshotRow },
    });

    Object.defineProperty(indexStateDelegate, "findFirst", {
        configurable: true,
        writable: true,
        value: async (...args: Parameters<typeof indexStateDelegate.findFirst>) => {
            // The pre-fix reader reaches this global delegate after it has
            // already read cursor 77, so this creates the observable race.
            await mutateOnce();
            return await originalIndexStateFindFirst(...args);
        },
    });
    Object.defineProperty(db, "$transaction", {
        configurable: true,
        writable: true,
        value: async (...args: Parameters<typeof db.$transaction>) => {
            const [callback] = args;
            // A mutation itself starts a transaction. It must retain the real
            // writer path instead of recursively receiving this read snapshot.
            if (typeof callback !== "function" || mutationPromise) {
                return await originalTransaction(...args);
            }
            await mutateOnce();
            return await callback(snapshotTx);
        },
    });

    return {
        restore: () => {
            if (restored) return;
            restored = true;
            Object.defineProperty(indexStateDelegate, "findFirst", {
                configurable: true,
                writable: true,
                value: originalIndexStateFindFirst,
            });
            Object.defineProperty(db, "$transaction", {
                configurable: true,
                writable: true,
                value: originalTransaction,
            });
        },
    };
}

describe("plugin collection UI query route", () => {
    it("registers candidate-preparation routes behind authenticated Data transport and maps malformed/currentness failures", async () => {
        const accountId = "account-candidate-preparation-routes";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "candidate-stage-row",
                status: "open",
                title: "Stage through the route",
                revision: 1,
            }],
        });
        const request = {
            binding: {
                source: ref,
                target: ref,
                candidate: { releaseVersion: "2.0.0", artifactDigest: `sha256:${"a".repeat(64)}` },
            },
            limit: 1,
        };
        await withPluginDataApp(async (app) => {
            const unauthenticated = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/candidate-preparation/source-page",
                payload: request,
            });
            expect(unauthenticated.statusCode).toBe(401);

            const malformed = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/candidate-preparation/stage",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {},
            });
            expect(malformed.statusCode).toBe(400);
            expect(malformed.json()).toEqual({ error: "collection_candidate_preparation_invalid" });

            const missingRelease = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/candidate-preparation/source-page",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: request,
            });
            expect(missingRelease.statusCode).toBe(409);
            expect(missingRelease.json()).toEqual({ error: "collection_candidate_preparation_contract_mismatch" });

            await Promise.all([
                db.accountPluginRelease.create({
                    data: {
                        accountId,
                        pluginId: ref.pluginId,
                        version: "1.0.0",
                        archiveDigestSha256: `sha256:${"b".repeat(64)}`,
                        normalizedManifest: toPrismaJson(COLLECTION_MANIFEST),
                        collectionContracts: toPrismaJson([ref]),
                        uiSlots: [],
                    },
                }),
                db.accountPluginRelease.create({
                    data: {
                        accountId,
                        pluginId: ref.pluginId,
                        version: "2.0.0",
                        archiveDigestSha256: `sha256:${"c".repeat(64)}`,
                        normalizedManifest: toPrismaJson(COLLECTION_MANIFEST),
                        collectionContracts: toPrismaJson([ref]),
                        uiSlots: [],
                    },
                }),
            ]);
            const staged = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/candidate-preparation/stage",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    binding: request.binding,
                    items: [{
                        source: { rowId: "candidate-stage-row", revision: 1 },
                        target: {
                            content: { t: "plain", v: { privateNote: "candidate-only" } },
                            projection: { status: "open", title: "Stage through the route" },
                        },
                    }],
                },
            });
            expect(staged.statusCode).toBe(200);
            expect(staged.json()).toEqual({ results: [{ status: "staged" }] });

            const foreignAccount = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/candidate-preparation/retire",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": "account-candidate-preparation-foreign",
                    ...V3_HEADERS,
                },
                payload: { binding: request.binding },
            });
            // Retirement is idempotent after release deletion, but its route
            // still authenticates and scopes the Account before any mutation.
            expect(foreignAccount.statusCode).toBe(200);
            expect(foreignAccount.json()).toEqual({ status: "retired" });
        });
    });

    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-data-ui-query-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
            sqliteConnectionLimit: 2,
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
            () => db.pluginCollectionAbsenceEpoch.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.pluginCollectionContract.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("does not commit an old-mode Collection writer across the Account transition fence", async () => {
        const accountId = "account-collection-transition-fence";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            mode: "e2ee",
            seq: 41,
            rows: [],
        });
        const transitionFenceAcquired = deferred();
        const releaseTransition = deferred();
        let writerSettled = false;
        const transition = inTx(async (tx) => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId);
            expect(fence.status).toBe("ready");
            if (fence.status !== "ready") return;
            transitionFenceAcquired.resolve();
            await releaseTransition.promise;
            await applyAccountEncryptionTransitionInTx(tx, {
                accountId,
                expectedVersion: fence.account.version,
                toMode: "plain",
                contentKey: { kind: "preserve" },
            });
        });

        await transitionFenceAcquired.promise;
        const oldModeContent = sealPluginCollectionPrivatePayloadV1({
            material: { type: "legacy", secret: new Uint8Array(32).fill(9) },
            payload: { privateNote: "must not cross the Account transition" },
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const writer = mutatePluginCollection({
            accountId,
            request: {
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                writerContext: {
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                operations: [{
                    kind: "put",
                    rowId: "task-old-mode",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: { t: "encrypted", c: oldModeContent },
                    projection: { status: "open", title: "Old-mode writer" },
                }],
            },
        }).finally(() => {
            writerSettled = true;
        });

        try {
            // The real second connection cannot acquire the same Account-first
            // fence while the transition holds its census/final-flip lock.
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(writerSettled).toBe(false);

            releaseTransition.resolve();
            await transition;
            await expect(writer).rejects.toMatchObject({
                code: "collection_content_mode_mismatch",
            });
            await expect(db.pluginCollectionRow.count({ where: { accountId } })).resolves.toBe(0);
            await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(0);
        } finally {
            releaseTransition.resolve();
            await transition.catch(() => undefined);
            await writer.catch(() => undefined);
        }
    }, 30_000);

    it("persists, orders, bounds, and pages the admitted maximum compound key as one raw binary value", async () => {
        const accountId = "account-maximum-binary-collection-index";
        const indexedValue = "\u0000".repeat(256);
        const { firstRowId, secondRowId, rangedRowId, indexStateId } = await seedMaximumBinaryIndexCollectionAccount(accountId);
        const persisted = await db.pluginCollectionIndexEntry.findMany({
            where: { indexStateId },
            orderBy: { encodedSortKey: "asc" },
            select: { encodedSortKey: true, rowId: true },
        });
        expect(persisted).toEqual([
            expect.objectContaining({
                encodedSortKey: expect.any(Uint8Array),
                rowId: firstRowId,
            }),
            expect.objectContaining({
                encodedSortKey: expect.any(Uint8Array),
                rowId: secondRowId,
            }),
            expect.objectContaining({
                encodedSortKey: expect.any(Uint8Array),
                rowId: rangedRowId,
            }),
        ]);
        expect(persisted.map((entry) => entry.encodedSortKey.byteLength)).toEqual([2_318, 2_318, 2_317]);

        await withPluginDataApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                ...V3_HEADERS,
            };
            const first = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue, indexedValue],
                    order: "asc",
                    limit: 1,
                },
            });
            expect(first.statusCode).toBe(200);
            const firstPage = PluginCollectionQueryResultV1Schema.parse(first.json());
            expect(firstPage.rows.map((row) => row.rowId)).toEqual([firstRowId]);
            expect(firstPage.nextCursor).toEqual(expect.any(String));
            if (!firstPage.nextCursor) throw new Error("Expected a maximum-key cursor.");
            expect(firstPage.nextCursor.length).toBeLessThanOrEqual(4_096);
            const rawCursor = decodeBase64(firstPage.nextCursor, "base64url");
            expect(rawCursor.byteLength).toBe(2_353);
            expect(rawCursor[0]).toBe(1);

            const second = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue, indexedValue],
                    order: "asc",
                    limit: 1,
                    cursor: firstPage.nextCursor,
                },
            });
            expect(second.statusCode).toBe(200);
            expect(PluginCollectionQueryResultV1Schema.parse(second.json()).rows.map((row) => row.rowId))
                .toEqual([secondRowId]);

            const shorterPrefix = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue],
                    order: "asc",
                    limit: 200,
                },
            });
            expect(shorterPrefix.statusCode).toBe(200);
            expect(PluginCollectionQueryResultV1Schema.parse(shorterPrefix.json()).rows.map((row) => row.rowId))
                .toEqual([firstRowId, secondRowId, rangedRowId]);

            const fourthFieldRange = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue],
                    range: { lower: indexedValue, upper: indexedValue },
                    order: "asc",
                    limit: 200,
                },
            });
            expect(fourthFieldRange.statusCode).toBe(200);
            expect(PluginCollectionQueryResultV1Schema.parse(fourthFieldRange.json()).rows.map((row) => row.rowId))
                .toEqual([firstRowId, secondRowId]);

            const descending = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue, indexedValue],
                    order: "desc",
                    limit: 1,
                },
            });
            expect(descending.statusCode).toBe(200);
            const descendingFirstPage = PluginCollectionQueryResultV1Schema.parse(descending.json());
            expect(descendingFirstPage.rows.map((row) => row.rowId)).toEqual([secondRowId]);
            if (!descendingFirstPage.nextCursor) throw new Error("Expected a descending maximum-key cursor.");
            const descendingSecond = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue, indexedValue],
                    order: "desc",
                    limit: 1,
                    cursor: descendingFirstPage.nextCursor,
                },
            });
            expect(descendingSecond.statusCode).toBe(200);
            expect(PluginCollectionQueryResultV1Schema.parse(descendingSecond.json()).rows.map((row) => row.rowId))
                .toEqual([firstRowId]);

            const wrongOrder = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue, indexedValue],
                    order: "desc",
                    limit: 1,
                    cursor: firstPage.nextCursor,
                },
            });
            expect(wrongOrder.statusCode).toBe(400);
            expect(wrongOrder.json()).toEqual({ error: "collection_cursor_invalid" });

            const tampered = Uint8Array.from(rawCursor);
            tampered[1] = tampered[1]! ^ 0x01;
            const tamperedCursor = encodeBase64(tampered, "base64url");
            const rejected = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    order: "asc",
                    limit: 1,
                    cursor: tamperedCursor,
                },
            });
            expect(rejected.statusCode).toBe(400);
            expect(rejected.json()).toEqual({ error: "collection_cursor_invalid" });

            const truncated = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue, indexedValue],
                    order: "asc",
                    limit: 1,
                    cursor: encodeBase64(rawCursor.subarray(0, -1), "base64url"),
                },
            });
            expect(truncated.statusCode).toBe(400);
            expect(truncated.json()).toEqual({ error: "collection_cursor_invalid" });

            const withTrailingByte = new Uint8Array(rawCursor.byteLength + 1);
            withTrailingByte.set(rawCursor);
            withTrailingByte[withTrailingByte.length - 1] = 0x00;
            const trailing = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST.id,
                    collectionId: "binary-keys",
                    indexId: "by-four-strings",
                    prefix: [indexedValue, indexedValue, indexedValue, indexedValue],
                    order: "asc",
                    limit: 1,
                    cursor: encodeBase64(withTrailingByte, "base64url"),
                },
            });
            expect(trailing.statusCode).toBe(400);
            expect(trailing.json()).toEqual({ error: "collection_cursor_invalid" });
        });
    });

    it("reads only the exact persisted contract admitted by the current Account release", async () => {
        const accountId = "account-collection-contract-read";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [],
        });
        await db.accountPluginRelease.create({
            data: {
                accountId,
                pluginId: PLUGIN_ID,
                version: "1.0.0",
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
                normalizedManifest: toPrismaJson(COLLECTION_MANIFEST),
                collectionContracts: toPrismaJson([ref]),
                uiSlots: toPrismaJson([]),
                packageAssetArchive: toPrismaJson({
                    archiveDigestSha256: `sha256:${"d".repeat(64)}`,
                    resources: [],
                }),
            },
        });

        await withPluginDataApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                ...V3_HEADERS,
            };
            const admitted = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/contract",
                headers,
                payload: { ref },
            });

            expect(admitted.statusCode).toBe(200);
            expect(PluginCollectionContractReadResultV1Schema.parse(admitted.json()))
                .toMatchObject({
                    contract: {
                        pluginId: ref.pluginId,
                        collectionId: ref.collectionId,
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                        rowIdField: "id",
                        serverReadable: ["status", "title"],
                    },
                });

            const forged = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/contract",
                headers,
                payload: {
                    ref: {
                        ...ref,
                        contractDigest: `A${ref.contractDigest.slice(1)}`,
                    },
                },
            });
            expect(forged.statusCode).toBe(404);
            expect(forged.json()).toEqual({ error: "collection_unavailable" });

            await db.accountPluginRelease.update({
                where: {
                    accountId_pluginId_version: {
                        accountId,
                        pluginId: PLUGIN_ID,
                        version: "1.0.0",
                    },
                },
                data: { collectionContracts: toPrismaJson([]) },
            });
            const noLongerReleased = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/contract",
                headers,
                payload: { ref },
            });
            expect(noLongerReleased.statusCode).toBe(404);
            expect(noLongerReleased.json()).toEqual({ error: "collection_unavailable" });
        });
    });

    it("serves current rows through the direct get and bounded query contract", async () => {
        const accountId = "account-direct-collection-reader";
        await seedCurrentCollectionAccount({
            accountId,
            seq: 77,
            rows: [
                { rowId: "task-a", status: "open", title: "First open", revision: 1 },
                { rowId: "task-b", status: "closed", title: "Closed", revision: 2 },
                { rowId: "task-c", status: "open", title: "Second open", revision: 3 },
            ],
        });

        await withPluginDataApp(async (app) => {
            const get = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/get",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: "task-a",
                },
            });
            expect(get.statusCode).toBe(200);
            expect(PluginCollectionGetResultV1Schema.parse(get.json())).toEqual({
                row: {
                    rowId: "task-a",
                    revision: 1,
                    content: { t: "plain", v: { privateNote: "secret-task-a" } },
                    projection: { status: "open", title: "First open" },
                },
                absenceEpoch: 0,
            });

            const first = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "by-status",
                    prefix: ["open"],
                    order: "asc",
                    limit: 1,
                },
            });
            expect(first.statusCode).toBe(200);
            const firstPage = PluginCollectionQueryResultV1Schema.parse(first.json());
            expect(firstPage).toEqual({
                rows: [{
                    rowId: "task-a",
                    revision: 1,
                    content: { t: "plain", v: { privateNote: "secret-task-a" } },
                    projection: { status: "open", title: "First open" },
                }],
                nextCursor: expect.any(String),
                changeCursor: 77,
            });

            const second = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "by-status",
                    prefix: ["open"],
                    order: "asc",
                    limit: 1,
                    cursor: firstPage.nextCursor,
                },
            });
            expect(second.statusCode).toBe(200);
            expect(PluginCollectionQueryResultV1Schema.parse(second.json())).toEqual({
                rows: [{
                    rowId: "task-c",
                    revision: 3,
                    content: { t: "plain", v: { privateNote: "secret-task-c" } },
                    projection: { status: "open", title: "Second open" },
                }],
                changeCursor: 77,
            });

            const reboundCursor = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "by-status",
                    prefix: ["closed"],
                    order: "asc",
                    limit: 1,
                    cursor: firstPage.nextCursor,
                },
            });
            expect(reboundCursor.statusCode).toBe(400);
            expect(reboundCursor.json()).toEqual({ error: "collection_cursor_invalid" });

            const undeclaredIndex = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "not-a-contract-index",
                    order: "asc",
                },
            });
            expect(undeclaredIndex.statusCode).toBe(400);
            expect(undeclaredIndex.json()).toEqual({ error: "collection_query_invalid" });
        });
    });

    it("rejects a direct-query cursor replayed by a different authenticated Account", async () => {
        const accountA = "account-direct-query-cursor-a";
        const accountB = "account-direct-query-cursor-b";
        await seedCurrentCollectionAccount({
            accountId: accountA,
            rows: [
                { rowId: "task-a", status: "open", title: "A first", revision: 1 },
                { rowId: "task-b", status: "open", title: "A second", revision: 2 },
            ],
        });
        // Keep the declared contract, bounds, index order, and raw cursor key
        // identical. The authenticated Account is the only distinguishing
        // query scope, so an old fingerprint would accept this replay.
        await seedCurrentCollectionAccount({
            accountId: accountB,
            rows: [
                { rowId: "task-a", status: "open", title: "B first", revision: 1 },
                { rowId: "task-b", status: "open", title: "B second", revision: 2 },
            ],
        });

        await withPluginDataApp(async (app) => {
            const request = {
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                indexId: "by-status",
                prefix: ["open"],
                order: "asc" as const,
                limit: 1,
            };
            const first = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountA,
                    ...V3_HEADERS,
                },
                payload: request,
            });
            expect(first.statusCode).toBe(200);
            const firstPage = PluginCollectionQueryResultV1Schema.parse(first.json());
            if (!firstPage.nextCursor) throw new Error("Expected an Account-A cursor.");

            const replay = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountB,
                    ...V3_HEADERS,
                },
                payload: { ...request, cursor: firstPage.nextCursor },
            });
            expect(replay.statusCode).toBe(400);
            expect(replay.json()).toEqual({ error: "collection_cursor_invalid" });
        });
    });

    it("never labels rows that cross a collection mutation with the earlier AccountChange cursor", async () => {
        const accountId = "account-direct-query-single-snapshot";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            seq: 77,
            rows: [{ rowId: "task-a", status: "open", title: "Before", revision: 1 }],
        });
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        const intent = await db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId, pluginId: PLUGIN_ID } },
        });
        const contract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
            },
        });
        const indexState = await db.pluginCollectionIndexState.findFirstOrThrow({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                contractDigest: ref.contractDigest,
                buildState: "ready",
            },
        });
        const entries = await db.pluginCollectionIndexEntry.findMany({
            where: { indexStateId: indexState.id },
            orderBy: { encodedSortKey: "asc" },
        });
        const rows = await db.pluginCollectionRow.findMany({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
                deletedAt: null,
            },
            include: { projections: true },
        });

        await withPluginDataApp(async (app) => {
            const racedSnapshot = racePluginCollectionQuerySnapshot({
                snapshot: { account, intent, contract, indexState, entries, rows },
                mutate: async () => {
                    const mutation = await app.inject({
                        method: "POST",
                        url: "/v1/plugins/data/mutate",
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": accountId,
                            ...V3_HEADERS,
                        },
                        payload: {
                            pluginId: PLUGIN_ID,
                            collectionId: COLLECTION_ID,
                            writerContext: {
                                schemaVersion: ref.schemaVersion,
                                contractDigest: ref.contractDigest,
                            },
                            operations: [{
                                kind: "put",
                                rowId: "task-a",
                                expectedRevision: 1,
                                content: { t: "plain", v: { privateNote: "updated" } },
                                projection: { status: "open", title: "After" },
                            }],
                        },
                    });
                    expect(mutation.statusCode).toBe(200);
                    expect(mutation.json()).toMatchObject({
                        status: "updated",
                        changeCursor: 78,
                    });
                },
            });
            try {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/plugins/data/query",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": accountId,
                        ...V3_HEADERS,
                    },
                    payload: {
                        pluginId: PLUGIN_ID,
                        collectionId: COLLECTION_ID,
                        indexId: "by-status",
                        prefix: ["open"],
                        order: "asc",
                        limit: 1,
                    },
                });
                expect(response.statusCode).toBe(200);
                expect(PluginCollectionQueryResultV1Schema.parse(response.json())).toMatchObject({
                    // A response that observed cursor 77 must be the same read
                    // snapshot: it cannot contain the mutation committed at 78.
                    rows: [{
                        rowId: "task-a",
                        revision: 1,
                        projection: { status: "open", title: "Before" },
                    }],
                    changeCursor: 77,
                });
            } finally {
                racedSnapshot.restore();
            }
        });
    });

    it("keeps static UI-query rows and their AccountChange cursor in one snapshot", async () => {
        const accountId = "account-ui-query-single-snapshot";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            seq: 77,
            rows: [{ rowId: "task-a", status: "open", title: "Before", revision: 1 }],
        });
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        const intent = await db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId, pluginId: PLUGIN_ID } },
        });
        const contract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
            },
        });
        const indexState = await db.pluginCollectionIndexState.findFirstOrThrow({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                contractDigest: ref.contractDigest,
                buildState: "ready",
            },
        });
        const entries = await db.pluginCollectionIndexEntry.findMany({
            where: { indexStateId: indexState.id },
            orderBy: { encodedSortKey: "asc" },
        });
        const rows = await db.pluginCollectionRow.findMany({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
                deletedAt: null,
            },
            include: { projections: true },
        });

        await withPluginDataApp(async (app) => {
            const racedSnapshot = racePluginCollectionQuerySnapshot({
                snapshot: { account, intent, contract, indexState, entries, rows },
                mutate: async () => {
                    const mutation = await app.inject({
                        method: "POST",
                        url: "/v1/plugins/data/mutate",
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": accountId,
                            ...V3_HEADERS,
                        },
                        payload: {
                            pluginId: PLUGIN_ID,
                            collectionId: COLLECTION_ID,
                            writerContext: {
                                schemaVersion: ref.schemaVersion,
                                contractDigest: ref.contractDigest,
                            },
                            operations: [{
                                kind: "put",
                                rowId: "task-a",
                                expectedRevision: 1,
                                content: { t: "plain", v: { privateNote: "updated" } },
                                projection: { status: "open", title: "After" },
                            }],
                        },
                    });
                    expect(mutation.statusCode).toBe(200);
                    expect(mutation.json()).toMatchObject({
                        status: "updated",
                        changeCursor: 78,
                    });
                },
            });
            try {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/plugins/data/ui-query",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": accountId,
                        ...V3_HEADERS,
                    },
                    payload: queryRequest(),
                });
                expect(response.statusCode).toBe(200);
                expect(PluginCollectionUiQueryResultV1Schema.parse(response.json())).toMatchObject({
                    // The static adapter is an owner-constrained view over the
                    // same snapshot, never a later row paired with cursor 77.
                    rows: [{
                        context: { rowId: "task-a", revision: 1 },
                        fields: { status: "open", title: "Before" },
                    }],
                    changeCursor: 77,
                });
            } finally {
                racedSnapshot.restore();
            }
        });
    });

    for (const queryCase of ACCOUNT_MODE_CURRENTNESS_QUERY_CASES) {
        it(`rejects ${queryCase.name} query rows when Account encryption mode changes after the row read`, async () => {
            const accountId = `account-query-mode-currentness-${queryCase.name}`;
            const secretTitle = `Must not disclose ${queryCase.name}`;
            const secretNote = `secret-after-${queryCase.name}`;
            await seedCurrentCollectionAccount({
                accountId,
                seq: 77,
                rows: [{
                    rowId: "task-a",
                    status: "open",
                    title: secretTitle,
                    revision: 1,
                    contentEnvelope: { t: "plain", v: { privateNote: secretNote } },
                }],
            });
            await withPluginDataApp(async (app) => {
                const modeFlip = flipAccountModeBeforePostQueryCurrentnessRead({
                    accountId,
                    seq: 78,
                });
                try {
                    const response = await app.inject({
                        method: "POST",
                        url: queryCase.url,
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": accountId,
                            ...V3_HEADERS,
                        },
                        payload: queryCase.payload,
                    });
                    expect(modeFlip.wasFlipped()).toBe(true);
                    expect(response.statusCode).toBe(409);
                    expect(response.json()).toEqual({ error: "collection_content_mode_mismatch" });
                    expect(response.body).not.toContain(secretTitle);
                    expect(response.body).not.toContain(secretNote);
                } finally {
                    modeFlip.restore();
                }
            });
        });
    }

    it("fails closed before direct reads disclose a mode-inconsistent row", async () => {
        const accountId = "account-direct-collection-mode-mismatch";
        await seedCurrentCollectionAccount({
            accountId,
            mode: "e2ee",
            rows: [{
                rowId: "task-encrypted",
                status: "open",
                title: "Must not disclose",
                revision: 1,
                contentEnvelope: { t: "plain", v: { privateNote: "wrong mode" } },
            }],
        });

        await withPluginDataApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                ...V3_HEADERS,
            };
            const get = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/get",
                headers,
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: "task-encrypted",
                },
            });
            expect(get.statusCode).toBe(409);
            expect(get.json()).toEqual({ error: "collection_content_mode_mismatch" });
            expect(get.body).not.toContain("Must not disclose");
            expect(get.body).not.toContain("wrong mode");

            const query = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "by-status",
                    prefix: ["open"],
                    order: "asc",
                },
            });
            expect(query.statusCode).toBe(409);
            expect(query.json()).toEqual({ error: "collection_content_mode_mismatch" });
            expect(query.body).not.toContain("Must not disclose");
            expect(query.body).not.toContain("wrong mode");
        });
    });

    it("keeps a forged descending direct-query cursor inside its admitted index range", async () => {
        const accountId = "account-direct-collection-descending-cursor";
        await seedCurrentCollectionAccount({
            accountId,
            rows: [
                { rowId: "task-closed-a", status: "closed", title: "First closed", revision: 1 },
                { rowId: "task-closed-b", status: "closed", title: "Second closed", revision: 2 },
                { rowId: "task-open", status: "open", title: "Must remain outside closed", revision: 3 },
            ],
        });

        await withPluginDataApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                ...V3_HEADERS,
            };
            const first = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "by-status",
                    prefix: ["closed"],
                    order: "desc",
                    limit: 1,
                },
            });
            expect(first.statusCode).toBe(200);
            const firstPage = PluginCollectionQueryResultV1Schema.parse(first.json());
            if (!firstPage.nextCursor) throw new Error("Expected a cursor from the first closed page.");
            const cursor = decodeBase64(firstPage.nextCursor, "base64url");
            const forgedCursorBytes = new Uint8Array(36);
            // Retain version and query fingerprint, but make the syntactically
            // valid key [0xff] larger than every stored key. The cursor is
            // query-bound but not secret, so the owner must retain the
            // declared upper range bound itself.
            forgedCursorBytes.set(cursor.subarray(0, 33));
            new DataView(forgedCursorBytes.buffer).setUint16(33, 1, false);
            forgedCursorBytes[35] = 0xff;
            const forgedCursor = encodeBase64(forgedCursorBytes, "base64url");

            const resumed = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers,
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "by-status",
                    prefix: ["closed"],
                    order: "desc",
                    limit: 10,
                    cursor: forgedCursor,
                },
            });
            expect(resumed.statusCode).toBe(200);
            const page = PluginCollectionQueryResultV1Schema.parse(resumed.json());
            expect(page.rows.map((row) => row.projection.status)).toEqual([
                "closed",
                "closed",
            ]);
            expect(resumed.body).not.toContain("Must remain outside closed");
        });
    });

    it("materializes an immutable manifest contract and returns only its declared query projection with keyset pagination", async () => {
        const accountId = "account-ui-query-a";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            seq: 77,
            rows: [
                { rowId: "task-a", status: "open", title: "First open", revision: 1 },
                { rowId: "task-b", status: "closed", title: "Closed", revision: 2 },
                { rowId: "task-c", status: "open", title: "Second open", revision: 3 },
            ],
        });

        await expect(db.pluginCollectionContract.findFirst({
            where: { contractDigest: ref.contractDigest },
            select: {
                pluginId: true,
                collectionId: true,
                schemaVersion: true,
                contractDigest: true,
                privacyProjection: true,
            },
        })).resolves.toMatchObject({
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            schemaVersion: 1,
            contractDigest: ref.contractDigest,
            privacyProjection: expect.objectContaining({
                rowIdField: "id",
                uiQueries: [expect.objectContaining({ id: QUERY_ID })],
            }),
        });

        await withPluginDataApp(async (app) => {
            const first = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest(),
            });
            expect(first.statusCode).toBe(200);
            const firstPage = PluginCollectionUiQueryResultV1Schema.parse(first.json());
            expect(firstPage).toEqual({
                rows: [{
                    context: {
                        collection: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
                        rowId: "task-a",
                        revision: 1,
                    },
                    fields: { status: "open", title: "First open" },
                }],
                nextCursor: expect.any(String),
                changeCursor: 77,
            });
            expect(JSON.stringify(firstPage)).not.toContain("secret-task-a");

            const second = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest({ cursor: firstPage.nextCursor }),
            });
            expect(second.statusCode).toBe(200);
            expect(PluginCollectionUiQueryResultV1Schema.parse(second.json())).toEqual({
                rows: [{
                    context: {
                        collection: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
                        rowId: "task-c",
                        revision: 3,
                    },
                    fields: { status: "open", title: "Second open" },
                }],
                changeCursor: 77,
            });
        });
    });

    it("rejects a static UI-query cursor replayed by a different authenticated Account", async () => {
        const accountA = "account-ui-query-cursor-a";
        const accountB = "account-ui-query-cursor-b";
        await seedCurrentCollectionAccount({
            accountId: accountA,
            rows: [
                { rowId: "task-a", status: "open", title: "A first", revision: 1 },
                { rowId: "task-b", status: "open", title: "A second", revision: 2 },
            ],
        });
        await seedCurrentCollectionAccount({
            accountId: accountB,
            rows: [
                { rowId: "task-a", status: "open", title: "B first", revision: 1 },
                { rowId: "task-b", status: "open", title: "B second", revision: 2 },
            ],
        });

        await withPluginDataApp(async (app) => {
            const first = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountA,
                    ...V3_HEADERS,
                },
                payload: queryRequest(),
            });
            expect(first.statusCode).toBe(200);
            const firstPage = PluginCollectionUiQueryResultV1Schema.parse(first.json());
            if (!firstPage.nextCursor) throw new Error("Expected an Account-A UI cursor.");

            const replay = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountB,
                    ...V3_HEADERS,
                },
                payload: queryRequest({ cursor: firstPage.nextCursor }),
            });
            expect(replay.statusCode).toBe(400);
            expect(replay.json()).toEqual({ error: "collection_cursor_invalid" });
        });
    });

    it("isolates rows by authenticated Account and rejects foreign/malformed query authority", async () => {
        const accountA = "account-ui-query-a";
        const accountB = "account-ui-query-b";
        await seedCurrentCollectionAccount({
            accountId: accountA,
            rows: [{ rowId: "task-a", status: "open", title: "A private task", revision: 1 }],
        });
        await seedCurrentCollectionAccount({
            accountId: accountB,
            rows: [{ rowId: "task-b", status: "open", title: "B private task", revision: 1 }],
        });

        await withPluginDataApp(async (app) => {
            const own = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountB,
                    ...V3_HEADERS,
                },
                payload: queryRequest(),
            });
            expect(own.statusCode).toBe(200);
            expect(PluginCollectionUiQueryResultV1Schema.parse(own.json()).rows).toEqual([
                expect.objectContaining({ context: expect.objectContaining({ rowId: "task-b" }) }),
            ]);
            expect(own.body).not.toContain("A private task");

            const foreign = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountB,
                    ...V3_HEADERS,
                },
                payload: queryRequest({ collectionId: "other-collection" }),
            });
            expect(foreign.statusCode).toBe(404);
            expect(foreign.json()).toEqual({ error: "collection_unavailable" });

            const malformed = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountB,
                    ...V3_HEADERS,
                },
                payload: queryRequest({ parameters: { status: "open", unexpected: "no" } }),
            });
            expect(malformed.statusCode).toBe(400);
            expect(malformed.json()).toEqual({ error: "collection_query_invalid" });

            const malformedShape = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountB,
                    ...V3_HEADERS,
                },
                payload: { ...queryRequest(), callerSuppliedContract: "forbidden" },
            });
            expect(malformedShape.statusCode).toBe(400);
            expect(malformedShape.json()).toEqual({ error: "collection_query_invalid" });
        });
    });

    it("requires V3, binds cursors to the declared query, and fails closed when the current writable contract disappears", async () => {
        const accountId = "account-ui-query-currentness";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [
                { rowId: "task-a", status: "open", title: "First", revision: 1 },
                { rowId: "task-b", status: "open", title: "Second", revision: 2 },
            ],
        });

        await withPluginDataApp(async (app) => {
            const oldProtocol = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    "x-happier-account-stored-content-protocol": "2",
                },
                payload: queryRequest(),
            });
            expect(oldProtocol.statusCode).toBe(426);
            expect(oldProtocol.json()).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
                },
            });

            const first = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest(),
            });
            const firstPage = PluginCollectionUiQueryResultV1Schema.parse(first.json());
            const rebound = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest({
                    parameters: { status: "closed" },
                    cursor: firstPage.nextCursor,
                }),
            });
            expect(rebound.statusCode).toBe(400);
            expect(rebound.json()).toEqual({ error: "collection_cursor_invalid" });
        });

        await db.accountPluginIntent.update({
            where: { accountId_pluginId: { accountId, pluginId: PLUGIN_ID } },
            data: { writableCollections: toPrismaJson([]) },
        });
        await withPluginDataApp(async (app) => {
            const unavailable = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest(),
            });
            expect(unavailable.statusCode).toBe(404);
            expect(unavailable.json()).toEqual({ error: "collection_unavailable" });
        });
        expect(ref.contractDigest).toHaveLength(43);
    });

    it("rejects a mode-inconsistent row before returning its server-readable projection", async () => {
        const accountId = "account-ui-query-encrypted";
        const seeded = await seedCurrentCollectionAccount({
            accountId,
            mode: "e2ee",
            rows: [{
                rowId: "task-encrypted",
                status: "open",
                title: "Must not disclose",
                revision: 1,
                contentEnvelope: { t: "plain", v: { privateNote: "wrong mode" } },
            }],
        });

        await withPluginDataApp(async (app) => {
            const mismatch = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest(),
            });
            expect(mismatch.statusCode).toBe(409);
            expect(mismatch.json()).toEqual({ error: "collection_content_mode_mismatch" });
            expect(mismatch.body).not.toContain("Must not disclose");
        });

        await db.pluginCollectionRow.update({
            where: {
                accountId_pluginId_collectionId_rowId: {
                    accountId,
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: "task-encrypted",
                },
            },
            data: {
                contentEnvelope: toPrismaJson({
                    t: "encrypted",
                    c: sealPluginCollectionPrivatePayloadV1({
                        material: { type: "dataKey", machineKey: new Uint8Array(32).fill(9) },
                        payload: { privateNote: "correct encryption domain" },
                        randomBytes: (length) => new Uint8Array(length).fill(7),
                    }),
                }),
            },
        });
        await withPluginDataApp(async (app) => {
            const readable = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest(),
            });
            expect(readable.statusCode).toBe(200);
            expect(PluginCollectionUiQueryResultV1Schema.parse(readable.json()).rows).toEqual([
                expect.objectContaining({ fields: { status: "open", title: "Must not disclose" } }),
            ]);

            const direct = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/get",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: "task-encrypted",
                },
            });
            expect(direct.statusCode).toBe(200);
            expect(PluginCollectionGetResultV1Schema.parse(direct.json())).toMatchObject({
                row: {
                    rowId: "task-encrypted",
                    revision: 1,
                    content: { t: "encrypted" },
                    projection: { status: "open", title: "Must not disclose" },
                },
            });
        });

        expect(seeded.ref.pluginId).toBe(PLUGIN_ID);
    });

    it("rejects a parseable but non-canonical instant parameter as query input", async () => {
        const accountId = "account-ui-query-instant";
        await seedReadyEmptyInstantCollectionAccount(accountId);

        await withPluginDataApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: "example.events",
                    collectionId: "events",
                    uiQueryId: "at",
                    parameters: { at: "2026-01-02T03:04:05Z" },
                },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "collection_query_invalid" });
        });
    });

    it("rejects non-canonical non-indexed instants before direct and static queries decode them", async () => {
        const accountId = "account-non-indexed-instant-mutation";
        const ref = await seedReadyNonIndexedInstantCollectionAccount(accountId);
        const canonicalInstant = "2026-08-10T19:30:00.000Z";

        await withPluginDataApp(async (app) => {
            const mutate = async (rowId: string, occurredAt: string) => await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: NON_INDEXED_INSTANT_COLLECTION_MANIFEST.id,
                    collectionId: "events",
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId,
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { status: "open", "occurred-at": occurredAt },
                    }],
                },
            });

            for (const [rowId, occurredAt] of [
                ["offset", "2026-08-10T21:30:00+02:00"],
                ["missing-milliseconds", "2026-08-10T19:30:00Z"],
            ] as const) {
                const rejected = await mutate(rowId, occurredAt);
                expect(rejected.statusCode).toBe(400);
                expect(rejected.json()).toEqual({ error: "collection_mutation_invalid" });
            }

            const admitted = await mutate("canonical", canonicalInstant);
            expect(admitted.statusCode).toBe(200);

            const direct = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: NON_INDEXED_INSTANT_COLLECTION_MANIFEST.id,
                    collectionId: "events",
                    indexId: "by-status",
                    prefix: ["open"],
                    order: "asc",
                    limit: 1,
                },
            });
            expect(direct.statusCode).toBe(200);
            expect(PluginCollectionQueryResultV1Schema.parse(direct.json())).toMatchObject({
                rows: [{
                    rowId: "canonical",
                    projection: { status: "open", "occurred-at": canonicalInstant },
                }],
            });

            const staticQuery = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: NON_INDEXED_INSTANT_COLLECTION_MANIFEST.id,
                    collectionId: "events",
                    uiQueryId: "open",
                    parameters: { status: "open" },
                },
            });
            expect(staticQuery.statusCode).toBe(200);
            expect(PluginCollectionUiQueryResultV1Schema.parse(staticQuery.json())).toMatchObject({
                rows: [{
                    context: { rowId: "canonical", revision: 1 },
                    fields: { status: "open", "occurred-at": canonicalInstant },
                }],
            });
        });
    });

    it("admits the current writer contract and atomically makes a row visible to its static UI query", async () => {
        const accountId = "account-collection-mutation";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            seq: 41,
            rows: [],
        });

        await withPluginDataApp(async (app) => {
            const mutation = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-written",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "never projected" } },
                        projection: { status: "open", title: "Written task" },
                    }],
                },
            });

            expect(mutation.statusCode).toBe(200);
            expect(mutation.json()).toEqual({
                status: "updated",
                results: [{ rowId: "task-written", revision: 1, deleted: false }],
                changeCursor: 42,
            });

            const queried = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest(),
            });
            expect(queried.statusCode).toBe(200);
            expect(PluginCollectionUiQueryResultV1Schema.parse(queried.json())).toEqual({
                rows: [{
                    context: {
                        collection: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
                        rowId: "task-written",
                        revision: 1,
                    },
                    fields: { status: "open", title: "Written task" },
                }],
                changeCursor: 42,
            });
        });

        await expect(db.pluginCollectionRow.findFirst({
            where: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "task-written",
            },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 1,
            contentEnvelope: { t: "plain", v: { privateNote: "never projected" } },
        });
        await expect(db.accountChange.findFirst({
            where: {
                accountId,
                kind: "pluginDomain",
                entityId: `pluginDomain/${PLUGIN_ID}/data-collection/${COLLECTION_ID}`,
            },
            select: { cursor: true, hint: true },
        })).resolves.toEqual({
            cursor: 42,
            hint: {
                pluginDomain: "dataCollection",
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                contractDigest: ref.contractDigest,
                revision: 1,
                rowIds: ["task-written"],
            },
        });
    });

    it("evaluates live-row batch assertions before writes without emitting assertion state", async () => {
        const accountId = "account-collection-batch-assert";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            seq: 41,
            rows: [{ rowId: "task-current", status: "open", title: "Current", revision: 3 }],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [
                    { kind: "assert", rowId: "task-current", expectedRevision: 3 },
                    {
                        kind: "put",
                        rowId: "task-written",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "new" } },
                        projection: { status: "open", title: "Written" },
                    },
                ],
            },
        })).resolves.toEqual({
            status: "updated",
            results: [{ rowId: "task-written", revision: 1, deleted: false }],
            changeCursor: 42,
        });

        await expect(db.pluginCollectionRow.findMany({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
            },
            orderBy: { rowId: "asc" },
            select: { rowId: true, revision: true, deletedAt: true },
        })).resolves.toEqual([
            { rowId: "task-current", revision: 3, deletedAt: null },
            { rowId: "task-written", revision: 1, deletedAt: null },
        ]);
        await expect(db.accountChange.findMany({
            where: { accountId },
            select: { hint: true },
        })).resolves.toEqual([{
            hint: {
                pluginDomain: "dataCollection",
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                contractDigest: ref.contractDigest,
                revision: 1,
                rowIds: ["task-written"],
            },
        }]);

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [
                    { kind: "assert", rowId: "task-current", expectedRevision: 2 },
                    { kind: "assert", rowId: "task-missing", expectedRevision: 1 },
                    {
                        kind: "put",
                        rowId: "task-after-conflict",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "must not persist" } },
                        projection: { status: "open", title: "Must not persist" },
                    },
                ],
            },
        })).resolves.toEqual({
            status: "conflict",
            conflicts: [
                { rowId: "task-current", revision: 3, deleted: false },
                { rowId: "task-missing", revision: null, deleted: false },
            ],
        });
        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: "task-after-conflict",
            },
        })).resolves.toBe(0);
        await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(1);
    });

    it("rejects a tombstone as an assertion currentness match before any batch write", async () => {
        const accountId = "account-collection-batch-assert-tombstone";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{ rowId: "task-tombstone", status: "open", title: "Tombstone", revision: 3 }],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };
        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{ kind: "delete", rowId: "task-tombstone", expectedRevision: 3 }],
            },
        })).resolves.toMatchObject({ status: "updated" });

        await expect(db.pluginCollectionRow.findFirstOrThrow({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: "task-tombstone",
            },
            select: {
                id: true,
                rowId: true,
                revision: true,
                deletedAt: true,
                contentEnvelope: true,
            },
        })).resolves.toEqual({
            id: expect.any(String),
            rowId: "task-tombstone",
            revision: 4,
            deletedAt: expect.any(Date),
            contentEnvelope: null,
        });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [
                    { kind: "assert", rowId: "task-tombstone", expectedRevision: 4 },
                    {
                        kind: "put",
                        rowId: "task-after-tombstone-assert",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "must not persist" } },
                        projection: { status: "open", title: "Must not persist" },
                    },
                ],
            },
        })).resolves.toEqual({
            status: "conflict",
            conflicts: [{ rowId: "task-tombstone", revision: 4, deleted: true }],
        });
        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: "task-after-tombstone-assert",
            },
        })).resolves.toBe(0);
        await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(1);
    });

    it("does not resurrect a retained tombstone through an absent put", async () => {
        const accountId = "account-collection-tombstone-absent-put";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-tombstone",
                status: "open",
                title: "Tombstone",
                revision: 3,
            }],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };
        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "delete",
                    rowId: "task-tombstone",
                    expectedRevision: 3,
                }],
            },
        })).resolves.toMatchObject({ status: "updated" });
        const before = await db.pluginCollectionRow.findFirstOrThrow({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: "task-tombstone",
            },
        });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-tombstone",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: {
                        t: "plain",
                        v: { privateNote: "must not resurrect" },
                    },
                    projection: {
                        status: "open",
                        title: "Must not resurrect",
                    },
                }],
            },
        })).resolves.toEqual({
            status: "conflict",
            conflicts: [{
                rowId: "task-tombstone",
                revision: 4,
                deleted: true,
            }],
        });
        await expect(db.pluginCollectionRow.findFirstOrThrow({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: "task-tombstone",
            },
        })).resolves.toEqual(before);
        await expect(db.accountChange.count({
            where: { accountId },
        })).resolves.toBe(1);
    });

    it("rejects a stale absent writer after physical forget and accepts a fresh observed epoch", async () => {
        const accountId = "account-collection-forget-aba";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-forget-aba",
                status: "open",
                title: "Forget ABA",
                revision: 3,
            }],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };

        let observedAbsenceEpoch = -1;
        await withPluginDataApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/get",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: "task-forget-aba",
                },
            });
            expect(response.statusCode).toBe(200);
            const snapshot = PluginCollectionGetResultV1Schema.parse(response.json());
            expect(snapshot.row?.revision).toBe(3);
            observedAbsenceEpoch = snapshot.absenceEpoch;
        });
        expect(observedAbsenceEpoch).toBe(0);

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "delete",
                    rowId: "task-forget-aba",
                    expectedRevision: 3,
                }],
            },
        })).resolves.toMatchObject({
            status: "updated",
            results: [{ rowId: "task-forget-aba", revision: 4, deleted: true }],
        });

        await withPluginDataApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/forget",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    writerContext,
                    rowId: "task-forget-aba",
                    expectedRevision: 4,
                    expectedAbsenceEpoch: observedAbsenceEpoch,
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "forgotten" });
        });
        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "task-forget-aba",
            },
        })).resolves.toBe(0);

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-forget-aba",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: observedAbsenceEpoch,
                    content: { t: "plain", v: { privateNote: "stale" } },
                    projection: { status: "open", title: "Stale" },
                }],
            },
        })).resolves.toEqual({
            status: "conflict",
            conflicts: [{ rowId: "task-forget-aba", revision: null, deleted: false }],
        });

        let freshAbsenceEpoch = -1;
        await withPluginDataApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/get",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: "task-forget-aba",
                },
            });
            expect(response.statusCode).toBe(200);
            const snapshot = PluginCollectionGetResultV1Schema.parse(response.json());
            expect(snapshot.row).toBeNull();
            freshAbsenceEpoch = snapshot.absenceEpoch;
        });
        expect(freshAbsenceEpoch).toBeGreaterThan(observedAbsenceEpoch);

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-forget-aba",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: freshAbsenceEpoch,
                    content: { t: "plain", v: { privateNote: "fresh" } },
                    projection: { status: "open", title: "Fresh" },
                }],
            },
        })).resolves.toMatchObject({
            status: "updated",
            results: [{ rowId: "task-forget-aba", revision: freshAbsenceEpoch + 1, deleted: false }],
        });
        await expect(db.pluginCollectionRow.findFirstOrThrow({
            where: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "task-forget-aba",
            },
            select: { revision: true, deletedAt: true },
        })).resolves.toEqual({ revision: freshAbsenceEpoch + 1, deletedAt: null });
    });

    it("preserves a provider timeout from the pre-mutation quota census", async () => {
        harness.resetEnv({ HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const accountId = "account-collection-pre-census-provider-timeout";
        const { ref } = await seedCurrentCollectionAccount({ accountId, rows: [] });
        const providerTimeout = Object.assign(
            new Error("Timed out fetching a new connection during the quota census."),
            { code: "P2024" },
        );
        const boundary = failPluginCollectionQuotaCensusRead({
            accountId,
            occurrence: 1,
            error: providerTimeout,
        });

        try {
            await expect(mutatePluginCollection({
                accountId,
                request: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-new",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "new" } },
                        projection: { status: "open", title: "New" },
                    }],
                },
            })).rejects.toBe(providerTimeout);
            expect(boundary.censusReads()).toBe(1);
            await expect(db.pluginCollectionRow.count({
                where: { accountId, rowId: "task-new" },
            })).resolves.toBe(0);
        } finally {
            boundary.restore();
        }
    });

    it("preserves a provider timeout from the post-mutation quota census and rolls back", async () => {
        harness.resetEnv({ HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const accountId = "account-collection-post-census-provider-timeout";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{ rowId: "task-existing", status: "open", title: "Before", revision: 1 }],
        });
        const providerTimeout = Object.assign(
            new Error("Timed out fetching a new connection during the quota census."),
            { code: "P2024" },
        );
        const boundary = failPluginCollectionQuotaCensusRead({
            accountId,
            occurrence: 2,
            error: providerTimeout,
        });

        try {
            await expect(mutatePluginCollection({
                accountId,
                request: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-existing",
                        expectedRevision: 1,
                        content: { t: "plain", v: { privateNote: "after" } },
                        projection: { status: "open", title: "After" },
                    }],
                },
            })).rejects.toBe(providerTimeout);
            expect(boundary.censusReads()).toBe(2);
            await expect(db.pluginCollectionRow.findFirstOrThrow({
                where: { accountId, rowId: "task-existing" },
                select: { revision: true, contentEnvelope: true },
            })).resolves.toEqual({
                revision: 1,
                contentEnvelope: { t: "plain", v: { privateNote: "secret-task-existing" } },
            });
        } finally {
            boundary.restore();
        }
    });

    it("keeps a malformed persisted contract observed by the quota census typed as contract inconsistency", async () => {
        const accountId = "account-collection-census-malformed-contract";
        const { ref } = await seedCurrentCollectionAccount({ accountId, rows: [] });
        const additional = await seedAdditionalCurrentCollectionRow({
            accountId,
            manifest: ROW_AND_COUNT_QUOTA_COLLECTION_MANIFEST,
            row: { rowId: "malformed-contract-row", status: "open", title: "Malformed", revision: 1 },
        });
        await db.pluginCollectionContract.updateMany({
            where: {
                pluginId: additional.ref.pluginId,
                collectionId: additional.ref.collectionId,
                schemaVersion: additional.ref.schemaVersion,
                contractDigest: additional.ref.contractDigest,
            },
            data: { privacyProjection: toPrismaJson({ v: 1 }) },
        });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext: {
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                operations: [{
                    kind: "put",
                    rowId: "task-new",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: { privateNote: "new" } },
                    projection: { status: "open", title: "New" },
                }],
            },
        })).rejects.toMatchObject({ code: "collection_contract_inconsistent" });
    });

    it("rejects a concurrent 31-to-33 indexed-prefix candidate at the quota transaction owner", async () => {
        const accountId = "account-collection-prefix-quota";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            manifest: PREFIX_QUOTA_COLLECTION_MANIFEST,
            rows: [
                ...Array.from({ length: 31 }, (_, index) => ({
                    rowId: `task-${index + 1}`,
                    status: "open" as const,
                    title: `Task ${index + 1}`,
                    revision: 1,
                })),
                { rowId: "task-closed", status: "closed" as const, title: "Outside quota prefix", revision: 1 },
            ],
        });
        const mutate = (rowId: string) => mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext: {
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                operations: [{
                    kind: "put",
                    rowId,
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: { privateNote: rowId } },
                    projection: { status: "open", title: rowId },
                }],
            },
        });

        const outcomes = await Promise.allSettled([
            mutate("task-32"),
            mutate("task-33"),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
            status: "rejected",
            reason: {
                code: "collection_quota_incompatible",
                dimension: "maxRows",
                effectiveMaximum: 32,
            },
        });
        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                deletedAt: null,
            },
        })).resolves.toBe(33);
    }, 30_000);

    it("rejects current-contract activation when persisted indexed-prefix state already exceeds its declared maximum", async () => {
        const accountId = "account-collection-prefix-activation-overage";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            manifest: LOWERED_PREFIX_QUOTA_COLLECTION_MANIFEST,
            rows: [
                { rowId: "task-1", status: "open", title: "First", revision: 1 },
                { rowId: "task-2", status: "open", title: "Second", revision: 1 },
            ],
        });

        await expect(inTx(async (tx) => (
            await preparePluginCollectionWritableContractsTx({
                tx,
                accountId,
                pluginId: ref.pluginId,
                contracts: [ref],
            })
        ))).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxRows",
            effectiveMaximum: 1,
        });
    });

    it("allows a prefix-quota overage to decrease even while it remains above the lowered maximum", async () => {
        const accountId = "account-collection-lowered-prefix-overage";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            manifest: LOWERED_PREFIX_QUOTA_COLLECTION_MANIFEST,
            rows: [
                { rowId: "task-1", status: "open", title: "First", revision: 1 },
                { rowId: "task-2", status: "open", title: "Second", revision: 1 },
                { rowId: "task-3", status: "open", title: "Third", revision: 1 },
            ],
        });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext: {
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                operations: [{
                    kind: "delete",
                    rowId: "task-1",
                    expectedRevision: 1,
                }],
            },
        })).resolves.toMatchObject({
            status: "updated",
            results: [{ rowId: "task-1", revision: 2, deleted: true }],
        });
        await expect(db.pluginCollectionRow.count({
            where: { accountId, pluginId: ref.pluginId, collectionId: ref.collectionId, deletedAt: null },
        })).resolves.toBe(2);
    });

    it("does not let a small write in another current Collection bypass a retained declared row overage", async () => {
        const accountId = "account-collection-untouched-declared-overage";
        const { ref } = await seedCurrentCollectionAccount({ accountId, rows: [] });
        await seedAdditionalCurrentCollectionRow({
            accountId,
            manifest: ROW_AND_COUNT_QUOTA_COLLECTION_MANIFEST,
            row: {
                rowId: "oversized-row",
                status: "open",
                title: "x".repeat(256),
                revision: 1,
                contentEnvelope: { t: "plain", v: { privateNote: "x".repeat(256) } },
            },
        });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext: {
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                operations: [{
                    kind: "put",
                    rowId: "small-write",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: { privateNote: "small" } },
                    projection: { status: "open", title: "Small" },
                }],
            },
        })).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxRowEncodedBytes",
            effectiveMaximum: 256,
        });
        await expect(db.pluginCollectionRow.count({
            where: { accountId, pluginId: ref.pluginId, collectionId: ref.collectionId, rowId: "small-write" },
        })).resolves.toBe(0);
    });

    it("does not let an unrelated write bypass a retained row after the deployment row ceiling is lowered", async () => {
        harness.resetEnv({ HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: String(512 * 1024) });
        const accountId = "account-collection-untouched-deployment-overage";
        const { ref } = await seedCurrentCollectionAccount({ accountId, rows: [] });
        await seedAdditionalCurrentCollectionRow({
            accountId,
            manifest: LARGE_ROW_QUOTA_COLLECTION_MANIFEST,
            row: {
                rowId: "formerly-valid-large-row",
                status: "open",
                title: "Large",
                revision: 1,
                contentEnvelope: { t: "plain", v: { privateNote: "x".repeat(600 * 1024) } },
            },
        });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext: {
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                operations: [{
                    kind: "put",
                    rowId: "unrelated-small-write",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: { privateNote: "small" } },
                    projection: { status: "open", title: "Small" },
                }],
            },
        })).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxRowEncodedBytes",
            effectiveMaximum: 512 * 1024,
        });
        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: "unrelated-small-write",
            },
        })).resolves.toBe(0);
    });

    it("measures the complete Account state through one shared persisted-row metric and returns typed effective-limit failures", async () => {
        const accountId = "account-collection-row-and-count-quota";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            manifest: ROW_AND_COUNT_QUOTA_COLLECTION_MANIFEST,
            rows: Array.from({ length: 50 }, (_, index) => ({
                rowId: `task-${index + 1}`,
                status: "open" as const,
                title: `Existing ${index + 1}`,
                revision: 1,
            })),
        });
        const originalTransaction = db.$transaction.bind(db);
        const findManyInputs: unknown[] = [];
        let restored = false;
        Reflect.set(db, "$transaction", async (...args: Parameters<typeof db.$transaction>) => {
            const [callback, options] = args;
            if (typeof callback !== "function") {
                return await originalTransaction(...args);
            }
            return await originalTransaction(async (tx) => {
                // This narrow database-boundary observer retains the actual
                // transaction and mutation path while recording only quota IO.
                const observedTx = Object.create(tx) as Tx;
                const observedRows = Object.create(tx.pluginCollectionRow);
                const originalFindMany = tx.pluginCollectionRow.findMany.bind(tx.pluginCollectionRow);
                Object.defineProperties(observedRows, {
                    findMany: {
                        value: async (...findManyArgs: Parameters<typeof tx.pluginCollectionRow.findMany>) => {
                            findManyInputs.push(findManyArgs[0]);
                            return await originalFindMany(...findManyArgs);
                        },
                    },
                });
                Object.defineProperty(observedTx, "pluginCollectionRow", { value: observedRows });
                return await callback(observedTx);
            }, options);
        });

        try {
            await expect(mutatePluginCollection({
                accountId,
                request: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-new",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "new" } },
                        projection: { status: "open", title: "New task" },
                    }],
                },
            })).resolves.toMatchObject({
                status: "updated",
                results: [{ rowId: "task-new", revision: 1, deleted: false }],
            });

            // One Account-wide census reads every live row through the same
            // stored-row metric — envelope plus typed projections plus the
            // contract that owns the quota — instead of measuring each
            // Collection separately. It is paged, and the page is bounded and
            // walked in the supporting index's own column order.
            const censusPages = findManyInputs.filter((input): input is Readonly<{
                where: Readonly<{ accountId?: unknown; pluginId?: unknown; deletedAt?: unknown }>;
                orderBy?: unknown;
                take?: unknown;
                select?: Readonly<Record<string, unknown>>;
            }> => {
                if (typeof input !== "object" || input === null || !("where" in input)) return false;
                const where = (input as Readonly<{ where?: Readonly<Record<string, unknown>> }>).where;
                return where?.accountId === accountId
                    && where?.deletedAt === null
                    && where?.pluginId === undefined;
            });
            expect(censusPages.length).toBeGreaterThan(0);
            for (const page of censusPages) {
                expect(page.select).toMatchObject({
                    contentEnvelope: true,
                    projections: { select: { fieldId: true, typedEncodedValue: true } },
                    contract: { select: { normalizedSchema: true, privacyProjection: true } },
                });
                expect(page.orderBy).toEqual([
                    { accountId: "asc" },
                    { deletedAt: "asc" },
                    { id: "asc" },
                ]);
                expect(typeof page.take).toBe("number");
                expect(page.take as number).toBeGreaterThanOrEqual(1);
            }
            await expect(mutatePluginCollection({
                accountId,
                request: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-too-large",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "x".repeat(256) } },
                        projection: { status: "open", title: "x".repeat(256) },
                    }],
                },
            })).rejects.toMatchObject({
                code: "collection_quota_incompatible",
                dimension: "maxRowEncodedBytes",
                effectiveMaximum: 256,
            });
            await expect(db.pluginCollectionRow.count({
                where: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: "task-too-large",
                },
            })).resolves.toBe(0);
        } finally {
            if (!restored) {
                restored = true;
                Reflect.set(db, "$transaction", originalTransaction);
            }
        }
    });

    it("rejects a deployment-bounded batch before its mutation transaction can persist any row", async () => {
        harness.resetEnv({ HAPPIER_COLLECTION_MAX_BATCH_ROWS: "1" });
        const accountId = "account-collection-deployment-batch-limit";
        const { ref } = await seedCurrentCollectionAccount({ accountId, rows: [] });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [
                    {
                        kind: "put",
                        rowId: "task-1",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "first" } },
                        projection: { status: "open", title: "First" },
                    },
                    {
                        kind: "put",
                        rowId: "task-2",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "second" } },
                        projection: { status: "open", title: "Second" },
                    },
                ],
            },
        })).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxBatchRows",
            effectiveMaximum: 1,
        });
        await expect(db.pluginCollectionRow.count({ where: { accountId } })).resolves.toBe(0);
        await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(0);
    });

    it("keeps lowered-overage rows readable while allowing only a strictly reducing Collection mutation", async () => {
        // The deployment Account row ceiling is also this collection's upper
        // bound, while the batch ceiling must remain coherent with it.
        harness.resetEnv({
            HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: "1",
            HAPPIER_COLLECTION_MAX_BATCH_ROWS: "1",
        });
        const accountId = "account-collection-lowered-row-limit";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [
                { rowId: "task-1", status: "open", title: "Existing 1", revision: 1 },
                { rowId: "task-2", status: "open", title: "Existing 2", revision: 1 },
            ],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };

        await withPluginDataApp(async (app) => {
            const read = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    indexId: "by-status",
                    prefix: ["open"],
                    order: "asc",
                    limit: 200,
                },
            });
            expect(read.statusCode).toBe(200);
            expect(PluginCollectionQueryResultV1Schema.parse(read.json()).rows.map((row) => row.rowId))
                .toEqual(["task-1", "task-2"]);
        });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-1",
                    expectedRevision: 1,
                    content: { t: "plain", v: { privateNote: "non-reducing" } },
                    projection: { status: "open", title: "Existing 1" },
                }],
            },
        })).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxRows",
            effectiveMaximum: 1,
        });
        await expect(db.pluginCollectionRow.findFirstOrThrow({
            where: { accountId, rowId: "task-1" },
            select: { revision: true, deletedAt: true },
        })).resolves.toEqual({ revision: 1, deletedAt: null });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "delete",
                    rowId: "task-1",
                    expectedRevision: 1,
                }],
            },
        })).resolves.toMatchObject({
            status: "updated",
            results: [{ rowId: "task-1", revision: 2, deleted: true }],
        });
        await expect(db.pluginCollectionRow.count({
            where: { accountId, deletedAt: null },
        })).resolves.toBe(1);
    });

    it("commits a 10,000-row reducing delete before the default SQLite transaction attempt expires", async () => {
        harness.resetEnv({ HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: "9998" });
        const accountId = "account-collection-default-limit-scale";
        const { ref, contract, indexState } = await seedCurrentCollectionAccount({ accountId, rows: [] });
        const rowCount = 10_000;
        const seedBatchSize = 500;
        const contentEnvelope = toPrismaJson({
            t: "plain",
            v: { privateNote: "x".repeat(256) },
        });

        for (let offset = 0; offset < rowCount; offset += seedBatchSize) {
            const rowIds = Array.from(
                { length: Math.min(seedBatchSize, rowCount - offset) },
                (_, index) => `scale-${String(offset + index).padStart(5, "0")}`,
            );
            await db.pluginCollectionRow.createMany({
                data: rowIds.map((rowId) => ({
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId,
                    schemaVersion: ref.schemaVersion,
                    revision: 1,
                    contractId: contract.id,
                    contractDigest: ref.contractDigest,
                    contentEnvelope,
                })),
            });
            const seededRows = await db.pluginCollectionRow.findMany({
                where: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: { in: rowIds },
                },
                select: { id: true, rowId: true },
            });
            expect(seededRows).toHaveLength(rowIds.length);
            await db.pluginCollectionProjection.createMany({
                data: seededRows.flatMap((row) => [
                    {
                        rowDbId: row.id,
                        accountId,
                        pluginId: ref.pluginId,
                        collectionId: ref.collectionId,
                        rowId: row.rowId,
                        fieldId: "status",
                        typedEncodedValue: JSON.stringify("open"),
                        rowRevision: 1,
                    },
                    {
                        rowDbId: row.id,
                        accountId,
                        pluginId: ref.pluginId,
                        collectionId: ref.collectionId,
                        rowId: row.rowId,
                        fieldId: "title",
                        typedEncodedValue: JSON.stringify(`Scale ${row.rowId} payload!!`),
                        rowRevision: 1,
                    },
                ]),
            });
            await db.pluginCollectionIndexEntry.createMany({
                data: seededRows.map((row) => ({
                    indexStateId: indexState.id,
                    encodedSortKey: copyBytes(encodePluginCollectionIndexSortKeyV1({
                        fields: [{ kind: "string", value: "open" }],
                        rowId: row.rowId,
                    })),
                    rowId: row.rowId,
                    rowRevision: 1,
                })),
            });
        }

        const startedAt = performance.now();
        const outcome = await Promise.allSettled([mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext: {
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                operations: [{
                    kind: "delete",
                    rowId: "scale-00000",
                    expectedRevision: 1,
                }],
            },
        })]);
        const elapsedMs = performance.now() - startedAt;
        const result = outcome[0];
        if (!result || result.status !== "fulfilled") {
            const reason = result && result.status === "rejected" ? result.reason : undefined;
            const reasonText = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
            throw new Error(`10,000-row reducing delete rejected after ${Math.round(elapsedMs)} ms: ${reasonText}`);
        }

        expect(result.value).toMatchObject({
            status: "updated",
            results: [{ rowId: "scale-00000", revision: 2, deleted: true }],
        });
        expect(elapsedMs).toBeLessThan(10_000);
        await expect(db.pluginCollectionRow.count({
            where: { accountId, deletedAt: null },
        })).resolves.toBe(9_999);
    }, 120_000);

    it("enforces the Account row ceiling across separately under-limit current Collections", async () => {
        harness.resetEnv({
            HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: "2",
            HAPPIER_COLLECTION_MAX_BATCH_ROWS: "2",
        });
        const accountId = "account-collection-cross-collection-aggregate";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{ rowId: "task-existing", status: "open", title: "Existing", revision: 1 }],
        });
        await seedAdditionalCurrentCollectionRow({
            accountId,
            manifest: {
                ...COLLECTION_MANIFEST,
                id: "example.other-aggregate",
                displayName: "Aggregate quota fixture",
            },
            row: { rowId: "other-existing", status: "open", title: "Other", revision: 1 },
        });

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext: {
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                operations: [{
                    kind: "put",
                    rowId: "task-new",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: { privateNote: "new" } },
                    projection: { status: "open", title: "New" },
                }],
            },
        })).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxAccountRows",
            effectiveMaximum: 2,
        });
        await expect(db.pluginCollectionRow.count({ where: { accountId, deletedAt: null } })).resolves.toBe(2);
        await expect(db.pluginCollectionRow.count({
            where: { accountId, pluginId: ref.pluginId, collectionId: ref.collectionId, rowId: "task-new" },
        })).resolves.toBe(0);
    });

    it("derives a same-plugin relation edge only after its current target exists", async () => {
        const accountId = "account-collection-relation";
        const { projectRef, taskRef } = await seedReadyRelationCollectionAccount(accountId);

        await withPluginDataApp(async (app) => {
            const project = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "project-a",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "project-a", title: "Project A" },
                    }],
                },
            });
            expect(project.statusCode).toBe(200);

            const task = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: taskRef.schemaVersion,
                        contractDigest: taskRef.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-a",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "task-a", title: "Task A", "project-id": "project-a" },
                    }],
                },
            });
            expect(task.statusCode).toBe(200);
        });

        await expect(db.pluginCollectionRelation.findMany({
            where: { accountId, sourceCollectionId: "tasks", sourceRowId: "task-a" },
            select: {
                relationId: true,
                targetKind: true,
                targetPluginId: true,
                targetCollectionId: true,
                targetRowId: true,
                sourceRevision: true,
                deletedAt: true,
            },
        })).resolves.toEqual([{
            relationId: "project",
            targetKind: "collection",
            targetPluginId: RELATION_COLLECTION_MANIFEST.id,
            targetCollectionId: "projects",
            targetRowId: "project-a",
            sourceRevision: 1,
            deletedAt: null,
        }]);

        await withPluginDataApp(async (app) => {
            const blocked = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    operations: [{
                        kind: "delete",
                        rowId: "project-a",
                        expectedRevision: 1,
                    }],
                },
            });
            expect(blocked.statusCode).toBe(409);
            expect(blocked.json()).toEqual({
                error: "collection_relation_restricted",
                dependentCount: 1,
                continuation: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    relationId: "project",
                    target: {
                        collectionId: "projects",
                        rowId: "project-a",
                    },
                    query: {
                        indexId: "by-project-id",
                        prefix: ["project-a"],
                        order: "asc",
                        limit: 200,
                    },
                },
            });

            const dependents = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    indexId: "by-project-id",
                    prefix: ["project-a"],
                    order: "asc",
                    limit: 200,
                },
            });
            expect(dependents.statusCode).toBe(200);
            expect(dependents.json()).toMatchObject({
                rows: [{ rowId: "task-a" }],
            });
        });
        await expect(db.pluginCollectionRow.findFirst({
            where: {
                accountId,
                pluginId: RELATION_COLLECTION_MANIFEST.id,
                collectionId: "projects",
                rowId: "project-a",
            },
            select: { deletedAt: true },
        })).resolves.toEqual({ deletedAt: null });
    });

    it("persists an Account-visible Machine host relation and rolls back an unavailable target", async () => {
        const accountId = "account-collection-host-relation";
        const { ref } = await seedReadyHostMachineRelationCollectionAccount(accountId);
        await db.machine.create({
            data: {
                id: "machine-a",
                accountId,
                metadata: "{}",
            },
        });
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": accountId,
            ...V3_HEADERS,
        };

        await withPluginDataApp(async (app) => {
            await expect(app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: HOST_MACHINE_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-a",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "task-a", title: "Task A", "machine-id": "machine-a" },
                    }],
                },
            })).resolves.toMatchObject({ statusCode: 200 });

            const unavailable = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: HOST_MACHINE_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-b",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "task-b", title: "Task B", "machine-id": "missing-machine" },
                    }],
                },
            });
            expect(unavailable.statusCode).toBe(409);
            expect(unavailable.json()).toEqual({ error: "collection_relation_unavailable" });
        });

        await expect(db.pluginCollectionRelation.findMany({
            where: { accountId, sourceCollectionId: "tasks", deletedAt: null },
            select: {
                relationId: true,
                targetKind: true,
                targetPluginId: true,
                targetCollectionId: true,
                targetRowId: true,
            },
        })).resolves.toEqual([{
            relationId: "machine",
            targetKind: "host:machine",
            targetPluginId: null,
            targetCollectionId: null,
            targetRowId: "machine-a",
        }]);
        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: HOST_MACHINE_RELATION_COLLECTION_MANIFEST.id,
                collectionId: "tasks",
            },
        })).resolves.toBe(1);
    });

    it("validates an E2EE host relation from its server-readable projection without reading private content", async () => {
        const accountId = "account-collection-host-relation-e2ee";
        const { ref } = await seedReadyHostMachineRelationCollectionAccount(accountId, "e2ee");
        await db.machine.create({
            data: { id: "machine-e2ee", accountId, metadata: "{}" },
        });
        const ciphertext = sealPluginCollectionPrivatePayloadV1({
            material: { type: "legacy", secret: new Uint8Array(32).fill(9) },
            payload: { privateNote: "must not reach the relation resolver" },
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });

        await withPluginDataApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: {
                    pluginId: HOST_MACHINE_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-e2ee",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "encrypted", c: ciphertext },
                        projection: {
                            id: "task-e2ee",
                            title: "Encrypted task",
                            "machine-id": "machine-e2ee",
                        },
                    }],
                },
            });
            expect(response.statusCode).toBe(200);
        });

        await expect(db.pluginCollectionRelation.findFirst({
            where: { accountId, sourceCollectionId: "tasks", sourceRowId: "task-e2ee" },
            select: { targetKind: true, targetRowId: true },
        })).resolves.toEqual({ targetKind: "host:machine", targetRowId: "machine-e2ee" });
    });

    it("retires a source edge when a current schema evolution removes its relation", async () => {
        const accountId = "account-collection-relation-removal";
        const { projectRef, taskRef } = await seedReadyRelationCollectionAccount(accountId);
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": accountId,
            ...V3_HEADERS,
        };

        await withPluginDataApp(async (app) => {
            await expect(app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "project-a",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "project-a", title: "Project A" },
                    }],
                },
            })).resolves.toMatchObject({ statusCode: 200 });
            await expect(app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: taskRef.schemaVersion,
                        contractDigest: taskRef.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-a",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "task-a", title: "Task A", "project-id": "project-a" },
                    }],
                },
            })).resolves.toMatchObject({ statusCode: 200 });
        });

        const evolvedRefs = await inTx(async (tx) => (
            await materializePluginCollectionContractsFromManifestTx({
                tx,
                manifest: RELATION_REMOVED_COLLECTION_MANIFEST,
            })
        ));
        const evolvedTaskRef = evolvedRefs.find((ref) => ref.collectionId === "tasks");
        if (!evolvedTaskRef) throw new Error("Fixture evolved task contract was not materialized.");
        await db.accountPluginIntent.update({
            where: { accountId_pluginId: { accountId, pluginId: RELATION_COLLECTION_MANIFEST.id } },
            data: {
                desiredVersion: "2.0.0",
                writableCollections: toPrismaJson([projectRef, evolvedTaskRef]),
            },
        });
        const [evolvedTaskContract, existingTaskRow] = await Promise.all([
            db.pluginCollectionContract.findFirstOrThrow({
                where: {
                    pluginId: evolvedTaskRef.pluginId,
                    collectionId: evolvedTaskRef.collectionId,
                    schemaVersion: evolvedTaskRef.schemaVersion,
                    contractDigest: evolvedTaskRef.contractDigest,
                },
                select: { id: true },
            }),
            db.pluginCollectionRow.findFirstOrThrow({
                where: {
                    accountId,
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    rowId: "task-a",
                },
                select: { id: true, revision: true },
            }),
        ]);
        const evolvedTaskIndexState = await db.pluginCollectionIndexState.create({
            data: {
                accountId,
                pluginId: RELATION_COLLECTION_MANIFEST.id,
                collectionId: "tasks",
                indexId: "by-project-id",
                contractId: evolvedTaskContract.id,
                contractDigest: evolvedTaskRef.contractDigest,
                buildState: "ready",
                indexedThroughRevision: existingTaskRow.revision,
            },
            select: { id: true },
        });
        await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: evolvedTaskIndexState.id,
                encodedSortKey: copyBytes(encodePluginCollectionIndexSortKeyV1({
                    fields: [{ kind: "string", value: "project-a" }],
                    rowId: "task-a",
                })),
                rowId: "task-a",
                rowRevision: existingTaskRow.revision,
            },
        });

        await withPluginDataApp(async (app) => {
            const migratedTask = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: evolvedTaskRef.schemaVersion,
                        contractDigest: evolvedTaskRef.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-a",
                        expectedRevision: 1,
                        content: { t: "plain", v: {} },
                        projection: { id: "task-a", title: "Task A", "project-id": "project-a" },
                    }],
                },
            });
            expect(migratedTask.statusCode).toBe(200);

            const deletedProject = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    operations: [{
                        kind: "delete",
                        rowId: "project-a",
                        expectedRevision: 1,
                    }],
                },
            });
            expect(deletedProject.statusCode).toBe(200);
        });

        await expect(db.pluginCollectionRelation.findFirstOrThrow({
            where: {
                accountId,
                sourceCollectionId: "tasks",
                sourceRowId: "task-a",
            },
            select: { deletedAt: true },
        })).resolves.toEqual({ deletedAt: expect.any(Date) });
    });

    it("rolls back a batch that would create two live unique relation edges", async () => {
        const accountId = "account-collection-unique-relation";
        const { projectRef, taskRef } = await seedReadyRelationCollectionAccount(accountId);
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": accountId,
            ...V3_HEADERS,
        };

        await withPluginDataApp(async (app) => {
            await expect(app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "project-a",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "project-a", title: "Project A" },
                    }],
                },
            })).resolves.toMatchObject({ statusCode: 200 });

            const duplicate = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: taskRef.schemaVersion,
                        contractDigest: taskRef.contractDigest,
                    },
                    operations: ["task-a", "task-b"].map((rowId) => ({
                        kind: "put" as const,
                        rowId,
                        expectedRevision: "absent" as const,
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain" as const, v: {} },
                        projection: { id: rowId, title: `Task ${rowId}`, "project-id": "project-a" },
                    })),
                },
            });
            expect(duplicate.statusCode).toBe(409);
            expect(duplicate.json()).toEqual({ error: "collection_relation_unavailable" });
        });

        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: RELATION_COLLECTION_MANIFEST.id,
                collectionId: "tasks",
            },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionRelation.count({
            where: { accountId, sourceCollectionId: "tasks", deletedAt: null },
        })).resolves.toBe(0);
    });

    it("atomically swaps two live unique relation targets in one batch", async () => {
        const accountId = "account-collection-unique-relation-swap";
        const { projectRef, taskRef } = await seedReadyRelationCollectionAccount(accountId);
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": accountId,
            ...V3_HEADERS,
        };

        await withPluginDataApp(async (app) => {
            await expect(app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    operations: ["project-a", "project-b"].map((rowId) => ({
                        kind: "put" as const,
                        rowId,
                        expectedRevision: "absent" as const,
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain" as const, v: {} },
                        projection: { id: rowId, title: `Project ${rowId}` },
                    })),
                },
            })).resolves.toMatchObject({ statusCode: 200 });

            await expect(app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: taskRef.schemaVersion,
                        contractDigest: taskRef.contractDigest,
                    },
                    operations: [
                        {
                            kind: "put",
                            rowId: "task-a",
                            expectedRevision: "absent",
                            expectedAbsenceEpoch: 0,
                            content: { t: "plain", v: {} },
                            projection: { id: "task-a", title: "Task A", "project-id": "project-a" },
                        },
                        {
                            kind: "put",
                            rowId: "task-b",
                            expectedRevision: "absent",
                            expectedAbsenceEpoch: 0,
                            content: { t: "plain", v: {} },
                            projection: { id: "task-b", title: "Task B", "project-id": "project-b" },
                        },
                    ],
                },
            })).resolves.toMatchObject({ statusCode: 200 });

            const swapped = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: taskRef.schemaVersion,
                        contractDigest: taskRef.contractDigest,
                    },
                    operations: [
                        {
                            kind: "put",
                            rowId: "task-a",
                            expectedRevision: 1,
                            content: { t: "plain", v: {} },
                            projection: { id: "task-a", title: "Task A", "project-id": "project-b" },
                        },
                        {
                            kind: "put",
                            rowId: "task-b",
                            expectedRevision: 1,
                            content: { t: "plain", v: {} },
                            projection: { id: "task-b", title: "Task B", "project-id": "project-a" },
                        },
                    ],
                },
            });
            expect(swapped.statusCode).toBe(200);
        });

        await expect(db.pluginCollectionRelation.findMany({
            where: { accountId, sourceCollectionId: "tasks", deletedAt: null },
            orderBy: { sourceRowId: "asc" },
            select: { sourceRowId: true, targetRowId: true },
        })).resolves.toEqual([
            { sourceRowId: "task-a", targetRowId: "project-b" },
            { sourceRowId: "task-b", targetRowId: "project-a" },
        ]);
    });

    it("nullifies an optional same-plugin relation through the dependent projection before deleting its target", async () => {
        const accountId = "account-collection-nullify-relation";
        const { projectRef, taskRef, taskIndexState } = await seedReadyNullifyRelationCollectionAccount(accountId);

        await withPluginDataApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                ...V3_HEADERS,
            };
            await expect(app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "project-a",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "project-a", title: "Project A" },
                    }],
                },
            })).resolves.toMatchObject({ statusCode: 200 });
            await expect(app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    writerContext: {
                        schemaVersion: taskRef.schemaVersion,
                        contractDigest: taskRef.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-a",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: {} },
                        projection: { id: "task-a", title: "Task A", "project-id": "project-a" },
                    }],
                },
            })).resolves.toMatchObject({ statusCode: 200 });

            const deleted = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    operations: [{
                        kind: "delete",
                        rowId: "project-a",
                        expectedRevision: 1,
                    }],
                },
            });
            expect(deleted.statusCode).toBe(200);
            expect(deleted.json()).toEqual({
                status: "updated",
                results: [{ rowId: "project-a", revision: 2, deleted: true }],
                changeCursor: 4,
            });
        });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId_rowId: {
                    accountId,
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    rowId: "task-a",
                },
            },
            select: {
                revision: true,
                projections: {
                    orderBy: { fieldId: "asc" },
                    select: { typedEncodedValue: true, rowRevision: true },
                },
            },
        })).resolves.toEqual({
            revision: 2,
            projections: [
                { typedEncodedValue: "\"task-a\"", rowRevision: 2 },
                { typedEncodedValue: "null", rowRevision: 2 },
                { typedEncodedValue: "\"Task A\"", rowRevision: 2 },
            ],
        });
        await expect(db.pluginCollectionRelation.count({
            where: {
                accountId,
                sourceCollectionId: "tasks",
                sourceRowId: "task-a",
                deletedAt: null,
            },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionIndexEntry.findMany({
            where: { indexStateId: taskIndexState.id },
            select: { encodedSortKey: true, rowId: true, rowRevision: true },
        })).resolves.toEqual([{
            encodedSortKey: encodePluginCollectionIndexSortKeyV1({
                fields: [{ kind: "string", value: null }],
                rowId: "task-a",
            }),
            rowId: "task-a",
            rowRevision: 2,
        }]);
        await expect(db.accountChange.findMany({
            where: {
                accountId,
                kind: "pluginDomain",
                entityId: {
                    in: [
                        `pluginDomain/${NULLIFY_RELATION_COLLECTION_MANIFEST.id}/data-collection/projects`,
                        `pluginDomain/${NULLIFY_RELATION_COLLECTION_MANIFEST.id}/data-collection/tasks`,
                    ],
                },
            },
            orderBy: { entityId: "asc" },
            select: { cursor: true, entityId: true, hint: true },
        })).resolves.toEqual([{
            cursor: 3,
            entityId: `pluginDomain/${NULLIFY_RELATION_COLLECTION_MANIFEST.id}/data-collection/projects`,
            hint: {
                pluginDomain: "dataCollection",
                pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                collectionId: "projects",
                contractDigest: projectRef.contractDigest,
                revision: 2,
                rowIds: ["project-a"],
            },
        }, {
            cursor: 4,
            entityId: `pluginDomain/${NULLIFY_RELATION_COLLECTION_MANIFEST.id}/data-collection/tasks`,
            hint: {
                pluginDomain: "dataCollection",
                pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                collectionId: "tasks",
                contractDigest: taskRef.contractDigest,
                revision: 2,
                rowIds: ["task-a"],
            },
        }]);
    });
});
