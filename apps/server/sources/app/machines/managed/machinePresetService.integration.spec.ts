import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from 'fastify';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PluginManifestV2Schema } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import * as prisma from '@/storage/prisma';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { machinesRoutes } from "@/app/api/routes/machines/machinesRoutes";
import { registerMachinePoolRoutes } from '@/app/api/routes/machines/pools/registerMachinePoolRoutes';
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx, type Tx } from "@/storage/inTx";
import { createQualifiedConnectedAccountIdentityDigest } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import { resolveMachinePresetForAcquireInTx } from "./machinePresetService";
import { resolveMachineSetup } from './machineSetup';
import { archiveTeamInTx, restoreTeamInTx } from '@/app/teams/lifecycle';
import { createEmptyMachineSetupDesiredV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { createReleaseLessDeclarationV1, mergeReleaseLessDeclarationV2 } from "@/app/plugins/availability/currentDeclaration";
import { admitManagedAcquire } from "./managedAcquire";
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

describe("Machine preset relational owner", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-machine-presets-", initAuth: false, initEncrypt: true });
    }, 120_000);

    afterAll(async () => { if (harness) await harness.close(); });

    it('publishes the shared preset collection discriminator only for real content mutations', async () => {
        const accountId = 'preset-collection-publication-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const id = 'preset-collection-publication';
        const changes = () => db.accountChange.findMany({ where: { accountId }, select: { kind: true, entityId: true, cursor: true } });
        let cursor = -1;
        const mutations = [
            { operation: 'create', input: { homeId, id, owner: { kind: 'account', accountId }, name: 'Before', setup: { scripts: [{ body: 'echo ready' }] } } },
            { operation: 'update', input: { homeId, id, expectedRevision: 0, patch: { name: 'After' } } },
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
        const unchanged = await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 3, patch: { name: 'After' } });
        expect(unchanged.json()).toMatchObject({ kind: 'saved', preset: { revision: 3 } });
        expect((await changes())[0]!.cursor).toBe(cursor);
        const conflict = await requestPreset(accountId, 'update', { homeId, id, expectedRevision: 0, patch: { name: 'Rejected' } });
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

    it('projects only public delegated controller and fixed review facts for a Plain member without Machine access', async () => {
        const encryptionMode = 'plain';
        const homeId = await getOrCreateServerIdentityId();
        const owner = `preset-public-controller-owner-${encryptionMode}`;
        const member = `preset-public-controller-member-${encryptionMode}`;
        await db.account.createMany({ data: [owner, member].map(id => ({ id,
            publicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64'), encryptionMode })) });
        const team = await db.team.create({ data: { name: 'Company compute' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' }] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const installationPublicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
        await db.machine.update({ where: { id: controller.machineId }, data: { installationPublicKey: new Uint8Array(installationPublicKey) } });
        const definition = { id: `preset-public-controller-${encryptionMode}`, homeId, name: 'Team guest', owner: { kind: 'team', teamId: team.id },
            controllerDisplayName: 'Company builder',
            controller, launch, teamAcquireDelegated: true, retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' }, wakeOnAcceptedMessage: false };
        expect((await requestPreset(owner, 'create', definition)).statusCode).toBe(200);
        const target = { homeId, id: definition.id };
        const result = (await requestPreset(member, 'get', target)).json().preset;
        expect(result.controllerDisplayName).toBe(definition.controllerDisplayName);
        expect(result.launch).toEqual(launch);
        expect((await requestPreset(member, 'list', { homeId })).json().presets)
            .toContainEqual(expect.objectContaining({ id: definition.id, controllerDisplayName: definition.controllerDisplayName }));
        expect(result.delegatedAcquire).toMatchObject({ kind: 'ready', controller: { custodian: { accountId: owner },
            installationPublicKey: encodeBase64(installationPublicKey, 'base64url') },
            // The reviewed Machine is named for itself (the provider's default), not after the preset's launch.
            reviewedFacts: { controller, launch: { ...launch, name: 'Guest' }, retention: definition.retention, wakeOnAcceptedMessage: false,
                preset: { id: definition.id, revision: 0 } } });
        expect(result.delegatedAcquire).not.toHaveProperty('credentialPurposes');
        expect(result.delegatedAcquire.controller).not.toHaveProperty('metadata');
        expect((await requestPreset(owner, 'get', target)).json().preset).not.toHaveProperty('delegatedAcquire');
        expect(await db.machineAccountGrant.count({ where: { machineId: controller.machineId, accountId: member } })).toBe(0);
        expect((await requestPreset(owner, 'update', { ...target, expectedRevision: 0,
            patch: { controllerDisplayName: 'Renamed builder' } })).json()).toMatchObject({ kind: 'saved',
                preset: { controllerDisplayName: 'Renamed builder', revision: 1 } });
        expect((await requestPreset(member, 'get', target)).json().preset.controllerDisplayName).toBe('Renamed builder');
        expect((await requestPreset(owner, 'update', { ...target, expectedRevision: 1,
            patch: { teamAcquireDelegated: true } })).json()).toMatchObject({ kind: 'saved',
                preset: { controllerDisplayName: 'Renamed builder', revision: 1 } });
        const cleared = (await requestPreset(owner, 'update', { ...target, expectedRevision: 1,
            patch: { controllerDisplayName: null } })).json();
        expect(cleared).toMatchObject({ kind: 'saved', preset: { revision: 2 } });
        expect(cleared.preset).not.toHaveProperty('controllerDisplayName');
        expect((await requestPreset(member, 'get', target)).json().preset).not.toHaveProperty('controllerDisplayName');
        const credentials = [{ purpose: { consumer: launch.provider, purpose: 'native' },
            account: { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: 'private-company-connection' } }];
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { launch: { ...launch, credentials } } });
        const unavailable = (await requestPreset(member, 'get', target)).json().preset;
        expect(unavailable).not.toHaveProperty('controllerDisplayName');
        expect(unavailable.launch).not.toHaveProperty('credentials');
        expect(unavailable.delegatedAcquire).toEqual({ kind: 'unavailable', code: 'credential_unavailable' });
        expect((await requestPreset(owner, 'get', target)).json().preset.launch.credentials).toEqual(credentials);
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: false, revision: { increment: 1 } } });
        const withdrawn = (await requestPreset(member, 'get', target)).json().preset;
        expect(withdrawn.launch).not.toHaveProperty('credentials');
        expect(withdrawn.delegatedAcquire).toEqual({ kind: 'unavailable', code: 'permission_denied' });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: member } }, data: { status: 'suspended' } });
        expect((await requestPreset(member, 'get', target)).statusCode).toBe(404);
    });

    it('projects an E2EE Team delegated label and typed availability without owner Machine metadata', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-public-controller-owner-e2ee';
        const member = 'preset-public-controller-member-e2ee';
        await db.account.createMany({ data: [owner, member].map(id => ({ id,
            publicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64'), encryptionMode: 'e2ee' })) });
        const team = await db.team.create({ data: { name: 'E2EE shared compute' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' }] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const installationPublicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19)).publicKey;
        await db.machine.update({ where: { id: controller.machineId }, data: { installationPublicKey: new Uint8Array(installationPublicKey) } });
        const definition = { id: 'preset-public-controller-e2ee', homeId, name: 'E2EE team guest', owner: { kind: 'team', teamId: team.id },
            controllerDisplayName: 'E2EE company builder', controller, launch, teamAcquireDelegated: true,
            retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' }, wakeOnAcceptedMessage: false };
        const created = await requestPreset(owner, 'create', definition);
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({ kind: 'saved', preset: { controllerDisplayName: definition.controllerDisplayName } });

        const assertPublicProjection = (preset: Record<string, unknown>) => {
            expect(preset.controllerDisplayName).toBe(definition.controllerDisplayName);
            // The exact controller carrier is retained for preset admission; it is
            // identity only and carries no Machine metadata or access grant.
            expect(preset.controller).toEqual(controller);
            expect(preset.launch).not.toHaveProperty('credentials');
            expect(preset.delegatedAcquire).toMatchObject({ kind: 'ready', controller: { custodian: { accountId: owner },
                installationPublicKey: encodeBase64(installationPublicKey, 'base64url') },
                reviewedFacts: { controller, launch: { ...launch, name: 'Guest' }, optionStatus: 'current' } });
            expect(preset.delegatedAcquire).not.toHaveProperty('credentialPurposes');
            expect(preset.delegatedAcquire.controller).not.toHaveProperty('metadata');
            expect(preset.delegatedAcquire.reviewedFacts).not.toHaveProperty('credentials');
        };

        const target = { homeId, id: definition.id };
        const first = (await requestPreset(member, 'get', target)).json().preset as Record<string, unknown>;
        assertPublicProjection(first);
        const listed = (await requestPreset(member, 'list', { homeId })).json().presets as Record<string, unknown>[];
        assertPublicProjection(listed.find(preset => preset.id === definition.id)!);
        expect(await db.machineAccountGrant.count({ where: { machineId: controller.machineId, accountId: member } })).toBe(0);

        const renamed = await requestPreset(owner, 'update', { ...target, expectedRevision: 0,
            patch: { controllerDisplayName: 'Renamed E2EE builder' } });
        expect(renamed.statusCode, renamed.body).toBe(200);
        const afterUpdate = (await requestPreset(member, 'get', target)).json().preset as Record<string, unknown>;
        expect(afterUpdate.controllerDisplayName).toBe('Renamed E2EE builder');
        expect(afterUpdate.controller).toEqual(controller);
        expect(afterUpdate.delegatedAcquire).toMatchObject({ kind: 'ready' });

        const failingId = 'preset-public-controller-e2ee-failing-options';
        const credentials = [{ purpose: { consumer: launch.provider, purpose: 'native' },
            account: { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: 'missing-e2ee-profile' } }];
        const failingDefinition = { ...definition, id: failingId, name: 'E2EE failing options', controllerDisplayName: 'E2EE options builder',
            launch: { ...launch, credentials } };
        const failingCreated = await requestPreset(owner, 'create', failingDefinition);
        expect(failingCreated.statusCode, failingCreated.body).toBe(200);
        expect(failingCreated.json()).toMatchObject({ kind: 'saved', preset: { controllerDisplayName: failingDefinition.controllerDisplayName } });
        const failing = (await requestPreset(member, 'get', { homeId, id: failingId })).json().preset as Record<string, unknown>;
        expect(failing.controllerDisplayName).toBe(failingDefinition.controllerDisplayName);
        expect(failing.controller).toEqual(controller);
        expect(failing.launch).not.toHaveProperty('credentials');
        expect(failing.delegatedAcquire).toEqual({ kind: 'unavailable', code: 'credential_unavailable' });
        const failingList = (await requestPreset(member, 'list', { homeId })).json().presets as Record<string, unknown>[];
        expect(failingList.find(preset => preset.id === failingId)?.delegatedAcquire)
            .toEqual({ kind: 'unavailable', code: 'credential_unavailable' });
        const failingUpdate = await requestPreset(owner, 'update', { homeId, id: failingId, expectedRevision: 0,
            patch: { controllerDisplayName: 'Renamed E2EE options builder' } });
        expect(failingUpdate.statusCode, failingUpdate.body).toBe(200);
        expect((await requestPreset(member, 'get', { homeId, id: failingId })).json().preset.delegatedAcquire)
            .toEqual({ kind: 'unavailable', code: 'credential_unavailable' });
    });

    it.each([
        { encryptionMode: 'e2ee', team: true, delegated: true },
        { encryptionMode: 'plain', team: false, delegated: false },
        { encryptionMode: 'plain', team: true, delegated: false },
    ] as const)('persists controller labels only for delegated Team presets for $encryptionMode team=$team delegated=$delegated, including retained labels', async scenario => {
        const homeId = await getOrCreateServerIdentityId();
        const accountId = `preset-private-label-${scenario.encryptionMode}-${scenario.team}`;
        await db.account.create({ data: { id: accountId, encryptionMode: scenario.encryptionMode,
            publicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64') } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const team = await db.team.create({ data: { name: 'Private controller label' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId, role: 'admin' } });
        const definition = { id: `${accountId}-preset`, homeId, name: 'Guest', controller, launch,
            owner: scenario.team ? { kind: 'team', teamId: team.id } : { kind: 'account', accountId },
            ...(scenario.delegated ? { teamAcquireDelegated: true } : {}), controllerDisplayName: 'Private builder' };
        const publishes = scenario.team && scenario.delegated;
        const created = await requestPreset(accountId, 'create', definition);
        expect(created.statusCode, created.body).toBe(200);
        if (publishes) {
            expect(created.json().preset.controllerDisplayName).toBe(definition.controllerDisplayName);
            expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } })).launch)
                .toHaveProperty('controllerDisplayName', definition.controllerDisplayName);
        } else {
            expect(created.json().preset).not.toHaveProperty('controllerDisplayName');
            expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } })).launch)
                .not.toHaveProperty('controllerDisplayName');
        }
        // Retained development rows and caller-provided patches must preserve the
        // approved shared label, while private/non-delegated rows stay stripped.
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { launch: { ...launch, controllerDisplayName: 'Old retained builder' } } });
        for (const patch of [{ name: 'Content edit' }, { controllerDisplayName: 'Supplied builder' }]) {
            const current = await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } });
            const updated = await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: current.revision, patch });
            expect(updated.statusCode, updated.body).toBe(200);
            if (publishes) {
                const expectedLabel = 'controllerDisplayName' in patch ? patch.controllerDisplayName : 'Old retained builder';
                expect(updated.json().preset.controllerDisplayName).toBe(expectedLabel);
                expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } })).launch)
                    .toHaveProperty('controllerDisplayName', expectedLabel);
            } else {
                expect(updated.json().preset).not.toHaveProperty('controllerDisplayName');
                expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } })).launch)
                    .not.toHaveProperty('controllerDisplayName');
            }
        }
    });

    it('selects only distinct credentials for a delegated preset collection and observes retirement on the next read', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-scale-owner';
        const member = 'preset-scale-member';
        await db.account.createMany({ data: [owner, member].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const team = await db.team.create({ data: { name: 'Scale-shaped delegated presets' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' }] });
        const purposes = ['cloud', 'cua'];
        const controller = await seedCurrentProvisioner(owner, homeId, purposes);
        await db.machine.update({ where: { id: controller.machineId }, data: {
            installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey),
        } });
        const refs = ['selected-first', 'selected-second'].map(accountId => ({
            service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId,
        }));
        for (const ref of refs) {
            const written = await mutateQualifiedConnectedServiceCredential({ accountId: owner, ref,
                expectedCredentialRevision: null, authenticationModeId: 'api-key',
                content: { t: 'plain', v: { token: 'synthetic-private-token' } }, metadata: { displayName: ref.accountId, scopes: [] } });
            expect(written.status).toBe('written');
        }
        const sample = await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: owner } });
        await db.serviceAccountToken.createMany({ data: Array.from({ length: 1024 }, (_, index) => {
            const ref = { ...refs[0]!, accountId: `unrelated-${index}` };
            return { ...sample, id: `preset-scale-credential-${index}`, connectedAccountId: ref.accountId,
                qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(ref) };
        }) });
        await db.managedMachinePreset.createMany({ data: Array.from({ length: 128 }, (_, index) => ({
            id: `preset-scale-${index.toString().padStart(3, '0')}`, homeId, teamId: team.id, name: `Guest ${index}`,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            teamAcquireDelegated: true, launch: { ...launch, credentials: purposes.map(purpose => ({
                purpose: { consumer: launch.provider, purpose }, account: refs[index % refs.length]!,
            })) },
        })) });

        const rowCounts: number[] = [];
        const original = db.$transaction;
        // Observe only the real database boundary; route, admission, projection,
        // stored metadata and SQL execution remain the production path.
        const observe = (tx: Tx): Tx => new Proxy(tx, { get(client, property, proxyReceiver) {
                if (property !== '$queryRaw') return Reflect.get(client, property, proxyReceiver);
                return async (...values: unknown[]) => {
                    const rows: unknown = await Reflect.apply(client.$queryRaw, client, values);
                    const query = values[0];
                    if (query && typeof query === 'object' && String(Reflect.get(query, 'sql')).includes('ServiceAccountToken')) {
                        if (!Array.isArray(rows)) throw new Error('Expected credential row set');
                        rowCounts.push(rows.length);
                        // Fail at the measured storage boundary before an old
                        // inventory scan can project every unrelated profile.
                        expect(rows.length).toBeLessThanOrEqual(refs.length);
                        expect(rows.flatMap(row => Object.keys(row))).not.toContain('token');
                        expect(rows.flatMap(row => Object.keys(row))).not.toContain('configurationContent');
                    }
                    return rows;
                };
            } });
        // SQLite list reads use the real snapshot connection rather than
        // Prisma's transaction callback; observe both existing DB paths.
        const snapshot = prisma.withSqliteReadSnapshot;
        const snapshotObservation = vi.spyOn(prisma, 'withSqliteReadSnapshot').mockImplementation(
            (read, options) => snapshot(tx => read(observe(tx)), options),
        );
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(observe(tx)), ...args.slice(1)]);
        } });
        try {
            const listed = await requestPreset(member, 'list', { homeId, owner: { kind: 'team', teamId: team.id } });
            expect(rowCounts).toEqual([2]);
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().presets).toHaveLength(128);
            expect(listed.json().presets.every((preset: { delegatedAcquire: { kind: string } }) => preset.delegatedAcquire.kind === 'ready')).toBe(true);
            expect(listed.body).not.toContain('synthetic-private-token');

            await db.serviceAccountToken.updateMany({ where: { accountId: owner, connectedAccountId: refs[0]!.accountId },
                data: { expiresAt: new Date(0) } });
            rowCounts.length = 0;
            const expired = await requestPreset(member, 'list', { homeId, owner: { kind: 'team', teamId: team.id } });
            expect(expired.statusCode, expired.body).toBe(200);
            expect(expired.json().presets.filter((preset: { delegatedAcquire: { kind: string } }) => preset.delegatedAcquire.kind === 'ready')).toHaveLength(64);
            expect(expired.json().presets[0].delegatedAcquire).toEqual({ kind: 'unavailable', code: 'credential_unavailable' });
            expect(rowCounts).toEqual([2]);
        } finally { db.$transaction = original; snapshotObservation.mockRestore(); }
    });

    it('saves setup-only Account and Team presets without controller authority and preserves optional-part fencing', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const accountId = 'preset-setup-only-owner';
        const memberId = 'preset-setup-only-member';
        await db.account.createMany({ data: [accountId, memberId].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const setup = { scripts: [{ body: 'echo saved setup' }] };
        const input = { id: 'preset-setup-only-account', homeId, name: 'Setup only', owner: { kind: 'account', accountId }, setup };
        // There is deliberately no Machine, provisioner or Connected Account fixture.
        const created = await requestPreset(accountId, 'create', input);
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toEqual({ kind: 'saved', preset: { ...input, revision: 0 } });
        expect((await requestPreset(accountId, 'create', input)).json()).toEqual(created.json());
        expect((await requestPreset(accountId, 'list', { homeId })).json()).toEqual({ kind: 'listed', presets: [created.json().preset] });
        expect((await requestPreset(memberId, 'get', { homeId, id: input.id })).statusCode).toBe(404);
        expect((await requestPreset(accountId, 'update', { homeId, id: input.id, expectedRevision: 0,
            patch: { setup: null } })).statusCode).toBe(400);
        expect((await requestPreset(accountId, 'get', { homeId, id: input.id })).json()).toEqual({ kind: 'found', preset: created.json().preset });
        expect((await requestPreset(accountId, 'create', { ...input, id: 'preset-half-creation',
            controller: { machineId: 'missing-controller', installationId: 'missing-installation' } })).statusCode).toBe(400);
        const team = await db.team.create({ data: { name: 'Setup-only Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId, role: 'admin' }, { teamId: team.id, accountId: memberId, role: 'member' },
        ] });
        const teamInput = { ...input, id: 'preset-setup-only-team', owner: { kind: 'team', teamId: team.id } };
        expect((await requestPreset(memberId, 'create', teamInput)).statusCode).toBe(403);
        expect((await requestPreset(accountId, 'create', teamInput)).json()).toMatchObject({ kind: 'saved', preset: { revision: 0, setup } });
        expect((await requestPreset(memberId, 'get', { homeId, id: teamInput.id })).json()).toMatchObject({ kind: 'found', preset: { setup } });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId } }, data: { status: 'suspended' } });
        expect((await requestPreset(accountId, 'update', { homeId, id: teamInput.id, expectedRevision: 0,
            patch: { name: 'Denied after retirement' } })).statusCode).toBe(404);
        await db.account.update({ where: { id: accountId }, data: { status: 'suspended' } });
        expect((await requestPreset(accountId, 'create', { ...input, id: 'preset-retired-owner' })).statusCode).toBe(403);
    });

    it('clears creation while preserving setup and refuses acquisition or clearing the last part', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const accountId = 'preset-clear-creation-owner';
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const setup = { scripts: [{ body: 'echo retained setup' }] };
        const definition = { id: 'preset-clear-creation', homeId, owner: { kind: 'account', accountId },
            name: 'Creation and setup', launch, controller, setup };
        expect((await requestPreset(accountId, 'create', definition)).json()).toMatchObject({ kind: 'saved' });
        expect((await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { launch: null } })).statusCode).toBe(400);
        expect((await requestPreset(accountId, 'get', { homeId, id: definition.id })).json())
            .toMatchObject({ kind: 'found', preset: { revision: 0, launch, controller, setup } });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId: launch.provider.pluginId } }, data: { enabled: false } });
        const cleared = await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { launch: null, controller: null } });
        expect(cleared.statusCode, cleared.body).toBe(200);
        const setupOnly = { id: definition.id, homeId, owner: definition.owner, name: definition.name, revision: 1, setup };
        expect(cleared.json()).toEqual({ kind: 'saved', preset: setupOnly });
        expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id },
            select: { launch: true, controllerMachineId: true, controllerInstallationId: true, setup: true } }))
            .toEqual({ launch: null, controllerMachineId: null, controllerInstallationId: null, setup });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId, id: definition.id, revision: 1 })))
            .resolves.toEqual({ kind: 'refused', code: 'invalid_request' });
        expect((await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 1,
            patch: { setup: null } })).statusCode).toBe(400);
        expect((await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 1,
            patch: { launch, controller } })).json()).toMatchObject({ kind: 'saved', preset: { revision: 2, launch, controller } });
        expect((await requestPreset(accountId, 'list', { homeId })).json()).toEqual({ kind: 'listed',
            presets: [{ ...setupOnly, revision: 2, launch, controller }] });
        const archived = await requestPreset(accountId, 'archive', { homeId, id: definition.id, expectedRevision: 2 });
        expect(archived.json()).toMatchObject({ kind: 'saved', preset: { revision: 3, setup, archivedAt: expect.any(Number) } });
        expect((await requestPreset(accountId, 'restore', { homeId, id: definition.id, expectedRevision: 3 })).json())
            .toEqual({ kind: 'saved', preset: { ...setupOnly, revision: 4, launch, controller } });
    });

    it('captures the exact admitted setup revision and retains it when the preset changes or is archived', async () => {
        const accountId = 'preset-setup-snapshot-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const setup = { scripts: [{ body: 'echo original' }] };
        const definition = { id: 'preset-setup-snapshot', homeId, owner: { kind: 'account', accountId }, name: 'Setup', launch, controller, setup };
        expect((await requestPreset(accountId, 'create', definition)).json()).toMatchObject({ kind: 'saved' });
        const request = { custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: 'setup-snapshot-admission',
            input: { requestId: 'setup-snapshot-create', continuationPresent: false, input: { enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const }, selection: { kind: 'preset' as const,
                homeId, id: definition.id, revision: 0 }, controller, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } } };
        const admitted = await admitManagedAcquire(request);
        expect(admitted.machine.machineSetup).toEqual({ setup, state: 'pending' });
        // A preset is reused: its Machine takes the provider's default name, not the preset's launch name, unless one is given.
        expect(admitted.machine.launch.name).toBe('Guest');
        const named = await admitManagedAcquire({ ...request, requestEnvelopeDigest: 'setup-snapshot-named', input: { ...request.input,
            requestId: 'setup-snapshot-named', input: { ...request.input.input, selection: { ...request.input.input.selection, name: 'web-2' } } } });
        expect(named.machine.launch.name).toBe('web-2');
        expect((await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { setup: { scripts: [{ body: 'echo new' }] } } })).json()).toMatchObject({ kind: 'saved', preset: { revision: 1 } });
        expect((await requestPreset(accountId, 'archive', { homeId, id: definition.id, expectedRevision: 1 })).json()).toMatchObject({ kind: 'saved' });
        const replay = await admitManagedAcquire(request);
        expect(replay).toMatchObject({ replayed: true, machine: { id: admitted.machine.id,
            preset: { id: definition.id, revision: 0 }, machineSetup: { setup, state: 'pending' } } });
        expect(await db.managedMachine.count({ where: { admittedActionRequestId: request.input.requestId } })).toBe(1);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } })).machineSetup)
            .toEqual({ setup, state: 'pending' });
        await expect(admitManagedAcquire({ ...request, requestEnvelopeDigest: 'changed-setup-root' }))
            .rejects.toMatchObject({ code: 'request_conflict' });
    });

    it('revisions setup with the preset, drops stored additions and resets it without allocating', async () => {
        const accountId = 'preset-environment-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const setup = { toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' }, scripts: [{ body: 'echo ready' }],
            secretRefs: { v: 1, bindings: { API_TOKEN: { ref: 'setup-token' } } } };
        const definition = { id: 'preset-environment', homeId, owner: { kind: 'account', accountId }, name: 'Tools', launch, controller, setup };
        const before = await db.managedMachine.count();
        const created = await requestPreset(accountId, 'create', definition);
        expect(created.statusCode).toBe(200);
        expect(created.json()).toMatchObject({ kind: 'saved', preset: { revision: 0, setup } });
        expect((await requestPreset(accountId, 'create', definition)).json()).toEqual(created.json());
        const { scripts: _scripts, ...retainedSetup } = setup;
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { setup: { ...retainedSetup,
            setupScript: 'echo ready', future: true,
            toolchain: { ...setup.toolchain, future: true }, secretRefs: { ...setup.secretRefs,
                bindings: { API_TOKEN: { ref: 'setup-token', future: true } } } } } });
        expect((await requestPreset(accountId, 'get', { homeId, id: definition.id })).json().preset.setup).toEqual(setup);
        const changed = { ...setup, scripts: [{ body: 'echo changed' }] };
        expect((await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 0, patch: { setup: changed } })).json())
            .toMatchObject({ kind: 'saved', preset: { revision: 1, setup: changed } });
        expect((await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 0, patch: { setup: null } })).json())
            .toEqual({ kind: 'conflict', currentRevision: 1 });
        const cleared = (await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 1, patch: { setup: null } })).json();
        expect(cleared).toMatchObject({ kind: 'saved', preset: { revision: 2 } });
        expect(cleared.preset).not.toHaveProperty('setup');
        expect(await db.managedMachine.count()).toBe(before);
    });

    it('saves and admits direct Crabbox without a coordinator but refuses an unbound coordinator launch', async () => {
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
        const input = { id: 'preset-crabbox-direct', homeId, owner: { kind: 'account', accountId }, name: 'Local container', launch: localLaunch, controller };
        expect((await requestPreset(accountId, 'create', input)).json()).toMatchObject({ kind: 'saved', preset: { launch: localLaunch } });
        const acquired = await admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: 'crabbox-direct-reviewed',
            input: { requestId: 'crabbox-direct-create', continuationPresent: false, input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: 'one-off', homeId, controller,
                launch: localLaunch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } } });
        expect(acquired).toMatchObject({ machine: { launch: localLaunch } });
        const coordinatorLaunch = { ...localLaunch, choices: { backendId: 'aws', transport: 'coordinator', namespace: 'remote', target: 'linux',
            nativeImageId: 'ami-selected', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 } };
        expect((await requestPreset(accountId, 'create', { ...input, id: 'preset-crabbox-coordinator', launch: coordinatorLaunch })).json())
            .toMatchObject({ kind: 'saved', preset: { launch: coordinatorLaunch } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId,
            id: 'preset-crabbox-coordinator', revision: 0 }))).rejects.toMatchObject({ code: 'credential_unavailable' });
    });

    it("lists accessible future launchs through the authenticated Machine route owner", async () => {
        await db.account.create({ data: { id: "preset-http-owner", publicKey: null, encryptionMode: "plain" } });
        const homeId = await getOrCreateServerIdentityId();
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST", url: "/v1/machines/presets/list",
                headers: { "x-test-user-id": "preset-http-owner" }, payload: { homeId },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ kind: "listed", presets: [] });
        } finally {
            await app.close();
        }
    });

    it.each([
        { team: false, pool: false }, { team: true, pool: false },
        { team: false, pool: true }, { team: true, pool: true },
    ])('saves unavailable creation configuration for team=$team pool=$pool and checks availability at acquisition', async scenario => {
        const accountId = `preset-offline-${scenario.team}-${scenario.pool}`;
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const team = scenario.team ? await db.team.create({ data: { name: accountId,
            memberships: { create: { accountId, role: 'admin' } } } }) : null;
        const pool = scenario.pool ? await db.machinePool.create({ data: { id: crypto.randomUUID(), accountId, name: accountId,
            ...(team ? { teamId: team.id } : {}),
            members: { create: { machineId: controller.machineId, priorityTier: 0, enabled: false } } } }) : null;
        // The saved Docker configuration is useful before its provider is installed
        // or its selected Connected Account is available on the controller.
        const unavailableLaunch = { ...launch, provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' },
            choices: { runtime: 'docker', reviewedEffectDigest: 'a'.repeat(64), configuration: { kind: 'image', image: 'node:22-bookworm' } }, credentials: [{
                purpose: { consumer: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, purpose: 'registry' },
                account: { service: { pluginId: 'happier.devcontainer', localId: 'registry' }, accountId: 'retired-profile' },
            }] };
        const definition = { id: accountId, homeId, name: 'Saved Docker', launch: unavailableLaunch,
            owner: team ? { kind: 'team', teamId: team.id } : { kind: 'account', accountId },
            ...(pool ? { controllerPoolId: pool.id } : { controller }),
            ...(team ? { teamAcquireDelegated: true } : {}) };
        const before = await db.managedMachine.count();
        const created = await requestPreset(accountId, 'create', definition);
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({ kind: 'saved', preset: { id: definition.id, revision: 0 } });
        const editedLaunch = { ...unavailableLaunch, choices: { ...unavailableLaunch.choices,
            configuration: { kind: 'image', image: 'node:24-bookworm' } } };
        const edited = await requestPreset(accountId, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { launch: editedLaunch } });
        expect(edited.statusCode, edited.body).toBe(200);
        expect(edited.json()).toMatchObject({ kind: 'saved', preset: { revision: 1 } });
        expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } })).launch)
            .toMatchObject(editedLaunch);
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId, id: definition.id, revision: 1 })))
            .rejects.toMatchObject({ code: pool ? 'pool_no_available_machine' : 'provider_unavailable' });
        expect(await db.managedMachine.count()).toBe(before);
    });

    it("saves only declared choices without allocation and projects future stored choice fields away", async () => {
        const accountId = "preset-create-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const input = { id: "preset-create", homeId, owner: { kind: "account", accountId }, name: "Launch", launch, controller };
        const before = await db.managedMachine.count();
        const invalid = await requestPreset(accountId, "create", { ...input, launch: { ...launch, choices: { image: "linux", injected: true } } });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toEqual({ kind: "refused", code: "invalid_request" });
        expect(await db.managedMachinePreset.findUnique({ where: { id: input.id } })).toBeNull();
        const created = await requestPreset(accountId, "create", input);
        expect(created.statusCode).toBe(200);
        expect(created.json()).toMatchObject({ kind: "saved", preset: { id: input.id, revision: 0, launch } });
        expect((await requestPreset(accountId, "create", input)).json()).toEqual(created.json());
        expect(await db.managedMachine.count()).toBe(before);
        await db.managedMachinePreset.update({ where: { id: input.id }, data: { launch: { ...launch, choices: { image: "linux", futureChoice: true } } } });
        expect((await requestPreset(accountId, "get", { homeId, id: input.id })).json().preset.launch.choices).toEqual({ image: "linux" });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId, pluginId: launch.provider.pluginId } }, data: { enabled: false } });
        expect((await requestPreset(accountId, "create", { ...input, id: "preset-stale-provider" })).json())
            .toMatchObject({ kind: "saved", preset: { launch } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId,
            id: 'preset-stale-provider', revision: 0 }))).rejects.toMatchObject({ code: 'provider_unavailable' });
    });

    it("saves credential selections without availability and requires the actual credential purpose at acquisition", async () => {
        const accountId = "preset-credential-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        const controller = await seedCurrentProvisioner(accountId, homeId, "acquire-authentication");
        const input = { id: "preset-credential", homeId, owner: { kind: "account", accountId }, name: "Credential launch", launch, controller };
        expect((await requestPreset(accountId, "create", { ...input, id: 'preset-missing-credential' })).json())
            .toMatchObject({ kind: 'saved' });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId,
            id: 'preset-missing-credential', revision: 0 }))).rejects.toMatchObject({ code: 'credential_unavailable' });
        const ref = { service: { pluginId: launch.provider.pluginId, localId: "native-account" }, accountId: "native-profile" };
        const written = await mutateQualifiedConnectedServiceCredential({ accountId, ref, expectedCredentialRevision: null,
            authenticationModeId: "api-key", content: { t: "plain", v: { token: "must-not-disclose" } }, metadata: { displayName: "Native profile", scopes: [] } });
        expect(written.status).toBe("written");
        expect(await listQualifiedConnectedAccounts({ accountId, service: ref.service })).toMatchObject([{ ref, status: "connected", revisionSemantics: "revisioned" }]);
        const selected = { ...launch, credentials: [{ purpose: { consumer: launch.provider, purpose: "acquire-authentication" }, account: ref }] };
        const saved = await requestPreset(accountId, "create", { ...input, launch: selected });
        expect(saved.json(), saved.body).toMatchObject({ kind: "saved", preset: { launch: selected } });
        expect(saved.statusCode).toBe(200);
        expect(saved.body).not.toContain("must-not-disclose");
        const memberId = 'preset-credential-member';
        await db.account.create({ data: { id: memberId, publicKey: null, encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Credential delegation' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId, role: 'admin' }, { teamId: team.id, accountId: memberId, role: 'member' },
        ] });
        const delegatedId = 'preset-credential-delegated';
        expect((await requestPreset(accountId, 'create', { ...input, id: delegatedId,
            owner: { kind: 'team', teamId: team.id }, launch: selected, teamAcquireDelegated: true })).json())
            .toMatchObject({ kind: 'saved' });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: memberId,
            homeId, id: delegatedId, revision: 0 }))).resolves.toMatchObject({ kind: 'ready', delegated: true,
                custodianAccountId: accountId, preset: { launch: selected } });
        const reviewed = { enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const }, selection: { kind: "preset" as const, homeId, id: input.id, revision: 0 }, controller, retention: { kind: "until-delete" as const }, wakeOnAcceptedMessage: false };
        if (written.status !== "written") throw new Error("Credential fixture was not written");
        expect(await deleteQualifiedConnectedServiceCredential({ accountId, ref, expectedCredentialRevision: written.credentialRevision, expectedStorageMode: 'plain', cleanupGroupReferences: false })).toMatchObject({ status: "deleted" });
        expect((await requestPreset(accountId, "create", { ...input, id: "preset-removed-profile", launch: selected })).json())
            .toMatchObject({ kind: 'saved', preset: { launch: selected } });
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: "verified-removed-profile", input: { input: reviewed, requestId: "removed-profile", continuationPresent: false } }))
            .rejects.toMatchObject({ code: "credential_unavailable" });
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: memberId,
            requestEnvelopeDigest: 'delegated-removed-profile', input: { input: { ...reviewed,
                selection: { ...reviewed.selection, id: delegatedId } }, requestId: 'delegated-removed-profile', continuationPresent: false } }))
            .rejects.toMatchObject({ code: 'credential_unavailable' });
        expect(await db.managedMachine.count({ where: { presetId: input.id } })).toBe(0);
    });

    it('saves and acquires each distinct purpose once and refuses a removed secondary Account', async () => {
        const accountId = 'preset-plural-credential-owner';
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const purposes = ['cloud', 'cua'];
        const controller = await seedCurrentProvisioner(accountId, homeId, purposes);
        const credentials = purposes.map(purpose => ({ purpose: { consumer: launch.provider, purpose },
            account: { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: `native-${purpose}` } }));
        const written = await Promise.all(credentials.map(credential => mutateQualifiedConnectedServiceCredential({ accountId, ref: credential.account,
            expectedCredentialRevision: null, authenticationModeId: 'api-key', content: { t: 'plain', v: { token: `private-${credential.account.accountId}` } },
            metadata: { displayName: credential.account.accountId, scopes: [] } })));
        const selected = { ...launch, credentials };
        const definition = { id: 'preset-plural-credential', homeId, owner: { kind: 'account', accountId }, name: 'Plural launch', launch: selected, controller };
        expect((await requestPreset(accountId, 'create', { ...definition, id: 'preset-plural-incomplete',
            launch: { ...selected, credentials: credentials.slice(0, 1) } })).json()).toMatchObject({ kind: 'saved' });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId,
            id: 'preset-plural-incomplete', revision: 0 }))).rejects.toMatchObject({ code: 'credential_unavailable' });
        const saved = await requestPreset(accountId, 'create', definition);
        expect(saved.json()).toMatchObject({ kind: 'saved', preset: { launch: selected } });
        expect(saved.body).not.toContain('private-native');
        const reviewed = { enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const }, selection: { kind: 'preset' as const, homeId, id: definition.id, revision: 0 }, controller,
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const admitted = await admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId,
            requestEnvelopeDigest: 'plural-reviewed', input: { input: reviewed, requestId: 'plural-acquire', continuationPresent: false } });
        expect(admitted.machine.launch.credentials).toEqual(credentials);
        const secondary = written[1];
        if (secondary?.status !== 'written') throw new Error('Secondary credential fixture was not written');
        await deleteQualifiedConnectedServiceCredential({ accountId, ref: credentials[1]!.account, expectedCredentialRevision: secondary.credentialRevision, expectedStorageMode: 'plain', cleanupGroupReferences: false });
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId,
            requestEnvelopeDigest: 'plural-removed', input: { input: reviewed, requestId: 'plural-after-removal', continuationPresent: false } }))
            .rejects.toMatchObject({ code: 'credential_unavailable' });
        // Stored as reviewed, named for the Machine itself (the provider's default), not after the preset.
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } })).launch).toEqual({ ...selected, name: 'Guest' });
    });
    it("admits one resource under concurrent preset cap and replays it after archive without admitting another", async () => {
        const accountId = "preset-admission-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        const controller = await seedCurrentProvisioner(accountId, homeId);
        const created = await requestPreset(accountId, "create", { id: "preset-admission", homeId, owner: { kind: "account", accountId }, name: "Limited", launch, controller, simultaneousLimit: { maximum: 1 } });
        expect(created.statusCode).toBe(200);
        const reviewed = { enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const }, selection: { kind: "preset" as const, homeId, id: "preset-admission", revision: 0 }, controller,
            retention: { kind: "until-delete" as const }, wakeOnAcceptedMessage: false,
            // The reviewed launch is named as the Machine will be: its provider's default, not the preset's launch name.
            reviewedFacts: { launch: { ...launch, name: "Guest" }, controller, optionStatus: "current" as const, prerequisites: [{ requirement: { kind: "systemTool" as const, id: "native-cli" }, status: "available" as const }],
                billing: { location: "local" as const, stoppedBilling: "not-billed" as const }, retentionCapabilities: { supportedIntents: ["start" as const, "stop" as const, "delete" as const] },
                retention: { kind: "until-delete" as const }, wakeOnAcceptedMessage: false, prices: [{ amount: "0", currency: "USD", unit: "hour", source: "native", observedAt: 17 }],
                preset: { id: "preset-admission", revision: 0, name: "Limited" } } };
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: "verified-preset-mismatch", input: { input: { ...reviewed,
            reviewedFacts: { ...reviewed.reviewedFacts, launch: { ...launch, choices: { image: "unreviewed" } } } }, requestId: "preset-mismatched-facts", continuationPresent: false } }))
            .rejects.toMatchObject({ code: "invalid_request" });
        expect(await db.managedMachine.count({ where: { presetId: "preset-admission" } })).toBe(0);
        const requests = ["preset-admit-one", "preset-admit-two"];
        // The signed Action transport is the genuine external authority boundary; its verified digest is an input to this owner.
        const results = await Promise.allSettled(requests.map(requestId => admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: `verified-${requestId}`, input: { input: reviewed, requestId, continuationPresent: false } })));
        const admitted = results.flatMap((result, index) => result.status === "fulfilled" ? [{ ...result.value, requestId: requests[index] }] : []);
        expect(admitted).toHaveLength(1);
        expect(results.filter(result => result.status === "rejected").map(result => result.reason)).toEqual([expect.objectContaining({ code: "preset_limit_reached" })]);
        expect(await db.managedMachine.count({ where: { presetId: "preset-admission" } })).toBe(1);
        const captured = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted[0].machine.id } });
        expect(captured.reviewedFacts).toEqual({ ...reviewed.reviewedFacts,
            provisioner: expect.objectContaining({ id: launch.provider.localId, schemaVersion: launch.schemaVersion }) });
        expect((await requestPreset(accountId, "archive", { homeId, id: "preset-admission", expectedRevision: 0 })).statusCode).toBe(200);
        const replayed = await admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: `verified-${admitted[0].requestId}`, input: { input: reviewed, requestId: admitted[0].requestId, continuationPresent: false } });
        expect(replayed.replayed).toBe(true);
        expect(replayed.machine.id).toBe(admitted[0].machine.id);
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: captured.id } })).reviewedFacts).toEqual(captured.reviewedFacts);
        await expect(admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId, requestEnvelopeDigest: "verified-after-archive", input: { input: { ...reviewed, selection: { ...reviewed.selection, revision: 1 }, reviewedFacts: { ...reviewed.reviewedFacts, preset: { ...reviewed.reviewedFacts.preset, revision: 1 } } }, requestId: "preset-after-archive", continuationPresent: false } }))
            .rejects.toMatchObject({ code: "preset_archived" });
    });

    it("reads stored extras, clears future overrides, conflicts on stale edits, and archives without changing paid resources", async () => {
        const accountId = "preset-mutation-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        await db.managedMachinePreset.create({ data: {
            id: "preset-mutation", homeId, custodianAccountId: accountId, name: "Before",
            launch: { ...launch, futureEnvelope: "ignore" }, controllerMachineId: "controller", controllerInstallationId: "installation",
            retentionOverride: { kind: "until-delete" }, wakeOnAcceptedMessage: true, simultaneousMaximum: 1,
        } });
        const resource = await db.managedMachine.create({ data: {
            id: "preset-paid", homeId, custodianAccountId: accountId, presetId: "preset-mutation", presetRevision: 0,
            controllerMachineId: "controller", controllerInstallationId: "installation", admittedActionRequestId: "prior-admission",
            admittedInput: { retained: true }, launch: launch, allocation: "bound", resource: { nativeId: "immutable-paid-id" },
            retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false,
        } });
        const read = await requestPreset(accountId, "get", { homeId, id: "preset-mutation" });
        expect(read.statusCode).toBe(200);
        expect(read.json().preset.launch).toEqual(launch);
        const updated = await requestPreset(accountId, "update", { homeId, id: "preset-mutation", expectedRevision: 0,
            patch: { name: "After", retention: null, wakeOnAcceptedMessage: null, simultaneousLimit: null } });
        expect(updated.statusCode).toBe(200);
        expect(updated.json()).toMatchObject({ kind: "saved", preset: { revision: 1, name: "After" } });
        expect(updated.json().preset).not.toHaveProperty("retention");
        expect(updated.json().preset).not.toHaveProperty("wakeOnAcceptedMessage");
        expect(updated.json().preset).not.toHaveProperty("simultaneousLimit");
        const unchanged = await requestPreset(accountId, "update", { homeId, id: "preset-mutation", expectedRevision: 1, patch: { name: "After" } });
        expect(unchanged.json()).toEqual(updated.json());
        const stale = await requestPreset(accountId, "update", { homeId, id: "preset-mutation", expectedRevision: 0, patch: { name: "Stale" } });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({ kind: "conflict", currentRevision: 1 });
        const archived = await requestPreset(accountId, "archive", { homeId, id: "preset-mutation", expectedRevision: 1 });
        expect(archived.json()).toMatchObject({ kind: "saved", preset: { revision: 2, archivedAt: expect.any(Number) } });
        expect((await requestPreset(accountId, "list", { homeId })).json().presets).toEqual([]);
        expect((await requestPreset(accountId, "list", { homeId, includeArchived: true })).json().presets).toHaveLength(1);
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId, id: "preset-mutation", revision: 2 })))
            .resolves.toEqual({ kind: "refused", code: "preset_archived" });
        const restored = await requestPreset(accountId, "restore", { homeId, id: "preset-mutation", expectedRevision: 2 });
        expect(restored.json()).toMatchObject({ kind: "saved", preset: { revision: 3 } });
        expect(restored.json().preset).not.toHaveProperty("archivedAt");
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: resource.id } })).toEqual(resource);
    });

    it("uses current Team membership, never Home administration, for preset read and management", async () => {
        const homeId = await getOrCreateServerIdentityId();
        await db.account.createMany({ data: ["preset-team-admin", "preset-team-member", "preset-home-admin"].map(id => ({ id, publicKey: null, encryptionMode: "plain" })) });
        await db.account.update({ where: { id: "preset-home-admin" }, data: { homeRole: "admin" } });
        const team = await db.team.create({ data: { name: "Preset Team" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: "preset-team-admin", role: "admin" },
            { teamId: team.id, accountId: "preset-team-member", role: "member" },
        ] });
        const controller = await seedCurrentProvisioner("preset-team-admin", homeId);
        await db.managedMachinePreset.create({ data: { id: "preset-team", homeId, teamId: team.id, name: "Team launch", launch: launch,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId } });
        const target = { homeId, id: "preset-team" };
        expect((await requestPreset("preset-team-member", "get", target)).statusCode).toBe(200);
        expect((await requestPreset("preset-home-admin", "get", target)).statusCode).toBe(404);
        expect((await requestPreset("preset-team-member", "archive", { ...target, expectedRevision: 0 })).statusCode).toBe(404);
        expect((await requestPreset("preset-team-admin", "update", { ...target, expectedRevision: 0, patch: { name: "Managed" } })).statusCode).toBe(200);
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: "preset-team-member", ...target, revision: 1 })))
            .rejects.toMatchObject({ code: "permission_denied" });
        await db.machineAccountGrant.create({ data: { machineId: controller.machineId, accountId: "preset-team-member", accessLevel: "admin", createdByAccountId: "preset-team-admin" } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: "preset-team-member", ...target, revision: 1 })))
            .resolves.toMatchObject({ kind: "ready", custodianAccountId: "preset-team-admin" });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: "preset-team-member" } }, data: { status: "suspended" } });
        expect((await requestPreset("preset-team-member", "get", target)).statusCode).toBe(404);
        expect((await requestPreset("preset-team-member", "list", { homeId, owner: { kind: "team", teamId: team.id } })).json().presets).toEqual([]);
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: "preset-team-member", homeId, id: target.id, revision: 1 })))
            .resolves.toEqual({ kind: "refused", code: "preset_not_found" });
    });

    it.each(['creation', 'setup-only'] as const)('inherits Team archive for a %s preset without retiring its stored row', async kind => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = `preset-team-archive-owner-${kind}`;
        const member = `preset-team-archive-member-${kind}`;
        const outsider = `preset-team-archive-outsider-${kind}`;
        await db.account.createMany({ data: [owner, member, outsider].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const team = await db.team.create({ data: { name: 'Retained archived presets' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner, role: 'owner' },
            { teamId: team.id, accountId: member, role: 'member' }] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        await db.machine.update({ where: { id: controller.machineId }, data: { active: true,
            installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey) } });
        const setup = { scripts: [{ body: 'echo retained Team preset' }] };
        const definition = { id: `preset-team-archive-${kind}`, homeId, name: 'Team preset',
            owner: { kind: 'team', teamId: team.id }, setup,
            ...(kind === 'creation' ? { controller, launch, teamAcquireDelegated: true } : {}) };
        expect((await requestPreset(owner, 'create', definition)).json()).toMatchObject({ kind: 'saved', preset: { revision: 0 } });
        expect(await inTx(tx => archiveTeamInTx(tx, { actorAccountId: owner, teamId: team.id }))).toMatchObject({ ok: true });
        const archivedAt = (await db.team.findUniqueOrThrow({ where: { id: team.id } })).archivedAt?.getTime();
        expect(archivedAt).toEqual(expect.any(Number));
        const target = { homeId, id: definition.id };
        for (const actor of [owner, member]) {
            expect.soft((await requestPreset(actor, 'get', target)).json()).toMatchObject({ kind: 'found',
                preset: { id: definition.id, revision: 0, archivedAt } });
            expect.soft((await requestPreset(actor, 'list', { homeId, owner: definition.owner })).json())
                .toEqual({ kind: 'listed', presets: [] });
            expect.soft((await requestPreset(actor, 'list', { homeId, owner: definition.owner, includeArchived: true })).json())
                .toMatchObject({ kind: 'listed', presets: [{ id: definition.id, archivedAt }] });
        }
        for (let repeat = 0; repeat < 2; repeat++) {
            const result = await requestPreset(owner, 'archive', { ...target, expectedRevision: 0 });
            expect.soft(result.statusCode, result.body).toBe(200);
            expect.soft(result.json()).toMatchObject({ kind: 'saved', preset: { revision: 0, archivedAt } });
        }
        expect.soft(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: definition.id } }))
            .toMatchObject({ revision: 0, archivedAt: null });
        await expect.soft(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: owner, ...target, revision: 0 })))
            .resolves.toEqual({ kind: 'refused', code: 'preset_archived' });
        const apply = { actorAccountId: owner, custodianAccountId: owner, input: { homeId,
            machineId: controller.machineId, sources: [...createEmptyMachineSetupDesiredV1().sources, { kind: 'accountPreset' as const,
                presetId: definition.id, presetRevision: 0, setup }] } };
        await expect.soft(resolveMachineSetup(apply)).rejects.toMatchObject({ code: 'preset_archived' });
        expect((await requestPreset(member, 'archive', { ...target, expectedRevision: 0 })).statusCode).toBe(404);
        expect((await requestPreset(outsider, 'get', target)).statusCode).toBe(404);
        expect((await requestPreset(owner, 'update', { ...target, expectedRevision: 0, patch: { name: 'Not active' } })).statusCode).toBe(404);
        expect((await requestPreset(owner, 'restore', { ...target, expectedRevision: 0 })).statusCode).toBe(404);
        expect(await inTx(tx => restoreTeamInTx(tx, { actorAccountId: owner, teamId: team.id }))).toMatchObject({ ok: true });
        const restored = await requestPreset(owner, 'get', target);
        expect(restored.json()).toMatchObject({ kind: 'found', preset: { revision: 0 } });
        expect(restored.json().preset).not.toHaveProperty('archivedAt');
        await expect(resolveMachineSetup(apply)).resolves.toMatchObject({ sources: apply.input.sources });
    });

    it('keeps Team preset mutation responses credential-free for non-controller managers', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-public-mutation-owner';
        const admin = 'preset-public-mutation-admin';
        await db.account.createMany({ data: [owner, admin].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const team = await db.team.create({ data: { name: 'Public preset mutations' } });
        await db.teamMembership.createMany({ data: [owner, admin].map(accountId => ({ teamId: team.id, accountId, role: 'admin' })) });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const id = 'preset-public-mutation';
        await db.managedMachinePreset.create({ data: { id, homeId, teamId: team.id, name: 'Visible',
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            launch: { ...launch, credentials: [{ purpose: { consumer: launch.provider, purpose: 'native' },
                account: { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: 'private-company-connection' } }] } } });
        const saved = await requestPreset(admin, 'update', { homeId, id, expectedRevision: 0, patch: { name: 'Renamed' } });
        expect(saved.json()).toMatchObject({ kind: 'saved', preset: { revision: 1 } });
        expect(saved.json().preset.launch).not.toHaveProperty('credentials');
        const repeated = await requestPreset(admin, 'update', { homeId, id, expectedRevision: 1, patch: { name: 'Renamed' } });
        expect(repeated.json().preset.launch).not.toHaveProperty('credentials');
        for (const [action, expectedRevision] of [['archive', 1], ['archive', 2], ['restore', 2]] as const) {
            const result = await requestPreset(admin, action, { homeId, id, expectedRevision });
            expect(result.json()).toMatchObject({ kind: 'saved' });
            expect(result.json().preset.launch).not.toHaveProperty('credentials');
        }
        expect((await requestPreset(owner, 'get', { homeId, id })).json().preset.launch.credentials).toHaveLength(1);
    });

    it('admits only an exact delegated Team preset without controller access and revisions its spend authority', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-delegation-owner';
        const member = 'preset-delegation-member';
        const admin = 'preset-delegation-admin';
        await db.account.createMany({ data: [owner, member, admin].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const team = await db.team.create({ data: { name: 'Delegated creation' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: admin, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const definition = { id: 'preset-delegation', homeId, name: 'Delegated', owner: { kind: 'team', teamId: team.id },
            controller, launch, retention: { kind: 'unused' as const, afterMs: 60_000, effect: 'delete' as const },
            wakeOnAcceptedMessage: false, simultaneousLimit: { maximum: 1 } };
        const created = await requestPreset(owner, 'create', definition);
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json().preset.teamAcquireDelegated ?? false).toBe(false);
        const select = (revision: number) => inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: member,
            homeId, id: definition.id, revision }));
        await expect(select(0)).rejects.toMatchObject({ code: 'permission_denied' });
        expect(await db.machineAccountGrant.count({ where: { machineId: controller.machineId, accountId: member } })).toBe(0);
        expect((await requestPreset(admin, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { teamAcquireDelegated: true } })).json()).toEqual({ kind: 'refused', code: 'permission_denied' });
        expect((await requestPreset(owner, 'update', { homeId, id: definition.id, expectedRevision: 0,
            patch: { teamAcquireDelegated: true } })).json()).toMatchObject({ kind: 'saved', preset: { revision: 1, teamAcquireDelegated: true } });
        expect(await select(0)).toEqual({ kind: 'conflict', currentRevision: 1 });
        const selected = await select(1);
        expect(selected).toMatchObject({ kind: 'ready', delegated: true, custodianAccountId: owner });
        if (selected.kind !== 'ready') throw new Error('Expected delegated preset admission');
        const provisioner = selected.declaration.provisioner;
        const reviewedFacts = { ...buildManagedConfigurationFactsV1({
            choicesSchema: createPluginJsonSchemaZodValueAdapter(provisioner.launchSchema),
            launch: { ...launch, name: 'Guest' }, controller, optionStatus: 'current', prerequisites: [],
            provisioner: { ...provisioner, schemaVersion: provisioner.schemaVersion + 1 },
            billing: provisioner.billing, retentionCapabilities: provisioner.retention,
            preset: { ...definition, revision: 1 },
        }), retentionCapabilities: { supportedIntents: [] },
            billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const } };
        const request = { custodianAccountId: owner, requesterAccountId: member, requestEnvelopeDigest: 'delegated-admission', input: {
            requestId: 'preset-delegation-create', continuationPresent: false,
            input: { enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const },
                selection: { kind: 'preset' as const, homeId, id: definition.id, revision: 1 }, controller,
                retention: definition.retention, wakeOnAcceptedMessage: false, reviewedFacts },
        } };
        await expect(admitManagedAcquire({ ...request, input: { ...request.input, input: { ...request.input.input,
            retention: { kind: 'until-delete' as const } } } })).rejects.toMatchObject({ code: 'permission_denied' });
        await expect(admitManagedAcquire({ ...request, input: { ...request.input, input: { ...request.input.input,
            wakeOnAcceptedMessage: true } } })).rejects.toMatchObject({ code: 'permission_denied' });
        await expect(admitManagedAcquire({ ...request, input: { ...request.input, input: { ...request.input.input,
            controller: { ...controller, installationId: 'substituted' } } } })).rejects.toMatchObject({ code: 'controller_retired' });
        await expect(admitManagedAcquire({ ...request, input: { ...request.input, input: { ...request.input.input,
            reviewedFacts: { launch: { ...launch, credentials: [{ purpose: { consumer: launch.provider, purpose: 'native' },
                account: { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: 'substituted-connection' } }] },
                controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention: definition.retention,
                wakeOnAcceptedMessage: false, prices: [], preset: { id: definition.id, revision: 1, name: definition.name } },
        } } })).rejects.toMatchObject({ code: 'invalid_request' });
        await expect(admitManagedAcquire({ ...request, input: { ...request.input, input: {
            enrollmentIdentity: request.input.input.enrollmentIdentity, selection: { kind: 'one-off' as const,
                homeId, controller, launch, retention: definition.retention, wakeOnAcceptedMessage: false },
        } } })).rejects.toMatchObject({ code: 'permission_denied' });
        const acquired = await admitManagedAcquire(request);
        expect(acquired.machine).toMatchObject({ launch: { ...launch, name: 'Guest' }, retention: definition.retention, enrollmentAccountId: member });
        expect((await db.managedMachine.findUniqueOrThrow({ where: { id: acquired.machine.id } })).reviewedFacts)
            .toEqual({ ...reviewedFacts, provisioner,
                retentionCapabilities: selected.declaration.retention, billing: selected.declaration.billing });
        expect(acquired.machine.reviewedFacts?.provisioner).toEqual(provisioner);
        expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true,
            machine: { id: acquired.machine.id, reviewedFacts: { provisioner,
                retentionCapabilities: selected.declaration.retention, billing: selected.declaration.billing } } });
        await expect(admitManagedAcquire({ ...request, requesterAccountId: admin })).rejects.toMatchObject({ code: 'request_conflict' });
        expect(await select(1)).toEqual({ kind: 'refused', code: 'preset_limit_reached' });
        expect((await requestPreset(admin, 'update', { homeId, id: definition.id, expectedRevision: 1,
            patch: { retention: { kind: 'until-delete' } } })).json()).toEqual({ kind: 'refused', code: 'permission_denied' });
        expect((await requestPreset(admin, 'update', { homeId, id: definition.id, expectedRevision: 1,
            patch: { teamAcquireDelegated: false } })).json()).toEqual({ kind: 'refused', code: 'permission_denied' });
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: owner, pluginId: launch.provider.pluginId } },
            data: { enabled: false } });
        expect((await requestPreset(owner, 'update', { homeId, id: definition.id, expectedRevision: 1,
            patch: { teamAcquireDelegated: false } })).json()).toMatchObject({ kind: 'saved', preset: { revision: 2 } });
        expect((await requestPreset(owner, 'update', { homeId, id: definition.id, expectedRevision: 2,
            patch: { teamAcquireDelegated: true } })).json()).toMatchObject({ kind: 'saved', preset: { revision: 3 } });
        const current = (await requestPreset(owner, 'get', { homeId, id: definition.id })).json().preset;
        expect(current.teamAcquireDelegated).toBe(true);
        expect(await select(3)).toEqual({ kind: 'refused', code: 'preset_limit_reached' });
        expect((await requestPreset(owner, 'create', { ...definition, teamAcquireDelegated: true })).json())
            .toMatchObject({ kind: 'saved', preset: { revision: 3 } });
        expect((await requestPreset(owner, 'create', { ...definition, id: 'preset-delegation-account',
            owner: { kind: 'account', accountId: owner }, teamAcquireDelegated: true })).json())
            .toEqual({ kind: 'refused', code: 'invalid_request' });
        expect((await requestPreset(owner, 'archive', { homeId, id: definition.id, expectedRevision: 3 })).json())
            .toMatchObject({ kind: 'saved', preset: { revision: 4 } });
        expect(await select(4)).toEqual({ kind: 'refused', code: 'preset_archived' });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: member } }, data: { status: 'suspended' } });
        expect(await select(3)).toEqual({ kind: 'refused', code: 'preset_not_found' });
    });

    it('keeps pool review unbound and admits a member-owned guest on the bound eligible controller', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-pool-owner';
        const member = 'preset-pool-member';
        const stranger = 'preset-pool-stranger';
        await db.account.createMany({ data: [owner, member, stranger].map(id => ({ id, publicKey: null, encryptionMode: 'plain' })) });
        const team = await db.team.create({ data: { name: 'Pool guests' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner, role: 'admin' },
            { teamId: team.id, accountId: member, role: 'member' },
        ] });
        const controller = await seedCurrentProvisioner(owner, homeId, undefined, true);
        const key = new Uint8Array(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21)).publicKey);
        await db.machine.update({ where: { id: controller.machineId }, data: { installationPublicKey: key } });
        const outsideController = { machineId: 'pool-owner-outside', installationId: 'pool-outside-installation' };
        const offlineController = { machineId: 'pool-owner-offline', installationId: 'pool-offline-installation' };
        const ineligibleController = { machineId: 'pool-owner-no-provider', installationId: 'pool-no-provider-installation' };
        await db.machine.createMany({ data: [outsideController, offlineController, ineligibleController].map(value => ({
            id: value.machineId, installationId: value.installationId, accountId: owner, metadata: '{}',
            installationPublicKey: key, pluginMaterializationRevision: BigInt(1),
        })) });
        const occurrence = await db.pluginMachineMaterialization.findFirstOrThrow({ where: { machineId: controller.machineId } });
        await db.pluginMachineMaterialization.create({ data: { accountId: owner, serverIdentityId: homeId,
            machineId: offlineController.machineId, materializationId: offlineController.installationId,
            pluginId: occurrence.pluginId, version: occurrence.version, sourceClass: occurrence.sourceClass,
            portableRelease: occurrence.portableRelease, archiveDigestSha256: occurrence.archiveDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const poolId = 'f127dff1-8bd4-41ec-9993-d81ec851d7da';
        await db.machinePool.create({ data: { id: poolId, accountId: owner, teamId: team.id, name: 'Builders',
            members: { create: [{ machineId: controller.machineId, priorityTier: 1, enabled: true },
                { machineId: offlineController.machineId, priorityTier: 0, enabled: true },
                { machineId: ineligibleController.machineId, priorityTier: 0, enabled: true }] } } });
        const definition = { id: 'preset-pool-guests', homeId, name: 'Fresh guest', owner: { kind: 'team', teamId: team.id },
            controllerPoolId: poolId, launch, teamAcquireDelegated: true, simultaneousLimit: { maximum: 1 } };
        const saved = await requestPreset(owner, 'create', definition);
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json(), saved.body).toMatchObject({ kind: 'saved', preset: { controllerPoolId: poolId } });
        const projected = (await requestPreset(member, 'get', { homeId, id: definition.id })).json().preset;
        expect(projected).not.toHaveProperty('controller');
        expect(projected.delegatedAcquire).toMatchObject({ kind: 'ready', reviewedFacts: { optionStatus: 'current' } });
        expect(projected.delegatedAcquire).not.toHaveProperty('controller');
        expect(projected.delegatedAcquire.reviewedFacts).not.toHaveProperty('controller');
        expect(projected.delegatedAcquire.reviewedFacts.prerequisites).toEqual([
            { requirement: { kind: 'systemTool', id: 'shell' }, status: 'unknown' },
        ]);
        expect(JSON.stringify(projected)).not.toContain(controller.machineId);
        // A pool with no enabled member is the pool's own state, not an unavailable controller.
        await db.machinePoolMember.updateMany({ where: { poolId }, data: { enabled: false } });
        expect((await requestPreset(member, 'get', { homeId, id: definition.id })).json().preset.delegatedAcquire)
            .toEqual({ kind: 'unavailable', code: 'pool_no_available_machine' });
        await db.machinePoolMember.updateMany({ where: { poolId }, data: { enabled: true } });
        const select = (accountId: string) => inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId,
            homeId, id: definition.id, revision: 0, boundController: controller }));
        expect(await select(stranger)).toEqual({ kind: 'refused', code: 'preset_not_found' });
        const selected = await select(member);
        expect(selected).toMatchObject({ kind: 'ready', delegated: true, custodianAccountId: owner, preset: { controller } });
        if (selected.kind !== 'ready') throw new Error('Expected pool admission');
        const reviewedFacts = { ...projected.delegatedAcquire.reviewedFacts, controller };
        const poolApp = createAuthenticatedTestApp();
        let connectedIds = [controller.machineId, ineligibleController.machineId];
        registerMachinePoolRoutes(poolApp, { io: { in: () => ({ fetchSockets: async () => connectedIds.map(machineId => ({
            data: { clientType: 'machine-scoped', userId: owner, machineId },
        })) }) } });
        await poolApp.ready();
        try {
            const payload = { poolId, requestKey: 'fresh-pool-request', purpose: 'managed-preset',
                preset: { homeId, id: definition.id, revision: 0 } };
            const resolved = await poolApp.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                headers: { 'x-test-user-id': member }, payload });
            expect(resolved.statusCode, resolved.body).toBe(200);
            expect(resolved.json()).toMatchObject({ kind: 'resolved', machineId: controller.machineId,
                managedPreset: { controller, reviewedFacts } });
            connectedIds = [ineligibleController.machineId];
            const unavailable = await poolApp.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                headers: { 'x-test-user-id': member }, payload });
            expect(unavailable.json()).toMatchObject({ kind: 'unavailable', code: 'controller_unavailable', reason: 'no_available_machine' });
            const denied = await poolApp.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                headers: { 'x-test-user-id': stranger }, payload });
            expect(denied.json()).toMatchObject({ kind: 'unavailable', code: 'preset_not_found' });
            await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: false } });
            for (const inventory of [[controller.machineId], []]) {
                connectedIds = inventory;
                const notDelegated = await poolApp.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                    headers: { 'x-test-user-id': member }, payload });
                expect(notDelegated.json()).toEqual({ kind: 'unavailable', poolId,
                    reason: 'managed_preset_unavailable', code: 'permission_denied' });
            }
            await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: true } });
        } finally { await poolApp.close(); }
        await expect(admitManagedAcquire({ custodianAccountId: owner, requesterAccountId: member,
            requestEnvelopeDigest: 'pool-forged', input: { requestId: 'pool-forged', continuationPresent: false, input: {
                enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
                controller: outsideController,
                selection: { kind: 'preset', homeId, id: definition.id, revision: 0 },
                retention: reviewedFacts.retention, wakeOnAcceptedMessage: reviewedFacts.wakeOnAcceptedMessage,
                reviewedFacts: { ...reviewedFacts, controller: outsideController },
            } } })).rejects.toMatchObject({ code: 'controller_unavailable' });
        const acquired = await admitManagedAcquire({ custodianAccountId: owner, requesterAccountId: member,
            requestEnvelopeDigest: 'pool-guest', input: { requestId: 'pool-guest-create', continuationPresent: false, input: {
                enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, controller,
                selection: { kind: 'preset', homeId, id: definition.id, revision: 0 },
                retention: reviewedFacts.retention, wakeOnAcceptedMessage: reviewedFacts.wakeOnAcceptedMessage, reviewedFacts,
            } } });
        expect(acquired.machine).toMatchObject({ enrollmentAccountId: member, custodianAccountId: owner, controller });
        expect(await db.machineAccountGrant.count({ where: { machineId: controller.machineId, accountId: member } })).toBe(0);
        expect(await select(member)).toEqual({ kind: 'refused', code: 'preset_limit_reached' });
        await db.managedMachine.update({ where: { id: acquired.machine.id }, data: { allocation: 'confirmed-absent' } });
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: false } });
        await expect(select(member)).rejects.toMatchObject({ code: 'permission_denied' });
        await db.managedMachinePreset.update({ where: { id: definition.id }, data: { teamAcquireDelegated: true } });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: member } }, data: { status: 'suspended' } });
        expect(await select(member)).toEqual({ kind: 'refused', code: 'preset_not_found' });
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: member } }, data: { status: 'active' } });
        expect(await inTx(tx => archiveTeamInTx(tx, { actorAccountId: owner, teamId: team.id }))).toMatchObject({ ok: true });
        expect(await select(member)).toEqual({ kind: 'refused', code: 'preset_archived' });
        expect(await inTx(tx => restoreTeamInTx(tx, { actorAccountId: owner, teamId: team.id }))).toMatchObject({ ok: true });
        await db.machinePool.delete({ where: { id: poolId } });
        await expect(select(member)).rejects.toMatchObject({ code: 'controller_unavailable' });
    });

    it('binds a custodian Account pool with its saved credential selections without disclosing material', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const accountId = 'preset-pool-own-credentials';
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(accountId, homeId, 'acquire-authentication');
        await db.machine.update({ where: { id: controller.machineId }, data: {
            installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(24)).publicKey) } });
        const ref = { service: { pluginId: launch.provider.pluginId, localId: 'native-account' }, accountId: 'saved-pool-profile' };
        expect((await mutateQualifiedConnectedServiceCredential({ accountId, ref, expectedCredentialRevision: null,
            authenticationModeId: 'api-key', content: { t: 'plain', v: { token: 'pool-material-never-disclosed' } },
            metadata: { displayName: 'Pool profile', scopes: [] } })).status).toBe('written');
        const savedLaunch = { ...launch, credentials: [{ purpose: { consumer: launch.provider, purpose: 'acquire-authentication' }, account: ref }] };
        const poolId = crypto.randomUUID();
        await db.machinePool.create({ data: { id: poolId, accountId, name: 'Credential pool',
            members: { create: { machineId: controller.machineId, priorityTier: 0 } } } });
        const preset = { id: `${accountId}-preset`, homeId, name: 'Credential guest', owner: { kind: 'account', accountId },
            controllerPoolId: poolId, launch: savedLaunch };
        const saved = await requestPreset(accountId, 'create', preset);
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json().preset.launch.credentials).toEqual(savedLaunch.credentials);
        const app = createAuthenticatedTestApp();
        registerMachinePoolRoutes(app, { io: { in: () => ({ fetchSockets: async () => [{
            data: { clientType: 'machine-scoped', userId: accountId, machineId: controller.machineId },
        }] }) } });
        await app.ready();
        try {
            const resolved = await app.inject({ method: 'POST', url: '/v1/machines/pools/resolve',
                headers: { 'x-test-user-id': accountId }, payload: { poolId, requestKey: 'own-credential-pool',
                    purpose: 'managed-preset', preset: { homeId, id: preset.id, revision: 0 } } });
            expect(resolved.statusCode, resolved.body).toBe(200);
            expect(resolved.json()).toMatchObject({ kind: 'resolved', managedPreset: { controller } });
            expect(resolved.body).not.toContain('pool-material-never-disclosed');
            const facts = resolved.json().managedPreset.reviewedFacts;
            const acquired = await admitManagedAcquire({ custodianAccountId: accountId, requesterAccountId: accountId,
                requestEnvelopeDigest: 'own-credential-pool', input: { requestId: 'own-credential-pool', continuationPresent: false,
                    input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, controller,
                        selection: { kind: 'preset', homeId, id: preset.id, revision: 0 }, retention: facts.retention,
                        wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage, reviewedFacts: facts } } });
            expect(acquired.machine.launch.credentials).toEqual(savedLaunch.credentials);
        } finally { await app.close(); }
    });

    it('saves Account-hosted configuration but refuses acquisition through a controller pool', async () => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = 'preset-pool-account-provisioner';
        await db.account.create({ data: { id: owner, publicKey: null, encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(owner, homeId);
        await db.machine.update({ where: { id: controller.machineId }, data: {
            installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23)).publicKey) } });
        const intent = await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: {
            accountId: owner, pluginId: launch.provider.pluginId } } });
        const stored = intent.releaseLessDeclaration;
        if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !('manifest' in stored)) throw new Error('Missing declaration');
        const manifest = PluginManifestV2Schema.parse(stored.manifest);
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({ ...manifest, contributes: {
            ...manifest.contributes, actions: manifest.contributes?.actions?.map(action => ({ ...action,
                execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            })),
        } }));
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: owner, pluginId: manifest.id } },
            data: { releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.updateMany({ where: { accountId: owner, machineId: controller.machineId },
            data: { archiveDigestSha256: declaration.manifestDigestSha256 } });
        const poolId = crypto.randomUUID();
        await db.machinePool.create({ data: { id: poolId, accountId: owner, name: 'Unused controller pool',
            members: { create: { machineId: controller.machineId, priorityTier: 0 } } } });
        const result = await requestPreset(owner, 'create', { id: `${owner}-preset`, homeId, name: 'Account provisioning',
            owner: { kind: 'account', accountId: owner }, controllerPoolId: poolId, launch });
        expect(result.json(), result.body).toMatchObject({ kind: 'saved',
            preset: { delegatedAcquire: { kind: 'unavailable', code: 'provider_unavailable' } } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: owner, homeId,
            id: `${owner}-preset`, revision: 0 }))).rejects.toMatchObject({ code: 'provider_unavailable' });
    });

    it.each(['billing', 'retention'] as const)('refuses pool review when eligible installations disagree on %s', async difference => {
        const homeId = await getOrCreateServerIdentityId();
        const owner = `preset-pool-facts-${difference}`;
        await db.account.create({ data: { id: owner, publicKey: null, encryptionMode: 'plain' } });
        const controller = await seedCurrentProvisioner(owner, homeId);
        const second = { machineId: `${owner}-second`, installationId: `${owner}-second-installation` };
        const key = new Uint8Array(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22)).publicKey);
        await db.machine.update({ where: { id: controller.machineId }, data: { installationPublicKey: key } });
        await db.machine.create({ data: { id: second.machineId, accountId: owner, metadata: '{}',
            installationId: second.installationId, installationPublicKey: key, pluginMaterializationRevision: BigInt(1) } });
        const intent = await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: {
            accountId: owner, pluginId: launch.provider.pluginId } } });
        const stored = intent.releaseLessDeclaration;
        if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !('manifest' in stored)) throw new Error('Missing declaration');
        const manifest = PluginManifestV2Schema.parse(stored.manifest);
        const contribution = manifest.contributes!.machineProvisioners![0]!;
        const changed = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({ ...manifest, contributes: {
            ...manifest.contributes, machineProvisioners: [{ ...contribution,
                ...(difference === 'billing' ? { billing: { location: 'cloud', stoppedBilling: 'billed' } }
                    : { retention: { supportedIntents: ['delete'] } }),
            }],
        } }));
        const first = createReleaseLessDeclarationV1(manifest);
        const scoped = mergeReleaseLessDeclarationV2({ stored, declaration: first, publisher: controller }).stored;
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: owner, pluginId: manifest.id } },
            data: { releaseLessDeclaration: mergeReleaseLessDeclarationV2({ stored: scoped, declaration: changed, publisher: second }).stored } });
        await db.pluginMachineMaterialization.create({ data: { accountId: owner, serverIdentityId: homeId,
            machineId: second.machineId, materializationId: second.installationId, pluginId: manifest.id, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: changed.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const poolId = crypto.randomUUID();
        await db.machinePool.create({ data: { id: poolId, accountId: owner, name: 'Mixed installations',
            members: { create: [controller, second].map(value => ({ machineId: value.machineId, priorityTier: 0 })) } } });
        const result = await requestPreset(owner, 'create', { id: `${owner}-preset`, homeId, name: 'Mixed facts',
            owner: { kind: 'account', accountId: owner }, controllerPoolId: poolId, launch });
        expect(result.json(), result.body).toMatchObject({ kind: 'saved',
            preset: { delegatedAcquire: { kind: 'unavailable', code: 'provider_unavailable' } } });
        await expect(inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId: owner, homeId,
            id: `${owner}-preset`, revision: 0 }))).rejects.toMatchObject({ code: 'provider_unavailable' });
    });

    it("counts uncertain and retained stopped resources until confirmed absence, independent of archive", async () => {
        const accountId = "preset-cap-owner";
        const homeId = await getOrCreateServerIdentityId();
        await db.account.create({ data: { id: accountId, publicKey: null, encryptionMode: "plain" } });
        await db.managedMachinePreset.create({ data: { id: "preset-cap", homeId, custodianAccountId: accountId, name: "Limited",
            launch: launch, controllerMachineId: "controller", controllerInstallationId: "installation", simultaneousMaximum: 1 } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: accountId, presetId: "preset-cap", presetRevision: 0,
            controllerMachineId: "controller", controllerInstallationId: "installation", admittedActionRequestId: "capacity-admission",
            admittedInput: {}, launch: launch, allocation: "may-exist", retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false } });
        const use = () => inTx(tx => resolveMachinePresetForAcquireInTx(tx, { accountId, homeId, id: "preset-cap", revision: 0 }));
        await expect(use()).resolves.toEqual({ kind: "refused", code: "preset_limit_reached" });
        await db.managedMachine.update({ where: { id: row.id }, data: { allocation: "bound", archivedAt: new Date(), observation: { availability: "present", power: "stopped", observedAt: Date.now() } } });
        await expect(use()).resolves.toEqual({ kind: "refused", code: "preset_limit_reached" });
        await db.managedMachine.update({ where: { id: row.id }, data: { allocation: "confirmed-absent" } });
        // No controller was seeded: reaching current-controller validation proves capacity was released, without mocking acquisition.
        await expect(use()).rejects.toMatchObject({ code: "permission_denied" });
    });
});
