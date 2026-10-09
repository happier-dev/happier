import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as blobFiles from '@/storage/blob/files';
import type { Prisma } from "@prisma/client";
import {
    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
    PluginAccountDataEraseServerOutputV1Schema,
} from "@happier-dev/protocol";

import { pluginDataRoutes } from "@/app/api/routes/plugins/data/pluginDataRoutes";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { auth } from "@/app/auth/auth";
import {
    materializePluginCollectionContractsFromManifestTx,
} from "@/app/plugins/data/collections/contracts";
import {
    buildPluginAccountStoragePhysicalKey,
    buildPluginDeclarativeSettingsPhysicalKey,
} from "@/app/kv/accountScopedKv";
import { ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE } from "@/app/encryption/accountEncryptionTransitionCoordinator";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

const PLUGIN_ID = "example.erase";
const COLLECTION_ID = "tasks";

const COLLECTION_MANIFEST = {
    schemaVersion: 2,
    id: PLUGIN_ID,
    version: "1.0.0",
    displayName: "Erase fixture",
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

async function materializeFixtureContract() {
    const [ref] = await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({
            tx,
            manifest: COLLECTION_MANIFEST,
        })
    ));
    if (!ref) throw new Error("Expected fixture contract.");
    return await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: ref.pluginId,
            collectionId: ref.collectionId,
            schemaVersion: ref.schemaVersion,
            contractDigest: ref.contractDigest,
        },
    });
}

async function seedAccountCollectionData(input: Readonly<{
    accountId: string;
    contract: Readonly<{ id: string; schemaVersion: number; contractDigest: string }>;
}>) {
    const state = await db.pluginCollectionIndexState.create({
        data: {
            accountId: input.accountId,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            indexId: "by-status",
            contractId: input.contract.id,
            contractDigest: input.contract.contractDigest,
            buildState: "ready",
            indexedThroughRevision: 1,
        },
    });
    const first = await db.pluginCollectionRow.create({
        data: {
            accountId: input.accountId,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            rowId: "task-1",
            schemaVersion: input.contract.schemaVersion,
            revision: 1,
            contractId: input.contract.id,
            contractDigest: input.contract.contractDigest,
            contentEnvelope: toPrismaJson({ t: "plain", v: { privateNote: "erase-this-task-1" } }),
        },
    });
    const second = await db.pluginCollectionRow.create({
        data: {
            accountId: input.accountId,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            rowId: "task-2",
            schemaVersion: input.contract.schemaVersion,
            revision: 1,
            contractId: input.contract.id,
            contractDigest: input.contract.contractDigest,
            contentEnvelope: toPrismaJson({ t: "plain", v: { privateNote: "erase-this-task-2" } }),
        },
    });
    await db.pluginCollectionProjection.createMany({
        data: [first, second].map((row) => ({
            rowDbId: row.id,
            accountId: input.accountId,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            rowId: row.rowId,
            fieldId: "status",
            typedEncodedValue: JSON.stringify("open"),
            rowRevision: 1,
        })),
    });
    await db.pluginCollectionIndexEntry.createMany({
        data: [first, second].map((row, index) => ({
            indexStateId: state.id,
            encodedSortKey: Uint8Array.of(0x01, index),
            rowId: row.rowId,
            rowRevision: 1,
        })),
    });
    await db.pluginCollectionRelation.create({
        data: {
            accountId: input.accountId,
            sourceRowDbId: first.id,
            sourcePluginId: PLUGIN_ID,
            sourceCollectionId: COLLECTION_ID,
            sourceRowId: first.rowId,
            relationId: "task-link",
            targetKind: "collection",
            targetPluginId: PLUGIN_ID,
            targetCollectionId: COLLECTION_ID,
            targetRowId: second.rowId,
            sourceRevision: 1,
        },
    });
    return { state, first, second };
}

async function withProductionAuthenticatedPluginDataApp(
    run: (app: any) => Promise<void>,
): Promise<void> {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    pluginDataRoutes(typed);
    await typed.ready();
    try {
        await run(typed);
    } finally {
        await typed.close();
    }
}

describe("plugin Account data erasure", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-account-data-erase-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.pluginCollectionCandidatePreparationStage.deleteMany(),
            () => db.pluginCollectionIndexEntry.deleteMany(),
            () => db.pluginCollectionProjection.deleteMany(),
            () => db.pluginCollectionRelation.deleteMany(),
            () => db.pluginCollectionRow.deleteMany(),
            () => db.pluginCollectionIndexState.deleteMany(),
            () => db.pluginCollectionContract.deleteMany(),
            () => db.userKVStore.deleteMany(),
            () => db.homeAdministrationEvent.deleteMany(),
            () => db.uploadedFile.deleteMany(),
            () => db.managedMachine.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("reports account-not-found through the real Account-first erasure fence", async () => {
        const { erasePluginAccountDataInTx } = await import("./accountDataErase");

        await expect(inTx(async (tx) => await erasePluginAccountDataInTx({
            tx,
            accountId: "missing-plugin-data-account",
            pluginId: PLUGIN_ID,
        }))).resolves.toEqual({ status: "account-not-found" });
    });

    it('reviews retained native custody before the existing authenticated plugin data erase mutates either data destination', async () => {
        const accountId = 'plugin-data-native-review';
        await createPlainAccount(accountId);
        const provider = { pluginId: PLUGIN_ID, localId: 'cloud' };
        const resource = { contributionRef: provider, schemaVersion: 1, value: { id: 'retained-plugin-data-native' } };
        const recovery = { reference: 'retained-plugin-data-native', reason: 'manual_recovery' };
        const retained = await db.managedMachine.create({ data: {
            homeId: 'plugin-data-home', custodianAccountId: accountId,
            controllerMachineId: 'unavailable-controller', controllerInstallationId: 'installation-data-erase',
            admittedActionRequestId: 'plugin-data-review', admittedInput: {},
            launch: { provider, schemaVersion: 1, name: 'Retained', choices: {} },
            allocation: 'bound', resource, recovery, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            archivedAt: new Date('2026-10-01T00:00:00.000Z'),
        } });
        const storageKey = buildPluginAccountStoragePhysicalKey(PLUGIN_ID);
        const settingsKey = buildPluginDeclarativeSettingsPhysicalKey(PLUGIN_ID);
        await db.userKVStore.createMany({ data: [storageKey, settingsKey].map(key => ({
            accountId, key, value: new TextEncoder().encode('native-recovery-data'), version: 1,
        })) });
        await withAuthenticatedTestApp(app => pluginDataRoutes(app), async app => {
            const request = { method: 'POST' as const, url: '/v1/plugins/data/account-erase', headers: {
                'content-type': 'application/json', 'x-test-user-id': accountId,
                'x-happier-account-stored-content-protocol': String(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION),
            } };
            const review = await app.inject({ ...request, payload: { pluginId: PLUGIN_ID } });
            expect(review.statusCode).toBe(409);
            expect(review.json()).toMatchObject({ error: 'managed_resources_review_required', resources: [{
                managedId: retained.id, allocation: 'bound', resource, recovery,
            }] });
            expect(await db.userKVStore.findMany({ where: { accountId }, select: { value: true } }))
                .toEqual([expect.objectContaining({ value: expect.any(Uint8Array) }), expect.objectContaining({ value: expect.any(Uint8Array) })]);
            const erased = await app.inject({ ...request, payload: { pluginId: PLUGIN_ID, managedResourceDispositions: [{
                managedId: retained.id, expectedIntentRevision: 0, expectedAllocation: 'bound',
                expectedResource: resource, expectedRecovery: recovery, responsibility: 'manual',
            }] } });
            expect(erased.statusCode).toBe(200);
            expect(erased.json()).toMatchObject({ status: 'erased', changed: true });
            expect(await db.userKVStore.findMany({ where: { accountId }, select: { value: true } }))
                .toEqual([{ value: null }, { value: null }]);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: retained.id } })).toMatchObject({ allocation: 'bound', resource });
        });
    });

    it("reviews retained native custody before retirement and erases only after exact manual responsibility", async () => {
        const { deleteAccountForErasure } = await import("./accountDataErase");
        const accountId = "managed-erasure-review";
        await createPlainAccount(accountId);
        const controller = await db.machine.create({ data: {
            id: "managed-erasure-controller", accountId, installationId: "installation-erase", metadata: '{"t":"plain","v":{}}',
        } });
        const provider = { pluginId: "fixture.compute", localId: "cloud" };
        const retained = await db.managedMachine.create({ data: {
            id: "retained-native-resource", homeId: "managed-erasure-home", custodianAccountId: accountId,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!,
            admittedActionRequestId: "retained-request", admittedInput: {},
            launch: { provider, schemaVersion: 1, name: "Retained", choices: { privateLaunchNote: "not-for-recovery" } },
            allocation: "bound", resource: { contributionRef: provider, schemaVersion: 1, value: { id: "native-123" } },
            retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false, intentRevision: 3,
            observation: { observedAt: 7, availability: "unavailable", billing: { location: "cloud", stoppedBilling: "billed" } },
            cleanup: { disposition: "unavailable", reason: "credential_missing" },
            recovery: { reference: "native-123", reason: "credential_missing", consoleUrl: "https://provider.example/resources/native-123" },
            archivedAt: new Date(1),
        } });
        const first = await deleteAccountForErasure({ accountId });
        expect(first).toMatchObject({ status: "failed", code: "account_erasure_managed_resources_review_required", resources: [{
            managedId: retained.id, intentRevision: 3, controller: { machineId: controller.id, installationId: "installation-erase" },
            resource: { value: { id: "native-123" } }, cleanup: { disposition: "unavailable" },
            observation: { availability: "unavailable", billing: { stoppedBilling: "billed" } },
            recovery: { reference: "native-123" },
        }] });
        expect(JSON.stringify(first)).not.toContain("not-for-recovery");
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId } })).toMatchObject({ status: "active" });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: retained.id } })).toMatchObject({ allocation: "bound" });
        await expect(deleteAccountForErasure({ accountId, managedResourceDispositions: [{
            managedId: retained.id, expectedIntentRevision: 2, responsibility: "manual",
            expectedAllocation: 'bound', expectedResource: { contributionRef: provider, schemaVersion: 1, value: { id: 'native-123' } },
            expectedRecovery: { reference: 'native-123', reason: 'credential_missing', consoleUrl: 'https://provider.example/resources/native-123' },
        }] })).resolves.toMatchObject({ status: "failed", code: "account_erasure_managed_resources_review_required" });
        await expect(deleteAccountForErasure({ accountId, managedResourceDispositions: [{
            managedId: retained.id, expectedIntentRevision: 3, responsibility: "manual",
            expectedAllocation: 'bound', expectedResource: { contributionRef: provider, schemaVersion: 1, value: { id: 'native-123' } },
            expectedRecovery: { reference: 'native-123', reason: 'credential_missing', consoleUrl: 'https://provider.example/resources/native-123' },
        }] })).resolves.toEqual({ status: "deleted" });
        expect(await db.managedMachine.findUnique({ where: { id: retained.id } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
    });

    it("does not require manual native cleanup for an unsubmitted or confirmed-absent allocation", async () => {
        const { deleteAccountForErasure } = await import("./accountDataErase");
        const accountId = "managed-erasure-absent";
        await createPlainAccount(accountId);
        for (const allocation of ["unsubmitted", "confirmed-absent"] as const) {
            await db.managedMachine.create({ data: {
                homeId: "managed-erasure-home", custodianAccountId: accountId,
                controllerMachineId: "gone-controller", controllerInstallationId: "gone-installation",
                admittedActionRequestId: `absent-${allocation}`, admittedInput: {},
                launch: { provider: { pluginId: "fixture.compute", localId: "cloud" }, schemaVersion: 1, name: allocation, choices: {} },
                allocation, retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false,
            } });
        }
        await expect(deleteAccountForErasure({ accountId })).resolves.toEqual({ status: "deleted" });
        expect(await db.managedMachine.count({ where: { custodianAccountId: accountId } })).toBe(0);
    });

    it('requires refreshed native identity review when a paid resource is reported during Account blob erasure', async () => {
        const { deleteAccountForErasure } = await import('./accountDataErase');
        const accountId = 'late-native-erasure';
        await createPlainAccount(accountId);
        const provider = { pluginId: 'fixture.compute', localId: 'cloud' };
        const recovery = { reference: 'purchase-in-progress', reason: 'manual_recovery' };
        const managed = await db.managedMachine.create({ data: {
            homeId: 'late-native-home', custodianAccountId: accountId,
            controllerMachineId: 'late-controller', controllerInstallationId: 'late-installation',
            admittedActionRequestId: 'late-native-request', admittedInput: {},
            launch: { provider, schemaVersion: 1, name: 'Purchasing', choices: {} },
            allocation: 'may-exist', recovery, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } });
        await db.uploadedFile.create({ data: { accountId, path: 'isolated-late-native-blob' } });
        const resource = { contributionRef: provider, schemaVersion: 1, value: { id: 'paid-after-review' } };
        // The blob store is a genuine outside-Tx boundary. No file or user storage is erased.
        vi.spyOn(blobFiles, 'deletePublicFile').mockImplementationOnce(async () => {
            await db.managedMachine.update({ where: { id: managed.id }, data: {
                allocation: 'bound', resource, recovery: { reference: 'paid-after-review', reason: 'manual_recovery' },
            } });
        });
        const result = await deleteAccountForErasure({ accountId, managedResourceDispositions: [{
            managedId: managed.id, expectedIntentRevision: 0, responsibility: 'manual',
            expectedAllocation: 'may-exist', expectedRecovery: recovery,
        }] });
        expect(result).toMatchObject({ status: 'failed', code: 'account_erasure_managed_resources_review_required',
            resources: [{ managedId: managed.id, allocation: 'bound', resource, recovery: { reference: 'paid-after-review' } }] });
        expect(await db.account.findUniqueOrThrow({ where: { id: accountId } })).toMatchObject({ status: 'disabled' });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } })).toMatchObject({ allocation: 'bound', resource });

        // The self credential is intentionally retired. Existing independent Home
        // administration owns retry; no erasure token or revived self grant exists.
        const administratorId = 'late-native-erasure-administrator';
        await createPlainAccount(administratorId);
        await db.account.update({ where: { id: administratorId }, data: { homeRole: 'owner' } });
        vi.mocked(blobFiles.deletePublicFile).mockResolvedValueOnce(undefined);
        await expect(deleteAccountForErasure({
            accountId, actor: { kind: 'home_administration', actorAccountId: administratorId },
            managedResourceDispositions: [{ managedId: managed.id, expectedIntentRevision: 0, responsibility: 'manual',
                expectedAllocation: 'bound', expectedResource: resource,
                expectedRecovery: { reference: 'paid-after-review', reason: 'manual_recovery' } }],
        })).resolves.toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
        expect(await db.account.findUniqueOrThrow({ where: { id: administratorId } })).toMatchObject({ status: 'active', homeRole: 'owner' });
    });

    it("tombstones only the selected Account's durable plugin data, retires its derived records, and is retry-idempotent", async () => {
        const { erasePluginAccountData } = await import("./accountDataErase");
        const erasedAccountId = "account-erased";
        const retainedAccountId = "account-retained";
        await createPlainAccount(erasedAccountId);
        await createPlainAccount(retainedAccountId);
        const contract = await materializeFixtureContract();
        const erased = await seedAccountCollectionData({ accountId: erasedAccountId, contract });
        const retained = await seedAccountCollectionData({ accountId: retainedAccountId, contract });
        await db.pluginCollectionCandidatePreparationStage.createMany({
            data: [
                { accountId: erasedAccountId, row: erased.first, candidateIdentity: "a".repeat(43) },
                { accountId: retainedAccountId, row: retained.first, candidateIdentity: "b".repeat(43) },
            ].map(({ accountId, row, candidateIdentity }) => ({
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: row.rowId,
                candidateIdentity,
                sourceRowDbId: row.id,
                sourceContractId: contract.id,
                sourceSchemaVersion: contract.schemaVersion,
                sourceContractDigest: contract.contractDigest,
                sourceRevision: 1,
                targetContractId: contract.id,
                targetSchemaVersion: contract.schemaVersion,
                targetContractDigest: contract.contractDigest,
                candidateReleaseVersion: "2.0.0",
                candidateArtifactDigest: `sha256:${"a".repeat(64)}`,
                targetContentEnvelope: toPrismaJson({ t: "plain", v: {} }),
                targetProjection: toPrismaJson({ status: "open" }),
            })),
        });
        const historicalDeletedAt = new Date("2026-08-11T11:00:00.000Z");
        const historicalTombstone = await db.pluginCollectionRow.create({
            data: {
                accountId: erasedAccountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "task-historical",
                schemaVersion: contract.schemaVersion,
                revision: 17,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson({
                    t: "plain",
                    v: { privateNote: "historic-content-must-be-scrubbed" },
                }),
                deletedAt: historicalDeletedAt,
            },
        });

        const storageKey = buildPluginAccountStoragePhysicalKey(PLUGIN_ID);
        const settingsKey = buildPluginDeclarativeSettingsPhysicalKey(PLUGIN_ID);
        await db.userKVStore.createMany({
            data: [
                {
                    accountId: erasedAccountId,
                    key: storageKey,
                    value: new TextEncoder().encode("opaque-account-kv"),
                    version: 4,
                },
                {
                    accountId: erasedAccountId,
                    key: settingsKey,
                    value: new TextEncoder().encode("opaque-declarative-settings"),
                    version: 7,
                },
                {
                    accountId: retainedAccountId,
                    key: storageKey,
                    value: new TextEncoder().encode("retained-account-kv"),
                    version: 2,
                },
                {
                    accountId: retainedAccountId,
                    key: settingsKey,
                    value: new TextEncoder().encode("retained-declarative-settings"),
                    version: 3,
                },
            ],
        });

        await expect(erasePluginAccountData({
            accountId: erasedAccountId,
            pluginId: PLUGIN_ID,
        })).resolves.toMatchObject({
            status: "erased",
            accountStorage: { status: "tombstoned", revision: 5 },
            declarativeSettings: { status: "tombstoned", revision: 8 },
            collections: {
                tombstonedRowCount: 2,
                scrubbedHistoricalTombstoneContentCount: 1,
                deletedProjectionCount: 2,
                deletedIndexEntryCount: 2,
                resetIndexStateCount: 1,
                retiredRelationCount: 1,
            },
        });

        await expect(db.userKVStore.findMany({
            where: { accountId: erasedAccountId },
            orderBy: { key: "asc" },
            select: { key: true, value: true, version: true },
        })).resolves.toEqual([
            { key: storageKey, value: null, version: 5 },
            { key: settingsKey, value: null, version: 8 },
        ].sort((left, right) => left.key.localeCompare(right.key)));
        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: erasedAccountId },
            orderBy: { rowId: "asc" },
            select: { id: true, rowId: true, revision: true, deletedAt: true, contentEnvelope: true },
        })).resolves.toEqual([
            expect.objectContaining({ id: erased.first.id, rowId: "task-1", revision: 2, deletedAt: expect.any(Date), contentEnvelope: null }),
            expect.objectContaining({ id: erased.second.id, rowId: "task-2", revision: 2, deletedAt: expect.any(Date), contentEnvelope: null }),
            {
                id: historicalTombstone.id,
                rowId: "task-historical",
                revision: 17,
                deletedAt: historicalDeletedAt,
                contentEnvelope: null,
            },
        ]);
        await expect(db.pluginCollectionProjection.count({ where: { accountId: erasedAccountId } })).resolves.toBe(0);
        await expect(db.pluginCollectionIndexEntry.count({ where: { indexStateId: erased.state.id } })).resolves.toBe(0);
        await expect(db.pluginCollectionIndexState.findUniqueOrThrow({
            where: { id: erased.state.id },
            select: { buildState: true, indexedThroughRevision: true },
        })).resolves.toEqual({ buildState: "ready", indexedThroughRevision: 0 });
        await expect(db.pluginCollectionRelation.findFirstOrThrow({
            where: { sourceRowDbId: erased.first.id },
            select: { deletedAt: true },
        })).resolves.toEqual({ deletedAt: expect.any(Date) });
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: erasedAccountId },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: retainedAccountId },
        })).resolves.toBe(1);

        await expect(db.pluginCollectionContract.count()).resolves.toBe(1);
        await expect(db.userKVStore.findMany({
            where: { accountId: retainedAccountId },
            orderBy: { key: "asc" },
            select: { key: true, value: true, version: true },
        })).resolves.toEqual([
            { key: storageKey, version: 2 },
            { key: settingsKey, version: 3 },
        ].sort((left, right) => left.key.localeCompare(right.key)).map((expected) => (
            expect.objectContaining({ ...expected, value: expect.any(Uint8Array) })
        )));
        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: retainedAccountId },
            orderBy: { rowId: "asc" },
            select: { id: true, rowId: true, revision: true, deletedAt: true },
        })).resolves.toEqual([
            { id: retained.first.id, rowId: "task-1", revision: 1, deletedAt: null },
            { id: retained.second.id, rowId: "task-2", revision: 1, deletedAt: null },
        ]);
        await expect(db.pluginCollectionIndexEntry.count({ where: { indexStateId: retained.state.id } })).resolves.toBe(2);

        await expect(erasePluginAccountData({
            accountId: erasedAccountId,
            pluginId: PLUGIN_ID,
        })).resolves.toMatchObject({
            status: "erased",
            accountStorage: { status: "already-tombstoned", revision: 5 },
            declarativeSettings: { status: "already-tombstoned", revision: 8 },
            collections: {
                tombstonedRowCount: 0,
                scrubbedHistoricalTombstoneContentCount: 0,
                deletedProjectionCount: 0,
                deletedIndexEntryCount: 0,
                resetIndexStateCount: 0,
                retiredRelationCount: 0,
            },
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: erasedAccountId },
            select: { seq: true },
        })).resolves.toEqual({ seq: 3 });
    });

    it("reports changed when erasure only scrubs historical tombstone content and resets derived index state", async () => {
        const accountId = "account-historical-tombstone-scrub";
        const historicalDeletedAt = new Date("2026-08-13T10:00:00.000Z");
        await createPlainAccount(accountId);
        const contract = await materializeFixtureContract();
        await db.userKVStore.createMany({
            data: [
                {
                    accountId,
                    key: buildPluginAccountStoragePhysicalKey(PLUGIN_ID),
                    value: null,
                    version: 4,
                },
                {
                    accountId,
                    key: buildPluginDeclarativeSettingsPhysicalKey(PLUGIN_ID),
                    value: null,
                    version: 7,
                },
            ],
        });
        const tombstone = await db.pluginCollectionRow.create({
            data: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                rowId: "historical-only",
                schemaVersion: contract.schemaVersion,
                revision: 17,
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                contentEnvelope: toPrismaJson({
                    t: "plain",
                    v: { privateNote: "must-not-remain-after-erasure" },
                }),
                deletedAt: historicalDeletedAt,
            },
        });
        const indexState = await db.pluginCollectionIndexState.create({
            data: {
                accountId,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                indexId: "by-status",
                contractId: contract.id,
                contractDigest: contract.contractDigest,
                buildState: "ready",
                indexedThroughRevision: 17,
            },
        });
        await expect(db.userKVStore.findMany({
            where: { accountId },
            orderBy: { key: "asc" },
            select: { key: true, value: true, version: true },
        })).resolves.toEqual([
            {
                key: buildPluginDeclarativeSettingsPhysicalKey(PLUGIN_ID),
                value: null,
                version: 7,
            },
            {
                key: buildPluginAccountStoragePhysicalKey(PLUGIN_ID),
                value: null,
                version: 4,
            },
        ].sort((left, right) => left.key.localeCompare(right.key)));

        await withAuthenticatedTestApp((app) => pluginDataRoutes(app), async (app) => {
            const erased = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/account-erase",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    "x-happier-account-stored-content-protocol": String(
                        ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
                    ),
                },
                payload: { pluginId: PLUGIN_ID },
            });

            expect(erased.statusCode).toBe(200);
            expect(PluginAccountDataEraseServerOutputV1Schema.parse(erased.json())).toEqual({
                status: "erased",
                changed: true,
            });
        });

        await expect(db.pluginCollectionRow.findUniqueOrThrow({
            where: { id: tombstone.id },
            select: { revision: true, deletedAt: true, contentEnvelope: true },
        })).resolves.toEqual({
            revision: 17,
            deletedAt: historicalDeletedAt,
            contentEnvelope: null,
        });
        await expect(db.pluginCollectionIndexState.findUniqueOrThrow({
            where: { id: indexState.id },
            select: { indexedThroughRevision: true },
        })).resolves.toEqual({ indexedThroughRevision: 0 });
    });

    it("cancels an active transition in bounded chunks before erasing and leaves every data destination untouched until an explicit retry can finish cleanup", async () => {
        const accountId = "account-transition-cleanup";
        const transitionId = "transition-account-data-erase";
        const contract = await materializeFixtureContract();
        await createPlainAccount(accountId);
        const seeded = await seedAccountCollectionData({ accountId, contract });
        const storageKey = buildPluginAccountStoragePhysicalKey(PLUGIN_ID);
        const settingsKey = buildPluginDeclarativeSettingsPhysicalKey(PLUGIN_ID);
        await db.userKVStore.createMany({
            data: [
                {
                    accountId,
                    key: storageKey,
                    value: new TextEncoder().encode("opaque-account-kv"),
                    version: 1,
                },
                {
                    accountId,
                    key: settingsKey,
                    value: new TextEncoder().encode("opaque-declarative-settings"),
                    version: 1,
                },
            ],
        });
        await db.accountEncryptionTransition.create({
            data: {
                id: transitionId,
                accountId,
                fromEncryptionMode: "plain",
                toEncryptionMode: "e2ee",
                sourceAccountVersion: 0,
                sourceSettingsVersion: 0,
                status: "authorized",
                activeAccountId: accountId,
                preparedAt: new Date("2026-08-13T09:00:00.000Z"),
                expiresAt: new Date("2100-01-01T00:00:00.000Z"),
            },
        });
        await db.accountEncryptionTransitionCollectionStage.createMany({
            data: Array.from(
                { length: ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize + 1 },
                (_, index) => ({
                    transitionId,
                    pluginId: PLUGIN_ID,
                    collectionId: COLLECTION_ID,
                    rowId: `cleanup-${index}`,
                    sourceRevision: 1,
                    sourceEnvelope: toPrismaJson({ t: "plain", v: {} }),
                    targetEnvelope: toPrismaJson({ t: "encrypted", c: "staged-target" }),
                    schemaVersion: 1,
                    contractDigest: contract.contractDigest,
                    sourceEncodedBytes: 2n,
                    targetEncodedBytes: 13n,
                }),
            ),
        });

        const headers = {
            "content-type": "application/json",
            "x-test-user-id": accountId,
            "x-happier-account-stored-content-protocol": String(
                ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
            ),
        };
        await withAuthenticatedTestApp((app) => pluginDataRoutes(app), async (app) => {
            const pending = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/account-erase",
                headers,
                payload: { pluginId: PLUGIN_ID },
            });
            expect(pending.statusCode).toBe(200);
            expect(PluginAccountDataEraseServerOutputV1Schema.parse(pending.json())).toEqual({
                status: "transition-cleanup-pending",
            });
        });

        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "authorized", activeAccountId: accountId });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId },
        })).resolves.toBe(1);
        await expect(db.userKVStore.findMany({
            where: { accountId, key: { in: [storageKey, settingsKey] } },
            orderBy: { key: "asc" },
            select: { key: true, value: true, version: true },
        })).resolves.toEqual([
            { key: settingsKey, value: new TextEncoder().encode("opaque-declarative-settings"), version: 1 },
            { key: storageKey, value: new TextEncoder().encode("opaque-account-kv"), version: 1 },
        ].sort((left, right) => left.key.localeCompare(right.key)));
        await expect(db.pluginCollectionRow.findMany({
            where: { id: { in: [seeded.first.id, seeded.second.id] } },
            orderBy: { rowId: "asc" },
            select: { revision: true, deletedAt: true },
        })).resolves.toEqual([
            { revision: 1, deletedAt: null },
            { revision: 1, deletedAt: null },
        ]);

        await withAuthenticatedTestApp((app) => pluginDataRoutes(app), async (app) => {
            const retried = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/account-erase",
                headers,
                payload: { pluginId: PLUGIN_ID },
            });
            expect(retried.statusCode).toBe(200);
            expect(PluginAccountDataEraseServerOutputV1Schema.parse(retried.json())).toEqual({
                status: "erased",
                changed: true,
            });
        });
        await expect(db.accountEncryptionTransition.findUniqueOrThrow({
            where: { id: transitionId },
            select: { status: true, activeAccountId: true },
        })).resolves.toEqual({ status: "cancelled", activeAccountId: null });
        await expect(db.accountEncryptionTransitionCollectionStage.count({
            where: { transitionId },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionRow.count({
            where: { id: { in: [seeded.first.id, seeded.second.id] }, deletedAt: null },
        })).resolves.toBe(0);
    });

    it("stamps the authenticated Account at the Data route and rejects a caller-supplied cross-Account target", async () => {
        const authenticatedAccountId = "account-route-authenticated";
        const otherAccountId = "account-route-other";
        await createPlainAccount(authenticatedAccountId);
        await createPlainAccount(otherAccountId);
        const contract = await materializeFixtureContract();
        const authenticated = await seedAccountCollectionData({ accountId: authenticatedAccountId, contract });
        const other = await seedAccountCollectionData({ accountId: otherAccountId, contract });
        const storageKey = buildPluginAccountStoragePhysicalKey(PLUGIN_ID);
        const settingsKey = buildPluginDeclarativeSettingsPhysicalKey(PLUGIN_ID);
        await db.userKVStore.createMany({
            data: [
                {
                    accountId: authenticatedAccountId,
                    key: storageKey,
                    value: new TextEncoder().encode("authenticated-account-kv"),
                    version: 1,
                },
                {
                    accountId: authenticatedAccountId,
                    key: settingsKey,
                    value: new TextEncoder().encode("authenticated-settings"),
                    version: 1,
                },
                {
                    accountId: otherAccountId,
                    key: storageKey,
                    value: new TextEncoder().encode("other-account-kv"),
                    version: 1,
                },
                {
                    accountId: otherAccountId,
                    key: settingsKey,
                    value: new TextEncoder().encode("other-settings"),
                    version: 1,
                },
            ],
        });

        await withAuthenticatedTestApp((app) => pluginDataRoutes(app), async (app) => {
            const headers = {
                "content-type": "application/json",
                "x-test-user-id": authenticatedAccountId,
                "x-happier-account-stored-content-protocol": String(
                    ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
                ),
            };
            const rejectedCrossAccountTarget = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/account-erase",
                headers,
                payload: { pluginId: PLUGIN_ID, accountId: otherAccountId },
            });
            expect(rejectedCrossAccountTarget.statusCode).toBe(400);
            expect(rejectedCrossAccountTarget.json()).toEqual({
                error: "plugin_account_data_erase_invalid",
            });

            const erased = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/account-erase",
                headers,
                payload: { pluginId: PLUGIN_ID },
            });
            expect(erased.statusCode).toBe(200);
            expect(PluginAccountDataEraseServerOutputV1Schema.parse(erased.json())).toEqual({
                status: "erased",
                changed: true,
            });

            const retried = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/account-erase",
                headers,
                payload: { pluginId: PLUGIN_ID },
            });
            expect(retried.statusCode).toBe(200);
            expect(PluginAccountDataEraseServerOutputV1Schema.parse(retried.json())).toEqual({
                status: "erased",
                changed: false,
            });
        });

        await expect(db.userKVStore.findMany({
            where: { accountId: authenticatedAccountId },
            orderBy: { key: "asc" },
            select: { key: true, value: true },
        })).resolves.toEqual([
            { key: storageKey, value: null },
            { key: settingsKey, value: null },
        ].sort((left, right) => left.key.localeCompare(right.key)));
        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: authenticatedAccountId },
            orderBy: { rowId: "asc" },
            select: { id: true, deletedAt: true },
        })).resolves.toEqual([
            { id: authenticated.first.id, deletedAt: expect.any(Date) },
            { id: authenticated.second.id, deletedAt: expect.any(Date) },
        ]);
        await expect(db.userKVStore.findMany({
            where: { accountId: otherAccountId },
            orderBy: { key: "asc" },
            select: { key: true, value: true },
        })).resolves.toEqual([
            { key: storageKey },
            { key: settingsKey },
        ].sort((left, right) => left.key.localeCompare(right.key)).map(({ key }) => (
            expect.objectContaining({ key, value: expect.any(Uint8Array) })
        )));
        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: otherAccountId },
            orderBy: { rowId: "asc" },
            select: { id: true, deletedAt: true },
        })).resolves.toEqual([
            { id: other.first.id, deletedAt: null },
            { id: other.second.id, deletedAt: null },
        ]);
    });

    it("rejects a terminal credential before it can erase the authenticated Account's plugin data", async () => {
        const accountId = "account-route-terminal-credential";
        await createPlainAccount(accountId);
        const storageKey = buildPluginAccountStoragePhysicalKey(PLUGIN_ID);
        await db.userKVStore.create({
            data: {
                accountId,
                key: storageKey,
                value: new TextEncoder().encode("must-remain-after-terminal-rejection"),
                version: 1,
            },
        });

        await withAuthenticatedTestApp((app) => pluginDataRoutes(app), async (app) => {
            const rejected = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/account-erase",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountId,
                    "x-test-auth-token-kind": "terminal",
                    "x-happier-account-stored-content-protocol": String(
                        ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
                    ),
                },
                payload: { pluginId: PLUGIN_ID },
            });

            expect(rejected.statusCode).toBe(403);
            expect(rejected.json()).toEqual({
                error: "plugin_account_data_erase_present_user_required",
            });
        });

        await expect(db.userKVStore.findUniqueOrThrow({
            where: { accountId_key: { accountId, key: storageKey } },
            select: { value: true },
        })).resolves.toEqual({ value: expect.any(Uint8Array) });
    });

    it("rejects a real terminal-auth token through the production auth decorator before mutating plugin data", async () => {
        const accountId = "account-route-production-terminal-credential";
        await createPlainAccount(accountId);
        const storageKey = buildPluginAccountStoragePhysicalKey(PLUGIN_ID);
        await db.userKVStore.create({
            data: {
                accountId,
                key: storageKey,
                value: new TextEncoder().encode("must-remain-after-production-terminal-rejection"),
                version: 1,
            },
        });
        const terminalToken = await auth.createToken(accountId, {
            session: "terminal-auth-request",
        }, {
            kind: "terminal",
            authority: "account_automation",
        });

        await withProductionAuthenticatedPluginDataApp(async (app) => {
            const rejected = await app.inject({
                method: "POST",
                url: "/v1/plugins/data/account-erase",
                headers: {
                    authorization: `Bearer ${terminalToken}`,
                    "content-type": "application/json",
                    "x-happier-account-stored-content-protocol": String(
                        ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
                    ),
                },
                payload: { pluginId: PLUGIN_ID },
            });

            expect(rejected.statusCode).toBe(403);
            expect(rejected.json()).toEqual({
                error: "plugin_account_data_erase_present_user_required",
            });
        });

        await expect(db.userKVStore.findUniqueOrThrow({
            where: { accountId_key: { accountId, key: storageKey } },
            select: { value: true },
        })).resolves.toEqual({ value: expect.any(Uint8Array) });
    });
});
