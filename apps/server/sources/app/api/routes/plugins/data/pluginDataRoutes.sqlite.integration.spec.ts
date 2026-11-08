import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { encodePluginCollectionLogicalValueV1, type PluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { PLUGIN_MANIFEST as CHANNELS_MANIFEST, collectionMigrations as channelsCollectionMigrations } from '../../../../../../../../packages/plugins/channels/src/manifest';
import { createPluginCollectionSharingClientV1 } from '@happier-dev/protocol/plugins/data/collectionSharingClientV1';
import { PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 } from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import { PluginCollectionRowV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginCollectionPresenceResultV1Schema } from '@happier-dev/protocol/plugins/data/collectionPresenceV1';
import tweetnacl from "tweetnacl";
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';

import {
    signAccountContentKeyBindingV1,
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    PLUGIN_COLLECTION_REVISION_MAX,
    PluginAccountCollectionContributionV1Schema,
    PluginCollectionContractReadResultV1Schema,
    PluginCollectionGetResultV1Schema,
    PluginManifestV2Schema,
    PluginCollectionQueryResultV1Schema,
    PluginCollectionUiQueryResultV1Schema,
    PluginCollectionUiQueryTransportResultV1Schema,
    decodeBase64,
    encodeBase64,
    encodePluginCollectionIndexSortKeyV1,
    normalizePluginAccountCollectionContractV1,
    measurePluginCollectionMutationRequestEncodedBytesV1,
    sealPluginCollectionPrivatePayloadV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import {
    materializePluginCollectionContractsFromManifestTx,
    preparePluginCollectionWritableContractsTx,
} from "@/app/plugins/data/collections/contracts";
import { mutatePluginCollection as mutatePluginCollectionWithAuthentication } from "@/app/plugins/data/collections/mutation";
import { backfillPluginCollectionUsageTotalsInTx } from "@/app/plugins/data/collections/usageTotals";
import { promotePluginCollectionCandidatePreparationInTx, stagePluginCollectionCandidatePreparation } from '@/app/plugins/data/collections/candidatePreparation';
import { measurePluginCollectionStoredRowEncodedBytes } from "@/app/plugins/data/collections/storedRowUsage";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../../testkit/sqliteFastify";
import { pluginDataRoutes } from "./pluginDataRoutes";
import { holdSqliteWriteLock } from "@/testkit/sqliteWriteLock";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import { observePrismaReads } from "@/testkit/observePrismaReads";
import { logger } from "@/utils/logging/log";
import { enableMonitoring } from "../../../utils/enableMonitoring";

const PLUGIN_ID = "example.tasks";
const COLLECTION_ID = "tasks";
const QUERY_ID = "open-by-status";
const PRIVATE_QUERY_ID = "open-private-by-status";
const V3_HEADERS = {
    "x-happier-account-stored-content-protocol": String(
        ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    ),
} as const;
const authentication = createPresentUserSessionAccessAuthentication();

function mutatePluginCollection(
    input: Omit<Parameters<typeof mutatePluginCollectionWithAuthentication>[0], "authentication">,
) {
    return mutatePluginCollectionWithAuthentication({ ...input, authentication });
}

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
            rowIdField: "id",
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
            }, {
                id: PRIVATE_QUERY_ID,
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
                projectedFields: ["status", "privateNote"],
            }],
            relations: [],
            migrations: [],
            identityFields: [],
        }],
    },
} as const;

const COLLECTION_READER_CONTEXT = (() => {
    const contract = normalizePluginAccountCollectionContractV1({
        pluginId: COLLECTION_MANIFEST.id,
        contribution: PluginAccountCollectionContributionV1Schema.parse(
            COLLECTION_MANIFEST.contributes.accountCollections[0],
        ),
    });
    return {
        pluginId: contract.pluginId,
        collectionId: contract.collectionId,
        schemaVersion: contract.schemaVersion,
        contractDigest: contract.contractDigest,
    };
})();

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

const HOST_SESSION_RELATION_COLLECTION_MANIFEST = {
    ...HOST_MACHINE_RELATION_COLLECTION_MANIFEST,
    id: "example.session-tasks",
    displayName: "Session relation fixture",
    contributes: {
        accountCollections: [{
            ...HOST_MACHINE_RELATION_COLLECTION_MANIFEST.contributes.accountCollections[0],
            schema: {
                ...HOST_MACHINE_RELATION_COLLECTION_MANIFEST.contributes.accountCollections[0].schema,
                properties: {
                    id: { type: "string", maxLength: 256 },
                    title: { type: "string", maxLength: 256 },
                    "session-id": { type: "string", maxLength: 256 },
                },
                required: ["id", "title", "session-id"],
            },
            serverReadable: ["id", "title", "session-id"],
            relations: [{
                id: "session",
                kind: "host",
                field: "session-id",
                hostKind: "session",
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

    return {
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(Array.from(content.publicKey)),
        contentPublicKeySig: new Uint8Array(Array.from(signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey: content.publicKey,
        }))),
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

/** Direct fixture writes model a database after its canonical totals backfill. */
async function backfillCurrentCollectionUsage(accountId: string): Promise<void> {
    await inTx(async tx => {
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId, "serializing");
        expect(fence.status).toBe("ready");
        await backfillPluginCollectionUsageTotalsInTx({ tx, accountId });
    });
}

async function seedCurrentCollectionAccount(params: Readonly<{
    accountId: string;
    mode?: "plain" | "e2ee";
    seq?: number;
    rows: readonly SeedRow[];
    manifest?: unknown;
    retainRelease?: boolean;
    /** `null` is a daemon-claimed, release-less writer pointer. */
    desiredVersion?: string | null;
}>) {
    const manifest = PluginManifestV2Schema.parse(params.manifest ?? COLLECTION_MANIFEST);
    await createAccount({
        id: params.accountId,
        mode: params.mode ?? "plain",
        seq: params.seq ?? 41,
    });
    const contracts = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest,
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
            desiredVersion: params.desiredVersion === undefined ? "1.0.0" : params.desiredVersion,
            enabled: true,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson([ref]),
            revision: BigInt(1),
        },
    });
    if (params.retainRelease !== false) {
        await retainCollectionRelease({ accountId: params.accountId, manifest, refs: [ref] });
    }
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

    await backfillCurrentCollectionUsage(params.accountId);
    return { ref, contract, indexState };
}

async function retainCollectionRelease(input: Readonly<{
    accountId: string;
    manifest: unknown;
    refs: readonly Readonly<{
        pluginId: string;
        collectionId: string;
        schemaVersion: number;
        contractDigest: string;
    }>[];
}>): Promise<void> {
    const manifest = PluginManifestV2Schema.parse(input.manifest);
    await db.accountPluginRelease.create({
        data: {
            accountId: input.accountId,
            pluginId: manifest.id,
            version: manifest.version,
            archiveDigestSha256: `sha256:${"f".repeat(64)}`,
            normalizedManifest: toPrismaJson(manifest),
            collectionContracts: toPrismaJson(input.refs),
            uiSlots: toPrismaJson([]),
        },
    });
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
    await backfillCurrentCollectionUsage(params.accountId);
    return { ref };
}

/**
 * Injects a provider timeout at the persisted quota-usage boundary while
 * keeping every other operation on the real SQLite transaction path.
 */
function failPluginCollectionQuotaUsageOperation(input: Readonly<{
    accountId: string;
    phase: "read" | "write";
    error: Error;
}>) {
    const originalTransaction = db.$transaction.bind(db);
    let usageReads = 0;
    let usageWrites = 0;
    let restored = false;

    Reflect.set(db, "$transaction", async (...args: Parameters<typeof db.$transaction>) => {
        const [callback, options] = args;
        if (typeof callback !== "function") {
            return await originalTransaction(...args);
        }
        return await originalTransaction(async (tx) => {
            const usageTx: typeof tx = Object.create(tx);
            const usageAccount = Object.create(tx.account);
            const originalRead = tx.account.findUniqueOrThrow.bind(tx.account);
            Object.defineProperty(usageAccount, "findUniqueOrThrow", {
                value: async (...readArgs: Parameters<typeof tx.account.findUniqueOrThrow>) => {
                    const request = readArgs[0];
                    if (
                        request?.where.id === input.accountId
                        && request.select?.pluginCollectionRows === true
                        && request.select?.pluginCollectionEncodedBytes === true
                    ) {
                        usageReads += 1;
                        if (input.phase === "read") throw input.error;
                    }
                    return await originalRead(...readArgs);
                },
            });
            const originalWrite = tx.account.update.bind(tx.account);
            Object.defineProperty(usageAccount, "update", {
                value: async (...writeArgs: Parameters<typeof tx.account.update>) => {
                    const request = writeArgs[0];
                    const result = await originalWrite(...writeArgs);
                    if (request.where.id === input.accountId
                        && request.data.pluginCollectionRows !== undefined
                        && request.data.pluginCollectionEncodedBytes !== undefined) {
                        usageWrites += 1;
                        // The real counter update has executed in this transaction;
                        // a provider failure here must roll it back with row effects.
                        if (input.phase === "write") throw input.error;
                    }
                    return result;
                },
            });
            Object.defineProperty(usageTx, "account", { value: usageAccount });
            return await callback(usageTx);
        }, options);
    });

    return {
        usageReads: () => usageReads,
        usageWrites: () => usageWrites,
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
    ref: Awaited<ReturnType<typeof materializePluginCollectionContractsFromManifestTx>>[number];
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
    await retainCollectionRelease({
        accountId,
        manifest: MAXIMUM_BINARY_INDEX_COLLECTION_MANIFEST,
        refs: [ref],
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
    return { firstRowId, secondRowId, rangedRowId, indexStateId: indexState.id, ref };
}

async function seedReadyEmptyInstantCollectionAccount(accountId: string) {
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
    await retainCollectionRelease({ accountId, manifest: INSTANT_COLLECTION_MANIFEST, refs: [ref] });
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
    return ref;
}

async function seedReadyNonIndexedInstantCollectionAccount(accountId: string): Promise<Readonly<{
    pluginId: string;
    collectionId: string;
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
    await retainCollectionRelease({
        accountId,
        manifest: NON_INDEXED_INSTANT_COLLECTION_MANIFEST,
        refs: [ref],
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

async function seedReadyRelationCollectionAccount(accountId: string, manifest: unknown = RELATION_COLLECTION_MANIFEST) {
    await createAccount({ id: accountId, mode: "plain", seq: 0 });
    const refs = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest,
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
    await retainCollectionRelease({ accountId, manifest, refs });
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
    await retainCollectionRelease({ accountId, manifest: NULLIFY_RELATION_COLLECTION_MANIFEST, refs });
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

async function seedReadyHostSessionRelationCollectionAccount(accountId: string) {
    await createAccount({ id: accountId, mode: "plain", seq: 0 });
    const refs = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: HOST_SESSION_RELATION_COLLECTION_MANIFEST,
        })
    ));
    const ref = refs[0];
    if (!ref) throw new Error("Fixture Session relation contract was not materialized.");
    await db.accountPluginIntent.create({
        data: {
            accountId,
            pluginId: HOST_SESSION_RELATION_COLLECTION_MANIFEST.id,
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
    readerContext: typeof COLLECTION_READER_CONTEXT;
}> = {}) {
    return {
        pluginId: PLUGIN_ID,
        collectionId: COLLECTION_ID,
        uiQueryId: QUERY_ID,
        parameters: { status: "open" },
        readerContext: COLLECTION_READER_CONTEXT,
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
        readerContext: COLLECTION_READER_CONTEXT,
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
/**
 * Commit a real mutation after the query has established its read snapshot.
 * Every subsequent row/index read must still observe that same snapshot.
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
    let mutationPromise: Promise<void> | null = null;
    const restore = observeSqliteRequests({
        after: async (request) => {
            if (!mutationPromise && request.model === "Account" && request.action === "findUnique") {
                mutationPromise = input.mutate();
                await mutationPromise;
            }
        },
    });
    return {
        restore: () => {
            restore();
            expect(mutationPromise).not.toBeNull();
        },
    };
}

describe("plugin collection UI query route", () => {
    it("admits direct rows once and prepares an unchanged stored contract only once per immutable version", async () => {
        const accountId = "account-direct-admission-cost";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            retainRelease: false,
            desiredVersion: null,
            rows: [
                { rowId: "cost-a", status: "open", title: "A", revision: 1 },
                { rowId: "cost-b", status: "open", title: "B", revision: 1 },
            ],
        });
        await withPluginDataApp(async app => {
            const rowAdmissions = vi.spyOn(PluginCollectionRowV1Schema._zod, "run");
            // Standalone persistence admission uses the lazy facade; containing
            // schemas use native run. Observe both without replacing validation.
            const rowParses = vi.spyOn(PluginCollectionRowV1Schema, "parse");
            const contractAdmissions = vi.spyOn(PluginAccountCollectionContributionV1Schema, "parse");
            try {
                const selections = [
                    ["/v1/plugins/data/get", { rowId: "cost-a" }, 1],
                    ["/v1/plugins/data/query", { indexId: "by-status", prefix: ["open"], order: "asc", limit: 50 }, 2],
                ] as const;
                // Warm through the real authenticated route before measuring
                // unchanged persisted-version reads, never through a helper.
                await app.inject({ method: "POST", url: selections[0][0],
                    headers: { ...V3_HEADERS, "x-test-user-id": accountId },
                    payload: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, readerContext: ref, ...selections[0][1] },
                });
                for (const [url, selection, rowCount] of Array.from({ length: 16 }, (_, index) => selections[index % selections.length]!)) {
                    rowAdmissions.mockClear();
                    rowParses.mockClear();
                    contractAdmissions.mockClear();
                    const response = await app.inject({
                        method: "POST", url,
                        headers: { ...V3_HEADERS, "x-test-user-id": accountId },
                        payload: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, readerContext: ref, ...selection },
                    });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(contractAdmissions).not.toHaveBeenCalled();
                    // Facade entry also invokes native run: do not count that
                    // one admission twice. Containing reparses only add runs.
                    expect(rowParses).toHaveBeenCalledTimes(rowCount);
                    expect(rowAdmissions).toHaveBeenCalledTimes(rowCount);
                }
                // The same Collection's next immutable version requires a new
                // preparation; subsequent reads carry that admitted result.
                const [next] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: {
                    ...COLLECTION_MANIFEST, version: "2.0.0",
                    contributes: { accountCollections: [{ ...COLLECTION_MANIFEST.contributes.accountCollections[0], schemaVersion: 2 }] },
                } }));
                if (!next) throw new Error("Expected the next immutable contract");
                await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId: PLUGIN_ID } },
                    data: { writableCollections: toPrismaJson([next]), revision: { increment: 1 } },
                });
                contractAdmissions.mockClear();
                for (let read = 0; read < 16; read++) {
                    const response = await app.inject({ method: "POST", url: "/v1/plugins/data/get",
                        headers: { ...V3_HEADERS, "x-test-user-id": accountId },
                        payload: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, readerContext: next, rowId: "cost-a" },
                    });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ row: null });
                }
                expect(contractAdmissions).toHaveBeenCalledTimes(1);
            } finally {
                rowAdmissions.mockRestore();
                rowParses.mockRestore();
                contractAdmissions.mockRestore();
            }
        });
    });

    it("registers candidate-preparation routes behind authenticated Data transport and maps malformed/currentness failures", async () => {
        const accountId = "account-candidate-preparation-routes";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            retainRelease: false,
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
            () => db.sessionShare.deleteMany(),
            () => db.sessionTeamGrant.deleteMany(),
            () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("shares a Plain Collection row and enforces live view/edit access before conflicts", async () => {
        const owner = "collection-sharing-owner", recipient = "collection-sharing-recipient";
        const { ref } = await seedCurrentCollectionAccount({ accountId: owner, rows: [
            { rowId: "shared-row", revision: 1, status: "open", title: "Shared" },
            { rowId: "second-row", revision: 1, status: "open", title: "Second" },
        ] });
        await createAccount({ id: recipient, mode: "plain", seq: 1 });
        const team = await db.team.create({ data: { name: "Collection team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner, role: "owner" } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Editors", nameKey: "editors" } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: member.id, nativeContribution: true } });
        const address = { ownerAccountId: owner, pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, rowId: "shared-row" };
        const principal = { kind: "account", accountId: recipient } as const;
        await withPluginDataApp(async app => {
            const call = (accountId: string, operation: string, payload: unknown) => app.inject({ method: "POST",
                url: `/v1/plugins/data/sharing/${operation}`, headers: { ...V3_HEADERS, "x-test-user-id": accountId,
                    "content-type": "application/json" }, payload: JSON.stringify(payload) });
            const roster = await call(owner, "grants", address);
            expect(roster.statusCode).toBe(200);
            expect(roster.json()).toMatchObject({ ...address, access: "owner", grants: [] });
            expect((await call(recipient, "get", { ...address, readerContext: ref })).statusCode).toBe(404);
            expect((await call(owner, "set-grant", { ...address, principal, accessLevel: "view", expectedRevision: 1 })).statusCode).toBe(200);
            const viewed = await call(recipient, "get", { ...address, readerContext: ref });
            expect(viewed.statusCode).toBe(200);
            expect(viewed.json()).toMatchObject({ ownerAccountId: owner, access: "view", encryptionMode: "plain", encryptedDataKey: null,
                row: { revision: 1, projection: { title: "Shared" } } });
            const edit = { ...address, writerContext: ref, expectedRevision: 1, content: { t: "plain", v: { privateNote: "Peer private edit" } },
                projection: { status: "closed", title: "Edited" } };
            expect((await call(recipient, "put", { ...edit, expectedRevision: 999 })).json()).toEqual({ error: "collection_unavailable" });
            expect((await call(recipient, "set-grant", { ...address, principal: { kind: "team", teamId: team.id }, accessLevel: "edit", expectedRevision: 1 })).statusCode).toBe(403);
            expect((await call(owner, "set-grant", { ...address, principal, accessLevel: "edit", expectedRevision: 1 })).statusCode).toBe(200);
            const changed = await call(recipient, "put", edit);
            expect(changed.statusCode).toBe(200);
            expect(changed.json()).toMatchObject({ access: "edit", row: { revision: 2, content: edit.content, projection: edit.projection } });
            expect((await call(recipient, "put", edit)).json()).toEqual({ error: "collection_revision_conflict" });
            expect((await call(owner, "set-grant", { ...address, rowId: "second-row", principal, accessLevel: "view", expectedRevision: 1 })).statusCode).toBe(200);
            const firstPage = await call(recipient, "shared-with-me", { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, readerContext: ref, limit: 1 });
            expect(firstPage.statusCode).toBe(200);
            expect(firstPage.json().resources).toHaveLength(1);
            expect(firstPage.json().nextCursor).toEqual(expect.any(String));
            const lastPage = await call(recipient, "shared-with-me", { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, readerContext: ref,
                limit: 1, cursor: firstPage.json().nextCursor });
            expect(lastPage.json().resources).toHaveLength(1);
            expect(lastPage.json().resources[0].rowId).not.toBe(firstPage.json().resources[0].rowId);
            expect(lastPage.json().nextCursor).toBeNull();
            expect((await call(owner, "revoke-grant", { ...address, principal })).statusCode).toBe(200);
            expect((await call(recipient, "put", edit)).json()).toEqual({ error: "collection_unavailable" });
            for (const audience of [{ kind: "team", teamId: team.id }, { kind: "group", teamId: team.id, groupId: group.id }]) {
                expect((await call(owner, "set-grant", { ...address, principal: audience, accessLevel: "view", expectedRevision: 2 })).statusCode).toBe(200);
                expect((await call(recipient, "get", { ...address, readerContext: ref })).statusCode).toBe(200);
                expect((await call(owner, "revoke-grant", { ...address, principal: audience })).statusCode).toBe(200);
                expect((await call(recipient, "get", { ...address, readerContext: ref })).statusCode).toBe(404);
            }
            for (const audience of [principal, { kind: "team", teamId: team.id }, { kind: "group", teamId: team.id, groupId: group.id }]) {
                expect((await call(owner, "set-grant", { ...address, principal: audience, accessLevel: "view", expectedRevision: 2 })).statusCode).toBe(200);
            }
            const beforeDelete = await db.account.findUniqueOrThrow({ where: { id: recipient }, select: { seq: true } });
            const mutate = (operations: unknown[]) => app.inject({ method: "POST", url: "/v1/plugins/data/mutate",
                headers: { ...V3_HEADERS, "x-test-user-id": owner }, payload: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID,
                    writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest }, operations } });
            expect((await mutate([{ kind: "delete", rowId: address.rowId, expectedRevision: 2 }])).statusCode).toBe(200);
            expect((await db.account.findUniqueOrThrow({ where: { id: recipient }, select: { seq: true } })).seq).toBeGreaterThan(beforeDelete.seq);
            expect((await mutate([{ kind: "put", rowId: address.rowId, expectedRevision: 3, content: edit.content, projection: edit.projection }])).statusCode).toBe(200);
            expect((await call(recipient, "get", { ...address, readerContext: ref })).statusCode).toBe(404);
            expect((await call(recipient, "shared-with-me", { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, readerContext: ref })).json().resources.map((row: { rowId: string }) => row.rowId)).toEqual(["second-row"]);
            expect((await call(owner, "grants", address)).json().grants).toEqual([]);
            const wakes = await db.accountChange.findMany({ where: { accountId: recipient, kind: "pluginDomain" } });
            expect(wakes).not.toHaveLength(0);
            expect(JSON.stringify(wakes)).not.toContain("Peer private edit");
            expect(JSON.stringify(wakes)).not.toContain("Edited");
            expect(await db.pluginCollectionKeyEnvelope.count()).toBe(0);
        });
    });

    it("refuses editor relation changes identically for private and missing targets while preserving owner writes", async () => {
        const owner = "collection-relation-owner", recipient = "collection-relation-editor";
        const { projectRef, taskRef } = await seedReadyRelationCollectionAccount(owner);
        await createAccount({ id: recipient, mode: "plain", seq: 0 });
        const write = (ref: typeof projectRef, rowId: string, expectedRevision: number | null, projection: Record<string, string>) =>
            mutatePluginCollection({ accountId: owner, request: { pluginId: ref.pluginId, collectionId: ref.collectionId,
                writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                operations: [{ kind: "put", rowId, expectedRevision: expectedRevision ?? "absent",
                    ...(expectedRevision === null ? { expectedAbsenceEpoch: 0 } : {}),
                    content: { t: "plain", v: {} }, projection }] } });
        for (const rowId of ["original", "private-free", "private-occupied"]) {
            expect((await write(projectRef, rowId, null, { id: rowId, title: rowId })).status).toBe("updated");
        }
        const projection = (rowId: string, target: string) => ({ id: rowId, title: "Task", "project-id": target });
        expect((await write(taskRef, "shared", null, projection("shared", "original"))).status).toBe("updated");
        expect((await write(taskRef, "private-source", null, projection("private-source", "private-occupied"))).status).toBe("updated");
        const source = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: owner, collectionId: "tasks", rowId: "shared" } });
        await db.pluginCollectionAccountGrant.create({ data: { rowDbId: source.id, accountId: recipient,
            accessLevel: "edit", createdByAccountId: owner } });
        await withPluginDataApp(async app => {
            const put = (target: string, expectedRevision = 1) => app.inject({ method: "POST", url: "/v1/plugins/data/sharing/put",
                headers: { ...V3_HEADERS, "x-test-user-id": recipient }, payload: { ownerAccountId: owner,
                    pluginId: taskRef.pluginId, collectionId: taskRef.collectionId, rowId: "shared", writerContext: taskRef,
                    expectedRevision, content: { t: "plain", v: {} }, projection: projection("shared", target) } });
            const missing = await put("missing");
            expect(missing.statusCode).toBe(409);
            expect(missing.json()).toEqual({ error: "collection_relation_unavailable" });
            for (const target of ["private-free", "private-occupied"]) {
                const refused = await put(target);
                expect(refused.statusCode).toBe(missing.statusCode);
                expect(refused.json()).toEqual(missing.json());
            }
            // Editing content keeps the existing relation even when its target is private.
            expect((await put("original")).statusCode).toBe(200);
            // The owner can still change the relation, and private unique collisions still refuse.
            expect((await write(taskRef, "shared", 2, projection("shared", "private-free"))).status).toBe("updated");
            await expect(write(taskRef, "shared", 3, projection("shared", "private-occupied")))
                .rejects.toMatchObject({ code: "collection_relation_unavailable" });
            expect((await put("private-free", 3)).statusCode).toBe(200);
        });
    });

    it("refuses editor host relation probes while allowing content edits with an unchanged host reference", async () => {
        const owner = "collection-host-owner", recipient = "collection-host-editor";
        const { ref } = await seedReadyHostMachineRelationCollectionAccount(owner);
        await retainCollectionRelease({ accountId: owner, manifest: HOST_MACHINE_RELATION_COLLECTION_MANIFEST, refs: [ref] });
        await createAccount({ id: recipient, mode: "plain", seq: 0 });
        for (const id of ["host-original", "host-private"]) {
            await db.machine.create({ data: { id, accountId: owner, metadata: "{}" } });
        }
        const projection = (machineId: string) => ({ id: "shared", title: "Task", "machine-id": machineId });
        expect((await mutatePluginCollection({ accountId: owner, request: { pluginId: ref.pluginId, collectionId: ref.collectionId,
            writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest }, operations: [{ kind: "put", rowId: "shared",
                expectedRevision: "absent", expectedAbsenceEpoch: 0, content: { t: "plain", v: {} }, projection: projection("host-original") }] } })).status).toBe("updated");
        const source = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: owner, rowId: "shared" } });
        await db.pluginCollectionAccountGrant.create({ data: { rowDbId: source.id, accountId: recipient,
            accessLevel: "edit", createdByAccountId: owner } });
        await withPluginDataApp(async app => {
            for (const machineId of ["host-private", "host-missing", "host-original"]) {
                const response = await app.inject({ method: "POST", url: "/v1/plugins/data/sharing/put",
                    headers: { ...V3_HEADERS, "x-test-user-id": recipient }, payload: { ownerAccountId: owner,
                        pluginId: ref.pluginId, collectionId: ref.collectionId, rowId: "shared", writerContext: ref,
                        expectedRevision: 1, content: { t: "plain", v: {} }, projection: projection(machineId) } });
                expect(response.statusCode).toBe(machineId === "host-original" ? 200 : 409);
                if (machineId !== "host-original") expect(response.json()).toEqual({ error: "collection_relation_unavailable" });
            }
        });
    });

    it("applies the canonical deployment batch budget to grantee writes before persisting content", async () => {
        const owner = "collection-sharing-budget-owner", recipient = "collection-sharing-budget-peer";
        const { ref } = await seedCurrentCollectionAccount({ accountId: owner, rows: [
            { rowId: "budget-row", revision: 1, status: "open", title: "Original" },
        ] });
        await createAccount({ id: recipient, mode: "plain", seq: 0 });
        const row = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: owner, rowId: "budget-row" } });
        await db.pluginCollectionAccountGrant.create({ data: { rowDbId: row.id, accountId: recipient, accessLevel: "edit", createdByAccountId: owner } });
        await withPluginDataApp(async app => {
            const request = { ownerAccountId: owner, pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, rowId: row.rowId,
                writerContext: ref, expectedRevision: 1, content: { t: "plain", v: { privateNote: "Allowed after policy recovery" } },
                projection: { status: "open", title: "Edited" } };
            const put = () => app.inject({ method: "POST", url: "/v1/plugins/data/sharing/put",
                headers: { ...V3_HEADERS, "x-test-user-id": recipient }, payload: request });
            const canonicalRequest = { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID,
                writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                operations: [{ kind: "put" as const, rowId: row.rowId, expectedRevision: 1,
                    content: { t: "plain" as const, v: request.content.v }, projection: request.projection }] };
            const budget = measurePluginCollectionMutationRequestEncodedBytesV1(canonicalRequest) - 1;
            expect(measurePluginCollectionStoredRowEncodedBytes({ rowId: row.rowId, contentEnvelope: request.content,
                projections: Object.entries(request.projection).map(([fieldId, value]) => ({ fieldId, typedEncodedValue: JSON.stringify(value) })) })).toBeLessThan(budget);
            harness.resetEnv({ HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: String(budget), HAPPIER_COLLECTION_MAX_BATCH_BYTES: String(budget) });
            const refused = await put();
            expect(refused.statusCode).toBe(409);
            expect(refused.json()).toMatchObject({ error: "collection_quota_incompatible", dimension: "maxBatchBytes", effectiveMaximum: budget });
            expect(await db.pluginCollectionRow.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ revision: 1 });
            harness.resetEnv();
            expect((await put()).statusCode).toBe(200);
            expect(await db.pluginCollectionRow.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ revision: 2 });
        });
    });

    it("shares E2EE Collection ciphertext through two real Account clients and ends sharing on deletion before private recreation", async () => {
        const owner = "collection-e2ee-owner", recipient = "collection-e2ee-recipient";
        const material = { type: "legacy" as const, secret: randomBytes(32) };
        const initial = { id: "private-row", status: "open" as const, title: "Encrypted sharing", privateNote: "Owner private note" };
        const second = { ...initial, id: "private-row-two", privateNote: "Second private note" };
        const { ref } = await seedCurrentCollectionAccount({ accountId: owner, mode: "e2ee", rows: [initial, second].map(value => ({ rowId: value.id,
            revision: 1, status: value.status, title: value.title, contentEnvelope: { t: "encrypted" as const,
                c: sealPluginCollectionPrivatePayloadV1({ material, payload: { privateNote: value.privateNote }, randomBytes }) } })) });
        await createAccount({ id: recipient, mode: "e2ee", seq: 1 });
        const secretByAccount = new Map<string, Uint8Array>();
        for (const accountId of [owner, recipient]) {
            const signing = tweetnacl.sign.keyPair(), content = tweetnacl.box.keyPair();
            secretByAccount.set(accountId, content.secretKey);
            await db.account.update({ where: { id: accountId }, data: { publicKey: Buffer.from(signing.publicKey).toString("hex"),
                contentPublicKey: copyBytes(content.publicKey), contentPublicKeySig: copyBytes(signAccountContentKeyBindingV1({
                    accountSigningSecretKey: signing.secretKey, contentPublicKey: content.publicKey })) } });
        }
        await db.userRelationship.create({ data: { fromUserId: recipient, toUserId: owner, status: "friend" } });
        const contract = normalizePluginAccountCollectionContractV1({ pluginId: PLUGIN_ID,
            contribution: PluginAccountCollectionContributionV1Schema.parse(COLLECTION_MANIFEST.contributes.accountCollections[0]) });
        type Value = { id: string; status: "open" | "closed"; title: string; privateNote: string };
        const valid = (value: unknown): value is Value => value !== null && typeof value === "object" && "id" in value && typeof value.id === "string"
            && "status" in value && (value.status === "open" || value.status === "closed") && "title" in value && typeof value.title === "string"
            && "privateNote" in value && typeof value.privateNote === "string";
        await withPluginDataApp(async app => {
            const options = (accountId: string) => ({ accountId, contract, isValidLogicalValue: valid,
                parseStoredLogicalValue: (value: unknown) => valid(value) ? value : null, requireCurrent: () => {},
                crypto: { accountMaterial: accountId === owner ? material : null, randomBytes,
                    openKey: async (envelope: string) => openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(envelope),
                        recipientSecretKeyOrSeed: secretByAccount.get(accountId)! }) },
                request: async (path: string, body: unknown) => {
                    const response = await app.inject({ method: "POST", url: path,
                        headers: { ...V3_HEADERS, "x-test-user-id": accountId, "content-type": "application/json" }, payload: JSON.stringify(body) });
                    return { status: response.statusCode, body: response.json() as unknown };
                } });
            const ownerClient = createPluginCollectionSharingClientV1<Value>(options(owner));
            const peerClient = createPluginCollectionSharingClientV1<Value>(options(recipient));
            await ownerClient.setGrant(initial.id, { principal: { kind: "account", accountId: recipient }, accessLevel: "edit", expectedRevision: 1 });
            await ownerClient.setGrant(second.id, { principal: { kind: "account", accountId: recipient }, accessLevel: "view", expectedRevision: 1 });
            const shared = await peerClient.get({ ownerAccountId: owner, rowId: initial.id });
            expect(shared).toMatchObject({ ownerAccountId: owner, access: "edit", revision: 2, value: initial });
            const edited = await peerClient.put({ ownerAccountId: owner, value: { ...initial, privateNote: "Peer encrypted note" }, expectedRevision: shared.revision });
            expect(edited).toMatchObject({ revision: 3, value: { privateNote: "Peer encrypted note" } });
            const ownerRead = await ownerClient.get({ ownerAccountId: owner, rowId: initial.id });
            expect(ownerRead.value).toEqual(edited.value);
            const recipientReads: unknown[] = [];
            const restore = observeSqliteRequests({ before: request => {
                if (request.model === "Account" && request.action === "findUnique" && JSON.stringify(request.args).includes(recipient)) {
                    recipientReads.push(request.args);
                }
            } });
            try {
                const page = await peerClient.sharedWithMe({});
                expect(page.rows).toHaveLength(2);
                expect(page.rows).toEqual(expect.arrayContaining([edited]));
                expect(recipientReads).toHaveLength(1);
            } finally { restore(); }
            const persisted = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: owner, rowId: initial.id } });
            expect(persisted.contentEnvelope).toMatchObject({ t: "encrypted", k: "collection" });
            expect(JSON.stringify(persisted)).not.toContain("Peer encrypted note");
            expect(await db.pluginCollectionKeyEnvelope.count({ where: { rowDbId: persisted.id } })).toBe(2);
            const ordinary = await app.inject({ method: "POST", url: "/v1/plugins/data/get", headers: { ...V3_HEADERS, "x-test-user-id": owner },
                payload: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, readerContext: ref, rowId: initial.id } });
            expect(ordinary.json().row.encryptedDataKey).toEqual(expect.any(String));
            const replace = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate", headers: { ...V3_HEADERS, "x-test-user-id": owner }, payload: {
                pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest }, operations: [{ kind: "put", rowId: initial.id, expectedRevision: 3,
                    content: { t: "encrypted", c: sealPluginCollectionPrivatePayloadV1({ material, payload: { privateNote: "Wrong key" }, randomBytes }) },
                    projection: { status: initial.status, title: initial.title } }] } });
            expect(replace.json()).toMatchObject({ error: "collection_content_mode_mismatch" });
            await ownerClient.revokeGrant(initial.id, { principal: { kind: "account", accountId: recipient } });
            await expect(peerClient.get({ ownerAccountId: owner, rowId: initial.id })).rejects.toMatchObject({ code: "collection_unavailable" });
            await expect(peerClient.put({ ownerAccountId: owner, value: initial, expectedRevision: 3 })).rejects.toMatchObject({ code: "collection_unavailable" });
            const deleted = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate", headers: { ...V3_HEADERS, "x-test-user-id": owner },
                payload: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                    operations: [{ kind: "delete", rowId: second.id, expectedRevision: 2 }] } });
            expect(deleted.statusCode).toBe(200);
            const deletedRow = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: owner, rowId: second.id } });
            expect(await db.pluginCollectionKeyEnvelope.count({ where: { rowDbId: deletedRow.id } })).toBe(0);
            const recreatedWithoutResourceKey = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate",
                headers: { ...V3_HEADERS, "x-test-user-id": owner }, payload: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                    operations: [{ kind: "put", rowId: second.id, expectedRevision: 3,
                        content: { t: "encrypted", c: sealPluginCollectionPrivatePayloadV1({ material, payload: { privateNote: "Private recreation" }, randomBytes }) },
                        projection: { status: initial.status, title: initial.title } }] } });
            expect(recreatedWithoutResourceKey.statusCode).toBe(200);
            await expect(peerClient.get({ ownerAccountId: owner, rowId: second.id })).rejects.toMatchObject({ code: "collection_unavailable" });
            expect((await peerClient.sharedWithMe({})).rows).toEqual([]);
        });
    });

    it("reads content-free retained collection presence without claiming a writer or scanning rows", async () => {
        const accountId = "account-collection-presence";
        await seedCurrentCollectionAccount({ accountId, seq: 77, rows: [
            { rowId: "retained", status: "open", title: "Private retained body", revision: 1 },
        ] });
        await createAccount({ id: "account-collection-presence-other", mode: "plain", seq: 91 });
        // A dormant plugin has not admitted its current writer. Retained rows
        // must still wake it so that normal activation can perform migration.
        await db.accountPluginIntent.deleteMany({ where: { accountId } });
        const retained = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId } });
        await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: {
            ...COLLECTION_MANIFEST, contributes: { accountCollections: [
                { ...COLLECTION_MANIFEST.contributes.accountCollections[0], schemaVersion: 2, readableSchemaVersions: [2] },
                ...["deleted", "foreign", "unrelated"].map(id => ({ ...COLLECTION_MANIFEST.contributes.accountCollections[0], id })),
            ] },
        } }));
        const contracts = await db.pluginCollectionContract.findMany({ where: { pluginId: PLUGIN_ID } });
        const physicalContract = (collectionId: string) => contracts.find(contract => contract.collectionId === collectionId)!;
        await db.pluginCollectionRow.createMany({ data: [
            { accountId, pluginId: PLUGIN_ID, collectionId: "deleted", rowId: "deleted", schemaVersion: retained.schemaVersion,
                revision: 1, contractId: physicalContract("deleted").id, contractDigest: physicalContract("deleted").contractDigest,
                contentEnvelope: { t: "plain", v: {} }, deletedAt: new Date() },
            { accountId: "account-collection-presence-other", pluginId: PLUGIN_ID, collectionId: "foreign", rowId: "foreign",
                schemaVersion: retained.schemaVersion, revision: 1, contractId: physicalContract("foreign").id,
                contractDigest: physicalContract("foreign").contractDigest, contentEnvelope: { t: "plain", v: {} } },
            ...Array.from({ length: 1005 }, (_, index) => ({ accountId, pluginId: PLUGIN_ID,
                collectionId: "unrelated", rowId: `unrelated-${index}`, schemaVersion: retained.schemaVersion,
                revision: 1, contractId: physicalContract("unrelated").id, contractDigest: physicalContract("unrelated").contractDigest,
                contentEnvelope: { t: "plain", v: { title: "Unrequested private body" } } })),
        ] });
        const requests: Array<{ model?: string; action: string; args: unknown }> = [];
        const restore = observeSqliteRequests({ before: request => {
            requests.push({ model: request.model, action: request.action, args: request.args });
        } });
        try {
            await withPluginDataApp(async app => {
                const selected = [COLLECTION_ID, "deleted", "foreign", "empty", COLLECTION_ID]
                    .map(collectionId => ({ pluginId: PLUGIN_ID, collectionId }));
                const response = await app.inject({ method: "POST", url: "/v1/plugins/data/presence",
                    headers: { "x-test-user-id": accountId, ...V3_HEADERS }, payload: { collections: selected } });
                expect(response.statusCode).toBe(200);
                expect(PluginCollectionPresenceResultV1Schema.parse(response.json())).toEqual({ collections: [
                    { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, present: true },
                    { pluginId: PLUGIN_ID, collectionId: "deleted", present: false },
                    { pluginId: PLUGIN_ID, collectionId: "foreign", present: false },
                    { pluginId: PLUGIN_ID, collectionId: "empty", present: false },
                ], changeCursor: 77 });
            });
        } finally { restore(); }
        const selections = requests.filter(request => request.action === "queryRaw"
            && JSON.stringify(request.args).includes("PluginCollectionRow"));
        expect(selections).toHaveLength(1);
        expect(requests.filter(request => request.model?.startsWith("PluginCollection")
            || request.model === "AccountPluginIntent" || request.model === "AccountPluginRelease")).toEqual([]);
        expect(JSON.stringify(selections)).not.toContain("contentEnvelope");
    });

    it("pairs presence with its snapshot cursor and answers the next request from the new Account state", async () => {
        const accountId = "account-collection-presence-snapshot";
        await seedCurrentCollectionAccount({ accountId, seq: 12, rows: [
            { rowId: "retained", status: "open", title: "Retained", revision: 1 },
        ] });
        let changed = false;
        let restore = observeSqliteRequests({ after: async request => {
            if (!changed && request.model === "Account" && request.action === "findUnique") {
                changed = true;
                await db.pluginCollectionRow.updateMany({ where: { accountId }, data: { deletedAt: new Date() } });
                await db.account.update({ where: { id: accountId }, data: { seq: 13 } });
            }
        } });
        try {
            await withPluginDataApp(async app => {
                const response = await app.inject({ method: "POST", url: "/v1/plugins/data/presence",
                    headers: { "x-test-user-id": accountId, ...V3_HEADERS },
                    payload: { collections: [{ pluginId: PLUGIN_ID, collectionId: COLLECTION_ID }] } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ collections: [
                    { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, present: true },
                ], changeCursor: 12 });
            });
        } finally { restore(); }
        expect(changed).toBe(true);
        await commitValidE2eeAccountModeForTest({ accountId, seq: 14 });
        await withPluginDataApp(async app => {
            const response = await app.inject({ method: "POST", url: "/v1/plugins/data/presence",
                headers: { "x-test-user-id": accountId, ...V3_HEADERS }, payload: { collections: [] } });
            // Presence is content-free, so a valid mode change only moves its cursor.
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ collections: [], changeCursor: 14 });
        });
    });

    it("admits only authenticated own-Account presence requests and keeps unavailable mode explicit", async () => {
        const accountId = "account-collection-presence-admission";
        await createAccount({ id: accountId, mode: "plain", seq: 4 });
        await withPluginDataApp(async app => {
            const payload = { collections: [] };
            const headers = { "x-test-user-id": accountId, ...V3_HEADERS };
            const empty = await app.inject({ method: "POST", url: "/v1/plugins/data/presence", headers, payload });
            expect(empty.statusCode).toBe(200);
            expect(PluginCollectionPresenceResultV1Schema.parse(empty.json())).toEqual({ collections: [], changeCursor: 4 });
            const unauthenticated = await app.inject({ method: "POST", url: "/v1/plugins/data/presence", payload });
            expect(unauthenticated.statusCode).toBe(401);
            const unsupported = await app.inject({ method: "POST", url: "/v1/plugins/data/presence",
                headers: { "x-test-user-id": accountId }, payload });
            expect(unsupported.statusCode).toBe(426);
            const selector = await app.inject({ method: "POST", url: "/v1/plugins/data/presence", headers,
                payload: { ...payload, accountId: "another-account" } });
            expect(selector.statusCode).toBe(400);
            await db.account.update({ where: { id: accountId }, data: { encryptionMode: "e2ee" } });
            const inconsistent = await app.inject({ method: "POST", url: "/v1/plugins/data/presence", headers, payload });
            expect(inconsistent.statusCode).toBe(409);
            expect(inconsistent.json()).toEqual({ error: "collection_content_mode_mismatch" });
        });
    });

    it("serves concurrent collection reads while another process holds the SQLite writer lock", async () => {
        harness.resetEnv({ HAPPIER_DB_TX_MAX_RETRIES: "0", HAPPIER_DB_TX_MAX_WAIT_MS: "1000" });
        const accountId = "account-cross-process-read";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            seq: 77,
            rows: [{ rowId: "task-a", status: "open", title: "Before", revision: 1 }],
        });
        const writer = await holdSqliteWriteLock();
        try {
            await withPluginDataApp(async (app) => {
                const responses = await Promise.all(Array.from({ length: 3 }, () => app.inject({
                    method: "POST",
                    url: "/v1/plugins/data/query",
                    headers: { "x-test-user-id": accountId, ...V3_HEADERS },
                    payload: {
                        pluginId: PLUGIN_ID, collectionId: COLLECTION_ID, readerContext: ref,
                        indexId: "by-status", prefix: ["open"], order: "asc", limit: 1,
                    },
                })));
                expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
                for (const response of responses) {
                    expect(PluginCollectionQueryResultV1Schema.parse(response.json())).toMatchObject({
                        rows: [{ rowId: "task-a", revision: 1, projection: { title: "Before" } }],
                        changeCursor: 77,
                    });
                }
            });
        } finally {
            await writer.release();
        }
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
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId, "exclusive");
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
        const { firstRowId, secondRowId, rangedRowId, indexStateId, ref } = await seedMaximumBinaryIndexCollectionAccount(accountId);
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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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
            retainRelease: false,
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
                    access: "writable",
                    contract: {
                        pluginId: ref.pluginId,
                        collectionId: ref.collectionId,
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                        rowIdField: "id",
                        serverReadable: ["status", "title"],
                    },
                });

            // A caller holding this digest's contract is admitted without receiving it again.
            const held = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/contract",
                headers,
                payload: { ref, omitContract: true },
            });
            expect(held.statusCode).toBe(200);
            expect(held.json()).toEqual({ access: "writable" });

            for (const omitContract of [undefined, true]) {
                const forged = await app.inject({
                    method: "POST",
                    url: "/v1/plugins/data/contract",
                    headers,
                    payload: {
                        ref: {
                            ...ref,
                            contractDigest: `A${ref.contractDigest.slice(1)}`,
                        },
                        ...(omitContract ? { omitContract } : {}),
                    },
                });
                expect(forged.statusCode).toBe(404);
                expect(forged.json()).toEqual({ error: "collection_unavailable" });
            }

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

    it("serves a retained compatible Collection contract read-only while keeping mutation on the exact current writer", async () => {
        const accountId = "account-collection-compatible-reader";
        const retainedReaderManifest = {
            ...COLLECTION_MANIFEST,
            contributes: {
                accountCollections: [{
                    ...COLLECTION_MANIFEST.contributes.accountCollections[0],
                    readableSchemaVersions: [2],
                }],
            },
        } as const;
        const targetManifest = {
            ...COLLECTION_MANIFEST,
            version: "2.0.0",
            contributes: {
                accountCollections: [{
                    ...COLLECTION_MANIFEST.contributes.accountCollections[0],
                    schemaVersion: 2,
                    readableSchemaVersions: [1],
                    migrations: [{
                        id: "tasks-v1-to-v2",
                        fromSchemaVersion: 1,
                        toSchemaVersion: 2,
                    }],
                }],
            },
        } as const;
        const incompatibleManifest = {
            ...targetManifest,
            version: "3.0.0",
            contributes: {
                accountCollections: [{
                    ...targetManifest.contributes.accountCollections[0],
                    schemaVersion: 3,
                    readableSchemaVersions: [],
                    migrations: [],
                }],
            },
        } as const;
        const { ref: retainedReaderRef, contract: sourceContract, indexState } = await seedCurrentCollectionAccount({
            accountId,
            retainRelease: false,
            manifest: retainedReaderManifest,
            rows: [{ rowId: "retained-task", status: "open", title: "Retained", revision: 1 }],
        });
        const sourceRef = retainedReaderRef;
        const [targetRef] = await inTx(async (tx) => (
            await materializePluginCollectionContractsFromManifestTx({ tx, manifest: targetManifest })
        ));
        const [incompatibleRef] = await inTx(async (tx) => (
            await materializePluginCollectionContractsFromManifestTx({ tx, manifest: incompatibleManifest })
        ));
        if (!retainedReaderRef || !targetRef || !incompatibleRef) throw new Error("Fixture evolved contracts were not materialized.");
        const targetContract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: targetRef.pluginId,
                collectionId: targetRef.collectionId,
                schemaVersion: targetRef.schemaVersion,
                contractDigest: targetRef.contractDigest,
            },
        });
        await db.$transaction([
            db.accountPluginIntent.update({
                where: { accountId_pluginId: { accountId, pluginId: PLUGIN_ID } },
                data: {
                    desiredVersion: "2.0.0",
                    writableCollections: toPrismaJson([targetRef]),
                    revision: BigInt(2),
                },
            }),
            db.pluginCollectionRow.updateMany({
                where: { accountId, contractId: sourceContract.id },
                data: {
                    schemaVersion: targetRef.schemaVersion,
                    contractId: targetContract.id,
                    contractDigest: targetRef.contractDigest,
                },
            }),
            db.pluginCollectionIndexState.update({
                where: { id: indexState.id },
                data: {
                    contractId: targetContract.id,
                    contractDigest: targetRef.contractDigest,
                },
            }),
            ...[
                { version: "1.0.0", manifest: retainedReaderManifest, ref: retainedReaderRef },
                { version: "2.0.0", manifest: targetManifest, ref: targetRef },
                { version: "3.0.0", manifest: incompatibleManifest, ref: incompatibleRef },
            ].map(({ version, manifest, ref }, index) => db.accountPluginRelease.create({
                data: {
                    accountId,
                    pluginId: PLUGIN_ID,
                    version,
                    archiveDigestSha256: `sha256:${String(index + 1).repeat(64)}`,
                    normalizedManifest: toPrismaJson(manifest),
                    collectionContracts: toPrismaJson([ref]),
                    uiSlots: toPrismaJson([]),
                    packageAssetArchive: toPrismaJson({
                        archiveDigestSha256: `sha256:${String(index + 4).repeat(64)}`,
                        resources: [],
                    }),
                },
            })),
        ]);

        await withAuthenticatedTestApp((app) => {
            enableMonitoring(app);
            app.addHook("onSend", async (request: { id: string }, reply: { header(name: string, value: string): unknown }) => {
                reply.header("x-test-request-id", request.id);
            });
            pluginDataRoutes(app);
        }, async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                ...V3_HEADERS,
            };
            for (const [url, payload] of [
                ["/v1/plugins/data/get", {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: "retained-task",
                }],
                ["/v1/plugins/data/query", {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    indexId: "by-status",
                    order: "asc",
                }],
                ["/v1/plugins/data/ui-query", {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    uiQueryId: "open",
                    parameters: { status: "open" },
                }],
            ] as const) {
                const omittedReader = await app.inject({ method: "POST", url, headers, payload });
                expect(omittedReader.statusCode).toBe(400);
                expect(omittedReader.json()).toEqual({ error: "collection_query_invalid" });
            }
            const retained = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/contract",
                headers,
                payload: { ref: retainedReaderRef },
            });
            expect(retained.statusCode).toBe(200);
            expect(PluginCollectionContractReadResultV1Schema.parse(retained.json())).toMatchObject({
                access: "readOnly",
                contract: retainedReaderRef,
            });

            const get = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/get",
                headers,
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    readerContext: retainedReaderRef,
                    rowId: "retained-task",
                },
            });
            expect(get.statusCode).toBe(200);
            expect(PluginCollectionGetResultV1Schema.parse(get.json())).toMatchObject({
                row: { rowId: "retained-task", projection: { status: "open", title: "Retained" } },
            });

            const staleMutation = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    writerContext: {
                        schemaVersion: sourceRef.schemaVersion,
                        contractDigest: sourceRef.contractDigest,
                    },
                    operations: [{ kind: "delete", rowId: "retained-task", expectedRevision: 1 }],
                },
            });
            expect(staleMutation.statusCode).toBe(409);
            expect(staleMutation.json()).toEqual({ error: "collection_writer_contract_unavailable" });

            // The logging sink is the external boundary; contract admission,
            // storage and the HTTP route remain real.
            const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
            const refusalEntries = () => warnings.mock.calls.flatMap(([fields]) => (
                typeof fields === "object" && fields !== null && "module" in fields
                && fields.module === "plugin-collection-read" ? [fields] : []
            ));
            try {
                for (const [url, payload] of [
                    ["/v1/plugins/data/contract", { ref: incompatibleRef }],
                    ["/v1/plugins/data/get", { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID,
                        readerContext: incompatibleRef, rowId: "retained-task" }],
                    ["/v1/plugins/data/query", { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID,
                        readerContext: incompatibleRef, indexId: "by-status", order: "asc" }],
                ] as const) {
                    warnings.mockClear();
                    const incompatible = await app.inject({ method: "POST", url, headers, payload });
                    expect(incompatible.statusCode).toBe(409);
                    expect(incompatible.json()).toEqual({ error: "collection_update_required" });
                    expect(refusalEntries()).toEqual([{
                        level: "warn",
                        module: "plugin-collection-read",
                        httpRequestId: incompatible.headers["x-test-request-id"],
                        responseCode: "collection_update_required",
                        decisionBranch: "reader_writer_incompatible",
                        collectionRef: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
                        readerRef: incompatibleRef,
                        writerRef: targetRef,
                    }]);
                    expect(incompatible.headers["x-test-request-id"]).toMatch(/^req-/);
                }
                warnings.mockClear();
                const compatible = await app.inject({ method: "POST", url: "/v1/plugins/data/contract", headers,
                    payload: { ref: retainedReaderRef } });
                expect(compatible.statusCode).toBe(200);
                expect(refusalEntries()).toEqual([]);

                await db.pluginCollectionRow.updateMany({ where: { accountId, rowId: "retained-task" },
                    data: { contractId: sourceContract.id, schemaVersion: sourceRef.schemaVersion, contractDigest: sourceRef.contractDigest } });
                const shared = await app.inject({ method: "POST", url: PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1.get, headers,
                    payload: { ownerAccountId: accountId, pluginId: PLUGIN_ID, collectionId: COLLECTION_ID,
                        rowId: "retained-task", readerContext: targetRef } });
                expect(shared.statusCode).toBe(409);
                expect(shared.json()).toEqual({ error: "collection_update_required" });
                expect(refusalEntries()).toEqual([expect.objectContaining({
                    httpRequestId: shared.headers["x-test-request-id"],
                    responseCode: "collection_update_required",
                    decisionBranch: "shared_row_writer_mismatch",
                    collectionRef: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
                    readerRef: targetRef,
                    writerRef: targetRef,
                })]);

                warnings.mockClear();
                await db.pluginCollectionContract.deleteMany({ where: incompatibleRef });
                const missing = await app.inject({ method: "POST", url: "/v1/plugins/data/contract", headers,
                    payload: { ref: incompatibleRef } });
                expect(missing.statusCode).toBe(409);
                expect(missing.json()).toEqual({ error: "collection_update_required" });
                expect(refusalEntries()).toEqual([expect.objectContaining({
                    httpRequestId: missing.headers["x-test-request-id"],
                    responseCode: "collection_update_required",
                    decisionBranch: "reader_not_materialized",
                    readerRef: incompatibleRef,
                    writerRef: targetRef,
                })]);
                await inTx(async (tx) => await materializePluginCollectionContractsFromManifestTx({ tx, manifest: incompatibleManifest }));

                warnings.mockClear();
                const unavailable = await app.inject({ method: "POST", url: "/v1/plugins/data/contract", headers,
                    payload: { ref: { ...incompatibleRef, pluginId: "example.absent" } } });
                expect(unavailable.statusCode).toBe(404);
                expect(unavailable.json()).toEqual({ error: "collection_unavailable" });
                expect(refusalEntries()).toEqual([expect.objectContaining({
                    httpRequestId: unavailable.headers["x-test-request-id"],
                    responseCode: "collection_unavailable",
                    decisionBranch: "intent_missing",
                })]);

                warnings.mockImplementation(() => { throw new Error("Fixture logging sink unavailable"); });
                const withoutSink = await app.inject({ method: "POST", url: "/v1/plugins/data/contract", headers,
                    payload: { ref: incompatibleRef } });
                expect(withoutSink.statusCode).toBe(409);
                expect(withoutSink.json()).toEqual({ error: "collection_update_required" });
            } finally {
                warnings.mockRestore();
            }

            // Independently upgraded daemon writer -> older app-compiled reader.
            // The writer moves forward; an app cannot borrow its contract.
            await db.accountPluginIntent.update({
                where: { accountId_pluginId: { accountId, pluginId: PLUGIN_ID } },
                data: { desiredVersion: null, writableCollections: toPrismaJson([incompatibleRef]) },
            });
            const oldApp = await app.inject({ method: 'POST', url: '/v1/plugins/data/contract', headers,
                payload: { ref: retainedReaderRef } });
            expect(oldApp.statusCode).toBe(409);
            expect(oldApp.json()).toEqual({ error: 'collection_update_required' });
            expect(await db.accountPluginIntent.findUniqueOrThrow({
                where: { accountId_pluginId: { accountId, pluginId: PLUGIN_ID } },
                select: { writableCollections: true },
            })).toEqual({ writableCollections: [incompatibleRef] });
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                readerContext: COLLECTION_READER_CONTEXT,
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
                        readerContext: ref,
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

    it("transports a private static projection for the Account client without making it server-readable", async () => {
        const accountId = "account-ui-query-private-projection";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-private",
                status: "open",
                title: "Server title",
                revision: 1,
                contentEnvelope: { t: "plain", v: { privateNote: "Client-only note" } },
            }],
        });

        await withPluginDataApp(async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    ...V3_HEADERS,
                },
                payload: queryRequest({
                    uiQueryId: PRIVATE_QUERY_ID,
                    readerContext: ref,
                }),
            });

            expect(response.statusCode).toBe(200);
            expect(PluginCollectionUiQueryTransportResultV1Schema.parse(response.json())).toEqual({
                rows: [{
                    context: {
                        collection: { pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
                        rowId: "task-private",
                        revision: 1,
                    },
                    fields: { status: "open" },
                    logicalRow: {
                        content: { t: "plain", v: { privateNote: "Client-only note" } },
                        projection: { status: "open", title: "Server title" },
                    },
                }],
                changeCursor: 41,
            });
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
        it(`admits ${queryCase.name} once per request and refuses the next request after an Account mode change`, async () => {
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
                const request = () => app.inject({
                    method: "POST",
                    url: queryCase.url,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": accountId,
                        ...V3_HEADERS,
                    },
                    payload: queryCase.payload,
                });
                expect((await request()).statusCode).toBe(200);
                await commitValidE2eeAccountModeForTest({ accountId, seq: 78 });
                const refused = await request();
                expect(refused.statusCode).toBe(409);
                expect(refused.json()).toEqual({ error: "collection_content_mode_mismatch" });
                expect(refused.body).not.toContain(secretTitle);
                expect(refused.body).not.toContain(secretNote);
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                    readerContext: COLLECTION_READER_CONTEXT,
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
                uiQueries: expect.arrayContaining([expect.objectContaining({ id: QUERY_ID })]),
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
                    readerContext: seeded.ref,
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
        const ref = await seedReadyEmptyInstantCollectionAccount(accountId);

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
                    readerContext: ref,
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
                    readerContext: ref,
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
                    readerContext: ref,
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

    it.each(["plain", "e2ee"] as const)("rejects an undeclared provider projection before persisting any %s Collection state", async (mode) => {
        const accountId = `account-provider-projection-refused-${mode}`;
        const { ref } = await seedCurrentCollectionAccount({ accountId, mode, rows: [] });
        const content = mode === "plain"
            ? { t: "plain" as const, v: { privateNote: "private provider detail" } }
            : { t: "encrypted" as const, c: sealPluginCollectionPrivatePayloadV1({
                material: { type: "legacy", secret: new Uint8Array(32).fill(9) },
                payload: { privateNote: "private provider detail" },
                randomBytes,
            }) };

        await withPluginDataApp(async (app) => {
            const refused = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers: { "x-test-user-id": accountId, ...V3_HEADERS },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                    operations: [{
                        kind: "put", rowId: "provider-entry", expectedRevision: "absent", expectedAbsenceEpoch: 0,
                        content,
                        projection: { status: "open", title: "Provider entry", providerObservation: "must stay ephemeral" },
                    }],
                },
            });
            expect(refused.statusCode).toBe(400);
            expect(refused.json()).toEqual({ error: "collection_mutation_invalid" });
        });

        expect(await Promise.all([
            db.pluginCollectionRow.count({ where: { accountId } }),
            db.pluginCollectionProjection.count({ where: { accountId } }),
            db.pluginCollectionIndexEntry.count({ where: { indexState: { accountId } } }),
            db.accountChange.count({ where: { accountId } }),
        ])).toEqual([0, 0, 0, 0]);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).toEqual({ seq: 41 });
    });

    it.each(["plain", "e2ee"] as const)("rejects an opposite-mode envelope before persisting any %s Collection state", async (mode) => {
        const accountId = `account-mutation-mode-refused-${mode}`;
        const { ref } = await seedCurrentCollectionAccount({ accountId, mode, rows: [] });
        const content = mode === "e2ee"
            ? { t: "plain" as const, v: { privateNote: "wrong Account mode" } }
            : { t: "encrypted" as const, c: sealPluginCollectionPrivatePayloadV1({
                material: { type: "legacy", secret: new Uint8Array(32).fill(9) },
                payload: { privateNote: "wrong Account mode" },
                randomBytes,
            }) };

        await withPluginDataApp(async (app) => {
            const refused = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers: { "x-test-user-id": accountId, ...V3_HEADERS },
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                    operations: [{
                        kind: "put", rowId: "mode-refused", expectedRevision: "absent", expectedAbsenceEpoch: 0,
                        content, projection: { status: "open", title: "Wrong Account mode" },
                    }],
                },
            });
            expect(refused.statusCode).toBe(409);
            expect(refused.json()).toEqual({ error: "collection_content_mode_mismatch" });
        });

        expect(await Promise.all([
            db.pluginCollectionRow.count({ where: { accountId } }),
            db.pluginCollectionProjection.count({ where: { accountId } }),
            db.pluginCollectionIndexEntry.count({ where: { indexState: { accountId } } }),
            db.accountChange.count({ where: { accountId } }),
        ])).toEqual([0, 0, 0, 0]);
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).toEqual({ seq: 41 });
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
                indexChanges: {
                    previousCursor: 0,
                    keys: [{
                        indexId: "by-status",
                        key: Buffer.from(encodePluginCollectionIndexSortKeyV1({
                            fields: [{ kind: "string", value: "open" }],
                            rowId: "task-written",
                        })).toString("hex"),
                    }],
                },
            },
        });
    });

    it.each([19, 20])("promotes retained Channels v%s census custody and serves it through its exact HTTP reader", async (sourceVersion) => {
        const accountId = `channels-v${sourceVersion}-retained-census`;
        const captured = JSON.parse(readFileSync(new URL(
            '../../../../../../../../packages/protocol/src/plugins/data/__fixtures__/channelStateV19Qa86.json', import.meta.url,
        ), 'utf8'));
        const retainedV20 = JSON.parse(readFileSync(new URL(
            '../../../../../../../../packages/plugins/channels/src/testkit/fixtures/channelStateV20.json', import.meta.url,
        ), 'utf8'));
        const sourceContract = sourceVersion === 20
            ? normalizePluginAccountCollectionContractV1({ pluginId: CHANNELS_MANIFEST.id,
                contribution: PluginAccountCollectionContributionV1Schema.parse(retainedV20.collection) })
            : PluginCollectionContractReadResultV1Schema.parse({ access: 'writable', contract: captured.writer }).contract;
        const { pluginId, collectionId, contractDigest: _digest, ...sourceDeclaration } = sourceContract;
        const targetDeclaration = CHANNELS_MANIFEST.contributes?.accountCollections?.find(item => item.id === collectionId);
        if (!targetDeclaration) throw new Error('Missing current Channels state declaration');
        const manifest = (version: string, collection: unknown) => PluginManifestV2Schema.parse({
            ...CHANNELS_MANIFEST, version, contributes: { accountCollections: [collection] },
        });
        const sourceManifest = manifest('1.0.0', { ...sourceDeclaration, id: collectionId });
        const targetManifest = manifest('2.0.0', targetDeclaration);
        const [source] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: sourceManifest }));
        const [target] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: targetManifest }));
        if (!source || !target) throw new Error('Missing Channels migration contracts');
        const targetContract = normalizePluginAccountCollectionContractV1({ pluginId,
            contribution: PluginAccountCollectionContributionV1Schema.parse(targetDeclaration) });
        await createAccount({ id: accountId, mode: 'plain', seq: 1 });
        await retainCollectionRelease({ accountId, manifest: sourceManifest, refs: [source] });
        await retainCollectionRelease({ accountId, manifest: targetManifest, refs: [target] });
        await db.accountPluginIntent.create({ data: { accountId, pluginId, desiredVersion: '1.0.0', enabled: true,
            offlineUiHosting: 'disabled', writableCollections: toPrismaJson([source]), revision: BigInt(1) } });
        await inTx(tx => preparePluginCollectionWritableContractsTx({ tx, accountId, pluginId, contracts: [source] }));
        const historical = { id: 'A'.repeat(43), 'record-kind': 'ingress-obligation', v: 1,
            'connection-id': 'connection-1', 'created-at': 1, 'updated-at': 1, 'due-at': 100,
            terminal: false, attention: false, payload: { censusId: 'C'.repeat(43), occurrenceIds: ['observation-1'], target: null,
                sourceAuthority: { connectionAuthorityEpoch: 1 }, lifecycle: { phase: 'retryDue', attemptCount: 1, dueAt: 100 },
                disposition: null, nonAdmission: null } };
        const encode = (contract: typeof sourceContract, value: PluginCollectionLogicalValueV1) => {
            const validate = compilePluginJsonSchema(contract.schema);
            const result = encodePluginCollectionLogicalValueV1({ contract, value, encryptionMode: 'plain', material: null,
                isValidLogicalValue: candidate => isValidPluginJsonSchemaValue(validate, candidate), randomBytes });
            if (result.status === 'failed') throw new Error(`Channels fixture rejected: ${result.reason}`);
            return result;
        };
        const sourceValue = encode(sourceContract, historical);
        await mutatePluginCollection({ accountId, request: { pluginId, collectionId,
            writerContext: { schemaVersion: source.schemaVersion, contractDigest: source.contractDigest },
            operations: [{ kind: 'put', rowId: historical.id, expectedRevision: 'absent', expectedAbsenceEpoch: 0,
                content: sourceValue.content, projection: sourceValue.projection }] } });
        let migrated = historical;
        for (let version = source.schemaVersion; version < target.schemaVersion;) {
            const edge = channelsCollectionMigrations['channel-state']?.find(step => step.fromSchemaVersion === version);
            if (!edge) throw new Error(`Missing Channels migration from v${version}`);
            migrated = await edge.migrate(migrated, { currentRevision: 1 }) as typeof historical;
            version = edge.toSchemaVersion;
        }
        expect(migrated).toEqual(historical);
        const staged = encode(targetContract, migrated);
        await stagePluginCollectionCandidatePreparation({ accountId, request: {
            binding: { source, target, candidate: { releaseVersion: '2.0.0', artifactDigest: `sha256:${'f'.repeat(64)}` } },
            items: [{ source: { rowId: historical.id, revision: 1 },
                target: { content: staged.content, projection: staged.projection } }],
        } });
        await inTx(async tx => {
            const currentIntent = await tx.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId, pluginId } } });
            await promotePluginCollectionCandidatePreparationInTx({ tx, accountId, pluginId, currentIntent,
                targetReleaseVersion: '2.0.0', targetContracts: [target] });
            await preparePluginCollectionWritableContractsTx({ tx, accountId, pluginId, contracts: [target] });
            await tx.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId } },
                data: { desiredVersion: '2.0.0', writableCollections: toPrismaJson([target]), revision: { increment: 1 } } });
        });
        const { censusId: _censusId, ...payload } = historical.payload;
        const current = { ...historical, id: 'B'.repeat(43), payload: { ...payload, normalizedIngress: null,
            observationShell: { v: 1, occurrenceId: 'observation-1', occurredAt: 1, transport: { kind: 'poll' },
                endpoint: { kind: 'direct', audience: 'direct', id: 'provider:chat:1' },
                actor: { kind: 'human', principalId: 'person-1', isIntegrationSelf: false },
                message: { id: 'provider:message:1', providerTimestamp: 1, addressingEvidence: 'none', contentProvenance: 'original' } } } };
        const encoded = encode(targetContract, current);
        const headers = { 'content-type': 'application/json', 'x-test-user-id': accountId, ...V3_HEADERS };
        await withPluginDataApp(async app => {
            const historicalGet = await app.inject({ method: 'POST', url: '/v1/plugins/data/get', headers,
                payload: { pluginId, collectionId, readerContext: target, rowId: historical.id } });
            expect(historicalGet.statusCode).toBe(200);
            expect(PluginCollectionGetResultV1Schema.parse(historicalGet.json()).row?.content).toEqual(staged.content);
            const mutation = await app.inject({ method: 'POST', url: '/v1/plugins/data/mutate', headers,
                payload: { pluginId, collectionId, writerContext: { schemaVersion: target.schemaVersion, contractDigest: target.contractDigest }, operations: [{ kind: 'put', rowId: current.id,
                    expectedRevision: 'absent', expectedAbsenceEpoch: 0, content: encoded.content, projection: encoded.projection }] } });
            expect(mutation.statusCode).toBe(200);
            const contract = await app.inject({ method: 'POST', url: '/v1/plugins/data/contract', headers, payload: { ref: target } });
            expect(contract.statusCode).toBe(200);
            expect(PluginCollectionContractReadResultV1Schema.parse(contract.json()).contract.schemaVersion).toBe(target.schemaVersion);
            const get = await app.inject({ method: 'POST', url: '/v1/plugins/data/get', headers,
                payload: { pluginId, collectionId, readerContext: target, rowId: current.id } });
            expect(get.statusCode).toBe(200);
            expect(PluginCollectionGetResultV1Schema.parse(get.json()).row?.content).toEqual(encoded.content);
        });
        const retained = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId, rowId: historical.id } });
        expect(retained).toMatchObject({ schemaVersion: target.schemaVersion, contractDigest: target.contractDigest, deletedAt: null });
        expect(retained.contentEnvelope).toEqual(staged.content);
    });

    it("admits a release-less claimed writer for contract reads, mutations and static UI queries", async () => {
        const accountId = "account-collection-release-less-writer";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            seq: 41,
            rows: [],
            desiredVersion: null,
            retainRelease: false,
        });
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": accountId,
            ...V3_HEADERS,
        };

        await withPluginDataApp(async (app) => {
            const contract = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/contract",
                headers,
                payload: { ref },
            });
            expect(contract.statusCode).toBe(200);
            expect(PluginCollectionContractReadResultV1Schema.parse(contract.json()))
                .toMatchObject({ access: "writable", contract: { contractDigest: ref.contractDigest } });

            const mutation = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: {
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    operations: [{
                        kind: "put",
                        rowId: "task-claimed",
                        expectedRevision: "absent",
                        expectedAbsenceEpoch: 0,
                        content: { t: "plain", v: { privateNote: "never projected" } },
                        projection: { status: "open", title: "Claimed task" },
                    }],
                },
            });
            expect(mutation.statusCode).toBe(200);

            const queried = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/ui-query",
                headers,
                payload: queryRequest(),
            });
            expect(queried.statusCode).toBe(200);
            expect(PluginCollectionUiQueryResultV1Schema.parse(queried.json()).rows)
                .toMatchObject([{ context: { rowId: "task-claimed", revision: 1 } }]);
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
        await expect(db.pluginCollectionIndexEntry.count({
            where: { indexState: { accountId, pluginId: PLUGIN_ID, collectionId: COLLECTION_ID } },
        })).resolves.toBeGreaterThan(0);

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
        await expect(db.pluginCollectionIndexEntry.count({
            where: {
                rowId: "task-after-conflict",
                indexState: { accountId, pluginId: PLUGIN_ID, collectionId: COLLECTION_ID },
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

    it("physically forgets an exact live retention row and advances its absence epoch", async () => {
        const accountId = "account-collection-forget-live";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-forget-live",
                status: "closed",
                title: "Forget live retention row",
                revision: 3,
            }],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };

        let observedAbsenceEpoch = -1;
        let cursorBeforeForget = -1;
        await withPluginDataApp(async (app) => {
            const snapshotResponse = await app.inject({
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
                    readerContext: ref,
                    rowId: "task-forget-live",
                },
            });
            const snapshot = PluginCollectionGetResultV1Schema.parse(snapshotResponse.json());
            expect(snapshot.row?.revision).toBe(3);
            observedAbsenceEpoch = snapshot.absenceEpoch;
            cursorBeforeForget = (await db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { seq: true },
            })).seq;

            const forgetResponse = await app.inject({
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
                    rowId: "task-forget-live",
                    expectedRevision: 3,
                },
            });
            expect(forgetResponse.statusCode).toBe(200);
            expect(forgetResponse.json()).toEqual({ status: "forgotten" });
        });

        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "task-forget-live",
            },
        })).resolves.toBe(0);
        // One successful live forget is one Collection change. The retirement
        // widens that collection's invalidation to full scope because the row
        // carrying the retired revision is gone, and it allocates exactly one
        // Account cursor, so a connected client wakes and re-reads once.
        await expect(db.accountChange.findFirstOrThrow({
            where: {
                accountId,
                kind: "pluginDomain",
                entityId: `pluginDomain/${PLUGIN_ID}/data-collection/${COLLECTION_ID}`,
            },
            select: { cursor: true, hint: true },
        })).resolves.toEqual({
            cursor: cursorBeforeForget + 1,
            hint: {
                pluginDomain: "dataCollection",
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                contractDigest: ref.contractDigest,
                revision: 4,
                full: true,
            },
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: accountId },
            select: { seq: true },
        })).resolves.toEqual({ seq: cursorBeforeForget + 1 });
        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-forget-live",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: observedAbsenceEpoch,
                    content: { t: "plain", v: { privateNote: "stale" } },
                    projection: { status: "open", title: "Stale recreation" },
                }],
            },
        })).resolves.toEqual({
            status: "conflict",
            conflicts: [{ rowId: "task-forget-live", revision: null, deleted: false }],
        });

        const currentAbsenceEpoch = await db.pluginCollectionAbsenceEpoch.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                },
            },
            select: { epoch: true },
        });
        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-forget-live",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: currentAbsenceEpoch.epoch,
                    content: { t: "plain", v: { privateNote: "fresh" } },
                    projection: { status: "open", title: "Fresh recreation" },
                }],
            },
        })).resolves.toMatchObject({ status: "updated" });

        await withPluginDataApp(async (app) => {
            const staleForget = await app.inject({
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
                    rowId: "task-forget-live",
                    expectedRevision: 3,
                },
            });
            expect(staleForget.statusCode).toBe(200);
            expect(staleForget.json()).toEqual({ status: "conflict" });
        });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId_rowId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: "task-forget-live",
                },
            },
            select: { revision: true, deletedAt: true },
        })).resolves.toEqual({
            revision: currentAbsenceEpoch.epoch + 1,
            deletedAt: null,
        });
    });

    it("admits the persisted ceiling revision and refuses the increment past it", async () => {
        const accountId = "account-collection-revision-ceiling";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-ceiling",
                status: "open",
                title: "Nearly exhausted",
                revision: PLUGIN_COLLECTION_REVISION_MAX - 1,
            }],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };
        const put = (expectedRevision: number, privateNote: string) => ({
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            writerContext,
            operations: [{
                kind: "put" as const,
                rowId: "task-ceiling",
                expectedRevision,
                content: { t: "plain" as const, v: { privateNote } },
                projection: { status: "open", title: "Nearly exhausted" },
            }],
        });

        await expect(mutatePluginCollection({
            accountId,
            request: put(PLUGIN_COLLECTION_REVISION_MAX - 1, "last-accepted"),
        })).resolves.toMatchObject({
            status: "updated",
            results: [{
                rowId: "task-ceiling",
                revision: PLUGIN_COLLECTION_REVISION_MAX,
                deleted: false,
            }],
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
                payload: put(PLUGIN_COLLECTION_REVISION_MAX, "over-the-ceiling"),
            });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "collection_revision_exhausted" });
        });

        // The refused write leaves the exhausted row and every derived
        // currentness witness exactly where the last accepted increment left it.
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId_rowId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: "task-ceiling",
                },
            },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: PLUGIN_COLLECTION_REVISION_MAX,
            contentEnvelope: { t: "plain", v: { privateNote: "last-accepted" } },
        });
        await expect(db.pluginCollectionProjection.findMany({
            where: { accountId, rowId: "task-ceiling" },
            select: { rowRevision: true },
        })).resolves.toEqual([
            { rowRevision: PLUGIN_COLLECTION_REVISION_MAX },
            { rowRevision: PLUGIN_COLLECTION_REVISION_MAX },
        ]);
    });

    it("reports a stale witness as an exact conflict rather than exhaustion", async () => {
        const accountId = "account-collection-revision-ceiling-stale";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-exhausted",
                status: "open",
                title: "Exhausted",
                revision: PLUGIN_COLLECTION_REVISION_MAX,
            }],
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
                    rowId: "task-exhausted",
                    expectedRevision: PLUGIN_COLLECTION_REVISION_MAX - 1,
                    content: { t: "plain", v: { privateNote: "stale" } },
                    projection: { status: "open", title: "Exhausted" },
                }],
            },
        })).resolves.toEqual({
            status: "conflict",
            conflicts: [{
                rowId: "task-exhausted",
                revision: PLUGIN_COLLECTION_REVISION_MAX,
                deleted: false,
            }],
        });
    });

    it("writes nothing when one operation of a batch exhausts its revision", async () => {
        const accountId = "account-collection-revision-ceiling-batch";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [
                { rowId: "task-batch-live", status: "open", title: "Live", revision: 3 },
                {
                    rowId: "task-batch-exhausted",
                    status: "open",
                    title: "Exhausted",
                    revision: PLUGIN_COLLECTION_REVISION_MAX,
                },
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
                operations: [
                    {
                        kind: "put",
                        rowId: "task-batch-live",
                        expectedRevision: 3,
                        content: { t: "plain", v: { privateNote: "batched" } },
                        projection: { status: "open", title: "Live" },
                    },
                    {
                        kind: "put",
                        rowId: "task-batch-exhausted",
                        expectedRevision: PLUGIN_COLLECTION_REVISION_MAX,
                        content: { t: "plain", v: { privateNote: "batched" } },
                        projection: { status: "open", title: "Exhausted" },
                    },
                ],
            },
        })).rejects.toMatchObject({ code: "collection_revision_exhausted" });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId_rowId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: "task-batch-live",
                },
            },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 3,
            contentEnvelope: { t: "plain", v: { privateNote: "secret-task-batch-live" } },
        });
    });

    it("advances the absence epoch to the persisted ceiling and refuses to pass it", async () => {
        const accountId = "account-collection-forget-epoch-ceiling";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-forget-ceiling",
                status: "closed",
                title: "Last forgettable",
                // Forget retires this live row at MAX - 1 and then advances the
                // shared absence epoch exactly onto the persisted ceiling.
                revision: PLUGIN_COLLECTION_REVISION_MAX - 2,
            }],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };

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
                    rowId: "task-forget-ceiling",
                    expectedRevision: PLUGIN_COLLECTION_REVISION_MAX - 2,
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "forgotten" });
        });
        await expect(db.pluginCollectionAbsenceEpoch.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                },
            },
            select: { epoch: true },
        })).resolves.toEqual({ epoch: PLUGIN_COLLECTION_REVISION_MAX });

        // An absent create is seeded from the epoch, so a ceiling epoch leaves
        // the identity typed-exhausted rather than overflowing the column.
        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-forget-ceiling",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: PLUGIN_COLLECTION_REVISION_MAX,
                    content: { t: "plain", v: { privateNote: "recreated" } },
                    projection: { status: "open", title: "Recreated" },
                }],
            },
        })).rejects.toMatchObject({ code: "collection_revision_exhausted" });
        await expect(db.pluginCollectionRow.count({
            where: { accountId, pluginId: ref.pluginId, collectionId: ref.collectionId },
        })).resolves.toBe(0);
    });

    it("refuses a forget whose absence epoch would pass the persisted ceiling", async () => {
        const accountId = "account-collection-forget-epoch-exhausted";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-forget-unforgettable",
                status: "closed",
                title: "Beyond the epoch ceiling",
                revision: PLUGIN_COLLECTION_REVISION_MAX - 1,
            }],
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
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    rowId: "task-forget-unforgettable",
                    expectedRevision: PLUGIN_COLLECTION_REVISION_MAX - 1,
                },
            });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "collection_revision_exhausted" });
        });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId_rowId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: "task-forget-unforgettable",
                },
            },
            select: { revision: true, deletedAt: true },
        })).resolves.toEqual({
            revision: PLUGIN_COLLECTION_REVISION_MAX - 1,
            deletedAt: null,
        });
        await expect(db.pluginCollectionAbsenceEpoch.findUnique({
            where: {
                accountId_pluginId_collectionId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                },
            },
        })).resolves.toBeNull();
    });

    it("leaves an exact live row untouched when the forget names a stale revision", async () => {
        const accountId = "account-collection-forget-live-stale-revision";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-forget-live-stale-revision",
                status: "closed",
                title: "Keep live retention row",
                revision: 3,
            }],
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
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    writerContext: {
                        schemaVersion: ref.schemaVersion,
                        contractDigest: ref.contractDigest,
                    },
                    rowId: "task-forget-live-stale-revision",
                    expectedRevision: 2,
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "conflict" });
        });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId_rowId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: "task-forget-live-stale-revision",
                },
            },
            select: { revision: true, deletedAt: true },
        })).resolves.toEqual({ revision: 3, deletedAt: null });
        await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(0);
        await expect(db.pluginCollectionAbsenceEpoch.count({ where: { accountId } })).resolves.toBe(0);
    });

    it("conflicts once when an exact forget meets a newer tombstone the direct read hides", async () => {
        const accountId = "account-collection-forget-hidden-tombstone";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{
                rowId: "task-forget-hidden",
                status: "open",
                title: "Hidden tombstone",
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
                operations: [{ kind: "delete", rowId: "task-forget-hidden", expectedRevision: 3 }],
            },
        })).resolves.toMatchObject({ status: "updated" });

        await withPluginDataApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                ...V3_HEADERS,
            };
            // A direct read cannot see the tombstone, so absence tells a
            // retention owner nothing about the revision it must name. The
            // exact-revision conflict is therefore the only answer, and it
            // must be terminal rather than an invitation to re-read and retry.
            const snapshot = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/get",
                headers,
                payload: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    readerContext: ref,
                    rowId: "task-forget-hidden",
                },
            });
            expect(PluginCollectionGetResultV1Schema.parse(snapshot.json()).row).toBeNull();

            const response = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/forget",
                headers,
                payload: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    writerContext,
                    rowId: "task-forget-hidden",
                    expectedRevision: 3,
                },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "conflict" });
        });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId_rowId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    rowId: "task-forget-hidden",
                },
            },
            select: { revision: true },
        })).resolves.toEqual({ revision: 4 });
    });

    it("forgets every exact row of one Collection and replays a lost response idempotently", async () => {
        const accountId = "account-collection-forget-sequence";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [
                { rowId: "task-a", status: "closed", title: "Retired A", revision: 3 },
                { rowId: "task-b", status: "closed", title: "Retired B", revision: 5 },
            ],
        });
        const writerContext = {
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        };
        const forgetPayload = (rowId: string, expectedRevision: number) => ({
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            writerContext,
            rowId,
            expectedRevision,
        });

        await withPluginDataApp(async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": accountId,
                ...V3_HEADERS,
            };
            const forget = async (rowId: string, expectedRevision: number) => (await app.inject({
                method: "POST",
                url: "/v1/plugins/data/forget",
                headers,
                payload: forgetPayload(rowId, expectedRevision),
            })).json();

            // Two retirements in one Collection share no caller-owned
            // currentness, so the second is not invalidated by the first.
            expect(await forget("task-a", 3)).toEqual({ status: "forgotten" });
            expect(await forget("task-b", 5)).toEqual({ status: "forgotten" });
            // The exact row is already gone, so the response-loss replay is the
            // same durable result rather than a second retirement.
            expect(await forget("task-a", 3)).toEqual({ status: "forgotten" });
        });

        await expect(db.pluginCollectionRow.count({
            where: { accountId, pluginId: ref.pluginId, collectionId: ref.collectionId },
        })).resolves.toBe(0);
        const epoch = await db.pluginCollectionAbsenceEpoch.findUniqueOrThrow({
            where: {
                accountId_pluginId_collectionId: {
                    accountId,
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                },
            },
            select: { epoch: true },
        });
        expect(epoch.epoch).toBeGreaterThan(6);

        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-a",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: { privateNote: "stale" } },
                    projection: { status: "open", title: "Stale recreation" },
                }],
            },
        })).resolves.toEqual({
            status: "conflict",
            conflicts: [{ rowId: "task-a", revision: null, deleted: false }],
        });
        await expect(mutatePluginCollection({
            accountId,
            request: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                writerContext,
                operations: [{
                    kind: "put",
                    rowId: "task-a",
                    expectedRevision: "absent",
                    expectedAbsenceEpoch: epoch.epoch,
                    content: { t: "plain", v: { privateNote: "fresh" } },
                    projection: { status: "open", title: "Fresh recreation" },
                }],
            },
        })).resolves.toMatchObject({
            status: "updated",
            results: [{ rowId: "task-a", revision: epoch.epoch + 1, deleted: false }],
        });
    });

    it("applies canonical relation cleanup before atomically forgetting an exact live row", async () => {
        const accountId = "account-collection-forget-live-relations";
        const { projectRef, taskRef } = await seedReadyNullifyRelationCollectionAccount(accountId);

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

            const snapshotResponse = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/get",
                headers,
                payload: {
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    readerContext: projectRef,
                    rowId: "project-a",
                },
            });
            const snapshot = PluginCollectionGetResultV1Schema.parse(snapshotResponse.json());
            expect(snapshot.row?.revision).toBe(1);

            const forgotten = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/forget",
                headers,
                payload: {
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    writerContext: {
                        schemaVersion: projectRef.schemaVersion,
                        contractDigest: projectRef.contractDigest,
                    },
                    rowId: "project-a",
                    expectedRevision: 1,
                },
            });
            expect(forgotten.statusCode).toBe(200);
            expect(forgotten.json()).toEqual({ status: "forgotten" });
        });

        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                collectionId: "projects",
                rowId: "project-a",
            },
        })).resolves.toBe(0);
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
        // Retirement widens only the retired collection. The relation-nullified
        // collection keeps its own exact invalidation at the revision the
        // cleanup wrote, so its readers still wake.
        await expect(db.accountChange.findMany({
            where: { accountId, kind: "pluginDomain" },
            orderBy: { entityId: "asc" },
            select: { entityId: true, hint: true },
        })).resolves.toEqual([
            {
                entityId: `pluginDomain/${NULLIFY_RELATION_COLLECTION_MANIFEST.id}/data-collection/projects`,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "projects",
                    contractDigest: projectRef.contractDigest,
                    revision: 2,
                    full: true,
                },
            },
            {
                entityId: `pluginDomain/${NULLIFY_RELATION_COLLECTION_MANIFEST.id}/data-collection/tasks`,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                    collectionId: "tasks",
                    contractDigest: taskRef.contractDigest,
                    revision: 2,
                    rowIds: ["task-a"],
                },
            },
        ]);
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
                    readerContext: ref,
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
                    readerContext: ref,
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

    it("preserves a provider timeout from the pre-mutation quota usage read", async () => {
        harness.resetEnv({ HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const accountId = "account-collection-pre-usage-provider-timeout";
        const { ref } = await seedCurrentCollectionAccount({ accountId, rows: [] });
        const providerTimeout = Object.assign(
            new Error("Timed out fetching a new connection during the quota usage read."),
            { code: "P2024" },
        );
        const boundary = failPluginCollectionQuotaUsageOperation({
            accountId,
            phase: "read",
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
            expect(boundary.usageReads()).toBe(1);
            await expect(db.pluginCollectionRow.count({
                where: { accountId, rowId: "task-new" },
            })).resolves.toBe(0);
        } finally {
            boundary.restore();
        }
    });

    it("preserves a provider timeout after the quota counter write and rolls back rows and usage", async () => {
        harness.resetEnv({ HAPPIER_DB_TX_MAX_RETRIES: "0" });
        const accountId = "account-collection-usage-write-provider-timeout";
        const { ref } = await seedCurrentCollectionAccount({
            accountId,
            rows: [{ rowId: "task-existing", status: "open", title: "Before", revision: 1 }],
        });
        const providerTimeout = Object.assign(
            new Error("Timed out completing the quota counter write."),
            { code: "P2024" },
        );
        const beforeUsage = await db.account.findUniqueOrThrow({ where: { id: accountId },
            select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } });
        const boundary = failPluginCollectionQuotaUsageOperation({
            accountId,
            phase: "write",
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
            expect(boundary.usageReads()).toBe(1);
            expect(boundary.usageWrites()).toBe(1);
            await expect(db.pluginCollectionRow.findFirstOrThrow({
                where: { accountId, rowId: "task-existing" },
                select: { revision: true, contentEnvelope: true },
            })).resolves.toEqual({
                revision: 1,
                contentEnvelope: { t: "plain", v: { privateNote: "secret-task-existing" } },
            });
            await expect(db.account.findUniqueOrThrow({ where: { id: accountId },
                select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } })).resolves.toEqual(beforeUsage);
        } finally {
            boundary.restore();
        }
    });

    it("keeps a malformed persisted contract retained by quota usage typed as contract inconsistency", async () => {
        const accountId = "account-collection-usage-malformed-contract";
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

    it("admits a small write in another current Collection beside an unchanged declared row overage", async () => {
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
        })).resolves.toMatchObject({ status: "updated" });
        await expect(db.pluginCollectionRow.count({
            where: { accountId, pluginId: ref.pluginId, collectionId: ref.collectionId, rowId: "small-write" },
        })).resolves.toBe(1);
    });

    it("admits an unrelated write beside an unchanged row after the deployment row ceiling is lowered", async () => {
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
        })).resolves.toMatchObject({ status: "updated" });
        await expect(db.pluginCollectionRow.count({
            where: {
                accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                rowId: "unrelated-small-write",
            },
        })).resolves.toBe(1);
    });

    it("reads only changed rows beside retained Account totals and returns typed effective-limit failures", async () => {
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
        const observations: ReturnType<typeof observePrismaReads>[] = [];
        let restored = false;
        Reflect.set(db, "$transaction", async (...args: Parameters<typeof db.$transaction>) => {
            const [callback, options] = args;
            if (typeof callback !== "function") {
                return await originalTransaction(...args);
            }
            return await originalTransaction(async (tx) => {
                const observed = observePrismaReads(tx, ["pluginCollectionRow"]);
                observations.push(observed);
                return await callback(observed.tx);
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

            await expect(mutatePluginCollection({
                accountId,
                request: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                    operations: [{ kind: "put", rowId: "task-new", expectedRevision: 1,
                        content: { t: "plain", v: { privateNote: "updated" } },
                        projection: { status: "open", title: "Updated task" } }],
                },
            })).resolves.toMatchObject({ status: "updated", results: [{ rowId: "task-new", revision: 2, deleted: false }] });

            // Reading the changed stored row proves the observer is live;
            // reading any of the 50 unchanged rows would reveal an Account census.
            const changed = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId, rowId: "task-new" }, select: { id: true } });
            const transferred = observations.flatMap(value => value.rows).flatMap(value => value.ids);
            expect(transferred.length).toBeGreaterThan(0);
            expect(transferred.every(id => id === "task-new" || id === changed.id)).toBe(true);
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
                    readerContext: ref,
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

        await backfillCurrentCollectionUsage(accountId);
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
                    readerContext: taskRef,
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

    it.each([
        { count: 200, mixed: false, nullifyOnly: false },
        { count: 201, mixed: false, nullifyOnly: false },
        { count: 200, mixed: true, nullifyOnly: false },
        { count: 201, mixed: false, nullifyOnly: true },
    ])("preserves bounded restriction recovery for $count dependents (mixed: $mixed, nullifyOnly: $nullifyOnly)", async ({ count, mixed, nullifyOnly }) => {
        const accountId = "account-large-restriction";
        const task = RELATION_COLLECTION_MANIFEST.contributes.accountCollections[1];
        const manifest = {
            ...RELATION_COLLECTION_MANIFEST,
            contributes: {
                accountCollections: [
                    RELATION_COLLECTION_MANIFEST.contributes.accountCollections[0],
                    {
                        ...task,
                        schema: {
                            ...task.schema,
                            required: nullifyOnly ? ["id", "title"] : task.schema.required,
                            properties: { ...task.schema.properties, optionalProject: { type: "string", maxLength: 256 } },
                        },
                        serverReadable: [...task.serverReadable, "optionalProject"],
                        relations: [
                            { ...task.relations[0], unique: false, required: !nullifyOnly, onDelete: nullifyOnly ? "nullify" : "restrict" },
                            { id: "zz-optional", kind: "collection", field: "optionalProject", collectionId: "projects", required: false, onDelete: "nullify" },
                        ],
                    },
                ],
            },
        };
        const { projectRef, taskRef } = await seedReadyRelationCollectionAccount(accountId, manifest);
        const projectWriter = { schemaVersion: projectRef.schemaVersion, contractDigest: projectRef.contractDigest };
        const taskWriter = { schemaVersion: taskRef.schemaVersion, contractDigest: taskRef.contractDigest };
        await mutatePluginCollection({ accountId, request: {
            pluginId: projectRef.pluginId, collectionId: "projects", writerContext: projectWriter,
            operations: [{ kind: "put", rowId: "project-a", expectedRevision: "absent", expectedAbsenceEpoch: 0,
                content: { t: "plain", v: {} }, projection: { id: "project-a", title: "Project A" } }],
        } });
        for (let offset = 0; offset < count; offset += 100) {
            await mutatePluginCollection({ accountId, request: {
                pluginId: taskRef.pluginId, collectionId: "tasks", writerContext: taskWriter,
                operations: Array.from({ length: Math.min(100, count - offset) }, (_, index) => {
                    const rowId = `task-${String(offset + index).padStart(3, "0")}`;
                    return { kind: "put" as const, rowId, expectedRevision: "absent" as const, expectedAbsenceEpoch: 0,
                        content: { t: "plain" as const, v: {} }, projection: {
                            id: rowId, title: rowId, "project-id": "project-a",
                            optionalProject: mixed && offset + index === 0 ? "project-a" : null,
                        } };
                }),
            } });
        }
        await withPluginDataApp(async (app) => {
            const headers = { "x-test-user-id": accountId, ...V3_HEADERS };
            const deletion = { pluginId: projectRef.pluginId, collectionId: "projects", writerContext: projectWriter,
                operations: [{ kind: "delete", rowId: "project-a", expectedRevision: 1 }] };
            const blocked = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate", headers, payload: deletion });
            expect(blocked.statusCode).toBe(409);
            await expect(db.pluginCollectionRow.count({ where: { accountId, deletedAt: null } })).resolves.toBe(count + 1);
            await expect(db.pluginCollectionRow.count({ where: { accountId, revision: { not: 1 } } })).resolves.toBe(0);
            if (nullifyOnly) {
                expect(blocked.json()).toEqual({ error: "collection_relation_unavailable" });
                return;
            }
            expect(blocked.json()).toMatchObject({ error: "collection_relation_restricted", dependentCount: Math.min(count, 200),
                continuation: { pluginId: taskRef.pluginId, collectionId: "tasks", relationId: "project",
                    target: { collectionId: "projects", rowId: "project-a" },
                    query: { indexId: "by-project-id", prefix: ["project-a"], order: "asc", limit: 200 } } });

            // Consume the returned query, delete a bounded page, and requery until the target can be deleted.
            const continuation = blocked.json().continuation;
            let removed = 0;
            while (removed < count) {
                const page = await app.inject({ method: "POST", url: "/v1/plugins/data/query", headers,
                    payload: { pluginId: continuation.pluginId, collectionId: continuation.collectionId,
                        readerContext: taskRef, ...continuation.query } });
                expect(page.statusCode).toBe(200);
                const rows = PluginCollectionQueryResultV1Schema.parse(page.json()).rows;
                expect(rows.length).toBeGreaterThan(0);
                for (let offset = 0; offset < rows.length; offset += 100) {
                    await mutatePluginCollection({ accountId, request: {
                        pluginId: taskRef.pluginId, collectionId: "tasks", writerContext: taskWriter,
                        operations: rows.slice(offset, offset + 100).map((row) => ({ kind: "delete", rowId: row.rowId, expectedRevision: row.revision })),
                    } });
                }
                removed += rows.length;
            }
            expect(removed).toBe(count);
            const deleted = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate", headers, payload: deletion });
            expect(deleted.statusCode).toBe(200);
        });
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

    it("qualifies a Session host relation with the mutation credential instead of structural Team entitlement", async () => {
        const accountId = "account-collection-session-host-relation";
        const ownerId = "owner-collection-session-host-relation";
        const { ref } = await seedReadyHostSessionRelationCollectionAccount(accountId);
        await createAccount({ id: ownerId, mode: "plain", seq: 0 });
        const session = await db.session.create({ data: {
            accountId: ownerId,
            tag: "session-host-relation",
            metadata: "{}",
            encryptionMode: "plain",
        } });
        const team = await db.team.create({ data: {
            name: "Restricted host relation Team",
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId, role: "member" } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt: new Date(),
        } });
        const headers = { "x-test-user-id": accountId, ...V3_HEADERS };
        const mutation = (rowId: string) => ({
            pluginId: HOST_SESSION_RELATION_COLLECTION_MANIFEST.id,
            collectionId: "tasks",
            writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
            operations: [{
                kind: "put" as const,
                rowId,
                expectedRevision: "absent" as const,
                expectedAbsenceEpoch: 0,
                content: { t: "plain" as const, v: {} },
                projection: { id: rowId, title: "Task", "session-id": session.id },
            }],
        });

        await withPluginDataApp(async (app) => {
            const unqualified = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: mutation("unqualified"),
            });
            expect(unqualified.statusCode).toBe(409);
            expect(unqualified.json()).toEqual({ error: "collection_relation_unavailable" });

            await db.sessionShare.create({ data: {
                sessionId: session.id,
                sharedByUserId: ownerId,
                sharedWithUserId: accountId,
                accessLevel: "view",
            } });
            const direct = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/mutate",
                headers,
                payload: mutation("direct"),
            });
            expect(direct.statusCode).toBe(200);
        });
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

    it("invalidates a shared dependent when deleting a related row in another Collection", async () => {
        const accountId = "collection-shared-nullify-owner", recipient = "collection-shared-nullify-peer";
        const { projectRef, taskRef } = await seedReadyNullifyRelationCollectionAccount(accountId);
        await createAccount({ id: recipient, mode: "plain", seq: 0 });
        await withPluginDataApp(async app => {
            const headers = { ...V3_HEADERS, "x-test-user-id": accountId };
            const put = async (collectionId: string, writerContext: typeof projectRef, rowId: string, projection: Record<string, string>) => {
                const response = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate", headers,
                    payload: { pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id, collectionId,
                        writerContext: { schemaVersion: writerContext.schemaVersion, contractDigest: writerContext.contractDigest },
                        operations: [{ kind: "put", rowId, expectedRevision: "absent", expectedAbsenceEpoch: 0,
                            content: { t: "plain", v: {} }, projection }] } });
                expect(response.statusCode).toBe(200);
            };
            await put("projects", projectRef, "project-a", { id: "project-a", title: "Project A" });
            await put("tasks", taskRef, "task-a", { id: "task-a", title: "Task A", "project-id": "project-a" });
            const dependent = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId, collectionId: "tasks", rowId: "task-a" } });
            await db.pluginCollectionAccountGrant.create({ data: { rowDbId: dependent.id, accountId: recipient,
                accessLevel: "view", createdByAccountId: accountId } });
            const removed = await app.inject({ method: "POST", url: "/v1/plugins/data/mutate", headers,
                payload: { pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id, collectionId: "projects",
                    writerContext: { schemaVersion: projectRef.schemaVersion, contractDigest: projectRef.contractDigest },
                    operations: [{ kind: "delete", rowId: "project-a", expectedRevision: 1 }] } });
            expect(removed.statusCode).toBe(200);
            const wake = await db.accountChange.findFirst({ where: { accountId: recipient, kind: "pluginDomain" }, select: { hint: true } });
            expect(wake?.hint).toEqual({ pluginDomain: "dataCollection", pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id,
                collectionId: "tasks", contractDigest: taskRef.contractDigest, revision: 2, rowIds: ["task-a"] });
            const refreshed = await app.inject({ method: "POST", url: "/v1/plugins/data/sharing/get",
                headers: { ...V3_HEADERS, "x-test-user-id": recipient }, payload: { ownerAccountId: accountId,
                    pluginId: NULLIFY_RELATION_COLLECTION_MANIFEST.id, collectionId: "tasks", rowId: "task-a", readerContext: taskRef } });
            expect(refreshed.statusCode).toBe(200);
            expect(refreshed.json().row).toMatchObject({ revision: 2, projection: { "project-id": null } });
        });
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
