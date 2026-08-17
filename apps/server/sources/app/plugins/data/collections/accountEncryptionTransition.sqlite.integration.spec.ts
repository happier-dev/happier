import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sealPluginCollectionPrivatePayloadV1 } from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { materializePluginCollectionContractsFromManifestTx } from "@/app/plugins/data/collections/contracts";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import {
    applyPluginCollectionAccountEncryptionTransitionInTx,
    inspectPluginCollectionAccountEncryptionTransitionInTx,
    validatePluginCollectionAccountEncryptionTransitionStageInTx,
} from "./accountEncryptionTransition";

const ACCOUNT_ID = "collection-transition-account";
/** Whatever a plaintext Account's unkeyed derivation produced for this row. */
const PLAIN_MODE_LINK_TAG = "plain-mode-link-tag";
const PLAIN_MODE_ENTRY_TAG = "plain-mode-entry-tag";
const PLUGIN_ID = "example.transition";
const COLLECTION_ID = "tasks";

const MANIFEST = {
    schemaVersion: 2,
    id: PLUGIN_ID,
    version: "1.0.0",
    displayName: "Collection transition fixture",
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
                    status: { type: "string", enum: ["open", "closed"] },
                },
                required: ["id", "status"],
                additionalProperties: false,
            },
            serverReadable: ["status"],
            indexes: [{
                id: "by-status",
                fields: [{ field: "status", direction: "asc" }],
            }],
        }],
    },
} as const;

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Fixture JSON must be serializable.");
    return JSON.parse(encoded) as Prisma.InputJsonValue;
}

/**
 * One Prisma client exists per test process, so the whole file shares a single
 * harness. A per-`describe` harness throws "Database client is already
 * initialized." in the second block, which silently skips every test it owns.
 */
let harness: LightSqliteHarness;

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-collection-transition-",
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
        () => db.accountChange.deleteMany(),
        () => db.pluginCollectionIndexEntry.deleteMany(),
        () => db.pluginCollectionProjection.deleteMany(),
        () => db.pluginCollectionRelation.deleteMany(),
        () => db.pluginCollectionRow.deleteMany(),
        () => db.pluginCollectionIndexState.deleteMany(),
        () => db.pluginCollectionContract.deleteMany(),
        () => db.account.deleteMany(),
    ]);
});

describe("Collection Account-encryption transition inventory", () => {
    it("censuses and applies only live rows while retaining a content-free tombstone unchanged", async () => {
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                encryptionMode: "plain",
                publicKey: null,
                seq: 0,
            },
        });
        const [ref] = await inTx(async (tx) => (
            await materializePluginCollectionContractsFromManifestTx({
                tx,
                manifest: MANIFEST,
            })
        ));
        if (!ref) throw new Error("Expected fixture Collection contract.");
        const contract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
            },
        });
        const tombstone = await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "a-historical",
                schemaVersion: contract.schemaVersion,
                revision: 9,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: getActivePrismaRuntime().JsonNull,
                deletedAt: new Date("2026-08-12T08:00:00.000Z"),
            },
        });
        const live = await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "z-live",
                schemaVersion: contract.schemaVersion,
                revision: 4,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson({
                    t: "plain",
                    v: {},
                }),
            },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: live.id,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: live.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: 4,
            },
        });
        const indexState = await db.pluginCollectionIndexState.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                indexId: "by-status",
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                buildState: "ready",
                indexedThroughRevision: 4,
            },
        });
        const indexEntry = await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: indexState.id,
                encodedSortKey: new Uint8Array([1, 2, 3]),
                rowId: live.rowId,
                rowRevision: 4,
            },
        });

        await expect(inTx(async (tx) => (
            await inspectPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId: ACCOUNT_ID,
                sourceMode: "plain",
            })
        ))).resolves.toEqual({
            status: "complete",
            items: [{
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "z-live",
                revision: 4,
                sourceEnvelope: { t: "plain", v: {} },
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            }],
            rowCount: 1,
            sourceContentBytes: BigInt(
                new TextEncoder().encode(JSON.stringify({
                    t: "plain",
                    v: {},
                })).byteLength,
            ),
        });

        const targetEnvelope = {
            t: "encrypted" as const,
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(9),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(7),
            }),
        };
        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId: ACCOUNT_ID,
                fromMode: "plain",
                toMode: "e2ee",
                limits: {
                    participantLimit: 1,
                    encodedByteLimit: 1024n * 1024n,
                },
                directive: {
                    action: "migrate",
                    items: [{
                        pluginId: PLUGIN_ID,
                        collectionId: COLLECTION_ID,
                        rowId: live.rowId,
                        expectedRevision: 4,
                        sourceEnvelope: { t: "plain", v: {} },
                        targetEnvelope,
                        schemaVersion: contract.schemaVersion,
                        contractDigest: contract.contractDigest,
                    }],
                },
            })
        ))).resolves.toEqual({ status: "applied" });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: live.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({ revision: 5, contentEnvelope: targetEnvelope });
        await expect(db.pluginCollectionProjection.findFirstOrThrow({
            where: { rowDbId: live.id },
            select: { rowRevision: true },
        })).resolves.toEqual({ rowRevision: 5 });
        await expect(db.pluginCollectionIndexEntry.findUniqueOrThrow({
            where: { id: indexEntry.id },
            select: { rowRevision: true },
        })).resolves.toEqual({ rowRevision: 5 });
        await expect(db.pluginCollectionIndexState.findUniqueOrThrow({
            where: { id: indexState.id },
            select: { indexedThroughRevision: true },
        })).resolves.toEqual({ indexedThroughRevision: 5 });
        await expect(db.accountChange.findFirstOrThrow({
            where: { accountId: ACCOUNT_ID },
            select: { hint: true },
        })).resolves.toEqual({
            hint: {
                pluginDomain: "dataCollection",
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                contractDigest: contract.contractDigest,
                revision: 5,
                full: true,
            },
        });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: tombstone.id },
            select: { id: true, revision: true, deletedAt: true, contentEnvelope: true },
        })).resolves.toEqual({
            id: tombstone.id,
            revision: 9,
            deletedAt: new Date("2026-08-12T08:00:00.000Z"),
            contentEnvelope: null,
        });
    });
});

const IDENTITY_PLUGIN_ID = "example.identity-transition";
const IDENTITY_COLLECTION_ID = "links";

/**
 * A Collection whose row address and one indexed value are mode-derived
 * identity tags. Neither can be recomputed by the platform across a mode
 * transition, so the transition owner must refuse instead of leaving the rows
 * at addresses no client can derive again.
 */
const IDENTITY_MANIFEST = {
    schemaVersion: 2,
    id: IDENTITY_PLUGIN_ID,
    version: "1.0.0",
    displayName: "Mode-derived identity fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: IDENTITY_COLLECTION_ID,
            schemaVersion: 1,
            schema: {
                type: "object",
                properties: {
                    linkTag: { type: "string", maxLength: 256 },
                    entryTag: { type: "string", maxLength: 256 },
                    sessionId: { type: "string", maxLength: 256 },
                },
                required: ["linkTag", "entryTag", "sessionId"],
                additionalProperties: false,
            },
            rowIdField: "linkTag",
            serverReadable: ["entryTag", "sessionId"],
            indexes: [{
                id: "by-entry",
                fields: [{ field: "entryTag", direction: "asc" }],
            }],
            // A host relation, exactly as the real mode-derived Collection
            // carries one: the refusal must leave it at the old identity too.
            relations: [{
                id: "session",
                kind: "host",
                field: "sessionId",
                hostKind: "session",
            }],
            identityFields: ["entryTag", "linkTag"],
        }],
    },
} as const;

describe("Collection Account-encryption transition with mode-derived identity", () => {
    async function seedIdentityRow(): Promise<Readonly<{
        rowDbId: string;
        rowId: string;
        projectionId: string;
        indexEntryId: string;
        indexStateId: string;
        relationId: string;
    }>> {
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                encryptionMode: "plain",
                publicKey: null,
                seq: 0,
            },
        });
        const [ref] = await inTx(async (tx) => (
            await materializePluginCollectionContractsFromManifestTx({
                tx,
                manifest: IDENTITY_MANIFEST,
            })
        ));
        if (!ref) throw new Error("Expected fixture Collection contract.");
        const contract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                schemaVersion: ref.schemaVersion,
                contractDigest: ref.contractDigest,
            },
        });
        const live = await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: IDENTITY_PLUGIN_ID,
                collectionId: IDENTITY_COLLECTION_ID,
                rowId: PLAIN_MODE_LINK_TAG,
                schemaVersion: contract.schemaVersion,
                revision: 3,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson({ t: "plain", v: {} }),
            },
        });
        const projection = await db.pluginCollectionProjection.create({
            data: {
                rowDbId: live.id,
                accountId: ACCOUNT_ID,
                pluginId: IDENTITY_PLUGIN_ID,
                collectionId: IDENTITY_COLLECTION_ID,
                rowId: live.rowId,
                fieldId: "entryTag",
                typedEncodedValue: JSON.stringify(PLAIN_MODE_ENTRY_TAG),
                rowRevision: 3,
            },
        });
        const indexState = await db.pluginCollectionIndexState.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: IDENTITY_PLUGIN_ID,
                collectionId: IDENTITY_COLLECTION_ID,
                indexId: "by-entry",
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                buildState: "ready",
                indexedThroughRevision: 3,
            },
        });
        const indexEntry = await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: indexState.id,
                encodedSortKey: new Uint8Array([4, 5, 6]),
                rowId: live.rowId,
                rowRevision: 3,
            },
        });
        const relation = await db.pluginCollectionRelation.create({
            data: {
                accountId: ACCOUNT_ID,
                sourceRowDbId: live.id,
                sourcePluginId: IDENTITY_PLUGIN_ID,
                sourceCollectionId: IDENTITY_COLLECTION_ID,
                sourceRowId: live.rowId,
                relationId: "session",
                targetKind: "session",
                targetRowId: "session-1",
                sourceRevision: 3,
            },
        });
        return {
            rowDbId: live.id,
            rowId: live.rowId,
            projectionId: projection.id,
            indexEntryId: indexEntry.id,
            indexStateId: indexState.id,
            relationId: relation.id,
        };
    }

    it("refuses to activate a mode transition it cannot relocate, leaving every row, projection and index entry untouched", async () => {
        const seeded = await seedIdentityRow();
        const targetEnvelope = {
            t: "encrypted" as const,
            c: sealPluginCollectionPrivatePayloadV1({
                material: { type: "dataKey", machineKey: new Uint8Array(32).fill(3) },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(5),
            }),
        };
        const row = await db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: seeded.rowDbId },
            select: { schemaVersion: true, contractDigest: true },
        });

        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId: ACCOUNT_ID,
                fromMode: "plain",
                toMode: "e2ee",
                limits: { participantLimit: 8, encodedByteLimit: 1024n * 1024n },
                directive: {
                    action: "migrate",
                    items: [{
                        pluginId: IDENTITY_PLUGIN_ID,
                        collectionId: IDENTITY_COLLECTION_ID,
                        rowId: seeded.rowId,
                        expectedRevision: 3,
                        sourceEnvelope: { t: "plain", v: {} },
                        targetEnvelope,
                        schemaVersion: row.schemaVersion,
                        contractDigest: row.contractDigest,
                    }],
                },
            })
        ))).resolves.toEqual({ status: "identity_relocation_unsupported" });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: seeded.rowDbId },
            select: { rowId: true, revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            rowId: PLAIN_MODE_LINK_TAG,
            revision: 3,
            contentEnvelope: { t: "plain", v: {} },
        });
        await expect(db.pluginCollectionProjection.findUniqueOrThrow({
            where: { id: seeded.projectionId },
            select: { rowId: true, typedEncodedValue: true, rowRevision: true },
        })).resolves.toEqual({
            rowId: PLAIN_MODE_LINK_TAG,
            typedEncodedValue: JSON.stringify(PLAIN_MODE_ENTRY_TAG),
            rowRevision: 3,
        });
        await expect(db.pluginCollectionIndexEntry.findUniqueOrThrow({
            where: { id: seeded.indexEntryId },
            select: { rowId: true, rowRevision: true },
        })).resolves.toEqual({ rowId: PLAIN_MODE_LINK_TAG, rowRevision: 3 });
        await expect(db.pluginCollectionIndexState.findUniqueOrThrow({
            where: { id: seeded.indexStateId },
            select: { indexedThroughRevision: true },
        })).resolves.toEqual({ indexedThroughRevision: 3 });
        await expect(db.pluginCollectionRelation.findUniqueOrThrow({
            where: { id: seeded.relationId },
            select: { sourceRowId: true, sourceRevision: true, deletedAt: true },
        })).resolves.toEqual({
            sourceRowId: PLAIN_MODE_LINK_TAG,
            sourceRevision: 3,
            deletedAt: null,
        });
        await expect(db.accountChange.count({ where: { accountId: ACCOUNT_ID } }))
            .resolves.toBe(0);
    });

    it("refuses the emptiness assertion and the stage validation for the same live rows", async () => {
        const seeded = await seedIdentityRow();
        const row = await db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: seeded.rowDbId },
            select: { schemaVersion: true, contractDigest: true },
        });
        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId: ACCOUNT_ID,
                fromMode: "plain",
                toMode: "e2ee",
                limits: { participantLimit: 8, encodedByteLimit: 1024n * 1024n },
                directive: { action: "assert_empty" },
            })
        ))).resolves.toEqual({ status: "identity_relocation_unsupported" });
        await expect(inTx(async (tx) => (
            await validatePluginCollectionAccountEncryptionTransitionStageInTx({
                tx,
                accountId: ACCOUNT_ID,
                fromMode: "plain",
                toMode: "e2ee",
                limits: { participantLimit: 8, encodedByteLimit: 1024n * 1024n },
                items: [{
                    pluginId: IDENTITY_PLUGIN_ID,
                    collectionId: IDENTITY_COLLECTION_ID,
                    rowId: seeded.rowId,
                    expectedRevision: 3,
                    sourceEnvelope: { t: "plain", v: {} },
                    targetEnvelope: { t: "plain", v: {} },
                    schemaVersion: row.schemaVersion,
                    contractDigest: row.contractDigest,
                }],
            })
        ))).resolves.toEqual({ status: "identity_relocation_unsupported" });
        await expect(inTx(async (tx) => (
            await inspectPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId: ACCOUNT_ID,
                sourceMode: "plain",
            })
        ))).resolves.toEqual({
            status: "identity_relocation_unsupported",
            row: {
                pluginId: IDENTITY_PLUGIN_ID,
                collectionId: IDENTITY_COLLECTION_ID,
                rowId: PLAIN_MODE_LINK_TAG,
            },
        });
    });

    it("still transitions a tombstoned mode-derived row, which holds no recomputable address", async () => {
        const seeded = await seedIdentityRow();
        await db.pluginCollectionIndexEntry.delete({ where: { id: seeded.indexEntryId } });
        await db.pluginCollectionProjection.delete({ where: { id: seeded.projectionId } });
        await db.pluginCollectionRow.update({
            where: { id: seeded.rowDbId },
            data: {
                deletedAt: new Date("2026-08-16T00:00:00.000Z"),
                contentEnvelope: getActivePrismaRuntime().JsonNull,
            },
        });
        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId: ACCOUNT_ID,
                fromMode: "plain",
                toMode: "e2ee",
                limits: { participantLimit: 8, encodedByteLimit: 1024n * 1024n },
                directive: { action: "assert_empty" },
            })
        ))).resolves.toEqual({ status: "applied" });
    });
});
