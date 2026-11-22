import { resolveMachineRetentionPolicyV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { ManagedAcquireInputV1Schema, ManagedListOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from 'fastify';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { PluginManifestV2Schema } from "@happier-dev/protocol";
import { ManagedMachinePresetRecipientCensusResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { MachineSetupSourcesApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createManagedMachinePresetAcquireOverrideV1, createManagedMachinePresetResizeOverrideV1, createManagedMachinePresetSetupOverrideV1,
    openManagedMachinePresetRecipientProjectionV1, rewrapManagedMachinePresetRecipientsV1,
    replaceManagedMachinePresetLaunchNameV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

import { db } from "@/storage/db";
import { AccountStatus } from '@/storage/enums.generated';
import * as prisma from '@/storage/prisma';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { machinesRoutes } from "@/app/api/routes/machines/machinesRoutes";
import { registerMachinePoolRoutes } from '@/app/api/routes/machines/pools/registerMachinePoolRoutes';
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx, type Tx } from "@/storage/inTx";
import { createQualifiedConnectedAccountIdentityDigest } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import { migrateAccountManagedMachinePresetsForModeInTx, readAccountManagedMachinePresetEncryptionMigrationInventoryInTx, resolveMachinePresetForAcquireInTx } from "./machinePresetService";
import { authorizeMachinePresetCreationSaveInTx } from './machinePresetSave';
import { resolveMachineSetup } from './machineSetup';
import { getManagedMachine, listManagedMachines, readManagedResourceDependenciesInTx } from './managedRead';
import { archiveTeamInTx, restoreTeamInTx } from '@/app/teams/lifecycle';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createEmptyMachineSetupDesiredV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { createReleaseLessDeclarationV1, mergeReleaseLessDeclarationV2 } from "@/app/plugins/availability/currentDeclaration";
import { admitManagedAcquire } from "./managedAcquire";
import { validateManagedCreationBirthInTx } from './managedCreationBirth';
import { transitionSessionArchiveStateInTx } from '@/app/session/archive/transitionSessionArchiveStateInTx';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { admitManagedControl, reportManagedAcquire, reportManagedIntent, reportManagedResize, submitManagedAcquire } from './managedMutations';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { CRABBOX_PLUGIN } from '@happier-dev/plugins-machine-crabbox/manifest';
import { mutateQualifiedConnectedServiceCredential, deleteQualifiedConnectedServiceCredential, listQualifiedConnectedAccounts } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import { defineProtocolObject, defineProtocolString } from "@happier-dev/protocol/plugins/actions/protocol-composable-schema";
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from "@happier-dev/protocol/plugins/contributions/machineProvisioners";

const launch = { provider: { pluginId: "happier.machine.lima", localId: "lima" }, schemaVersion: 1, name: "Launch guest", choices: { image: "linux" } };

async function seedCurrentProvisioner(accountId: string, homeId: string, credentialPurpose?: string | readonly string[], includePrerequisite = false) {
    const credentialPurposes = typeof credentialPurpose === 'string' ? [credentialPurpose] : credentialPurpose ?? [];
    const controller = { machineId: `${accountId}-controller`, installationId: `${accountId}-installation` };
    await db.machine.create({ data: { id: controller.machineId, accountId, metadata: "{}", installationId: controller.installationId, pluginMaterializationRevision: BigInt(1) } });
    const launchSchema = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: "closed" });
    const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: "closed" });
    const roles = defineMachineProvisionerSchemas({ launch: launchSchema, resource: native });
    const actions = [
        { id: "check", inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
        { id: "acquire", inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
        { id: "bootstrap", inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
        { id: "inspect", inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
        { id: "destroy", inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        { id: "power", inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
    ];
    const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: launch.provider.pluginId, version: "1.0.0", displayName: "Preset integration fixture",
        engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 },
        ...(credentialPurposes.length ? { hostAccess: { required: credentialPurposes.map(id => ({ id, capability: "connectedAccounts", reason: "Acquire native resource",
            scope: { serviceRefs: ["native-account"], operations: ["use"] } })), optional: [] } } : {}), contributes: {
            machineProvisioners: [{ id: launch.provider.localId, title: "Guest", icon: "machine", resourceKind: "vm", schemaVersion: 1,
                launchSchema: launchSchema.jsonSchema, resourceSchema: native.jsonSchema,
                platforms: ["linux"], prerequisites: includePrerequisite ? [{ kind: 'systemTool', id: 'shell' }] : [], billing: { location: "local", stoppedBilling: "not-billed" }, retention: { supportedIntents: ["start", "stop", "delete"] },
                actions: { check: "check", acquire: "acquire", bootstrap: "bootstrap", inspect: "inspect", power: "power", destroy: "destroy" } }],
            actions: actions.map(action => ({ ...action, title: action.id, execution: { target: "daemon" },
                surfaces: ["plugin"], scopes: ["global"], dangerLevel: "safe", ...(action.id === "acquire" && credentialPurposes.length ? { hostAccess: credentialPurposes } : {}) })),
        } });
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.accountPluginIntent.create({ data: { accountId, pluginId: manifest.id, enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
    await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId, machineId: controller.machineId, materializationId: controller.installationId,
        pluginId: manifest.id, version: manifest.version, sourceClass: "bundledFirstParty", portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
        uiArtifacts: [], enabled: true, trustState: "trusted", observedAt: new Date() } });
    return controller;
}

async function requestPreset(accountId: string, operation: string, payload: object) {
    const app = createAuthenticatedTestApp();
    machinesRoutes(app);
    await app.ready();
    try {
        return await app.inject({ method: "POST", url: `/v1/machines/presets/${operation}`, headers: { "x-test-user-id": accountId }, payload });
    } finally { await app.close(); }
}

async function readReadyPresetRecipientCensus(accountId: string, input: object) {
    const response = await requestPreset(accountId, 'recipient-census', input);
    expect(response.statusCode, response.body).toBe(200);
    const result = ManagedMachinePresetRecipientCensusResultV1Schema.parse(response.json());
    if (result.kind !== 'ready') throw new Error(`Expected ready recipient census, received ${result.code}`);
    return result;
}

describe("Machine preset relational owner", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-presets-", initAuth: false, initEncrypt: true });
    }, 120_000);

    afterAll(async () => { if (harness) await harness.close(); });

    it('round-trips tagged preset content without projecting private fields into structural columns', async () => {
        const accountId = 'preset-opaque-content-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const content = { t: 'plain' as const, v: { v: 1 as const, name: 'Private preset', launch } };
        const recipients = [] as const;
        const id = 'preset-opaque-content';

        const saved = await requestPreset(accountId, 'create', {
            homeId, id, owner: { kind: 'account', accountId }, contentEncryptionMode: 'plain', content, recipients,
        });

        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json()).toMatchObject({ kind: 'saved', preset: {
            id, homeId, owner: { kind: 'account', accountId }, contentEncryptionMode: 'plain', content, recipients,
        } });
        expect(saved.json().preset).not.toHaveProperty('name');
        expect(saved.json().preset).not.toHaveProperty('launch');
        expect(saved.json().preset).not.toHaveProperty('setup');

        const row = await db.managedMachinePreset.findUniqueOrThrow({ where: { id } });
        expect(row.launch).toEqual({ contentEncryptionMode: 'plain', content, recipients });
        expect(row.setup).toBeNull();
        expect(row.name).toBe('');
    });

    it.each(['plain', 'e2ee'] as const)('persists successive %s configuration counters independently of row revisions', async mode => {
        const accountId = `preset-configuration-counter-${mode}-owner`;
        const homeId = await getOrCreateServerIdentityId();
        const keys = tweetnacl.box.keyPair();
        await db.account.create({ data: { id: accountId, encryptionMode: mode,
            ...createSignedAccountContentBinding(keys.publicKey) } });
        const id = `preset-configuration-counter-${mode}`;
        const owner = { kind: 'account' as const, accountId };
        const census = await readReadyPresetRecipientCensus(accountId, { homeId, owner });
        const seal = (presetId: string, image: string, name = 'Counter preset') => sealManagedMachinePresetContentV1({
            presetId, mode, content: { v: 1, name, launch: { ...launch, choices: { image } } },
            recipientCensus: census.recipients, randomBytes: tweetnacl.randomBytes,
        });
        // Legacy clients omit the additive counter; the persisted initial value is zero.
        const definition = { homeId, id, owner, contentEncryptionMode: mode, ...seal(id, 'image-a') };
        const created = await requestPreset(accountId, 'create', definition);
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({ kind: 'saved', preset: { configurationRevision: 0, revision: 0 } });
        expect((await requestPreset(accountId, 'create', definition)).json()).toMatchObject({
            kind: 'saved', preset: { configurationRevision: 0, revision: 0 },
        });

        for (const [image, expectedCounter] of [['image-b', 1], ['image-c', 2]] as const) {
            const current = (await requestPreset(accountId, 'get', { homeId, id })).json().preset;
            const updated = await requestPreset(accountId, 'update', { homeId, id, expectedRevision: current.revision,
                patch: { ...seal(id, image), configurationRevision: (current.configurationRevision ?? 0) + 1 } });
            expect(updated.statusCode, updated.body).toBe(200);
            expect(updated.json()).toMatchObject({ kind: 'saved', preset: { configurationRevision: expectedCounter } });
        }
        const beforeOperationalWrite = (await requestPreset(accountId, 'get', { homeId, id })).json().preset;
        const metadataSave = await requestPreset(accountId, 'update', { homeId, id,
            expectedRevision: beforeOperationalWrite.revision, patch: { wakeOnAcceptedMessage: true } });
        expect(metadataSave.json()).toMatchObject({ kind: 'saved', preset: { configurationRevision: 2, revision: 3 } });
        // Rename/reseal content writes omit the authored counter.
        const resealed = await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 3,
            patch: seal(id, 'image-c', 'Renamed counter preset') });
        expect(resealed.statusCode, resealed.body).toBe(200);
        expect(resealed.json()).toMatchObject({ kind: 'saved', preset: { configurationRevision: 2, revision: 4 } });
        expect((await requestPreset(accountId, 'list', { homeId })).json().presets).toContainEqual(resealed.json().preset);
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id } })).toMatchObject({ configurationRevision: 2 });

        const copiedId = `${id}-copy`;
        const copied = await requestPreset(accountId, 'create', { homeId, id: copiedId, owner, contentEncryptionMode: mode,
            ...seal(copiedId, 'image-c'), configurationRevision: 2 });
        expect(copied.statusCode, copied.body).toBe(200);
        expect(copied.json()).toMatchObject({ kind: 'saved', preset: { configurationRevision: 2, revision: 0 } });
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: copiedId } })).toMatchObject({ configurationRevision: 2 });
    });

    it.each(['plain', 'e2ee'] as const)('persists setup-only %s counters and returns bodyless revision headers', async mode => {
        const accountId = `preset-setup-counter-${mode}-owner`;
        const homeId = await getOrCreateServerIdentityId();
        const keys = tweetnacl.box.keyPair();
        await db.account.create({ data: { id: accountId, encryptionMode: mode,
            ...createSignedAccountContentBinding(keys.publicKey) } });
        const id = `preset-setup-counter-${mode}`;
        const owner = { kind: 'account' as const, accountId };
        const census = await readReadyPresetRecipientCensus(accountId, { homeId, owner });
        const seal = (name: string, setup = {}) => sealManagedMachinePresetContentV1({ presetId: id, mode,
            content: { v: 1, name, launch, setup }, recipientCensus: census.recipients, randomBytes: tweetnacl.randomBytes });
        const created = await requestPreset(accountId, 'create', { homeId, id, owner, contentEncryptionMode: mode,
            ...seal('Initial'), setupRevision: 1 });
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({ kind: 'saved', preset: { id, setupRevision: 1, revision: 0 } });
        const updated = await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 0,
            patch: { ...seal('Changed', { scripts: [{ body: 'echo changed', affects: 'none' }] }), setupRevision: 3 } });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(updated.json()).toMatchObject({ kind: 'saved', preset: { id, setupRevision: 3, revision: 1 } });
        expect((await requestPreset(accountId, 'get', { homeId, id })).json())
            .toMatchObject({ kind: 'found', preset: { setupRevision: 3 } });
        const renamed = await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 1,
            patch: seal('Renamed', { scripts: [{ body: 'echo changed', affects: 'none' }] }) });
        expect(renamed.json()).toMatchObject({ kind: 'saved', preset: { setupRevision: 3, revision: 2 } });
        const headers = await requestPreset(accountId, 'list', { homeId, projection: 'revisions', includeArchived: true });
        expect(headers.statusCode, headers.body).toBe(200);
        expect(headers.json()).toEqual({ kind: 'revisions', presets: [{ id, homeId, revision: 2, setupRevision: 3 }] });
    });

    it.each(['plain', 'e2ee'] as const)('reads retained raw %s-author presets without rewriting and seals only on normal save', async mode => {
        const accountId = `preset-legacy-${mode}-owner`;
        const homeId = await getOrCreateServerIdentityId();
        const keys = tweetnacl.box.keyPair();
        await db.account.create({ data: { id: accountId, encryptionMode: mode,
            ...createSignedAccountContentBinding(keys.publicKey) } });
        const setup = { scripts: [{ body: 'echo retained raw setup' }] };
        const raw = await db.managedMachinePreset.create({ data: {
            id: `preset-legacy-${mode}`, homeId, custodianAccountId: accountId,
            name: 'Retained raw preset', launch: { ...launch, controllerDisplayName: 'Retained builder' }, setup,
        } });
        const target = { homeId, id: raw.id };
        const expectedContent = { t: 'plain', v: { v: 1, name: raw.name, launch, setup,
            controllerDisplayName: 'Retained builder' } };
        const get = await requestPreset(accountId, 'get', target);
        expect(get.statusCode, get.body).toBe(200);
        expect(get.json()).toMatchObject({ kind: 'found', preset: {
            id: raw.id, revision: 0, configurationRevision: 0, contentEncryptionMode: 'plain', content: expectedContent, recipients: [],
        } });
        const listed = await requestPreset(accountId, 'list', { homeId });
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json().presets).toContainEqual(get.json().preset);
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: raw.id } })).toEqual(raw);
        const inventory = await inTx(tx => readAccountManagedMachinePresetEncryptionMigrationInventoryInTx(tx, { accountId }));
        expect(inventory.presets).toEqual([{ presetId: raw.id, expectedRevision: 0,
            contentEncryptionMode: 'plain', content: expectedContent, recipientEnvelope: null }]);
        if (mode === 'e2ee') {
            const metadataSave = await requestPreset(accountId, 'update', { ...target, expectedRevision: 0,
                patch: { wakeOnAcceptedMessage: true } });
            expect(metadataSave.statusCode, metadataSave.body).toBe(400);
            expect(metadataSave.json()).toEqual({ kind: 'refused', code: 'account_mode_mismatch' });
            expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: raw.id } })).toEqual(raw);
        }

        const owner = { kind: 'account' as const, accountId };
        const census = await readReadyPresetRecipientCensus(accountId, { homeId, presetId: raw.id, owner });
        expect(census.contentEncryptionMode).toBe(mode);
        const sealed = sealManagedMachinePresetContentV1({ presetId: raw.id, mode,
            content: { v: 1, name: raw.name, launch, setup, controllerDisplayName: 'Retained builder' },
            recipientCensus: census.recipients, randomBytes: tweetnacl.randomBytes });
        const saved = await requestPreset(accountId, 'update', { ...target, expectedRevision: 0,
            patch: { contentEncryptionMode: mode, content: sealed.content, recipients: sealed.recipients } });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json()).toMatchObject({ kind: 'saved', preset: { revision: 1,
            contentEncryptionMode: mode, content: sealed.content, recipients: sealed.recipients } });
        const current = await db.managedMachinePreset.findUniqueOrThrow({ where: { id: raw.id } });
        expect(current).toMatchObject({ name: '', setup: null, launch: {
            contentEncryptionMode: mode, content: sealed.content, recipients: sealed.recipients } });
        if (mode === 'e2ee') expect(JSON.stringify(current)).not.toContain('Retained raw preset');
    });

    it('reads retained raw managed snapshots without rewriting their private native state', async () => {
        const accountId = 'preset-raw-snapshot-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, encryptionMode: 'e2ee' } });
        const source = await db.managedMachinePreset.create({ data: { id: 'preset-raw-snapshot', homeId,
            custodianAccountId: accountId, name: 'Retained source', launch } });
        const resource = { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'retained-native-id' } };
        const row = await db.managedMachine.create({ data: { id: 'preset-raw-snapshot-managed', homeId,
            custodianAccountId: accountId, presetId: source.id, presetRevision: 0, launch, resource,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, allocation: 'bound',
            desired: 'start', desiredWhen: 'now', admittedActionRequestId: 'preset-raw-snapshot-create', admittedInput: {
                enrollmentAccountId: accountId, continuation: null,
                computeInput: { selection: { kind: 'preset', homeId, id: source.id, revision: 0, name: launch.name },
                    enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            } } });
        const current = await getManagedMachine({ actorAccountId: accountId, input: { homeId, managedId: row.id } });
        expect(current).toMatchObject({ id: row.id, launch, resource,
            preset: { id: source.id, revision: 0, contentEncryptionMode: 'plain' } });
        const listed = await listManagedMachines({ actorAccountId: accountId, input: { homeId, presetId: source.id } });
        expect(listed.machines).toContainEqual(current);
        const inventory = await inTx(tx => readAccountManagedMachinePresetEncryptionMigrationInventoryInTx(tx, { accountId }));
        expect(inventory.snapshots).toMatchObject([{ managedId: row.id, presetId: source.id,
            contentEncryptionMode: 'plain', content: { t: 'plain', v: { launch, nativeResult: { kind: 'bound', resource } } } }]);
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
        const recovery = { reference: 'retained-native-recovery', reason: 'native_read_unavailable' };
        await db.managedMachine.update({ where: { id: row.id }, data: {
            resource: prisma.getActivePrismaRuntime().DbNull, allocation: 'may-exist', recovery,
        } });
        const recoverable = await getManagedMachine({ actorAccountId: accountId, input: { homeId, managedId: row.id } });
        expect(recoverable).toMatchObject({ launch, recovery });
        expect((await listManagedMachines({ actorAccountId: accountId, input: { homeId, presetId: source.id } })).machines)
            .toContainEqual(recoverable);
        const recoveryInventory = await inTx(tx => readAccountManagedMachinePresetEncryptionMigrationInventoryInTx(tx, { accountId }));
        expect(recoveryInventory.snapshots[0]!.content).toMatchObject({ t: 'plain', v: { nativeResult: { kind: 'unknown', recovery } } });
        await db.managedMachine.update({ where: { id: row.id }, data: {
            resource, allocation: 'bound', recovery: prisma.getActivePrismaRuntime().DbNull,
        } });
        const nativeOperationRef = { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'retained-delete-operation' } };
        await db.managedMachine.update({ where: { id: row.id }, data: { nativeOperationRef, desired: 'delete', admittedInput: {
            enrollmentAccountId: accountId, submittedEffect: { homeId, managedId: row.id, expectedIntentRevision: 0,
                requestId: row.admittedActionRequestId, intent: 'delete' },
        } } });
        const deleting = await getManagedMachine({ actorAccountId: accountId, input: { homeId, managedId: row.id } });
        expect(deleting).toMatchObject({ resource, nativeOperationRef, desired: 'delete' });
        expect((await listManagedMachines({ actorAccountId: accountId, input: { homeId, presetId: source.id } })).machines)
            .toContainEqual(deleting);
        const deletingInventory = await inTx(tx => readAccountManagedMachinePresetEncryptionMigrationInventoryInTx(tx, { accountId }));
        expect(deletingInventory.snapshots[0]!.content).toMatchObject({ t: 'plain', v: {
            nativeResult: { kind: 'bound', resource }, nativeControlResult: { kind: 'delete', result: { kind: 'accepted', nativeOperationRef } },
        } });
        await db.managedMachine.update({ where: { id: row.id }, data: { desired: row.desired,
            nativeOperationRef: prisma.getActivePrismaRuntime().DbNull,
            admittedInput: { enrollmentAccountId: accountId, continuation: null,
                computeInput: { selection: { kind: 'preset', homeId, id: source.id, revision: 0, name: launch.name },
                    enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } },
        } });
        const sourceContent = inventory.presets[0]!.content;
        const snapshotContent = inventory.snapshots[0]!;
        const migration = {
            accountId, fromMode: 'e2ee' as const, toMode: 'plain' as const, ownerContentPublicKeyFingerprint: null,
            directive: {
                presets: [{ presetId: source.id, expectedRevision: 0, replacement: { content: sourceContent, recipients: [] } }],
                snapshots: [{ managedId: row.id, presetId: source.id, expectedContentEncryptionMode: 'plain' as const,
                    expectedContent: snapshotContent.content, expectedRecipientEnvelope: null,
                    replacement: { content: snapshotContent.content, recipients: [] } }],
            },
        };
        const unresolved = await db.managedMachine.update({ where: { id: row.id }, data: { recovery } });
        const retained = await getManagedMachine({ actorAccountId: accountId, input: { homeId, managedId: row.id } });
        expect(retained).toMatchObject({ launch, resource, recovery });
        expect((await listManagedMachines({ actorAccountId: accountId, input: { homeId, presetId: source.id } })).machines)
            .toContainEqual(retained);
        expect(await inTx(tx => migrateAccountManagedMachinePresetsForModeInTx(tx, migration))).toEqual({ status: 'invalid_content' });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(unresolved);
        expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: source.id } })).revision).toBe(0);
        await db.managedMachine.update({ where: { id: row.id }, data: { recovery: prisma.getActivePrismaRuntime().DbNull } });
        expect(await inTx(tx => migrateAccountManagedMachinePresetsForModeInTx(tx, migration))).toEqual({ status: 'applied' });
        const resealed = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        expect(resealed).toMatchObject({ launch: { contentEncryptionMode: 'plain', content: snapshotContent.content, recipients: [] },
            resource: null, nativeOperationRef: null, recovery: null, reviewedFacts: null,
            admittedInput: { enrollmentAccountId: accountId, continuation: null, computeInput: {
                selection: { kind: 'preset', homeId, id: source.id, revision: 0 },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } } });
        expect(JSON.stringify(resealed.admittedInput)).not.toContain('enrollmentIdentity');
        expect(JSON.stringify(resealed.admittedInput)).not.toContain(launch.name);
        expect(snapshotContent.content).toMatchObject({ t: 'plain', v: { enrollmentIdentity: { kind: 'existingUser', role: 'adopted' } } });
    });

    it('normalizes settled resize replay content during encryption migration and preserves an unincorporated override', async () => {
        const accountId = 'preset-migration-resize-owner';
        const homeId = await getOrCreateServerIdentityId();
        const keys = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(keys.publicKey);
        await db.account.create({ data: { id: accountId, encryptionMode: 'e2ee', ...binding } });
        const presetId = 'preset-migration-resize';
        const sourceBody = { v: 1 as const, name: 'Private source', launch };
        const snapshotBody = { v: 1 as const, name: 'Incorporated private resize', launch };
        const sourceContent = { t: 'plain' as const, v: sourceBody };
        const snapshotContent = { t: 'plain' as const, v: snapshotBody };
        await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: accountId,
            name: '', launch: { contentEncryptionMode: 'plain', content: sourceContent, recipients: [] } } });
        const census = await readReadyPresetRecipientCensus(accountId, { homeId, owner: { kind: 'account', accountId } });
        const seal = (content: typeof sourceBody) => sealManagedMachinePresetContentV1({ presetId, mode: 'e2ee', content,
            recipientCensus: census.recipients, randomBytes: tweetnacl.randomBytes });
        const sealedSource = seal(sourceBody);
        const sealedSnapshot = seal(snapshotBody);
        const managedId = 'preset-migration-resize-managed';
        const request = { action: 'machines.managed.resize' as const, requestId: 'preset-migration-resize-request', input: {
            homeId, managedId, size: { cpuCores: 8 }, reviewedFacts: { name: 'Old private review facts' },
            presetContentOverride: { content: { t: 'plain' as const, v: {
                ...snapshotBody, name: 'Old private resize delta', resize: { cpuCores: 8 },
            } } },
        } };
        const pendingAdmission = { enrollmentAccountId: accountId, presetContentOverride: request.input.presetContentOverride,
            currentAdmission: { kind: 'control', request } };
        const row = await db.managedMachine.create({ data: { id: managedId, homeId, custodianAccountId: accountId,
            presetId, presetRevision: 0, launch: { contentEncryptionMode: 'plain', content: snapshotContent, recipients: [] },
            admittedActionRequestId: 'preset-migration-resize-create', admittedInput: pendingAdmission,
            allocation: 'bound', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } });
        const input = { accountId, fromMode: 'plain' as const, toMode: 'e2ee' as const,
            ownerContentPublicKeyFingerprint: sealedSource.recipients[0]!.envelope.recipientContentPublicKeyFingerprint,
            directive: {
                presets: [{ presetId, expectedRevision: 0, replacement: sealedSource }],
                snapshots: [{ managedId, presetId, expectedContentEncryptionMode: 'plain' as const,
                    expectedContent: snapshotContent, expectedRecipientEnvelope: null, replacement: sealedSnapshot }],
            },
        };
        expect(await inTx(tx => migrateAccountManagedMachinePresetsForModeInTx(tx, input))).toEqual({ status: 'invalid_content' });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managedId } })).toEqual(row);
        expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: presetId } })).revision).toBe(0);
        await db.managedMachine.update({ where: { id: managedId }, data: { admittedInput: {
            enrollmentAccountId: accountId, currentAdmission: { kind: 'control', request, resizeSettled: true },
        } } });
        expect(await inTx(tx => migrateAccountManagedMachinePresetsForModeInTx(tx, input))).toEqual({ status: 'applied' });
        const migrated = await db.managedMachine.findUniqueOrThrow({ where: { id: managedId } });
        expect(migrated.admittedInput).toMatchObject({ enrollmentAccountId: accountId, currentAdmission: {
            kind: 'control', resizeSettled: true, request: { action: request.action, requestId: request.requestId,
                input: { homeId, managedId, presetContentOverride: { content: sealedSnapshot.content } } },
        } });
        expect(JSON.stringify(migrated)).not.toContain('Old private resize delta');
        expect(JSON.stringify(migrated)).not.toContain('Old private review facts');
        expect(migrated.admittedInput).not.toHaveProperty('currentAdmission.request.input.size');
        expect(JSON.stringify(migrated)).not.toContain('Incorporated private resize');
        await expect(admitManagedControl({ actorAccountId: accountId, custodianAccountId: accountId, input: {
            action: request.action, requestId: request.requestId,
            input: { homeId, managedId, presetContentOverride: request.input.presetContentOverride },
        } }))
            .rejects.toMatchObject({ code: 'account_mode_mismatch' });
    });

    it('refuses a tagged preset whose content mode disagrees with the author Account mode', async () => {
        const accountId = 'preset-mode-mismatch-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });

        const response = await requestPreset(accountId, 'create', {
            homeId, id: 'preset-mode-mismatch', owner: { kind: 'account', accountId },
            contentEncryptionMode: 'e2ee', content: { t: 'encrypted', c: encodeBase64(new Uint8Array(40)) }, recipients: [],
        });

        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toEqual({ kind: 'refused', code: 'account_mode_mismatch' });
        expect(await db.managedMachinePreset.findUnique({ where: { id: 'preset-mode-mismatch' } })).toBeNull();
    });

    it('keeps opaque preset save authority unavailable to an inactive account', async () => {
        const accountId = 'preset-save-inactive-account';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, status: AccountStatus.disabled, encryptionMode: 'plain' } });

        await expect(inTx(tx => authorizeMachinePresetCreationSaveInTx(tx, { accountId }, {
            homeId,
            owner: { kind: 'account', accountId },
        }))).rejects.toMatchObject({ code: 'permission_denied' });
    });

    it('refuses an E2EE Team preset census when the selected controller custodian is outside the Team audience', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-census-team-owner';
        const member = 'preset-census-team-member';
        const outsider = 'preset-census-controller-outsider';
        for (const id of [owner, member, outsider]) {
            const keys = tweetnacl.box.keyPair();
            await db.account.create({ data: { id, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        }
        const team = await db.team.create({ data: { name: 'Preset census Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const controller = await seedCurrentProvisioner(outsider, homeId);
        await db.machineGrant.create({ data: { principalKind: 'account',
            machineId: controller.machineId, accountId: owner, accessLevel: 'admin', createdByAccountId: outsider,
        } });

        const response = await requestPreset(owner, 'recipient-census', {
            homeId, owner: { kind: 'team', teamId: team.id }, controller,
        });

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ kind: 'refused', code: 'credential_unavailable' });
    });

    it('keeps E2EE Team recipient census and save structural when its controller is retired', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const manager = 'preset-census-retired-manager';
        const custodian = 'preset-census-retired-custodian';
        const managerKeys = tweetnacl.box.keyPair();
        const custodianKeys = tweetnacl.box.keyPair();
        await db.account.createMany({ data: [
            { id: manager, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(managerKeys.publicKey) },
            { id: custodian, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(custodianKeys.publicKey) },
        ] });
        const team = await db.team.create({ data: { name: 'Retired controller recipient census' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: manager, role: 'admin' },
            { teamId: team.id, accountId: custodian, role: 'member' },
        ] });
        const controller = await seedCurrentProvisioner(custodian, homeId);
        await db.machineGrant.create({ data: { principalKind: 'account',
            machineId: controller.machineId, accountId: manager, accessLevel: 'admin', createdByAccountId: custodian,
        } });
        await db.machine.update({ where: { id: controller.machineId }, data: { revokedAt: new Date() } });

        const id = 'preset-census-retired-controller';
        const target = { homeId, owner: { kind: 'team' as const, teamId: team.id }, controller };
        const census = await readReadyPresetRecipientCensus(manager, target);
        expect(census.recipients.map((recipient) => recipient.account.accountId)).toEqual([custodian, manager]);
        const sealed = sealManagedMachinePresetContentV1({
            presetId: id, mode: 'e2ee', content: { v: 1, name: 'Retired controller structural save', launch },
            recipientCensus: census.recipients, randomBytes: tweetnacl.randomBytes,
        });
        const saved = await requestPreset(manager, 'create', {
            ...target, id, contentEncryptionMode: 'e2ee', content: sealed.content, recipients: sealed.recipients,
        });

        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json()).toMatchObject({ kind: 'saved', preset: {
            id, contentEncryptionMode: 'e2ee', recipients: [{ accountId: custodian }, { accountId: manager }],
        } });
    });

    it('seals a new Team preset revision to current principals after its author leaves', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const author = 'preset-team-former-author';
        const manager = 'preset-team-current-manager';
        const authorKeys = tweetnacl.box.keyPair();
        const managerKeys = tweetnacl.box.keyPair();
        await db.account.createMany({ data: [
            { id: author, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(authorKeys.publicKey) },
            { id: manager, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(managerKeys.publicKey) },
        ] });
        const team = await db.team.create({ data: { name: 'Current Team preset recipients' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: author, role: 'owner' },
            { teamId: team.id, accountId: manager, role: 'admin' },
        ] });
        const controller = await seedCurrentProvisioner(manager, homeId);
        await db.machineGrant.create({ data: { principalKind: 'account',
            machineId: controller.machineId, accountId: author, accessLevel: 'admin', createdByAccountId: manager,
        } });
        const id = 'preset-team-current-principals';
        const createTarget = { homeId, owner: { kind: 'team' as const, teamId: team.id }, controller };
        const target = { ...createTarget, presetId: id };
        const initialCensus = await readReadyPresetRecipientCensus(author, createTarget);
        const initial = sealManagedMachinePresetContentV1({
            presetId: id, mode: 'e2ee', content: { v: 1, name: 'Former author revision', launch },
            recipientCensus: initialCensus.recipients, randomBytes: tweetnacl.randomBytes,
        });
        expect((await requestPreset(author, 'create', {
            homeId, id, owner: target.owner, controller, contentEncryptionMode: 'e2ee',
            content: initial.content, recipients: initial.recipients,
        })).statusCode).toBe(200);

        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: author } },
            data: { status: 'suspended' } });

        // A content revision has a fresh DEK, so it asks the structural census
        // rather than the persisted-row repair census that reports prepared envelopes.
        const managerCensus = await readReadyPresetRecipientCensus(manager, createTarget);
        expect(managerCensus.recipients.map((recipient) => recipient.account.accountId)).toEqual([manager]);
        const revised = sealManagedMachinePresetContentV1({
            presetId: id, mode: 'e2ee', content: { v: 1, name: 'Current manager revision', launch },
            recipientCensus: managerCensus.recipients, randomBytes: tweetnacl.randomBytes,
        });
        expect((await requestPreset(manager, 'update', { homeId, id, expectedRevision: 0,
            patch: { content: revised.content, recipients: revised.recipients } })).json()).toMatchObject({
            kind: 'saved', preset: { revision: 1, recipients: [{ accountId: manager }] },
        });
        expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id } })).launch).toMatchObject({
            recipients: [{ accountId: manager }],
        });
    });

    it('admits encrypted preset content as an opaque structural row and replays the same envelope', async () => {
        const accountId = 'preset-opaque-admission-owner';
        const homeId = await getOrCreateServerIdentityId();
        const accountKeys = tweetnacl.box.keyPair();
        await db.account.create({ data: { id: accountId, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(accountKeys.publicKey) } });
        const id = 'preset-opaque-admission';
        const census = await readReadyPresetRecipientCensus(accountId, {
            homeId, owner: { kind: 'account', accountId },
        });
        expect(census.contentEncryptionMode).toBe('e2ee');
        const sealed = sealManagedMachinePresetContentV1({
            presetId: id,
            mode: 'e2ee',
            content: { v: 1, name: 'Private E2EE preset', launch },
            recipientCensus: census.recipients,
            randomBytes: tweetnacl.randomBytes,
        });
        const saved = await requestPreset(accountId, 'create', {
            homeId, id, owner: { kind: 'account', accountId }, contentEncryptionMode: 'e2ee',
            content: sealed.content, recipients: sealed.recipients,
        });
        expect(saved.statusCode, saved.body).toBe(200);
        const enrollmentIdentity = {
            kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
            role: 'server' as const, adminAccessAtCreation: 'ask' as const,
            administrator: { username: 'private-preset-administrator' },
        };
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId: id,
            mode: 'e2ee',
            projection: { content: sealed.content, recipientEnvelope: sealed.recipients[0]!.envelope },
            accountId,
            accountKey: accountKeys.secretKey,
            launchName: 'Private allocation name',
            enrollmentIdentity,
            randomBytes: tweetnacl.randomBytes,
        });
        if (!presetContentOverride) throw new Error('Expected opaque acquire override');

        const request = {
            custodianAccountId: accountId, requesterAccountId: accountId,
            requestEnvelopeDigest: 'opaque-admission-envelope',
            input: { requestId: 'opaque-admission-request', continuationPresent: false, input: {
                selection: { kind: 'preset' as const, homeId, id, revision: 0 },
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
                presetContentOverride,
            } },
        };
        const admitted = await admitManagedAcquire(request);
        expect(admitted).toMatchObject({ presetContent: { content: sealed.content, recipients: sealed.recipients }, presetContentOverride, replayed: false,
            machine: { id: expect.any(String), preset: { id, revision: 0 }, retention: { kind: 'until-delete' } } });
        expect(admitted.machine).not.toHaveProperty('launch');
        expect(admitted.machine).not.toHaveProperty('machineSetup');
        expect(admitted.machine).not.toHaveProperty('reviewedFacts');
        expect(admitted.machine).not.toHaveProperty('enrollmentIdentity');

        const row = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } });
        expect(row.launch).toEqual({ contentEncryptionMode: 'e2ee', content: sealed.content, recipients: sealed.recipients });
        expect(JSON.stringify(row)).not.toContain('Private E2EE preset');
        expect(JSON.stringify(row)).not.toContain('Launch guest');
        expect(JSON.stringify(row)).not.toContain('Private allocation name');
        expect(JSON.stringify(row)).not.toContain('private-preset-administrator');
        expect(row.reviewedFacts).toBeNull();
        expect(row.machineSetup).toBeNull();
        expect(row.admittedInput).not.toHaveProperty('presetContent');

        const replayOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId: id,
            mode: 'e2ee',
            projection: { content: sealed.content, recipientEnvelope: sealed.recipients[0]!.envelope },
            accountId,
            accountKey: accountKeys.secretKey,
            launchName: 'Conflicting retry name',
            enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
            randomBytes: tweetnacl.randomBytes,
        });
        if (!replayOverride) throw new Error('Expected opaque retry override');
        const replay = await admitManagedAcquire({ ...request, input: { ...request.input, input: {
            ...request.input.input, presetContentOverride: replayOverride,
        } } });
        expect(replay).toMatchObject({ replayed: true, machine: { id: admitted.machine.id },
            presetContent: { content: sealed.content, recipients: sealed.recipients }, presetContentOverride });
        expect(replay.machine).not.toHaveProperty('launch');

        const read = await getManagedMachine({ actorAccountId: accountId,
            input: { homeId, managedId: admitted.machine.id } });
        expect(read).toMatchObject({ machine: { id: admitted.machine.id, preset: { id, revision: 0 } },
            presetContent: { content: sealed.content, recipientEnvelope: sealed.recipients[0]!.envelope } });
        expect(read).not.toHaveProperty('recipients');
        expect(read.machine).not.toHaveProperty('launch');

        const listed = await listManagedMachines({ actorAccountId: accountId, input: { homeId } });
        expect(listed.machines).toEqual(expect.arrayContaining([expect.objectContaining({
            machine: expect.objectContaining({ id: admitted.machine.id }),
            presetContent: expect.objectContaining({ content: sealed.content, recipientEnvelope: sealed.recipients[0]!.envelope }),
        })]));
        const listedOpaque = listed.machines.find((machine) => 'machine' in machine && machine.machine.id === admitted.machine.id);
        expect(listedOpaque).toBeDefined();
        expect(listedOpaque).not.toHaveProperty('recipients');

        const correlation = { homeId, managedId: admitted.machine.id, expectedIntentRevision: admitted.machine.intentRevision,
            requestId: request.input.requestId };
        await submitManagedAcquire(correlation);
        // Account retirement still needs the retained allocation/custody fact,
        // but the Home must not open this preset's provider or setup to find it.
        const dependencies = await inTx(tx => readManagedResourceDependenciesInTx(tx, { kind: 'account', accountId }));
        expect(dependencies).toEqual(expect.arrayContaining([expect.objectContaining({
            managedId: admitted.machine.id,
            homeId,
            custodianAccountId: accountId,
            opaquePreset: true,
        })]));
        const dependency = dependencies.find(candidate => candidate.managedId === admitted.machine.id);
        expect(dependency).not.toHaveProperty('provider');
        const nativeResult = { kind: 'bound' as const, resource: {
            contributionRef: launch.provider, schemaVersion: 1,
            value: { namespace: 'private-team-namespace', transport: 'private-transport', backendId: 'private-backend-id' },
        } };
        const observation = {
            observedAt: 123, availability: 'present' as const, power: 'running' as const, storage: 'retained' as const,
            size: { cpuCores: 8, memoryBytes: 34_359_738_368 },
            prices: [{ amount: '12.34', currency: 'USD', unit: 'month', source: 'private-plan', observedAt: 123 }],
            nativeCause: { localCause: 'native_command_failed' as const, command: 'create' as const,
                exitCode: 1, stderr: '/private/namespace/backend' },
        };
        const snapshotContent = replaceManagedMachinePresetLaunchNameV1({
            presetId: id,
            mode: 'e2ee',
            content: presetContentOverride.content,
            recipients: sealed.recipients,
            accountId,
            accountKey: accountKeys.secretKey,
            launchName: 'Daemon final private name',
            reviewedFacts: {
                launch: { ...launch, name: 'Daemon final private name' }, optionStatus: 'current', prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            },
            nativeResult,
            observation,
            randomBytes: tweetnacl.randomBytes,
        });
        if (!snapshotContent) throw new Error('Expected resealed controller snapshot');
        const report = { ...correlation, result: { kind: 'bound' as const } };
        // The outer report is structural only. Provider-native values must be
        // sealed in presetContent, not accepted because a daemon chose not to send them.
        await expect(reportManagedAcquire({ ...correlation, result: nativeResult, presetContent: snapshotContent, observation }))
            .rejects.toThrow();
        await expect(reportManagedAcquire({ ...report, presetContent: { t: 'plain', v: {} } }))
            .rejects.toMatchObject({ code: 'account_mode_mismatch' });
        await reportManagedAcquire({ ...report, presetContent: snapshotContent,
            observation: { observedAt: observation.observedAt, availability: observation.availability,
                power: observation.power, storage: observation.storage } });
        const snapshotted = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } });
        expect(snapshotted.launch).toEqual({ contentEncryptionMode: 'e2ee', content: snapshotContent, recipients: sealed.recipients });
        expect(snapshotted.admittedInput).not.toHaveProperty('presetContentOverride');
        expect(snapshotted.resource).toBeNull();
        expect(snapshotted.nativeOperationRef).toBeNull();
        expect(snapshotted.recovery).toBeNull();
        expect(snapshotted.observation).toEqual({ observedAt: observation.observedAt, availability: observation.availability,
            power: observation.power, storage: observation.storage });
        expect(JSON.stringify(snapshotted)).not.toContain('private-team-namespace');
        expect(JSON.stringify(snapshotted)).not.toContain('private-transport');
        expect(JSON.stringify(snapshotted)).not.toContain('private-backend-id');
        expect(JSON.stringify(snapshotted)).not.toContain('/private/namespace/backend');
        const afterSnapshot = await getManagedMachine({ actorAccountId: accountId,
            input: { homeId, managedId: admitted.machine.id } });
        expect(afterSnapshot).toMatchObject({ presetContent: { content: snapshotContent,
            recipientEnvelope: sealed.recipients[0]!.envelope } });
        expect(afterSnapshot.machine).not.toHaveProperty('resource');
        expect(afterSnapshot.machine).not.toHaveProperty('nativeOperationRef');
        expect(afterSnapshot.machine).not.toHaveProperty('recovery');
        expect(afterSnapshot.machine.observation).toEqual({ observedAt: observation.observedAt, availability: observation.availability,
            power: observation.power, storage: observation.storage });
        const postReportDependency = (await inTx(tx => readManagedResourceDependenciesInTx(tx, { kind: 'account', accountId })))
            .find(candidate => candidate.managedId === admitted.machine.id);
        expect(postReportDependency).toBeDefined();
        expect(postReportDependency).not.toHaveProperty('resource');
        expect(postReportDependency).not.toHaveProperty('nativeOperationRef');
        expect(postReportDependency).not.toHaveProperty('recovery');

        // A preset resize never sends the private requested size through Home.
        // The same server control owner still rejects the one-off wire arm when
        // its persisted row is opaque.
        await expect(admitManagedControl({ actorAccountId: accountId, custodianAccountId: accountId, input: {
            action: 'machines.managed.resize', requestId: 'opaque-raw-resize',
            input: { homeId, managedId: admitted.machine.id, size: { cpuCores: 16, memoryBytes: 68_719_476_736 } },
        } })).rejects.toMatchObject({ code: 'invalid_request' });

        const resizeOverride = createManagedMachinePresetResizeOverrideV1({
            presetId: id,
            mode: 'e2ee',
            projection: { content: snapshotContent, recipientEnvelope: sealed.recipients[0]!.envelope },
            accountId,
            accountKey: accountKeys.secretKey,
            size: { cpuCores: 16, memoryBytes: 68_719_476_736 },
            randomBytes: tweetnacl.randomBytes,
        });
        if (!resizeOverride) throw new Error('Expected opaque resize override');
        const resizeAdmission = await admitManagedControl({ actorAccountId: accountId, custodianAccountId: accountId, input: {
            action: 'machines.managed.resize', requestId: 'opaque-sealed-resize',
            input: { homeId, managedId: admitted.machine.id, presetContentOverride: resizeOverride },
        } });
        expect(resizeAdmission).toMatchObject({ replayed: false, presetContentOverride: resizeOverride });
        expect(JSON.stringify(await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } })))
            .not.toContain('68719476736');

        const resizeSnapshot = replaceManagedMachinePresetLaunchNameV1({
            presetId: id,
            mode: 'e2ee',
            content: resizeOverride.content,
            recipients: sealed.recipients,
            accountId,
            accountKey: accountKeys.secretKey,
            launchName: 'Daemon final private name',
            nativeControlResult: {
                kind: 'resize',
                result: { kind: 'unknown', code: 'private_resize_unknown', nativeCause: {
                    localCause: 'native_command_failed', command: 'update', exitCode: 1, stderr: '/private/resize/diagnostic',
                } },
            },
            randomBytes: tweetnacl.randomBytes,
        });
        if (!resizeSnapshot) throw new Error('Expected opaque resize snapshot');
        const resizeReport = {
            homeId,
            managedId: admitted.machine.id,
            requestId: 'opaque-sealed-resize',
        };
        const where = { id: admitted.machine.id };
        const beforeResizeReport = await db.managedMachine.findUniqueOrThrow({ where });
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        try {
            const invalidResize = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report-resize',
                headers: { 'x-test-user-id': accountId }, payload: { ...resizeReport,
                    result: { kind: 'unknown', code: 'private_resize_unknown', nativeCause: {
                        localCause: 'native_command_failed', command: 'update', exitCode: 1, stderr: '/private/resize/diagnostic',
                    } },
                    presetContent: resizeSnapshot,
                } });
            expect(invalidResize.statusCode).toBe(400);
            expect(await db.managedMachine.findUniqueOrThrow({ where })).toEqual(beforeResizeReport);
        } finally { await app.close(); }
        await reportManagedResize({ ...resizeReport, result: { kind: 'unknown' }, presetContent: resizeSnapshot,
            observation: { observedAt: 124, availability: 'present', power: 'running', storage: 'retained' } });
        const resized = await db.managedMachine.findUniqueOrThrow({ where });
        expect(resized.launch).toEqual({ contentEncryptionMode: 'e2ee', content: resizeSnapshot, recipients: sealed.recipients });
        expect(resized.resource).toBeNull();
        expect(resized.nativeOperationRef).toBeNull();
        expect(resized.recovery).toBeNull();
        expect(JSON.stringify(resized)).not.toContain('private_resize_unknown');
        expect(JSON.stringify(resized)).not.toContain('/private/resize/diagnostic');

        // The control admission remains durable for replay but not visible to
        // a later context once the controller has incorporated it in content.
        const settledReplay = await admitManagedControl({ actorAccountId: accountId, custodianAccountId: accountId, input: {
            action: 'machines.managed.resize', requestId: 'opaque-sealed-resize',
            input: { homeId, managedId: admitted.machine.id, presetContentOverride: resizeOverride },
        } });
        expect(settledReplay).toMatchObject({ replayed: true });
        expect(settledReplay).not.toHaveProperty('presetContentOverride');
    });

    it('accepts a late opaque Delete report after custody settled without restoring its old private snapshot', async () => {
        const accountId = 'preset-late-delete-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, encryptionMode: 'plain', publicKey: null } });
        const presetId = 'preset-late-delete';
        const content = { t: 'plain' as const, v: { v: 1 as const, name: 'Settled private snapshot', launch } };
        const lateContent = { t: 'plain' as const, v: { v: 1 as const, name: 'Old accepted private snapshot', launch } };
        const envelope = { contentEncryptionMode: 'plain', content, recipients: [] };
        await db.managedMachinePreset.create({ data: { id: presetId, homeId, custodianAccountId: accountId,
            name: '', launch: envelope } });
        const managedId = 'preset-late-delete-resource';
        const requestId = 'preset-late-delete-request';
        const request = { action: 'machines.managed.delete', requestId,
            input: { homeId, managedId, intent: 'delete', when: 'now', expectedRevision: 0, reviewedDependencies: true } };
        const observation = { observedAt: 2, availability: 'absent' as const, power: 'unknown' as const, storage: 'unknown' as const };
        const row = await db.managedMachine.create({ data: { id: managedId, homeId, custodianAccountId: accountId,
            presetId, presetRevision: 0, launch: envelope, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            allocation: 'confirmed-absent', desired: 'delete', desiredWhen: 'now', intentRevision: 1,
            admittedActionRequestId: 'preset-late-delete-create', admittedInput: { currentAdmission: { kind: 'control', request } },
            observation } });
        const report = { homeId, managedId, requestId, expectedIntentRevision: 1,
            result: { kind: 'accepted' as const }, presetContent: lateContent,
            observation: { ...observation, observedAt: 1, availability: 'present' as const } };
        await reportManagedIntent(report);
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managedId } })).toEqual(row);
        await reportManagedIntent({ ...report, observation: { ...observation, observedAt: 3 } });
        const updated = await db.managedMachine.findUniqueOrThrow({ where: { id: managedId } });
        expect(updated).toMatchObject({ launch: envelope, allocation: 'confirmed-absent', nativeOperationRef: null,
            cleanup: null, observation: { ...observation, observedAt: 3 }, admittedInput: row.admittedInput });
    });

    it('replays an opaque admission from its retained row after the controller is no longer available', async () => {
        const accountId = 'preset-opaque-replay-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const presetId = 'preset-opaque-replay';
        const content = { t: 'plain' as const, v: { v: 1 as const, name: 'Replay-safe private preset', launch } };
        const saved = await requestPreset(accountId, 'create', {
            homeId,
            id: presetId,
            owner: { kind: 'account', accountId },
            controller,
            contentEncryptionMode: 'plain',
            content,
            recipients: [],
        });
        expect(saved.statusCode, saved.body).toBe(200);
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId, mode: 'plain', projection: { content, recipientEnvelope: null },
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
        });
        if (!presetContentOverride) throw new Error('Expected opaque replay override');

        const request = {
            custodianAccountId: accountId,
            requesterAccountId: accountId,
            requestEnvelopeDigest: 'opaque-replay-controller-digest',
            input: {
                requestId: 'opaque-replay-controller-request',
                continuationPresent: false,
                input: {
                    selection: { kind: 'preset' as const, homeId, id: presetId, revision: 0 },
                    controller,
                    retention: { kind: 'until-delete' as const },
                    wakeOnAcceptedMessage: false,
                    presetContentOverride,
                },
            },
        };
        const admitted = await admitManagedAcquire(request);
        await db.machine.update({ where: { id: controller.machineId }, data: { installationId: 'controller-replaced-after-admission' } });

        await expect(admitManagedAcquire(request)).resolves.toMatchObject({
            replayed: true,
            machine: { id: admitted.machine.id },
            presetContent: { content, recipients: [] },
        });
    });

    it('resolves an encrypted setup preset for an ordinary Machine without carrying setup through Home', async () => {
        const accountId = 'preset-opaque-setup-owner';
        const homeId = await getOrCreateServerIdentityId();
        const accountKeys = tweetnacl.box.keyPair();
        await db.account.create({ data: { id: accountId, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(accountKeys.publicKey) } });
        const target = await seedCurrentProvisioner(accountId, homeId);
        const presetId = 'preset-opaque-setup';
        const census = await readReadyPresetRecipientCensus(accountId, {
            homeId, owner: { kind: 'account', accountId },
        });
        const setup = { scripts: [{ body: 'echo private setup' }] };
        const sealed = sealManagedMachinePresetContentV1({
            presetId,
            mode: 'e2ee',
            content: { v: 1, name: 'Private setup preset', setup },
            recipientCensus: census.recipients,
            randomBytes: tweetnacl.randomBytes,
        });
        const saved = await requestPreset(accountId, 'create', {
            homeId, id: presetId, owner: { kind: 'account', accountId }, contentEncryptionMode: 'e2ee',
            content: sealed.content, recipients: sealed.recipients,
        });
        expect(saved.statusCode, saved.body).toBe(200);

        const resolved = await resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId,
            input: { homeId, machineId: target.machineId, sources: [
                { kind: 'accountPresetOpaque' as const, presetId, presetRevision: 0, contentEncryptionMode: 'e2ee' },
                { kind: 'direct' as const, setup: {} },
            ] } });

        expect(resolved).toEqual({ sources: [
            { kind: 'accountPresetOpaque', presetId, presetRevision: 0, setupRevision: 0, contentEncryptionMode: 'e2ee',
                presetContent: { content: sealed.content, recipientEnvelope: sealed.recipients[0]!.envelope } },
            { kind: 'direct', setup: {} },
        ] });
        expect(JSON.stringify(resolved)).not.toContain('echo private setup');
        const setupOverride = createManagedMachinePresetSetupOverrideV1({
            presetId,
            mode: 'e2ee',
            projection: { content: sealed.content, recipientEnvelope: sealed.recipients[0]!.envelope },
            accountId,
            accountKey: accountKeys.secretKey,
            setup: { scripts: [{ body: 'echo edited private setup' }] },
            randomBytes: tweetnacl.randomBytes,
        });
        if (!setupOverride) throw new Error('Expected opaque setup override');
        const resolvedOverride = await resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId,
            input: { homeId, machineId: target.machineId, sources: [
                { kind: 'accountPresetOpaque' as const, presetId, presetRevision: 0, contentEncryptionMode: 'e2ee',
                    presetContentOverride: setupOverride },
                { kind: 'direct' as const, setup: {} },
            ] } });
        expect(resolvedOverride).toEqual({ sources: [
            { kind: 'accountPresetOpaque', presetId, presetRevision: 0, setupRevision: 0, contentEncryptionMode: 'e2ee',
                presetContent: { content: sealed.content, recipientEnvelope: sealed.recipients[0]!.envelope },
                presetContentOverride: setupOverride },
            { kind: 'direct', setup: {} },
        ] });
        expect(JSON.stringify(resolvedOverride)).not.toContain('echo edited private setup');
        await expect(resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId,
            input: { homeId, machineId: target.machineId, sources: [
                { kind: 'accountPresetOpaque' as const, presetId, presetRevision: 0, contentEncryptionMode: 'plain' },
                { kind: 'direct' as const, setup: {} },
            ] } })).rejects.toMatchObject({ code: 'account_mode_mismatch' });
        await expect(resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId,
            input: { homeId, machineId: target.machineId, sources: [
                { kind: 'accountPresetOpaque' as const, presetId, presetRevision: 0, contentEncryptionMode: 'e2ee',
                    presetContentOverride: { content: { t: 'plain' as const, v: { opaque: 'wrong mode' } } } },
                { kind: 'direct' as const, setup: {} },
            ] } })).rejects.toMatchObject({ code: 'account_mode_mismatch' });
    });

    it('uses the same opaque setup source carrier for a plain preset and rejects raw preset setup input', async () => {
        const accountId = 'preset-plain-setup-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const target = await seedCurrentProvisioner(accountId, homeId);
        const presetId = 'preset-plain-setup';
        const content = { t: 'plain' as const, v: { v: 1 as const, name: 'Plain setup preset',
            setup: { scripts: [{ body: 'echo plain setup' }] } } };
        const saved = await requestPreset(accountId, 'create', {
            homeId, id: presetId, owner: { kind: 'account', accountId }, contentEncryptionMode: 'plain',
            content, recipients: [],
        });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(MachineSetupSourcesApplyInputV1Schema.safeParse({ homeId, machineId: target.machineId, sources: [
            { kind: 'accountPreset', presetId, presetRevision: 0, setup: content.v.setup },
            { kind: 'direct', setup: {} },
        ] }).success).toBe(false);

        const resolved = await resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId,
            input: { homeId, machineId: target.machineId, sources: [
                { kind: 'accountPresetOpaque' as const, presetId, presetRevision: 0, contentEncryptionMode: 'plain' },
                { kind: 'direct' as const, setup: {} },
            ] } });

        expect(resolved).toEqual({ sources: [
            { kind: 'accountPresetOpaque', presetId, presetRevision: 0, setupRevision: 0, contentEncryptionMode: 'plain',
                presetContent: { content, recipientEnvelope: null } },
            { kind: 'direct', setup: {} },
        ] });
        expect(resolved.sources[0]).not.toHaveProperty('setup');
    });

    it('resolves a new setup copy on a managed Machine while retaining its original creation snapshot', async () => {
        const accountId = 'preset-managed-setup-candidate-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const target = await seedCurrentProvisioner(accountId, homeId);
        const presetId = 'preset-managed-setup-candidate';
        const definition = taggedPlainPreset({ id: presetId, homeId, owner: { kind: 'account', accountId },
            name: 'Original creation', privateFields: { launch, setup: { scripts: [{ body: 'echo original' }] } }, controller: target });
        expect((await requestPreset(accountId, 'create', definition)).json()).toMatchObject({ kind: 'saved' });
        const next = taggedPlainPresetContent('Updated setup', { launch, setup: { scripts: [{ body: 'echo updated' }] } });
        expect((await requestPreset(accountId, 'update', { homeId, id: presetId, expectedRevision: 0,
            patch: { content: next } })).json()).toMatchObject({ kind: 'saved', preset: { revision: 1 } });
        const input = { homeId, machineId: target.machineId, sources: [
            { kind: 'accountPresetOpaque' as const, presetId, presetRevision: 1, contentEncryptionMode: 'plain' as const },
            { kind: 'direct' as const, setup: {} },
        ] };
        // The same admitted target and current preset resolve before it owns a managed creation row.
        expect(await resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId, input }))
            .toMatchObject({ sources: [{ presetRevision: 1, presetContent: { content: next } }, { kind: 'direct' }] });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: accountId,
            enrolledMachineId: target.machineId, presetId, presetRevision: 0, allocation: 'bound', creationState: 'active',
            admittedActionRequestId: 'preset-managed-setup-candidate-create',
            launch: { contentEncryptionMode: 'plain', content: definition.content, recipients: [] },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            admittedInput: { enrollmentAccountId: accountId } } });
        const candidateInput = { homeId, machineId: target.machineId,
            candidatePreset: { presetId, presetRevision: 1 } };
        expect(await resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId, input: candidateInput }))
            .toMatchObject({ sources: [{ presetRevision: 1, presetContent: { content: next } }, { kind: 'direct' }] });
        await expect(resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId, input }))
            .rejects.toMatchObject({ code: 'invalid_request' });
        const creation = await resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId,
            creationManagedId: row.id, input: { ...input, sources: [{ kind: 'accountPresetOpaque', presetId,
                presetRevision: 0, contentEncryptionMode: 'plain' },
                { kind: 'direct', setup: {} }] } });
        expect(creation).toMatchObject({ creation: { managedId: row.id },
            sources: [{ presetRevision: 0, presetContent: { content: definition.content } }, { kind: 'direct' }] });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    });

    it('publishes the shared preset collection discriminator only for real content mutations', async () => {
        const accountId = 'preset-collection-publication-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const id = 'preset-collection-publication';
        const changes = () => db.accountChange.findMany({ where: { accountId }, select: { kind: true, entityId: true, cursor: true } });
        const before = { t: 'plain' as const, v: { v: 1 as const, name: 'Before', setup: { scripts: [{ body: 'echo ready' }] } } };
        const after = { t: 'plain' as const, v: { v: 1 as const, name: 'After', setup: { scripts: [{ body: 'echo ready' }] } } };
        let cursor = -1;
        const mutations = [
            { operation: 'create', input: { homeId, id, owner: { kind: 'account', accountId }, contentEncryptionMode: 'plain', content: before, recipients: [] } },
            { operation: 'update', input: { homeId, id, expectedRevision: 0, patch: { content: after } } },
            { operation: 'archive', input: { homeId, id, expectedRevision: 1 } },
            { operation: 'restore', input: { homeId, id, expectedRevision: 2 } },
        ];
        for (const mutation of mutations) {
            const response = await requestPreset(accountId, mutation.operation, mutation.input);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().kind).toBe('saved');
            const rows = await changes();
            expect(rows).toEqual([{ kind: 'account', entityId: 'machine-presets', cursor: expect.any(Number) }]);
            expect(rows[0]!.cursor).toBeGreaterThan(cursor);
            cursor = rows[0]!.cursor;
            if (mutation.operation === 'create') {
                const repeated = await requestPreset(accountId, 'create', mutation.input);
                expect(repeated.json()).toMatchObject({ kind: 'saved', preset: { revision: 0 } });
                expect((await changes())[0]!.cursor).toBe(cursor);
            }
        }
        const unchanged = await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 3, patch: { content: after } });
        expect(unchanged.json()).toMatchObject({ kind: 'saved', preset: { revision: 3 } });
        expect((await changes())[0]!.cursor).toBe(cursor);
        const conflict = await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 0,
            patch: { content: { t: 'plain', v: { v: 1, name: 'Rejected' } } } });
        expect(conflict.statusCode).toBe(409);
        expect((await changes())[0]!.cursor).toBe(cursor);
    });

    it('reveals only the exact current enrollment installation to its creation controller', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-child-codec-owner';
        const member = 'preset-child-codec-requester';
        await db.account.createMany({ data: [owner, member].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const publicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
        const guest = await db.machine.create({ data: { id: 'preset-child-codec-guest', accountId: member,
            metadata: '{}', installationId: 'preset-child-codec-installation', installationPublicKey: new Uint8Array(publicKey) } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: 'preset-child-codec-request', admittedInput: { enrollmentAccountId: member },
            enrolledMachineId: guest.id, launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const app = createAuthenticatedTestApp();
        // HTTP authentication/execution proof is the external boundary; all row/currentness logic is real.
        app.addHook('preHandler', async (request: FastifyRequest) => {
            request.externalActionExecutionAuthorized = true;
            request.externalActionExecutionMachineId = controller.machineId;
            request.externalActionExecutionCustodianAccountId = owner;
            request.externalActionExecutionRequestId = row.admittedActionRequestId;
            request.externalActionEffectActionId = request.headers['x-test-effect'] === 'inspect'
                ? 'machines.managed.inspect' : 'machines.managed.acquire';
        });
        machinesRoutes(app);
        await app.ready();
        const input = { homeId, managedId: row.id, expectedIntentRevision: 0, controller };
        const read = (includeEnrollmentInstallation = true, inspect = false) => app.inject({ method: 'POST',
            url: '/v1/machines/managed/controller/context', headers: { 'x-test-user-id': member,
                ...(inspect ? { 'x-test-effect': 'inspect' } : {}) },
            payload: { ...input, ...(includeEnrollmentInstallation ? { includeEnrollmentInstallation: true } : {}) } });
        try {
            const visible = await read();
            expect(visible.statusCode, visible.body).toBe(200);
            expect(visible.json().enrollmentInstallation).toEqual({ machineId: guest.id, installationId: guest.installationId,
                installationPublicKey: encodeBase64(publicKey, 'base64url') });
            expect((await read(false)).json()).not.toHaveProperty('enrollmentInstallation');
            const inspected = await read(true, true);
            expect(inspected.statusCode, inspected.body).toBe(200);
            expect(inspected.json()).toMatchObject({ requestId: row.admittedActionRequestId,
                enrollmentInstallation: visible.json().enrollmentInstallation });
            for (const data of [{ accountId: owner }, { revokedAt: new Date() }, { installationPublicKey: null }]) {
                await db.machine.update({ where: { id: guest.id }, data });
                for (const inspect of [false, true]) {
                    const denied = await read(true, inspect);
                    expect(denied.statusCode, denied.body).toBe(403);
                    expect(denied.json()).not.toHaveProperty('enrollmentInstallation');
                }
                await db.machine.update({ where: { id: guest.id }, data: { accountId: member, revokedAt: null,
                    installationPublicKey: new Uint8Array(publicKey) } });
            }
            await db.managedMachine.update({ where: { id: row.id }, data: { intentRevision: 1 } });
            expect((await read()).statusCode).toBe(409);
            expect((await read(true, true)).statusCode).toBe(409);
            await db.managedMachine.update({ where: { id: row.id }, data: { intentRevision: 0, creationState: 'canceled' } });
            expect((await read(true, true)).statusCode).toBe(409);
        } finally { await app.close(); }
    });

    type PlainPresetOwner = { kind: 'account'; accountId: string } | { kind: 'team'; teamId: string };
    type PresetController = { machineId: string; installationId: string };

    function taggedPlainPresetContent(name: string, privateFields: Readonly<Record<string, unknown>>) {
        return { t: 'plain' as const, v: { v: 1 as const, name, ...privateFields } };
    }

    function taggedPlainPreset(params: Readonly<{
        id: string;
        homeId: string;
        owner: PlainPresetOwner;
        name: string;
        privateFields: Readonly<Record<string, unknown>>;
        controller?: PresetController;
        controllerPoolId?: string;
        retention?: { kind: 'until-delete' } | { kind: 'unused'; afterMs: number; effect: 'delete' };
        wakeOnAcceptedMessage?: boolean;
        teamAcquireDelegated?: boolean;
        simultaneousLimit?: { maximum: number };
    }>) {
        return {
            id: params.id,
            homeId: params.homeId,
            owner: params.owner,
            contentEncryptionMode: 'plain' as const,
            content: taggedPlainPresetContent(params.name, params.privateFields),
            recipients: [] as const,
            ...(params.controller === undefined ? {} : { controller: params.controller }),
            ...(params.controllerPoolId === undefined ? {} : { controllerPoolId: params.controllerPoolId }),
            ...(params.retention === undefined ? {} : { retention: params.retention }),
            ...(params.wakeOnAcceptedMessage === undefined ? {} : { wakeOnAcceptedMessage: params.wakeOnAcceptedMessage }),
            ...(params.teamAcquireDelegated === undefined ? {} : { teamAcquireDelegated: params.teamAcquireDelegated }),
            ...(params.simultaneousLimit === undefined ? {} : { simultaneousLimit: params.simultaneousLimit }),
        };
    }

    it.each(['exact', 'pool'] as const)('does not claim current native options for an unchecked opaque %s preset', async placement => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = `unchecked-preset-owner-${placement}`;
        const member = `unchecked-preset-member-${placement}`;
        await db.account.createMany({ data: [owner, member].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const team = await db.team.create({ data: { name: 'Saved choices' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' }] });
        const controller = await seedCurrentProvisioner(owner, homeId, undefined, true);
        await db.machine.update({ where: { id: controller.machineId }, data: {
            installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey) } });
        const poolId = '6b6489de-7a75-4f80-9f04-9d8b3678e139';
        if (placement === 'pool') await db.machinePool.create({ data: { id: poolId, accountId: owner, teamId: team.id,
            name: 'Saved choices pool', members: { create: [{ machineId: controller.machineId, priorityTier: 0, enabled: true }] } } });
        const savedLaunch = { ...launch, choices: { image: 'template:fixture-missing-g1-options-1111' } };
        const definition = taggedPlainPreset({ id: `unchecked-preset-${placement}`, homeId, name: 'Unchecked choice',
            owner: { kind: 'team', teamId: team.id }, privateFields: { launch: savedLaunch },
            ...(placement === 'pool' ? { controllerPoolId: poolId } : { controller }), teamAcquireDelegated: true });
        const created = await requestPreset(owner, 'create', definition);
        expect(created.statusCode, created.body).toBe(200);
        const read = await requestPreset(member, 'get', { homeId, id: definition.id });
        expect(read.statusCode, read.body).toBe(200);
        const preset = read.json().preset;
        expect(preset.content).toEqual(definition.content);
        expect(preset).not.toHaveProperty('delegatedAcquire');
        expect(preset).not.toHaveProperty('reviewedFacts');
        expect(preset).not.toHaveProperty('nativeFacts');
        const listed = await requestPreset(member, 'list', { homeId });
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json().presets).toContainEqual(preset);
        expect(await db.machineGrant.count({ where: { principalKind: 'account', machineId: controller.machineId, accountId: member } })).toBe(0);
    });

    it('repairs a late Team member on the retained snapshot key after the source key has changed', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-late-snapshot-owner';
        const member = 'preset-late-snapshot-member';
        const outsider = 'preset-late-snapshot-outsider';
        const former = 'preset-late-snapshot-former';
        const ownerKeys = tweetnacl.box.keyPair();
        const memberKeys = tweetnacl.box.keyPair();
        const outsiderKeys = tweetnacl.box.keyPair();
        const formerKeys = tweetnacl.box.keyPair();
        await db.account.createMany({ data: [
            { id: owner, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) },
            { id: member, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(memberKeys.publicKey) },
            { id: outsider, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(outsiderKeys.publicKey) },
            { id: former, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(formerKeys.publicKey) },
        ] });
        const team = await db.team.create({ data: { name: 'Late snapshot recipient Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: former, role: 'member' },
        ] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const id = 'preset-late-snapshot';
        const target = { homeId, owner: { kind: 'team' as const, teamId: team.id }, controller };
        const census = await readReadyPresetRecipientCensus(owner, target);
        const original = sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee',
            content: { v: 1, name: 'Original retained private setup', launch },
            recipientCensus: census.recipients, randomBytes: tweetnacl.randomBytes });
        expect((await requestPreset(owner, 'create', { ...target, id, teamAcquireDelegated: true,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            contentEncryptionMode: 'e2ee', ...original })).statusCode).toBe(200);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member, role: 'member' } });
        const admission = await admitManagedAcquire({ custodianAccountId: owner, requesterAccountId: member,
            managedAcquireDelegation: true, requestEnvelopeDigest: 'late-snapshot-create', input: {
                requestId: 'late-snapshot-create', continuationPresent: false, input: {
                    selection: { kind: 'preset', homeId, id, revision: 0 }, controller,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                },
            } });
        const correlation = { homeId, managedId: admission.machine.id, controller,
            expectedIntentRevision: admission.machine.intentRevision, requestId: 'late-snapshot-create' };
        await submitManagedAcquire(correlation);
        await reportManagedAcquire({ ...correlation, result: { kind: 'bound' }, presetContent: original.content });
        const unreadable = await getManagedMachine({ actorAccountId: member, input: { homeId, managedId: admission.machine.id } });
        expect(unreadable).toMatchObject({ presetContent: { recipientEnvelope: null } });

        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: former } },
            data: { status: 'suspended' } });
        const current = await readReadyPresetRecipientCensus(owner, target);
        const revised = sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee',
            content: { v: 1, name: 'Later authored private setup', launch },
            recipientCensus: current.recipients, randomBytes: tweetnacl.randomBytes });
        expect((await requestPreset(owner, 'update', { homeId, id, expectedRevision: 0,
            patch: revised })).statusCode).toBe(200);

        const snapshotCensus = await readReadyPresetRecipientCensus(owner, { homeId, managedId: admission.machine.id });
        expect(snapshotCensus.recipients.map(recipient => recipient.account.accountId)).toEqual([member, owner].sort());
        expect((await requestPreset(member, 'recipient-census', { homeId, managedId: admission.machine.id })).json())
            .toMatchObject({ kind: 'refused', code: 'permission_denied' });
        expect((await requestPreset(outsider, 'recipient-census', { homeId, managedId: admission.machine.id })).json())
            .toMatchObject({ kind: 'refused', code: 'permission_denied' });
        const recipients = rewrapManagedMachinePresetRecipientsV1({ recipients: original.recipients,
            accountId: owner, accountKey: ownerKeys.secretKey, recipientCensus: snapshotCensus.recipients,
            randomBytes: tweetnacl.randomBytes });
        if (!recipients) throw new Error('Expected retained snapshot recipient envelopes');
        await expect(reportManagedAcquire({ ...correlation, result: { kind: 'bound' },
            presetContent: original.content, presetRecipients: original.recipients })).rejects.toMatchObject({ code: 'credential_unavailable' });
        const formerRecipient = original.recipients.find(recipient => recipient.accountId === former);
        if (!formerRecipient) throw new Error('Expected former recipient fixture');
        await expect(reportManagedAcquire({ ...correlation, result: { kind: 'bound' },
            presetContent: original.content, presetRecipients: [...recipients, formerRecipient] })).rejects.toMatchObject({ code: 'credential_unavailable' });
        await reportManagedAcquire({ ...correlation, result: { kind: 'bound' },
            presetContent: original.content, presetRecipients: recipients });
        // An older controller can still report without replacing the repaired audience.
        await reportManagedAcquire({ ...correlation, result: { kind: 'bound' }, presetContent: original.content });
        const repaired = await getManagedMachine({ actorAccountId: member, input: { homeId, managedId: admission.machine.id } });
        if (!('presetContent' in repaired)) throw new Error('Expected opaque snapshot');
        expect(openManagedMachinePresetRecipientProjectionV1({ presetId: id, mode: 'e2ee', projection: repaired.presetContent,
            accountId: member, accountKey: memberKeys.secretKey })).toMatchObject({ name: 'Original retained private setup' });
        const retained = await db.managedMachine.findUniqueOrThrow({ where: { id: admission.machine.id } });
        expect(retained.launch).toMatchObject({ content: original.content, recipients });
        expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id } })).launch).toMatchObject({ content: revised.content });
        expect(recipients.map(recipient => recipient.accountId)).not.toContain(former);
        expect(recipients.map(recipient => recipient.accountId)).not.toContain(outsider);
    });

    it('projects an opaque E2EE managed row to only the authenticated recipient envelope', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-managed-read-owner';
        const member = 'preset-managed-read-member';
        const ownerKeys = tweetnacl.box.keyPair();
        const memberKeys = tweetnacl.box.keyPair();
        await db.account.createMany({ data: [
            { id: owner, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) },
            { id: member, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(memberKeys.publicKey) },
        ] });
        const team = await db.team.create({ data: { name: 'Managed read recipients' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const id = 'preset-managed-read-projection';
        const census = await readReadyPresetRecipientCensus(owner, {
            homeId, owner: { kind: 'team', teamId: team.id }, controller,
        });
        const sealed = sealManagedMachinePresetContentV1({
            presetId: id,
            mode: 'e2ee',
            content: { v: 1, name: 'Private Team machine', launch },
            recipientCensus: census.recipients,
            randomBytes: tweetnacl.randomBytes,
        });
        const created = await requestPreset(owner, 'create', {
            id, homeId, owner: { kind: 'team', teamId: team.id }, controller,
            teamAcquireDelegated: true, contentEncryptionMode: 'e2ee',
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            content: sealed.content, recipients: sealed.recipients,
        });
        expect(created.statusCode, created.body).toBe(200);
        const expectedEnvelope = sealed.recipients.find(recipient => recipient.accountId === member)?.envelope;
        if (!expectedEnvelope) throw new Error('Expected member recipient envelope');
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId: id, mode: 'e2ee', projection: { content: sealed.content, recipientEnvelope: expectedEnvelope },
            accountId: member, accountKey: memberKeys.secretKey,
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, randomBytes: tweetnacl.randomBytes,
        });
        if (!presetContentOverride) throw new Error('Expected managed read override');

        const request = {
            custodianAccountId: owner, requesterAccountId: member, requestEnvelopeDigest: 'managed-read-projection',
            managedAcquireDelegation: true as const,
            input: { requestId: 'managed-read-projection', continuationPresent: false, input: {
                selection: { kind: 'preset' as const, homeId, id, revision: 0 },
                controller, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
                presetContentOverride,
            } },
        };
        const admitted = await admitManagedAcquire(request);

        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        await app.ready();
        try {
            const get = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/get',
                headers: { 'x-test-user-id': member }, payload: { homeId, managedId: admitted.machine.id } });
            expect(get.statusCode, get.body).toBe(200);
            expect(get.json()).toMatchObject({
                machine: { id: admitted.machine.id, preset: { id, revision: 0 } },
                presetContent: { content: sealed.content, recipientEnvelope: expectedEnvelope },
            });
            expect(get.json().presetContent).not.toHaveProperty('recipients');
            expect(get.json().machine).not.toHaveProperty('launch');
            expect(get.json().machine).not.toHaveProperty('reviewedFacts');

            const listed = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/list',
                headers: { 'x-test-user-id': member }, payload: { homeId } });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().machines).toMatchObject([{
                machine: { id: admitted.machine.id },
                presetContent: { content: sealed.content, recipientEnvelope: expectedEnvelope },
            }]);
            expect(listed.json().machines[0].presetContent).not.toHaveProperty('recipients');

            const ownerEnvelope = sealed.recipients.find(recipient => recipient.accountId === owner)?.envelope;
            expect(ownerEnvelope).toBeDefined();
            const ownedList = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/list',
                headers: { 'x-test-user-id': owner }, payload: { homeId, presetId: id } });
            expect(ownedList.statusCode, ownedList.body).toBe(200);
            expect(ManagedListOutputV1Schema.parse(ownedList.json()).machines).toEqual([expect.objectContaining({
                machine: expect.objectContaining({ id: admitted.machine.id }),
                presetContent: { content: sealed.content, recipientEnvelope: ownerEnvelope },
            })]);
        } finally {
            await app.close();
        }

        const catalog = await requestPreset(member, 'get', { homeId, id });
        expect(catalog.statusCode, catalog.body).toBe(200);
        expect(catalog.json()).toMatchObject({ kind: 'found', preset: {
            content: sealed.content, recipients: sealed.recipients,
        } });
    });

    it('keeps direct Crabbox one-off admission while opaque preset availability stays daemon-owned', async () => {
        const accountId = 'preset-crabbox-direct-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const controller = { machineId: `${accountId}-controller`, installationId: `${accountId}-installation` };
        await db.machine.create({ data: { id: controller.machineId, accountId, metadata: '{}', installationId: controller.installationId, pluginMaterializationRevision: BigInt(1) } });
        const manifest = PluginManifestV2Schema.parse(CRABBOX_PLUGIN.manifest);
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId, pluginId: manifest.id, enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId, machineId: controller.machineId, materializationId: controller.installationId,
            pluginId: manifest.id, version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const localLaunch = { provider: { pluginId: manifest.id, localId: 'crabbox' }, schemaVersion: 1, name: 'Local container',
            choices: { backendId: 'local-container', transport: 'direct', namespace: 'local', target: 'linux', nativeImageId: 'ubuntu:24.04', ttlSeconds: 5400, idleTimeoutSeconds: 1800 } };
        const input = taggedPlainPreset({ id: 'preset-crabbox-direct', homeId, owner: { kind: 'account', accountId }, name: 'Local container', privateFields: { launch: localLaunch }, controller });
        expect((await requestPreset(accountId, 'create', input)).json()).toMatchObject({ kind: 'saved', preset: { content: input.content } });
        const memberId = 'crabbox-team-member';
        await db.account.create({ data: { id: memberId, publicKey: null, encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Crabbox team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId, role: 'admin' }, { teamId: team.id, accountId: memberId, role: 'member' },
        ] });
        await db.machine.update({ where: { id: controller.machineId }, data: { active: true,
            installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey) } });
        const teamPreset = { ...input, id: 'crabbox-team-preset', owner: { kind: 'team', teamId: team.id }, teamAcquireDelegated: true };
        expect((await requestPreset(accountId, 'create', teamPreset)).json()).toMatchObject({ kind: 'saved' });
        const memberRead = (await requestPreset(memberId, 'get', { homeId, id: teamPreset.id })).json();
        expect(memberRead).toMatchObject({ kind: 'found', preset: { content: input.content } });
        expect(memberRead.preset).not.toHaveProperty('delegatedAcquire');
        const memberList = (await requestPreset(memberId, 'list', { homeId })).json();
        expect(memberList.presets).toContainEqual(memberRead.preset);
        const acquired = await admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: 'crabbox-direct-reviewed',
            input: { requestId: 'crabbox-direct-create', continuationPresent: false, input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: 'one-off', homeId, controller,
                launch: localLaunch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } } });
        expect(acquired).toMatchObject({ machine: { launch: localLaunch } });
        const coordinatorLaunch = { ...localLaunch, choices: { backendId: 'aws', transport: 'coordinator', namespace: 'remote', target: 'linux',
            nativeImageId: 'ami-selected', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 } };
        expect((await requestPreset(accountId, 'create', { ...input, id: 'preset-crabbox-coordinator', content: taggedPlainPresetContent('Coordinator preset', { launch: coordinatorLaunch }) })).json())
            .toMatchObject({ kind: 'saved', preset: { id: 'preset-crabbox-coordinator' } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId,
            id: 'preset-crabbox-coordinator', revision: 0 }))).resolves.toMatchObject({ kind: 'ready', presetContent: { content: taggedPlainPresetContent('Coordinator preset', { launch: coordinatorLaunch }) } });
    });

    it('saves and applies an opaque Team setup-only preset without a controller route', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-team-setup-owner';
        const member = 'preset-team-setup-member';
        await db.account.createMany({ data: [owner, member].map(id => ({ id, encryptionMode: 'plain', publicKey: null })) });
        const team = await db.team.create({ data: { name: 'Shared setup' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const target = await seedCurrentProvisioner(member, homeId);
        const presetId = 'preset-team-setup';
        const definition = taggedPlainPreset({ id: presetId, homeId, owner: { kind: 'team', teamId: team.id },
            name: 'Shared private setup', privateFields: { setup: { scripts: [{ body: 'echo shared setup' }] } } });
        const saved = await requestPreset(owner, 'create', definition);
        expect(saved.statusCode, saved.body).toBe(200);
        const resolved = await resolveMachineSetup({ actorAccountId: member, custodianAccountId: member,
            input: { homeId, machineId: target.machineId, sources: [
                { kind: 'accountPresetOpaque', presetId, presetRevision: 0, contentEncryptionMode: 'plain' },
                { kind: 'direct', setup: {} },
            ] } });
        expect(resolved).toMatchObject({ sources: [{ kind: 'accountPresetOpaque',
            presetContent: { content: definition.content, recipientEnvelope: null } }, { kind: 'direct', setup: {} }] });
        expect(await inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: member,
            homeId, id: presetId, revision: 0 }))).toMatchObject({ kind: 'refused', code: 'invalid_request' });
    });

    it('stores tagged Plain setup-only content opaquely and keeps Account ownership fencing', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-setup-only-owner';
        const outsider = 'preset-setup-only-outsider';
        await db.account.createMany({ data: [owner, outsider].map(id => ({ id, encryptionMode: 'plain', publicKey: null })) });
        const setup = { scripts: [{ body: 'echo saved setup' }] };
        const definition = taggedPlainPreset({
            id: 'preset-setup-only', homeId, owner: { kind: 'account', accountId: owner },
            name: 'Private setup', privateFields: { setup },
        });

        const created = await requestPreset(owner, 'create', definition);
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({ kind: 'saved', preset: {
            id: definition.id, revision: 0, content: definition.content, recipients: [],
        } });
        expect(created.json().preset).not.toHaveProperty('name');
        expect(created.json().preset).not.toHaveProperty('setup');
        const stored = await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } });
        expect(stored).toMatchObject({ name: '', launch: { content: definition.content, recipients: [] }, setup: null });

        const revisedSetup = { scripts: [{ body: 'echo revised setup' }] };
        const revisedContent = taggedPlainPresetContent('Private setup revised', { setup: revisedSetup });
        const updated = await requestPreset(owner, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { content: revisedContent, recipients: [] } });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(updated.json()).toMatchObject({ kind: 'saved', preset: {
            revision: 1, content: revisedContent, recipients: [],
        } });
        expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } })))
            .toMatchObject({ name: '', launch: { content: revisedContent, recipients: [] }, setup: null });
        expect((await requestPreset(owner, 'update', { homeId, id: definition.id, expectedRevision: 1,
            patch: { content: null } })).statusCode).toBe(400);
        expect((await requestPreset(outsider, 'get', { homeId, id: definition.id })).statusCode).toBe(404);
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: owner, homeId, id: definition.id, revision: 1,
        }))).resolves.toMatchObject({ kind: 'ready', custodianAccountId: owner,
            presetContent: { content: revisedContent, recipients: [] } });
    });

    it('retains the exact opaque snapshot across content change, archive, and replay', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-opaque-snapshot-owner';
        await db.account.create({ data: { id: owner, encryptionMode: 'plain', publicKey: null } });
        const id = 'preset-opaque-snapshot';
        const definition = taggedPlainPreset({
            id, homeId, owner: { kind: 'account', accountId: owner }, name: 'Initial private snapshot',
            privateFields: { launch, setup: { scripts: [{ body: 'echo initial' }] } },
        });
        expect((await requestPreset(owner, 'create', definition)).statusCode).toBe(200);
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId: id, mode: 'plain', projection: { content: definition.content, recipientEnvelope: null },
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
        });
        if (!presetContentOverride) throw new Error('Expected snapshot override');

        const request = {
            custodianAccountId: owner, requesterAccountId: owner, requestEnvelopeDigest: 'opaque-snapshot-request',
            input: { requestId: 'opaque-snapshot-request', continuationPresent: false, input: {
                selection: { kind: 'preset' as const, homeId, id, revision: 0 },
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
                presetContentOverride,
            } },
        };
        const admitted = await admitManagedAcquire(request);
        expect(admitted).toMatchObject({ replayed: false,
            presetContent: { content: definition.content, recipients: [] },
            machine: { preset: { id, revision: 0 } },
        });
        expect(admitted.machine).not.toHaveProperty('launch');
        expect(admitted.machine).not.toHaveProperty('reviewedFacts');
        const admittedRow = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } });
        expect(admittedRow.launch).toEqual({ contentEncryptionMode: 'plain', content: definition.content, recipients: [] });
        expect(admittedRow.reviewedFacts).toBeNull();
        expect(admittedRow.machineSetup).toBeNull();

        const revisedContent = taggedPlainPresetContent('Changed private snapshot', {
            launch: { ...launch, choices: { image: 'changed' } },
            setup: { scripts: [{ body: 'echo changed' }] },
        });
        expect((await requestPreset(owner, 'update', { homeId, id, expectedRevision: 0,
            patch: { content: revisedContent, recipients: [] } })).json()).toMatchObject({ kind: 'saved',
                preset: { revision: 1, content: revisedContent } });
        expect((await requestPreset(owner, 'archive', { homeId, id, expectedRevision: 1 })).json())
            .toMatchObject({ kind: 'saved', preset: { revision: 2, archivedAt: expect.any(Number) } });

        const replay = await admitManagedAcquire(request);
        expect(replay).toMatchObject({ replayed: true, machine: { id: admitted.machine.id },
            presetContent: { content: definition.content, recipients: [] } });
        await expect(admitManagedAcquire({
            ...request, requestEnvelopeDigest: 'opaque-snapshot-after-archive',
            input: { ...request.input, requestId: 'opaque-snapshot-after-archive',
                input: { ...request.input.input, selection: { kind: 'preset', homeId, id, revision: 2 } } },
        })).rejects.toMatchObject({ code: 'preset_archived' });
    });

    it.each(['archive', 'delete'] as const)('requires fresh acquisition after Session %s to birth again on a kept guest', async end => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(owner.id, homeId);
        const id = 'preset-member-local-reuse';
        expect((await requestPreset(owner.id, 'create', taggedPlainPreset({ id, homeId,
            owner: { kind: 'account', accountId: owner.id }, name: 'Kept member guest', privateFields: { launch },
            controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }))).statusCode).toBe(200);
        // The Home's signed Session child supplies the installed controller's Machine policy admission.
        const request = (requestId: string) => ({ custodianAccountId: owner.id, requesterAccountId: member.id,
            machinePolicySandbox: true as const, requestEnvelopeDigest: requestId, input: { requestId, continuationPresent: false,
                acquisitionMode: 'resource-bound' as const, reuseIdle: true as const,
                input: { selection: { kind: 'preset' as const, homeId, id, revision: 0 }, controller } } });
        const firstRequest = request(`member-local-first-${end}`);
        const first = await admitManagedAcquire(firstRequest);
        await db.managedMachine.update({ where: { id: first.machine.id }, data: { allocation: 'bound' } });
        const birth = { homeId, managedId: first.machine.id, controller };
        const admitBirth = () => inTx(tx => validateManagedCreationBirthInTx(tx, { accountId: member.id, birth }));
        expect(await admitBirth()).not.toBe(false);
        const session = await db.session.create({ data: { accountId: member.id, tag: 'member-local-session', metadata: '{}',
            encryptionMode: 'plain', managedCreationId: first.machine.id } });
        if (end === 'archive') {
            await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: session.id, wasArchived: false, archivedAt: new Date() }));
        } else {
            expect(await deleteOwnedSession({ reason: 'user_request', ownerAccountId: member.id, sessionId: session.id })).toEqual({ ok: true });
        }
        expect(await admitManagedAcquire(firstRequest)).toMatchObject({ replayed: true, machine: { id: first.machine.id } });
        expect(await admitBirth()).toBe(false);
        expect(await admitManagedAcquire(request(`member-local-next-${end}`))).toMatchObject({ machine: { id: first.machine.id } });
        expect(await admitBirth()).not.toBe(false);
    });

    it('reuses only an unoccupied kept local resource from the same custodian and preset configuration', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const accountId = 'preset-local-reuse-owner';
        await db.account.create({ data: { id: accountId, encryptionMode: 'plain', publicKey: null } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const id = 'preset-local-reuse';
        const definition = taggedPlainPreset({ id, homeId, owner: { kind: 'account', accountId }, name: 'Kept local',
            privateFields: { launch }, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        expect((await requestPreset(accountId, 'create', definition)).statusCode).toBe(200);
        const request = (requestId: string, revision = 0) => ({ custodianAccountId: accountId, requesterAccountId: accountId,
            requestEnvelopeDigest: requestId, input: { requestId, continuationPresent: false,
                acquisitionMode: 'resource-bound' as const, reuseIdle: true as const,
                input: { selection: { kind: 'preset' as const, homeId, id, revision }, controller } } });
        const first = await admitManagedAcquire(request('local-reuse-first'));
        await db.managedMachine.update({ where: { id: first.machine.id }, data: { allocation: 'bound' } });
        const pending = await admitManagedAcquire(request('local-reuse-pending'));
        expect(pending.machine.id).not.toBe(first.machine.id);
        expect((await admitManagedAcquire(request('local-reuse-first'))).machine.id).toBe(first.machine.id);
        await db.session.create({ data: { accountId, tag: 'local-reuse-prior-session', metadata: '{}',
            encryptionMode: 'plain', managedCreationId: first.machine.id, archivedAt: new Date() } });
        const reused = await admitManagedAcquire(request('local-reuse-second'));
        expect(reused.machine.id).toBe(first.machine.id);
        expect(await db.managedMachine.count({ where: { homeId, presetId: id } })).toBe(2);

        const session = await db.session.create({ data: { accountId, tag: 'local-reuse-session', metadata: '{}',
            encryptionMode: 'plain', managedCreationId: first.machine.id } });
        const busy = await admitManagedAcquire(request('local-reuse-busy'));
        expect(busy.machine.id).not.toBe(first.machine.id);
        await db.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
        expect((await admitManagedAcquire(request('local-reuse-archived'))).machine.id).toBe(first.machine.id);

        await db.managedMachine.update({ where: { id: first.machine.id }, data: {
            custodianAccountId: (await db.account.create({ data: { encryptionMode: 'plain' } })).id } });
        expect((await admitManagedAcquire(request('local-reuse-custodian'))).machine.id).not.toBe(first.machine.id);
        await db.managedMachine.update({ where: { id: first.machine.id }, data: { custodianAccountId: accountId } });

        const renamedContent = taggedPlainPresetContent('Renamed kept local', { launch });
        expect((await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 0,
            patch: { content: renamedContent, configurationRevision: 0 } })).json())
            .toMatchObject({ kind: 'saved', preset: { revision: 1 } });
        const beforeRenameReuse = await db.managedMachine.count({ where: { presetId: id } });
        expect((await admitManagedAcquire(request('local-reuse-renamed', 1))).machine.id).toBe(first.machine.id);
        expect(await db.managedMachine.count({ where: { presetId: id } })).toBe(beforeRenameReuse);
        expect(first.machine.preset).toMatchObject({ configurationRevision: 0 });

        // Prepare writes opaque private bytes through its existing admitted owner.
        const prepared = await import('./machinePresetService').then(({ updateMachinePreset }) => updateMachinePreset({
            accountId, presetPreparationAdmission: { homeId, id, expectedRevision: 1 },
            input: { homeId, id, expectedRevision: 1, patch: {
                content: taggedPlainPresetContent('Prepared kept local', { launch }),
            } },
        }));
        expect(prepared).toMatchObject({ kind: 'saved', preset: { revision: 2, configurationRevision: 0 } });
        expect((await admitManagedAcquire(request('local-reuse-prepared', 2))).machine.id).toBe(first.machine.id);
        expect(await db.managedMachine.count({ where: { presetId: id } })).toBe(beforeRenameReuse);

        // Unknown legacy snapshots must not match the preset's initial counter.
        await db.$executeRaw`UPDATE "ManagedMachine" SET "presetConfigurationRevision" = NULL WHERE "id" = ${first.machine.id}`;
        expect((await admitManagedAcquire(request('local-reuse-unknown-legacy', 2))).machine.id).not.toBe(first.machine.id);
        await db.$executeRaw`UPDATE "ManagedMachine" SET "presetConfigurationRevision" = 0 WHERE "id" = ${first.machine.id}`;
        expect((await admitManagedAcquire(request('local-reuse-known-legacy', 2))).machine.id).toBe(first.machine.id);

        const changedContent = taggedPlainPresetContent('Changed launch', {
            launch: { ...launch, choices: { image: 'changed' } }, setup: { scripts: [{ body: 'echo changed' }] },
        });
        expect((await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 2,
            patch: { content: changedContent, configurationRevision: 1 } })).json())
            .toMatchObject({ kind: 'saved', preset: { revision: 3, configurationRevision: 1 } });
        const changed = await admitManagedAcquire(request('local-reuse-changed', 3));
        expect(changed.machine.id).not.toBe(first.machine.id);
        expect(changed.machine.preset).toMatchObject({ revision: 3, configurationRevision: 1 });
        await db.managedMachine.update({ where: { id: changed.machine.id }, data: { allocation: 'bound' } });
        await db.session.create({ data: { accountId, tag: 'local-reuse-changed-session', metadata: '{}',
            encryptionMode: 'plain', managedCreationId: changed.machine.id, archivedAt: new Date() } });
        expect((await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 3, patch: {
            content: taggedPlainPresetContent('Changed setup again', {
                launch: { ...launch, choices: { image: 'changed' } }, setup: { scripts: [{ body: 'echo third' }] },
            }), configurationRevision: 2,
        } })).json()).toMatchObject({ kind: 'saved', preset: { revision: 4, configurationRevision: 2 } });
        const third = await admitManagedAcquire(request('local-reuse-third-configuration', 4));
        expect([first.machine.id, changed.machine.id]).not.toContain(third.machine.id);
        expect(third.machine.preset).toMatchObject({ revision: 4, configurationRevision: 2 });
        expect(await admitManagedAcquire(request('local-reuse-changed', 3))).toMatchObject({
            machine: { id: changed.machine.id, preset: { revision: 3, configurationRevision: 1 } },
            presetContent: { content: changedContent },
        });
        expect((await admitManagedAcquire(request('local-reuse-first')))).toMatchObject({
            machine: { id: first.machine.id, preset: { revision: 0, configurationRevision: 0 } },
            presetContent: { content: definition.content },
        });
        await expect(admitManagedAcquire(request('local-reuse-stale-selection', 2)))
            .rejects.toMatchObject({ code: 'request_conflict' });
    });

    it('enforces CAS, archive, replay, and simultaneous capacity without inspecting private content', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-structural-cap-owner';
        await db.account.create({ data: { id: owner, encryptionMode: 'plain', publicKey: null } });
        const id = 'preset-structural-cap';
        const opaqueLaunch = {
            provider: { pluginId: 'not.installed.for.server', localId: 'opaque' },
            schemaVersion: 99, name: 'Daemon-only declaration',
            choices: { credentialRef: 'not-a-server-reference', future: true },
        };
        const definition = taggedPlainPreset({
            id, homeId, owner: { kind: 'account', accountId: owner }, name: 'Opaque capacity',
            privateFields: { launch: opaqueLaunch }, simultaneousLimit: { maximum: 1 },
        });
        expect((await requestPreset(owner, 'create', definition)).statusCode).toBe(200);
        const changed = await requestPreset(owner, 'update', { homeId, id, expectedRevision: 0, patch: {
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
        } });
        expect(changed.statusCode, changed.body).toBe(200);
        expect(changed.json()).toMatchObject({ kind: 'saved', preset: {
            revision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
        } });
        const unchanged = await requestPreset(owner, 'update', { homeId, id, expectedRevision: 1, patch: {
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
        } });
        expect(unchanged.json()).toMatchObject({ kind: 'saved', preset: { revision: 1 } });
        const stale = await requestPreset(owner, 'update', { homeId, id, expectedRevision: 0,
            patch: { wakeOnAcceptedMessage: false } });
        expect(stale.statusCode, stale.body).toBe(409);
        expect(stale.json()).toEqual({ kind: 'conflict', currentRevision: 1 });
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId: id, mode: 'plain', projection: { content: definition.content, recipientEnvelope: null },
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
        });
        if (!presetContentOverride) throw new Error('Expected capacity override');

        const attempts = ['one', 'two'].map(suffix => ({
            custodianAccountId: owner, requesterAccountId: owner, requestEnvelopeDigest: 'opaque-cap-' + suffix,
            input: { requestId: 'opaque-cap-' + suffix, continuationPresent: false, input: {
                selection: { kind: 'preset' as const, homeId, id, revision: 1 },
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: true,
                presetContentOverride,
            } },
        }));
        const results = await Promise.allSettled(attempts.map(attempt => admitManagedAcquire(attempt)));
        const winnerIndex = results.findIndex(result => result.status === 'fulfilled');
        expect(winnerIndex).toBeGreaterThanOrEqual(0);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected').map(result => result.reason))
            .toEqual([expect.objectContaining({ code: 'preset_limit_reached' })]);
        const winner = attempts[winnerIndex]!;
        const admission = results[winnerIndex]!;
        if (admission.status !== 'fulfilled') throw new Error('Expected a capacity winner');
        const row = await db.managedMachine.findUniqueOrThrow({ where: { id: admission.value.machine.id } });
        expect(row.launch).toEqual({ contentEncryptionMode: 'plain', content: definition.content, recipients: [] });
        expect(row.reviewedFacts).toBeNull();

        expect((await requestPreset(owner, 'archive', { homeId, id, expectedRevision: 1 })).json())
            .toMatchObject({ kind: 'saved', preset: { revision: 2 } });
        expect(await admitManagedAcquire(winner)).toMatchObject({ replayed: true, machine: { id: admission.value.machine.id } });
        await db.managedMachine.update({ where: { id: row.id }, data: { allocation: 'confirmed-absent' } });
        expect((await requestPreset(owner, 'restore', { homeId, id, expectedRevision: 2 })).json())
            .toMatchObject({ kind: 'saved', preset: { revision: 3 } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: owner, homeId, id, revision: 3,
        }))).resolves.toMatchObject({ kind: 'ready', presetContent: { content: definition.content, recipients: [] } });
    });

    it.each(['member-unqualified', 'member-different', 'member-wake', 'member-omits', 'member-matches', 'owner-customizes'] as const)(
        'admits delegated retention only from the custodian policy (%s)', async scenario => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = `policy-owner-${scenario}`;
        const member = `policy-member-${scenario}`;
        await db.account.createMany({ data: [owner, member].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const team = await db.team.create({ data: { name: 'Policy authority Team' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' }] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const definition = taggedPlainPreset({ id: `policy-preset-${scenario}`, homeId,
            owner: { kind: 'team', teamId: team.id }, name: 'Owner policy', privateFields: { launch },
            controller, teamAcquireDelegated: true });
        expect((await requestPreset(owner, 'create', definition)).statusCode).toBe(200);
        const { category: _category, ...ownerPolicy } = resolveMachineRetentionPolicyV1({
            billing: { location: 'local', stoppedBilling: 'not-billed' }, nativeCapabilities: { supportedIntents: ['start', 'stop', 'delete'] } });
        const customPolicy = { retention: { kind: 'unused' as const, afterMs: 17, effect: 'delete' as const }, wakeOnAcceptedMessage: true };
        const requested = scenario === 'member-omits' ? {} : scenario === 'member-matches' ? ownerPolicy
            : scenario === 'member-wake' ? { ...ownerPolicy, wakeOnAcceptedMessage: !ownerPolicy.wakeOnAcceptedMessage } : customPolicy;
        const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId, id: definition.id, revision: 0 },
            controller, ...requested });
        const requestId = `policy-request-${scenario}`;
        const presetPolicy = scenario === 'owner-customizes' ? customPolicy : ownerPolicy;
        const request = { custodianAccountId: owner, requesterAccountId: scenario === 'owner-customizes' ? owner : member,
            managedAcquireDelegation: true as const,
            requestEnvelopeDigest: requestId, input: { requestId, continuationPresent: false, input,
                ...(scenario === 'member-unqualified' ? {} : { presetPolicy,
                    originalActionEnvelope: { v: 1 as const, requestId, input } }) } };
        if (scenario === 'member-unqualified' || scenario === 'member-different' || scenario === 'member-wake') {
            await expect(admitManagedAcquire(request)).rejects.toMatchObject({ code: 'permission_denied' });
            expect(await db.managedMachine.count({ where: { admittedActionRequestId: requestId } })).toBe(0);
        } else {
            const admitted = await admitManagedAcquire(request);
            expect(admitted.machine).toMatchObject({ retention: presetPolicy.retention, wakeOnAcceptedMessage: presetPolicy.wakeOnAcceptedMessage });
            expect(await db.machineGrant.count({ where: { principalKind: 'account', machineId: controller.machineId, accountId: member } })).toBe(0);
        }
    });

    it('uses current Team membership and controller ownership for delegation without creating a Machine grant', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-team-owner';
        const admin = 'preset-team-admin';
        const member = 'preset-team-member';
        const homeAdmin = 'preset-team-home-admin';
        await db.account.createMany({ data: [owner, admin, member, homeAdmin].map(id => ({
            id, encryptionMode: 'plain', publicKey: null,
        })) });
        await db.account.update({ where: { id: homeAdmin }, data: { homeRole: 'admin' } });
        const team = await db.team.create({ data: { name: 'Structural preset Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: admin, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const definition = taggedPlainPreset({
            id: 'preset-team-delegated', homeId, owner: { kind: 'team', teamId: team.id },
            name: 'Private Team launch', privateFields: { launch }, controller, teamAcquireDelegated: true,
        });
        expect((await requestPreset(owner, 'create', definition)).statusCode).toBe(200);
        expect((await requestPreset(member, 'get', { homeId, id: definition.id })).json())
            .toMatchObject({ kind: 'found', preset: { content: definition.content, recipients: [] } });
        expect((await requestPreset(homeAdmin, 'get', { homeId, id: definition.id })).statusCode).toBe(404);
        expect((await requestPreset(member, 'archive', { homeId, id: definition.id, expectedRevision: 0 })).statusCode).toBe(404);
        expect((await requestPreset(admin, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { teamAcquireDelegated: false } })).json()).toEqual({ kind: 'refused', code: 'permission_denied' });
        // A Team preset manager without controller Manage may repair recipients, never change the recipe counter.
        expect((await requestPreset(admin, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { recipients: [] } })).json()).toMatchObject({ kind: 'saved', preset: { revision: 0, configurationRevision: 0 } });
        expect((await requestPreset(admin, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { recipients: [], configurationRevision: 1 } })).json()).toEqual({ kind: 'refused', code: 'permission_denied' });
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } }))
            .toMatchObject({ revision: 0, configurationRevision: 0 });

        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: member, homeId, id: definition.id, revision: 0,
        }))).resolves.toMatchObject({ kind: 'ready', delegated: true, custodianAccountId: owner });
        expect(await db.machineGrant.count({ where: { principalKind: 'account', machineId: controller.machineId, accountId: member } })).toBe(0);

        await db.machine.update({ where: { id: controller.machineId }, data: {
            metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
            machineId: controller.machineId, actorAccountId: owner,
            principal: { kind: 'team', teamId: team.id }, level: 'admin',
        }))).toMatchObject({ kind: 'saved' });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: member, homeId, id: definition.id, revision: 0,
        }))).resolves.toMatchObject({ kind: 'ready', delegated: true, custodianAccountId: owner });
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: false } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: member, homeId, id: definition.id, revision: 0,
        }))).resolves.toMatchObject({ kind: 'ready', delegated: false, custodianAccountId: owner });
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: true } });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: team.id, accountId: owner } } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: member, homeId, id: definition.id, revision: 0,
        }))).rejects.toMatchObject({ code: 'permission_denied' });

        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: member } },
            data: { status: 'suspended' } });
        expect((await requestPreset(member, 'get', { homeId, id: definition.id })).statusCode).toBe(404);
        expect((await requestPreset(member, 'list', { homeId, owner: { kind: 'team', teamId: team.id } })).json())
            .toEqual({ kind: 'listed', presets: [] });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: member, homeId, id: definition.id, revision: 0,
        }))).resolves.toEqual({ kind: 'refused', code: 'preset_not_found' });
    });

    it('inherits Team archive without rewriting the opaque stored preset row', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-team-archive-owner';
        const member = 'preset-team-archive-member';
        const outsider = 'preset-team-archive-outsider';
        await db.account.createMany({ data: [owner, member, outsider].map(id => ({
            id, encryptionMode: 'plain', publicKey: null,
        })) });
        const team = await db.team.create({ data: { name: 'Archived opaque presets' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const definition = taggedPlainPreset({
            id: 'preset-team-archive', homeId, owner: { kind: 'team', teamId: team.id },
            name: 'Archived private setup', privateFields: { setup: { scripts: [{ body: 'echo retained' }] } },
            controller, teamAcquireDelegated: true,
        });
        expect((await requestPreset(owner, 'create', definition)).statusCode).toBe(200);
        expect(await inTx(tx => archiveTeamInTx(tx, { actorAccountId: owner, teamId: team.id }))).toMatchObject({ ok: true });
        const archivedAt = (await db.team.findUniqueOrThrow({ where: { id: team.id } })).archivedAt?.getTime();
        expect(archivedAt).toEqual(expect.any(Number));
        for (const actor of [owner, member]) {
            expect((await requestPreset(actor, 'get', { homeId, id: definition.id })).json())
                .toMatchObject({ kind: 'found', preset: { id: definition.id, revision: 0, archivedAt } });
            expect((await requestPreset(actor, 'list', { homeId, owner: definition.owner })).json())
                .toEqual({ kind: 'listed', presets: [] });
            expect((await requestPreset(actor, 'list', {
                homeId, owner: definition.owner, includeArchived: true,
            })).json()).toMatchObject({ kind: 'listed', presets: [{ id: definition.id, archivedAt }] });
        }
        expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } })).archivedAt).toBeNull();
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: owner, homeId, id: definition.id, revision: 0,
        }))).resolves.toEqual({ kind: 'refused', code: 'preset_archived' });
        expect((await requestPreset(member, 'archive', { homeId, id: definition.id, expectedRevision: 0 })).statusCode).toBe(404);
        expect((await requestPreset(outsider, 'get', { homeId, id: definition.id })).statusCode).toBe(404);
        expect(await inTx(tx => restoreTeamInTx(tx, { actorAccountId: owner, teamId: team.id }))).toMatchObject({ ok: true });
        const restored = await requestPreset(owner, 'get', { homeId, id: definition.id });
        expect(restored.statusCode, restored.body).toBe(200);
        expect(restored.json().preset).not.toHaveProperty('archivedAt');
    });

    it('keeps an Account-hosted E2EE preset acquirable without a controller declaration', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-account-hosted-owner';
        const keys = tweetnacl.box.keyPair();
        await db.account.create({ data: {
            id: owner, encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey),
        } });
        const id = 'preset-account-hosted';
        const census = await readReadyPresetRecipientCensus(owner, {
            homeId, owner: { kind: 'account', accountId: owner },
        });
        const accountHostedLaunch = {
            provider: { pluginId: 'account.hosted.not-installed', localId: 'opaque-host' },
            schemaVersion: 1, name: 'Account-hosted private launch', choices: { deferredCredential: 'opaque' },
        };
        const sealed = sealManagedMachinePresetContentV1({
            presetId: id, mode: 'e2ee',
            content: { v: 1, name: 'Account-hosted private preset', launch: accountHostedLaunch },
            recipientCensus: census.recipients, randomBytes: tweetnacl.randomBytes,
        });
        const saved = await requestPreset(owner, 'create', {
            id, homeId, owner: { kind: 'account', accountId: owner }, contentEncryptionMode: 'e2ee',
            content: sealed.content, recipients: sealed.recipients,
        });
        expect(saved.statusCode, saved.body).toBe(200);
        const selected = await inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: owner, homeId, id, revision: 0,
        }));
        expect(selected).toMatchObject({ kind: 'ready', delegated: false, custodianAccountId: owner,
            presetContent: { content: sealed.content, recipients: sealed.recipients } });
        if (selected.kind !== 'ready') throw new Error('Expected Account-hosted preset selection');
        expect(selected.preset).not.toHaveProperty('controller');
        const ownerEnvelope = sealed.recipients.find(recipient => recipient.accountId === owner)?.envelope;
        if (!ownerEnvelope) throw new Error('Expected Account-hosted recipient envelope');
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId: id, mode: 'e2ee', projection: { content: sealed.content, recipientEnvelope: ownerEnvelope },
            accountId: owner, accountKey: keys.secretKey,
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, randomBytes: tweetnacl.randomBytes,
        });
        if (!presetContentOverride) throw new Error('Expected Account-hosted override');
        const admitted = await admitManagedAcquire({
            custodianAccountId: owner, requesterAccountId: owner, requestEnvelopeDigest: 'account-hosted-opaque',
            input: { requestId: 'account-hosted-opaque', continuationPresent: false, input: {
                selection: { kind: 'preset' as const, homeId, id, revision: 0 },
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
                presetContentOverride,
            } },
        });
        expect(admitted).toMatchObject({ machine: { preset: { id, revision: 0 } },
            presetContent: { content: sealed.content, recipients: sealed.recipients } });
        expect(admitted.machine).not.toHaveProperty('controller');
        expect(admitted.machine).not.toHaveProperty('launch');
    });

    it('resolves exact delegated acquire custody without a controller grant and withdraws it at the next admission', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-exact-custodian';
        const member = 'preset-exact-member';
        const stranger = 'preset-exact-stranger';
        await db.account.createMany({ data: [owner, member, stranger].map(id => ({ id, encryptionMode: 'plain', publicKey: null })) });
        const team = await db.team.create({ data: { name: 'Exact delegated Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const controller = { machineId: 'exact-preset-controller', installationId: 'exact-preset-installation' };
        const publicKey = new Uint8Array(tweetnacl.sign.keyPair().publicKey);
        await db.machine.create({ data: { id: controller.machineId, accountId: owner, metadata: '{}',
            installationId: controller.installationId, installationPublicKey: publicKey } });
        const definition = taggedPlainPreset({ id: 'exact-delegated-preset', homeId,
            owner: { kind: 'team', teamId: team.id }, name: 'Private exact preset',
            privateFields: { launch: { provider: { pluginId: 'missing.private.provider', localId: 'opaque' },
                schemaVersion: 44, choices: { credential: 'unavailable' } } },
            controller, teamAcquireDelegated: true, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        expect((await requestPreset(owner, 'create', definition)).statusCode).toBe(200);
        const payload = { homeId, id: definition.id, revision: 0, controller };
        const resolved = await requestPreset(member, 'resolve-acquire', payload);
        expect(resolved.statusCode, resolved.body).toBe(200);
        expect(resolved.json()).toEqual({ kind: 'resolved', controller,
            controllerAccess: { custodian: { accountId: owner }, installationPublicKey: encodeBase64(publicKey, 'base64url') } });
        expect(resolved.body).not.toContain('missing.private.provider');
        const admitted = await admitManagedAcquire({ requesterAccountId: member, custodianAccountId: owner,
            managedAcquireDelegation: true,
            requestEnvelopeDigest: 'exact-member-opaque-admission', input: {
                requestId: 'exact-member-opaque-admission', continuationPresent: false, input: {
                    selection: { kind: 'preset', homeId, id: definition.id, revision: 0 }, controller,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                    presetContentOverride: { content: definition.content },
                },
            } });
        expect(admitted.machine).toMatchObject({ custodianAccountId: owner, enrollmentAccountId: member,
            controller, preset: { id: definition.id, revision: 0 } });
        expect((await requestPreset(owner, 'resolve-acquire', payload)).json()).toMatchObject({ kind: 'resolved', controller });
        expect((await requestPreset(stranger, 'resolve-acquire', payload)).json()).toMatchObject({ kind: 'refused', code: 'preset_not_found' });
        expect((await requestPreset(member, 'resolve-acquire', { ...payload, controllerAccess: { custodian: { accountId: member } } })).json())
            .toMatchObject({ kind: 'refused', code: 'invalid_request' });
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: false } });
        expect((await requestPreset(member, 'resolve-acquire', payload)).json()).toMatchObject({ kind: 'refused', code: 'permission_denied' });
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: true } });
        expect((await requestPreset(member, 'resolve-acquire', { ...payload, controller: { ...controller, installationId: 'other' } })).json())
            .toMatchObject({ kind: 'refused', code: 'controller_retired' });
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: member } });
        const withdrawn = await requestPreset(member, 'resolve-acquire', payload);
        expect(withdrawn.json()).toMatchObject({ kind: 'refused', code: 'preset_not_found' });
        expect(withdrawn.json()).not.toHaveProperty('controllerAccess');
    });

    it('resolves a delegated Team pool structurally without provider or credential review', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-team-pool-owner';
        const member = 'preset-team-pool-member';
        const stranger = 'preset-team-pool-stranger';
        await db.account.createMany({ data: [owner, member, stranger].map(id => ({
            id, encryptionMode: 'plain', publicKey: null,
        })) });
        const team = await db.team.create({ data: { name: 'Structural pool Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const controller = { machineId: 'preset-team-pool-controller', installationId: 'preset-team-pool-installation' };
        await db.machine.create({ data: {
            id: controller.machineId, accountId: owner, metadata: '{}', installationId: controller.installationId,
            installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey), pluginMaterializationRevision: BigInt(1),
        } });
        const poolId = 'bcace3b7-3a1b-4f20-9e4c-5bd9a9a4d31a';
        await db.machinePool.create({ data: { id: poolId, accountId: owner, teamId: team.id, name: 'Opaque Team pool',
            members: { create: { machineId: controller.machineId, priorityTier: 0 } } } });
        const opaqueLaunch = {
            provider: { pluginId: 'missing.private.provider', localId: 'opaque' },
            schemaVersion: 44, name: 'Never server-reviewed',
            choices: { credential: 'missing', daemonOnly: true },
        };
        const definition = taggedPlainPreset({
            id: 'preset-team-pool', homeId, owner: { kind: 'team', teamId: team.id },
            name: 'Private pooled preset', privateFields: { launch: opaqueLaunch },
            controllerPoolId: poolId, teamAcquireDelegated: true,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        });
        expect((await requestPreset(owner, 'create', definition)).statusCode).toBe(200);

        const app = createAuthenticatedTestApp();
        registerMachinePoolRoutes(app, { io: { in: () => ({ fetchSockets: async () => [{
            data: { clientType: 'machine-scoped', userId: owner, machineId: controller.machineId },
        }] }) } });
        await app.ready();
        const payload = { poolId, requestKey: 'team-pool-opaque', purpose: 'managed-preset' as const,
            preset: { homeId, id: definition.id, revision: 0 } };
        try {
            const resolved = await app.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                headers: { 'x-test-user-id': member }, payload });
            expect(resolved.statusCode, resolved.body).toBe(200);
            expect(resolved.json()).toMatchObject({ kind: 'resolved', poolId, machineId: controller.machineId,
                managedPreset: {
                    preset: { id: definition.id, revision: 0, contentEncryptionMode: 'plain' },
                    controller,
                    controllerAccess: { custodian: { accountId: owner }, installationPublicKey: expect.any(String) },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                } });
            for (const key of ['content', 'recipients', 'launch', 'setup', 'credentials', 'provisioner', 'reviewedFacts']) {
                expect(resolved.json().managedPreset).not.toHaveProperty(key);
            }
            expect(resolved.body).not.toContain('missing.private.provider');
            expect(resolved.body).not.toContain('Never server-reviewed');

            const denied = await app.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                headers: { 'x-test-user-id': stranger }, payload });
            expect(denied.json()).toMatchObject({ kind: 'unavailable', code: 'preset_not_found' });
            await db.machinePoolMember.updateMany({ where: { poolId }, data: { enabled: false } });
            const empty = await app.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                headers: { 'x-test-user-id': member }, payload });
            expect(empty.json()).toMatchObject({ kind: 'unavailable', code: 'pool_no_available_machine', reason: 'empty' });
        } finally {
            await app.close();
        }

        await db.machinePoolMember.updateMany({ where: { poolId }, data: { enabled: true } });
        const selected = await inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: member, homeId, id: definition.id, revision: 0, boundController: controller,
        }));
        expect(selected).toMatchObject({ kind: 'ready', delegated: true, custodianAccountId: owner,
            presetContent: { content: definition.content, recipients: [] } });
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({
            presetId: definition.id, mode: 'plain', projection: { content: definition.content, recipientEnvelope: null },
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
        });
        if (!presetContentOverride) throw new Error('Expected Team pool override');
        const acquired = await admitManagedAcquire({
            custodianAccountId: owner, requesterAccountId: member, requestEnvelopeDigest: 'team-pool-opaque',
            managedAcquireDelegation: true,
            input: { requestId: 'team-pool-opaque', continuationPresent: false, input: {
                selection: { kind: 'preset' as const, homeId, id: definition.id, revision: 0 },
                controller, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
                presetContentOverride,
            } },
        });
        expect(acquired).toMatchObject({ machine: { enrollmentAccountId: member, custodianAccountId: owner, controller },
            presetContent: { content: definition.content, recipients: [] } });
        expect(acquired.machine).not.toHaveProperty('launch');
        expect(acquired.machine).not.toHaveProperty('reviewedFacts');
        expect(await db.machineGrant.count({ where: { principalKind: 'account', machineId: controller.machineId, accountId: member } })).toBe(0);
    });

    it('resolves an Account pool with opaque unavailable private content without exposing it', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-account-pool-owner';
        await db.account.create({ data: { id: owner, encryptionMode: 'plain', publicKey: null } });
        const controller = { machineId: 'preset-account-pool-controller', installationId: 'preset-account-pool-installation' };
        await db.machine.create({ data: {
            id: controller.machineId, accountId: owner, metadata: '{}', installationId: controller.installationId,
            installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey), pluginMaterializationRevision: BigInt(1),
        } });
        const poolId = '1fb68721-4f3b-4cbd-a696-3ca3d399ff22';
        await db.machinePool.create({ data: { id: poolId, accountId: owner, name: 'Opaque Account pool',
            members: { create: { machineId: controller.machineId, priorityTier: 0 } } } });
        const opaqueLaunch = {
            provider: { pluginId: 'account.pool.not-installed', localId: 'opaque' },
            schemaVersion: 71, name: 'Hidden Account pool declaration',
            choices: { credentialRef: 'missing', opaque: true },
        };
        const definition = taggedPlainPreset({
            id: 'preset-account-pool', homeId, owner: { kind: 'account', accountId: owner },
            name: 'Private Account pool preset', privateFields: { launch: opaqueLaunch }, controllerPoolId: poolId,
        });
        const saved = await requestPreset(owner, 'create', definition);
        expect(saved.statusCode, saved.body).toBe(200);

        const app = createAuthenticatedTestApp();
        registerMachinePoolRoutes(app, { io: { in: () => ({ fetchSockets: async () => [{
            data: { clientType: 'machine-scoped', userId: owner, machineId: controller.machineId },
        }] }) } });
        await app.ready();
        try {
            const resolved = await app.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                headers: { 'x-test-user-id': owner }, payload: {
                    poolId, requestKey: 'account-pool-opaque', purpose: 'managed-preset',
                    preset: { homeId, id: definition.id, revision: 0 },
                } });
            expect(resolved.statusCode, resolved.body).toBe(200);
            expect(resolved.json()).toMatchObject({ kind: 'resolved', machineId: controller.machineId,
                managedPreset: {
                    preset: { id: definition.id, revision: 0, contentEncryptionMode: 'plain' },
                    controller,
                    controllerAccess: { custodian: { accountId: owner }, installationPublicKey: expect.any(String) },
                } });
            for (const key of ['content', 'recipients', 'launch', 'setup', 'credentials', 'provisioner', 'reviewedFacts']) {
                expect(resolved.json().managedPreset).not.toHaveProperty(key);
            }
            expect(resolved.body).not.toContain('account.pool.not-installed');
            expect(resolved.body).not.toContain('Hidden Account pool declaration');
        } finally {
            await app.close();
        }

        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: owner, homeId, id: definition.id, revision: 0, boundController: controller,
        }))).resolves.toMatchObject({ kind: 'ready', delegated: false, custodianAccountId: owner,
            presetContent: { content: definition.content, recipients: [] } });
    });
});
