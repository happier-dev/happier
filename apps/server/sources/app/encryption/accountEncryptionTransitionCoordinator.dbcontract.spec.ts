import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    sealPluginCollectionPrivatePayloadV1,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { materializePluginCollectionContractsFromManifestTx } from "@/app/plugins/data/collections/contracts";
import {
    applyPluginCollectionAccountEncryptionTransitionInTx,
} from "@/app/plugins/data/collections/accountEncryptionTransition";
import { erasePluginAccountData } from "@/app/plugins/data/accountDataErase";
import {
    buildPluginAccountStoragePhysicalKey,
    buildPluginDeclarativeSettingsPhysicalKey,
} from "@/app/kv/accountScopedKv";
import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    deriveAccountEncryptionMigrationKeyFingerprints,
} from "./accountEncryptionTransition";

import {
    activateAccountEncryptionTransitionCoordinatorInTx,
    authorizeAccountEncryptionTransitionCoordinatorInTx,
    cleanupExpiredAccountEncryptionTransitionsInTx,
    finalizeAccountEncryptionTransitionCoordinatorInTx,
    inventoryAccountEncryptionTransitionCoordinatorInTx,
    prepareAccountEncryptionTransitionCoordinatorInTx,
    stageAccountEncryptionTransitionCollectionsCoordinatorInTx,
    ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE,
} from "./accountEncryptionTransitionCoordinator";

type ContractProvider = "postgres" | "mysql";

const createdAccountIds = new Set<string>();
const createdPluginIds = new Set<string>();

function resolveContractProvider(): ContractProvider {
    const raw = String(
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres",
    ).trim().toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported Account transition contract provider: ${raw}`);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TypeError("Fixture JSON must be serializable.");
    }
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function uniquePluginId(): string {
    const pluginId = `example.transition-native-${randomUUID().split("-").join("")}`;
    createdPluginIds.add(pluginId);
    return pluginId;
}

function collectionManifest(pluginId: string) {
    return {
        schemaVersion: 2,
        id: pluginId,
        version: "1.0.0",
        displayName: "Account transition native contract fixture",
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
}

async function createCollectionContract(pluginId: string) {
    const manifest = collectionManifest(pluginId);
    const [ref] = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest,
        })
    ));
    if (!ref) throw new Error("Expected native Collection contract.");
    return await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
        select: {
            id: true,
            pluginId: true,
            collectionId: true,
            schemaVersion: true,
            contractDigest: true,
        },
    });
}

async function cleanupFixtures(): Promise<void> {
    const accountIds = [...createdAccountIds];
    createdAccountIds.clear();
    if (accountIds.length > 0) {
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    const pluginIds = [...createdPluginIds];
    createdPluginIds.clear();
    if (pluginIds.length > 0) {
        await db.pluginCollectionContract.deleteMany({
            where: { pluginId: { in: pluginIds } },
        });
    }
}

async function declareIsolatedFixtureCapacity(
    transitionId: string,
    capacity?: Readonly<{
        participantLimit: number;
        encodedByteLimit: bigint;
        reservedCapacityBytes: bigint;
    }>,
): Promise<void> {
    // Native-provider contract fixture only. It OVERWRITES the measured
    // capacity `prepare` stamps, shrinking it so a small fixture can reach the
    // fence; it is not the production aggregate policy.
    await db.accountEncryptionTransition.update({
        where: { id: transitionId },
        data: {
            measuredParticipantLimit: capacity?.participantLimit ?? 1_024,
            measuredEncodedByteLimit:
                capacity?.encodedByteLimit ?? 16n * 1024n * 1024n,
            reservedCapacityBytes:
                capacity?.reservedCapacityBytes ?? 32n * 1024n * 1024n,
        },
    });
}

async function prepareAuthorizedPlainTransition(params: Readonly<{
    accountId: string;
    expectedSigningKeyFingerprint: string | null;
    expectedContentKeyFingerprint: string | null;
    now?: Date;
}>): Promise<string> {
    const prepared = await inTx(async (tx) => (
        await prepareAccountEncryptionTransitionCoordinatorInTx({
            tx,
            accountId: params.accountId,
            request: {
                toMode: "plain",
                expectedAccountVersion: 0,
                expectedSigningKeyFingerprint:
                    params.expectedSigningKeyFingerprint,
                expectedContentKeyFingerprint:
                    params.expectedContentKeyFingerprint,
            },
            ...(params.now ? { now: params.now } : {}),
        })
    ));
    if (prepared.status !== "prepared") {
        throw new Error(`Expected prepared V5 transition, got ${prepared.status}`);
    }
    await declareIsolatedFixtureCapacity(prepared.transition.transitionId);
    await expect(inTx(async (tx) => (
        await authorizeAccountEncryptionTransitionCoordinatorInTx({
            tx,
            accountId: params.accountId,
            transitionId: prepared.transition.transitionId,
            authorization: { kind: "present_user_confirmation" },
            ...(params.now ? { now: params.now } : {}),
        })
    ))).resolves.toEqual({ status: "authorized" });
    const inventory = await inTx(async (tx) => (
        await inventoryAccountEncryptionTransitionCoordinatorInTx({
            tx,
            accountId: params.accountId,
            transitionId: prepared.transition.transitionId,
            ...(params.now ? { now: params.now } : {}),
        })
    ));
    if (inventory.status !== "ready") {
        throw new Error(`Expected ready V5 inventory, got ${inventory.status}`);
    }
    await expect(inTx(async (tx) => (
        await stageAccountEncryptionTransitionCollectionsCoordinatorInTx({
            tx,
            accountId: params.accountId,
            transitionId: prepared.transition.transitionId,
            items: inventory.items.map((item) => ({
                pluginId: item.pluginId,
                collectionId: item.collectionId,
                rowId: item.rowId,
                expectedRevision: item.revision,
                sourceEnvelope: item.sourceEnvelope,
                targetEnvelope: { t: "plain", v: {} },
                schemaVersion: item.schemaVersion,
                contractDigest: item.contractDigest,
            })),
            ...(params.now ? { now: params.now } : {}),
        })
    ))).resolves.toMatchObject({
        status: "staged",
        stagedParticipantCount: inventory.items.length,
    });
    return prepared.transition.transitionId;
}

describe("Account encryption transition Collection native database contract", () => {
    const provider = resolveContractProvider();
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL for DB contract test.");
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        await cleanupFixtures();
    });

    afterAll(async () => {
        await cleanupFixtures();
        if (dbConnected) {
            await db.$disconnect();
        }
    });

    it(`keeps V4 Account activation empty-only on ${provider} without mutating a live Collection row`, async () => {
        const accountId = `account-transition-live-${randomUUID()}`;
        createdAccountIds.add(accountId);
        const pluginId = uniquePluginId();
        await db.account.create({
            data: {
                id: accountId,
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract(pluginId);
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                schemaVersion: contract.schemaVersion,
                revision: 4,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson({
                    t: "encrypted",
                    c: sealPluginCollectionPrivatePayloadV1({
                        material: {
                            type: "dataKey",
                            machineKey: new Uint8Array(32).fill(7),
                        },
                        payload: {},
                        randomBytes: (length) => new Uint8Array(length).fill(3),
                    }),
                }),
            },
            select: { id: true },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: 4,
            },
        });

        await expect(inTx(async (tx) => (
            await finalizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                fromMode: "e2ee",
                toMode: "plain",
                contentKey: { kind: "preserve" },
                accountChangeHint: { source: "native-contract" },
            })
        ))).resolves.toEqual({ status: "collections_migration_incomplete" });

        await expect(db.account.findUniqueOrThrow({
            where: { id: accountId },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", seq: 0 });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: row.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 4,
            contentEnvelope: expect.objectContaining({ t: "encrypted" }),
        });
        await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(0);
    });

    it(`allows only a content-free tombstone through V4 activation on ${provider}`, async () => {
        const accountId = `account-transition-tombstone-${randomUUID()}`;
        createdAccountIds.add(accountId);
        const pluginId = uniquePluginId();
        await db.account.create({
            data: {
                id: accountId,
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract(pluginId);
        const deletedAt = new Date("2026-08-12T12:00:00.000Z");
        const tombstone = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "historical-row",
                schemaVersion: contract.schemaVersion,
                revision: 9,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: getActivePrismaRuntime().JsonNull,
                deletedAt,
            },
            select: { id: true },
        });

        await expect(inTx(async (tx) => (
            await finalizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                fromMode: "e2ee",
                toMode: "plain",
                contentKey: { kind: "preserve" },
                accountChangeHint: { source: "native-contract" },
            })
        ))).resolves.toMatchObject({
            status: "applied",
            mode: "plain",
            cursor: 1,
            version: 1,
        });

        await expect(db.account.findUniqueOrThrow({
            where: { id: accountId },
            select: { encryptionMode: true, seq: true },
        })).resolves.toEqual({ encryptionMode: "plain", seq: 1 });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: tombstone.id },
            select: { id: true, revision: true, deletedAt: true, contentEnvelope: true },
        })).resolves.toEqual({
            id: tombstone.id,
            revision: 9,
            deletedAt,
            contentEnvelope: null,
        });
        await expect(db.accountChange.findMany({
            where: { accountId },
            select: { cursor: true, kind: true, entityId: true, hint: true },
        })).resolves.toEqual([{
            cursor: 1,
            kind: "account",
            entityId: "self",
            hint: { source: "native-contract" },
        }]);
    });

    it(`fails closed on a stale Collection directive, then applies the exact live row once with every dependent witness on ${provider}`, async () => {
        const accountId = `account-transition-adapter-${randomUUID()}`;
        createdAccountIds.add(accountId);
        const pluginId = uniquePluginId();
        await db.account.create({
            data: {
                id: accountId,
                encryptionMode: "plain",
            },
        });
        const contract = await createCollectionContract(pluginId);
        const sourceEnvelope = { t: "plain" as const, v: {} };
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                schemaVersion: contract.schemaVersion,
                revision: 4,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson(sourceEnvelope),
            },
            select: { id: true },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: 4,
            },
        });
        const indexState = await db.pluginCollectionIndexState.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                indexId: "by-status",
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                buildState: "ready",
                indexedThroughRevision: 4,
            },
            select: { id: true },
        });
        await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: indexState.id,
                encodedSortKey: new Uint8Array([1, 2, 3]),
                rowId: "live-row",
                rowRevision: 4,
            },
        });
        await db.pluginCollectionRelation.create({
            data: {
                accountId,
                sourceRowDbId: row.id,
                sourcePluginId: pluginId,
                sourceCollectionId: contract.collectionId,
                sourceRowId: "live-row",
                relationId: "blocks",
                targetKind: "collection",
                targetPluginId: pluginId,
                targetCollectionId: contract.collectionId,
                targetRowId: "target-row",
                sourceRevision: 4,
            },
        });
        const targetEnvelope = {
            t: "encrypted" as const,
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(9),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(5),
            }),
        };
        const directive = {
            action: "migrate" as const,
            items: [{
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                expectedRevision: 4,
                sourceEnvelope,
                targetEnvelope,
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
            }],
        };

        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId,
                fromMode: "plain",
                toMode: "e2ee",
                limits: {
                    participantLimit: 1,
                    encodedByteLimit: 1024n * 1024n,
                },
                directive: {
                    ...directive,
                    items: [{ ...directive.items[0]!, expectedRevision: 3 }],
                },
            })
        ))).resolves.toEqual({ status: "migration_incomplete" });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: row.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({ revision: 4, contentEnvelope: sourceEnvelope });
        await expect(Promise.all([
            db.pluginCollectionProjection.findMany({
                where: { rowDbId: row.id },
                select: { rowRevision: true },
            }),
            db.pluginCollectionRelation.findMany({
                where: { sourceRowDbId: row.id },
                select: { sourceRevision: true },
            }),
            db.pluginCollectionIndexState.findMany({
                where: { id: indexState.id },
                select: { indexedThroughRevision: true },
            }),
            db.pluginCollectionIndexEntry.findMany({
                where: { indexStateId: indexState.id },
                select: { rowRevision: true },
            }),
        ])).resolves.toEqual([
            [{ rowRevision: 4 }],
            [{ sourceRevision: 4 }],
            [{ indexedThroughRevision: 4 }],
            [{ rowRevision: 4 }],
        ]);
        await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(0);

        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId,
                fromMode: "plain",
                toMode: "e2ee",
                limits: {
                    participantLimit: 1,
                    encodedByteLimit: 1024n * 1024n,
                },
                directive: {
                    ...directive,
                    items: [{
                        ...directive.items[0]!,
                        sourceEnvelope: { t: "plain", v: { stale: true } },
                    }],
                },
            })
        ))).resolves.toEqual({ status: "migration_incomplete" });
        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId,
                fromMode: "e2ee",
                toMode: "plain",
                limits: {
                    participantLimit: 1,
                    encodedByteLimit: 1024n * 1024n,
                },
                directive,
            })
        ))).resolves.toEqual({ status: "invalid_content" });

        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId,
                fromMode: "plain",
                toMode: "e2ee",
                limits: {
                    participantLimit: 1,
                    encodedByteLimit: 1024n * 1024n,
                },
                directive,
            })
        ))).resolves.toEqual({ status: "applied" });

        await expect(Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { seq: true },
            }),
            db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: row.id },
                select: { revision: true, contentEnvelope: true },
            }),
            db.pluginCollectionProjection.findMany({
                where: { rowDbId: row.id },
                select: { rowRevision: true },
            }),
            db.pluginCollectionRelation.findMany({
                where: { sourceRowDbId: row.id },
                select: { sourceRevision: true },
            }),
            db.pluginCollectionIndexState.findMany({
                where: { id: indexState.id },
                select: { indexedThroughRevision: true },
            }),
            db.pluginCollectionIndexEntry.findMany({
                where: { indexStateId: indexState.id },
                select: { rowRevision: true },
            }),
            db.accountChange.findMany({
                where: { accountId },
                select: { cursor: true, kind: true, hint: true },
            }),
        ])).resolves.toEqual([
            { seq: 1 },
            { revision: 5, contentEnvelope: targetEnvelope },
            [{ rowRevision: 5 }],
            [{ sourceRevision: 5 }],
            [{ indexedThroughRevision: 5 }],
            [{ rowRevision: 5 }],
            [{
                cursor: 1,
                kind: "pluginDomain",
                hint: expect.objectContaining({
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: contract.collectionId,
                    revision: 5,
                }),
            }],
        ]);

        await expect(inTx(async (tx) => (
            await applyPluginCollectionAccountEncryptionTransitionInTx({
                tx,
                accountId,
                fromMode: "plain",
                toMode: "e2ee",
                limits: {
                    participantLimit: 1,
                    encodedByteLimit: 1024n * 1024n,
                },
                directive,
            })
        ))).resolves.toEqual({ status: "invalid_content" });
        await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(1);
    });

    it(`activates a bounded V5 stage atomically with every Collection witness and preserves a content-free tombstone on ${provider}`, async () => {
        const accountId = `account-transition-v5-activate-${randomUUID()}`;
        createdAccountIds.add(accountId);
        const pluginId = uniquePluginId();
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: accountId,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract(pluginId);
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                schemaVersion: contract.schemaVersion,
                revision: 4,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson({
                    t: "encrypted",
                    c: sealPluginCollectionPrivatePayloadV1({
                        material: {
                            type: "dataKey",
                            machineKey: new Uint8Array(32).fill(23),
                        },
                        payload: {},
                        randomBytes: (length) => new Uint8Array(length).fill(29),
                    }),
                }),
            },
            select: { id: true },
        });
        const deletedAt = new Date("2026-08-12T16:00:00.000Z");
        const tombstone = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "historical-row",
                schemaVersion: contract.schemaVersion,
                revision: 9,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: getActivePrismaRuntime().JsonNull,
                deletedAt,
            },
            select: { id: true },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: 4,
            },
        });
        const indexState = await db.pluginCollectionIndexState.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                indexId: "by-status",
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                buildState: "ready",
                indexedThroughRevision: 4,
            },
            select: { id: true },
        });
        await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: indexState.id,
                encodedSortKey: new Uint8Array([1, 2, 3]),
                rowId: "live-row",
                rowRevision: 4,
            },
        });
        await db.pluginCollectionRelation.create({
            data: {
                accountId,
                sourceRowDbId: row.id,
                sourcePluginId: pluginId,
                sourceCollectionId: contract.collectionId,
                sourceRowId: "live-row",
                relationId: "blocks",
                targetKind: "collection",
                targetPluginId: pluginId,
                targetCollectionId: contract.collectionId,
                targetRowId: "target-row",
                sourceRevision: 4,
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const transitionId = await prepareAuthorizedPlainTransition({
            accountId,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
        });

        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                transitionId,
            })
        ))).resolves.toMatchObject({
            status: "activated",
            mode: "plain",
            cursor: 2,
            version: 2,
        });

        await expect(Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { encryptionMode: true, seq: true },
            }),
            db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: row.id },
                select: { revision: true, contentEnvelope: true },
            }),
            db.pluginCollectionProjection.findMany({
                where: { rowDbId: row.id },
                select: { rowRevision: true },
            }),
            db.pluginCollectionRelation.findMany({
                where: { sourceRowDbId: row.id },
                select: { sourceRevision: true },
            }),
            db.pluginCollectionIndexState.findMany({
                where: { id: indexState.id },
                select: { indexedThroughRevision: true },
            }),
            db.pluginCollectionIndexEntry.findMany({
                where: { indexStateId: indexState.id },
                select: { rowRevision: true },
            }),
            db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: tombstone.id },
                select: { revision: true, deletedAt: true, contentEnvelope: true },
            }),
            db.accountEncryptionTransition.findUniqueOrThrow({
                where: { id: transitionId },
                select: { status: true, activeAccountId: true },
            }),
            db.accountEncryptionTransitionCollectionStage.count({
                where: { transitionId },
            }),
            db.accountChange.findMany({
                where: { accountId },
                orderBy: { cursor: "asc" },
                select: { cursor: true, kind: true, entityId: true, hint: true },
            }),
        ])).resolves.toEqual([
            { encryptionMode: "plain", seq: 2 },
            { revision: 5, contentEnvelope: { t: "plain", v: {} } },
            [{ rowRevision: 5 }],
            [{ sourceRevision: 5 }],
            [{ indexedThroughRevision: 5 }],
            [{ rowRevision: 5 }],
            { revision: 9, deletedAt, contentEnvelope: null },
            { status: "activated", activeAccountId: null },
            0,
            [
                {
                    cursor: 1,
                    kind: "pluginDomain",
                    entityId: expect.any(String),
                    hint: expect.objectContaining({
                        pluginDomain: "dataCollection",
                        pluginId,
                        collectionId: contract.collectionId,
                        revision: 5,
                    }),
                },
                {
                    cursor: 2,
                    kind: "account",
                    entityId: "self",
                    hint: { accountEncryptionTransitionId: transitionId },
                },
            ],
        ]);
    });

    it(`migrates every retained Collection contract version and preserves one full durable change on ${provider}`, async () => {
        const accountId = `account-transition-v5-mixed-contract-${randomUUID()}`;
        createdAccountIds.add(accountId);
        const pluginId = uniquePluginId();
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: { id: accountId, ...binding, encryptionMode: "e2ee" },
        });
        const manifestForSchema = (schemaVersion: number) => ({
            schemaVersion: 2,
            id: pluginId,
            version: `${schemaVersion}.0.0`,
            displayName: "Account transition mixed-contract fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            contributes: {
                accountCollections: [{
                    id: "tasks",
                    schemaVersion,
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
                    indexes: [],
                }],
            },
        });
        const refs = await inTx(async (tx) => {
            const first = await materializePluginCollectionContractsFromManifestTx({
                tx,
                manifest: manifestForSchema(1),
            });
            const second = await materializePluginCollectionContractsFromManifestTx({
                tx,
                manifest: manifestForSchema(2),
            });
            return [first[0], second[0]] as const;
        });
        const [firstRef, secondRef] = refs;
        if (!firstRef || !secondRef) {
            throw new Error("Expected both retained Collection contracts.");
        }
        const contracts = await Promise.all([firstRef, secondRef].map(async (ref) => (
            await db.pluginCollectionContract.findFirstOrThrow({
                where: {
                    pluginId: ref.pluginId,
                    collectionId: ref.collectionId,
                    schemaVersion: ref.schemaVersion,
                    contractDigest: ref.contractDigest,
                },
                select: {
                    id: true,
                    collectionId: true,
                    schemaVersion: true,
                    contractDigest: true,
                },
            })
        )));
        const sourceEnvelope = toPrismaJson({
            t: "encrypted",
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(71),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(73),
            }),
        });
        const rows = await Promise.all(contracts.map(async (contract, index) => (
            await db.pluginCollectionRow.create({
                data: {
                    accountId,
                    pluginId,
                    collectionId: contract.collectionId,
                    rowId: `retained-contract-${index}`,
                    schemaVersion: contract.schemaVersion,
                    revision: 1,
                    contractId: contract.id,
                    contractDigest: contract.contractDigest,
                    contentEnvelope: sourceEnvelope,
                },
                select: { id: true, rowId: true },
            })
        )));
        await db.pluginCollectionProjection.createMany({
            data: rows.map((row) => ({
                rowDbId: row.id,
                accountId,
                pluginId,
                collectionId: "tasks",
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: 1,
            })),
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const transitionId = await prepareAuthorizedPlainTransition({
            accountId,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
        });

        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                transitionId,
            })
        ))).resolves.toMatchObject({
            status: "activated",
            mode: "plain",
            cursor: 2,
        });
        const expectedHintDigest = contracts[0]!.contractDigest > contracts[1]!.contractDigest
            ? contracts[0]!.contractDigest
            : contracts[1]!.contractDigest;
        await expect(Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { encryptionMode: true, seq: true },
            }),
            db.pluginCollectionRow.findMany({
                where: { id: { in: rows.map((row) => row.id) } },
                orderBy: { rowId: "asc" },
                select: { rowId: true, revision: true, contentEnvelope: true },
            }),
            db.accountChange.findMany({
                where: { accountId },
                orderBy: { cursor: "asc" },
                select: { cursor: true, kind: true, entityId: true, hint: true },
            }),
        ])).resolves.toEqual([
            { encryptionMode: "plain", seq: 2 },
            rows.map((row) => ({
                rowId: row.rowId,
                revision: 2,
                contentEnvelope: { t: "plain", v: {} },
            })),
            [
                {
                    cursor: 1,
                    kind: "pluginDomain",
                    entityId: `pluginDomain/${pluginId}/data-collection/tasks`,
                    hint: {
                        pluginDomain: "dataCollection",
                        pluginId,
                        collectionId: "tasks",
                        contractDigest: expectedHintDigest,
                        revision: 2,
                        full: true,
                    },
                },
                {
                    cursor: 2,
                    kind: "account",
                    entityId: "self",
                    hint: { accountEncryptionTransitionId: transitionId },
                },
            ],
        ]);
    });

    it(`abandons a V5 stage on a concurrent source revision and retries without overwriting the writer on ${provider}`, async () => {
        const accountId = `account-transition-v5-retry-${randomUUID()}`;
        createdAccountIds.add(accountId);
        const pluginId = uniquePluginId();
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: accountId,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract(pluginId);
        const sourceEnvelope = {
            t: "encrypted" as const,
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(31),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(37),
            }),
        };
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                schemaVersion: contract.schemaVersion,
                revision: 4,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson(sourceEnvelope),
            },
            select: { id: true },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: 4,
            },
        });
        const indexState = await db.pluginCollectionIndexState.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                indexId: "by-status",
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                buildState: "ready",
                indexedThroughRevision: 4,
            },
            select: { id: true },
        });
        await db.pluginCollectionIndexEntry.create({
            data: {
                indexStateId: indexState.id,
                encodedSortKey: new Uint8Array([1, 2, 3]),
                rowId: "live-row",
                rowRevision: 4,
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const firstTransitionId = await prepareAuthorizedPlainTransition({
            accountId,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
        });

        await db.pluginCollectionRow.update({
            where: { id: row.id },
            data: { revision: { increment: 1 } },
        });
        await db.pluginCollectionProjection.updateMany({
            where: { rowDbId: row.id },
            data: { rowRevision: 5 },
        });
        await db.pluginCollectionIndexState.update({
            where: { id: indexState.id },
            data: { indexedThroughRevision: 5 },
        });
        await db.pluginCollectionIndexEntry.updateMany({
            where: { indexStateId: indexState.id, rowId: "live-row" },
            data: { rowRevision: 5 },
        });
        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                transitionId: firstTransitionId,
            })
        ))).resolves.toEqual({ status: "migration_incomplete" });

        await expect(Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { encryptionMode: true, seq: true },
            }),
            db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: row.id },
                select: { revision: true, contentEnvelope: true },
            }),
            db.accountEncryptionTransition.findUniqueOrThrow({
                where: { id: firstTransitionId },
                select: { status: true, activeAccountId: true },
            }),
            db.accountEncryptionTransitionCollectionStage.count({
                where: { transitionId: firstTransitionId },
            }),
            db.accountChange.count({ where: { accountId } }),
        ])).resolves.toEqual([
            { encryptionMode: "e2ee", seq: 0 },
            { revision: 5, contentEnvelope: sourceEnvelope },
            { status: "cancelled", activeAccountId: null },
            0,
            0,
        ]);

        const retryTransitionId = await prepareAuthorizedPlainTransition({
            accountId,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
        });
        await expect(inTx(async (tx) => (
            await activateAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                transitionId: retryTransitionId,
            })
        ))).resolves.toMatchObject({
            status: "activated",
            mode: "plain",
            cursor: 2,
            version: 2,
        });
        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: row.id },
            select: { revision: true, contentEnvelope: true },
        })).resolves.toEqual({ revision: 6, contentEnvelope: { t: "plain", v: {} } });
    });

    it(`pages 501 native Collection sources and refuses targets below the measured aggregate capacity on ${provider}`, async () => {
        const accountId = `account-transition-v5-capacity-${randomUUID()}`;
        createdAccountIds.add(accountId);
        const pluginId = uniquePluginId();
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: accountId,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract(pluginId);
        const sourceEnvelope = toPrismaJson({
            t: "encrypted",
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(41),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(43),
            }),
        });
        await db.pluginCollectionRow.createMany({
            data: Array.from(
                {
                    length:
                        ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS
                        + 1,
                },
                (_, index) => ({
                    accountId,
                    pluginId,
                    collectionId: contract.collectionId,
                    rowId: `over-capacity-${index}`,
                    schemaVersion: contract.schemaVersion,
                    revision: 1,
                    contractId: contract.id,
                    contractDigest: contract.contractDigest,
                    contentEnvelope: sourceEnvelope,
                }),
            ),
        });
        const sourceRows = await db.pluginCollectionRow.findMany({
            where: { accountId, pluginId, collectionId: contract.collectionId },
            select: { id: true, rowId: true, revision: true },
        });
        await db.pluginCollectionProjection.createMany({
            data: sourceRows.map((row) => ({
                rowDbId: row.id,
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: row.revision,
            })),
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });

        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                },
            })
        ));
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared V5 transition, got ${prepared.status}`);
        }
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId: prepared.transition.transitionId },
        })).resolves.toBe(0);
        await declareIsolatedFixtureCapacity(prepared.transition.transitionId, {
            participantLimit: 1_024,
            encodedByteLimit: 16n * 1024n * 1024n,
            reservedCapacityBytes: 32n * 1024n * 1024n,
        });
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                transitionId: prepared.transition.transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toEqual({ status: "authorized" });
        const firstPage = await inTx(async (tx) => (
            await inventoryAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                transitionId: prepared.transition.transitionId,
            })
        ));
        expect(firstPage.status).toBe("ready");
        if (firstPage.status !== "ready") {
            throw new Error(`Expected ready V5 inventory, got ${firstPage.status}`);
        }
        expect(firstPage.items).toHaveLength(
            ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
        );
        expect(firstPage.nextCursor).toEqual(expect.any(String));
        const secondPage = await inTx(async (tx) => (
            await inventoryAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                transitionId: prepared.transition.transitionId,
                cursor: firstPage.nextCursor,
            })
        ));
        expect(secondPage.status).toBe("ready");
        if (secondPage.status !== "ready") {
            throw new Error(`Expected ready V5 inventory, got ${secondPage.status}`);
        }
        expect(secondPage.items).toHaveLength(1);
        expect(secondPage.nextCursor).toBeUndefined();

        await declareIsolatedFixtureCapacity(prepared.transition.transitionId, {
            participantLimit: 400,
            encodedByteLimit: 16n * 1024n * 1024n,
            reservedCapacityBytes: 32n * 1024n * 1024n,
        });
        await expect(inTx(async (tx) => (
            await stageAccountEncryptionTransitionCollectionsCoordinatorInTx({
                tx,
                accountId,
                transitionId: prepared.transition.transitionId,
                items: firstPage.items.slice(0, 400).map((item) => ({
                    pluginId: item.pluginId,
                    collectionId: item.collectionId,
                    rowId: item.rowId,
                    expectedRevision: item.revision,
                    sourceEnvelope: item.sourceEnvelope,
                    targetEnvelope: { t: "plain", v: {} },
                    schemaVersion: item.schemaVersion,
                    contractDigest: item.contractDigest,
                })),
            })
        ))).resolves.toEqual({ status: "migration_too_large" });
        await expect(Promise.all([
            db.accountEncryptionTransition.findUniqueOrThrow({
                where: { id: prepared.transition.transitionId },
                select: { status: true, activeAccountId: true },
            }),
            db.accountEncryptionTransitionCollectionStage.findMany({
                where: { transitionId: prepared.transition.transitionId },
                select: { targetEnvelope: true },
            }),
        ])).resolves.toEqual([
            { status: "authorized", activeAccountId: accountId },
            [{ targetEnvelope: null }],
        ]);
    });

    it(`expires and cleans the bounded V5 stage without changing authoritative source bytes on ${provider}`, async () => {
        const accountId = `account-transition-v5-expiry-${randomUUID()}`;
        createdAccountIds.add(accountId);
        const pluginId = uniquePluginId();
        const binding = createSignedAccountContentBinding();
        await db.account.create({
            data: {
                id: accountId,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract(pluginId);
        const sourceEnvelope = {
            t: "encrypted" as const,
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(47),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(53),
            }),
        };
        const row = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                schemaVersion: contract.schemaVersion,
                revision: 4,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson(sourceEnvelope),
            },
            select: { id: true },
        });
        await db.pluginCollectionProjection.create({
            data: {
                rowDbId: row.id,
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: "live-row",
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: 4,
            },
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const startedAt = new Date("2026-08-12T16:30:00.000Z");
        const transitionId = await prepareAuthorizedPlainTransition({
            accountId,
            expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
            now: startedAt,
        });
        const expiredAt = new Date(
            startedAt.getTime()
            + ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.lifetimeMs,
        );

        await expect(inTx(async (tx) => (
            await cleanupExpiredAccountEncryptionTransitionsInTx({
                tx,
                now: expiredAt,
            })
        ))).resolves.toEqual({
            expiredTransitionCount: 1,
            removedStageCount: 1,
        });

        await expect(Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { encryptionMode: true, seq: true },
            }),
            db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: row.id },
                select: { revision: true, contentEnvelope: true },
            }),
            db.accountEncryptionTransition.findUniqueOrThrow({
                where: { id: transitionId },
                select: { status: true, activeAccountId: true },
            }),
            db.accountEncryptionTransitionCollectionStage.count({
                where: { transitionId },
            }),
            db.accountChange.count({ where: { accountId } }),
        ])).resolves.toEqual([
            { encryptionMode: "e2ee", seq: 0 },
            { revision: 4, contentEnvelope: sourceEnvelope },
            { status: "expired", activeAccountId: null },
            0,
            0,
        ]);
    });

    it(`defers Account-data erase until a coordinator-created 501-stage cancellation is terminal on ${provider}`, async () => {
        const accountId = `account-transition-data-erase-${randomUUID()}`;
        const pluginId = uniquePluginId();
        const accountStorageKey = buildPluginAccountStoragePhysicalKey(pluginId);
        const declarativeSettingsKey = buildPluginDeclarativeSettingsPhysicalKey(pluginId);
        const accountStorageValue = Uint8Array.of(1, 2, 3);
        const declarativeSettingsValue = Uint8Array.of(4, 5, 6);
        const binding = createSignedAccountContentBinding();
        createdAccountIds.add(accountId);
        await db.account.create({
            data: {
                id: accountId,
                ...binding,
                encryptionMode: "e2ee",
            },
        });
        const contract = await createCollectionContract(pluginId);
        const sourceEnvelope = {
            t: "encrypted" as const,
            c: sealPluginCollectionPrivatePayloadV1({
                material: {
                    type: "dataKey",
                    machineKey: new Uint8Array(32).fill(59),
                },
                payload: {},
                randomBytes: (length) => new Uint8Array(length).fill(61),
            }),
        };
        await db.pluginCollectionRow.createMany({
            data: Array.from(
                {
                    length:
                        ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize
                        + 1,
                },
                (_, index) => ({
                    accountId,
                    pluginId,
                    collectionId: contract.collectionId,
                    rowId: `data-row-${index}`,
                    schemaVersion: contract.schemaVersion,
                    revision: 1,
                    contractId: contract.id,
                    contractDigest: contract.contractDigest,
                    contentEnvelope: toPrismaJson(sourceEnvelope),
                }),
            ),
        });
        const sourceRows = await db.pluginCollectionRow.findMany({
            where: { accountId, pluginId, collectionId: contract.collectionId },
            select: { id: true, rowId: true, revision: true },
        });
        const liveRow = sourceRows.find((row) => row.rowId === "data-row-0");
        if (!liveRow) throw new Error("Expected coordinator-created source row.");
        await db.pluginCollectionProjection.createMany({
            data: sourceRows.map((row) => ({
                rowDbId: row.id,
                accountId,
                pluginId,
                collectionId: contract.collectionId,
                rowId: row.rowId,
                fieldId: "status",
                typedEncodedValue: JSON.stringify("open"),
                rowRevision: row.revision,
            })),
        });
        await db.userKVStore.createMany({
            data: [
                {
                    accountId,
                    key: accountStorageKey,
                    value: accountStorageValue,
                    version: 1,
                },
                {
                    accountId,
                    key: declarativeSettingsKey,
                    value: declarativeSettingsValue,
                    version: 1,
                },
            ],
        });
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints({
            publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey,
        });
        const prepared = await inTx(async (tx) => (
            await prepareAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                request: {
                    toMode: "plain",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
                },
            })
        ));
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") {
            throw new Error(`Expected prepared V5 transition, got ${prepared.status}`);
        }
        const transitionId = prepared.transition.transitionId;
        await declareIsolatedFixtureCapacity(transitionId, {
            participantLimit: 1_024,
            encodedByteLimit: 16n * 1024n * 1024n,
            reservedCapacityBytes: 32n * 1024n * 1024n,
        });
        await expect(inTx(async (tx) => (
            await authorizeAccountEncryptionTransitionCoordinatorInTx({
                tx,
                accountId,
                transitionId,
                authorization: { kind: "present_user_confirmation" },
            })
        ))).resolves.toEqual({ status: "authorized" });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId },
        })).resolves.toBe(
            ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize + 1,
        );

        await expect(erasePluginAccountData({ accountId, pluginId })).resolves.toEqual({
            status: "transition-cleanup-pending",
        });

        await expect(Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { encryptionMode: true, seq: true },
            }),
            db.accountEncryptionTransition.findUniqueOrThrow({
                where: { id: transitionId },
                select: { status: true, activeAccountId: true },
            }),
            db.accountEncryptionTransitionCollectionStage.count({
                where: { transitionId },
            }),
            db.accountEncryptionTransitionCollectionStage.findMany({
                where: { transitionId },
                select: { sourceEnvelope: true, targetEnvelope: true },
            }),
            db.userKVStore.findMany({
                where: { accountId, key: { in: [accountStorageKey, declarativeSettingsKey] } },
                orderBy: { key: "asc" },
                select: { key: true, value: true, version: true },
            }),
            db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: liveRow.id },
                select: { revision: true, deletedAt: true, contentEnvelope: true },
            }),
            db.pluginCollectionProjection.count({ where: { rowDbId: liveRow.id } }),
            db.accountChange.count({ where: { accountId } }),
        ])).resolves.toEqual([
            { encryptionMode: "e2ee", seq: 0 },
            { status: "authorized", activeAccountId: accountId },
            1,
            [{ sourceEnvelope, targetEnvelope: null }],
            [
                { key: declarativeSettingsKey, value: declarativeSettingsValue, version: 1 },
                { key: accountStorageKey, value: accountStorageValue, version: 1 },
            ].sort((left, right) => left.key.localeCompare(right.key)),
            {
                revision: 1,
                deletedAt: null,
                contentEnvelope: sourceEnvelope,
            },
            1,
            0,
        ]);

        await expect(erasePluginAccountData({ accountId, pluginId })).resolves.toMatchObject({
            status: "erased",
            accountStorage: { status: "tombstoned", revision: 2 },
            declarativeSettings: { status: "tombstoned", revision: 2 },
            collections: {
                tombstonedRowCount:
                    ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize + 1,
                deletedProjectionCount:
                    ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize + 1,
            },
        });

        await expect(Promise.all([
            db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { encryptionMode: true },
            }),
            db.accountEncryptionTransition.findUniqueOrThrow({
                where: { id: transitionId },
                select: { status: true, activeAccountId: true },
            }),
            db.accountEncryptionTransitionCollectionStage.count({
                where: { transitionId },
            }),
            db.userKVStore.findMany({
                where: { accountId, key: { in: [accountStorageKey, declarativeSettingsKey] } },
                orderBy: { key: "asc" },
                select: { key: true, value: true, version: true },
            }),
            db.pluginCollectionRow.findUniqueOrThrow({
                where: { id: liveRow.id },
                select: { revision: true, deletedAt: true, contentEnvelope: true },
            }),
            db.pluginCollectionProjection.count({ where: { rowDbId: liveRow.id } }),
        ])).resolves.toEqual([
            { encryptionMode: "e2ee" },
            { status: "cancelled", activeAccountId: null },
            0,
            [
                { key: declarativeSettingsKey, value: null, version: 2 },
                { key: accountStorageKey, value: null, version: 2 },
            ].sort((left, right) => left.key.localeCompare(right.key)),
            {
                revision: 2,
                deletedAt: expect.any(Date),
                contentEnvelope: null,
            },
            0,
        ]);
    });
});
