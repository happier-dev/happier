import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createAuthenticatedRouteRequest } from '@/app/api/testkit/requestFixtures';
import { registerManagedMachineRoutes } from './managedRoutes';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { MACHINE_PLAIN_DATA_KEY_MARKER, MachineOperationProtocolCapabilitiesV1Schema, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { admitManagedControl } from './managedMutations';
import { createNativeSessionTeamCredentialFixture, TEST_AUTHENTICATION } from '@/app/teams/credentials/sessionBinding.testkit';
import { writeSessionTeamCredentialBindingsInTx, stampSessionTeamCredentialNativeDeliveryInTx,
    submitSessionTeamCredentialNativeDeliveryInTx, completeSessionTeamCredentialNativeDeliveryInTx } from '@/app/teams/credentials/sessionBinding';

async function publishFixtureManifest(accountId: string, homeId: string, machineId: string, input: unknown) {
    const manifest = PluginManifestV2Schema.parse(input);
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.accountPluginIntent.create({ data: { accountId, pluginId: manifest.id,
        enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
    await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId,
        machineId, materializationId: randomUUID(), pluginId: manifest.id, version: manifest.version,
        sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
        uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    return manifest;
}

describe('managed resize admission and observed settlement', () => {
    const homeId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-resize-admission-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('admits Manage, refuses Can use, and records the active request without revalidating changed policy or declarations', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: owner.id, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'resize-controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: controller.installationId, installationPublicKey: keys.publicKey, pluginMaterializationRevision: 1n } });
        const { fixture } = await import('../../../../../cli/src/plugins/runtime/invocation/actions/managedCustody.testkit');
        const previousManifest = fixture().manifest;
        const manifest = await publishFixtureManifest(owner.id, homeId, controller.machineId, { ...previousManifest,
            contributes: { ...previousManifest.contributes,
                machineProvisioners: previousManifest.contributes.machineProvisioners.map(provisioner => ({ ...provisioner, schemaVersion: 2 })) } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: controller.machineId,
            principal: { kind: 'account', accountId: member.id }, level: 'view' }));
        const launch = { provider: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, name: 'Resize guest', choices: {} };
        const provisioner = manifest.contributes.machineProvisioners![0]!;
        const { resize: _resize, ...previousDeclaration } = provisioner;
        const { resize: _resizeAction, ...previousActions } = provisioner.actions;
        const reviewedFacts = buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(provisioner.launchSchema),
            launch, controller, provisioner: { ...previousDeclaration, schemaVersion: 1, actions: previousActions }, optionStatus: 'current',
            prerequisites: [], billing: provisioner.billing, retentionCapabilities: provisioner.retention,
            machineOverride: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch, reviewedFacts, resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} },
            desired: 'start', desiredWhen: 'now', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const requestId = randomUUID();
        const actorAccountId = member.id;
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Replace only verified HTTP authentication, preserving route admission,
        // real access grants, declaration selection, persistence and publication.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            Object.assign(request, createAuthenticatedRouteRequest({ userId: actorAccountId,
                externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
                externalActionEffectActionId: 'machines.managed.resize', externalActionExecutionRequestId: requestId,
                externalActionExecutionCustodianAccountId: owner.id }));
        });
        registerManagedMachineRoutes(app as Parameters<typeof registerManagedMachineRoutes>[0]);
        const input = { requestId, action: 'machines.managed.resize', input: {
            homeId, managedId: row.id, size: { memoryBytes: 4_294_967_296 } } };
        try {
            const refused = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload: input });
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toEqual({ code: 'permission_denied' });
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: controller.machineId,
                principal: { kind: 'account', accountId: member.id }, level: 'admin' }));
            // Approval binds the size, not the revision current when it opened.
            await db.managedMachine.update({ where: { id: row.id }, data: { intentRevision: 3 } });
            const admitted = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit-control', payload: input });
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json()).toMatchObject({ machine: { desired: 'start', intentRevision: 4 },
                resizeProvisioner: { id: 'vm', schemaVersion: 2, actions: { resize: 'resize' } } });
            const retained = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            expect(retained.resource).toEqual(row.resource);
            expect(retained.launch).toEqual(row.launch);
            await db.accountPluginIntent.deleteMany({ where: { accountId: owner.id } });
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: controller.machineId,
                principal: { kind: 'account', accountId: member.id }, level: 'view' }));
            // The admitted finite job finishes under its signed request after
            // access changes. There is no new policy/declaration admission here.
            const observation = { availability: 'present', power: 'running', storage: 'retained', observedAt: 20,
                size: { cpuCores: 2, memoryBytes: 4_294_967_296, diskBytes: 17_179_869_184 } };
            const report = { homeId, managedId: row.id, requestId, result: { kind: 'confirmed' }, observation };
            const settled = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report-resize', payload: report });
            expect(settled.statusCode, settled.body).toBe(200);
            expect(settled.json()).toMatchObject({ machine: { observation } });
            await db.managedMachine.update({ where: { id: row.id }, data: {
                admittedInput: { currentAdmission: { kind: 'control', request: { ...input, requestId: randomUUID() } } },
            } });
            const superseded = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report-resize', payload: report });
            expect(superseded.statusCode, superseded.body).toBe(409);
            expect(superseded.json()).toEqual({ code: 'request_conflict' });
        } finally { await app.close(); }
    });

    it('admits resize with an installed native credential while preserving its guest and resource identities', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await db.machine.update({ where: { id: f.controller.id }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'credential-controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        const before = await db.managedMachine.update({ where: { id: f.row.id }, data: {
            creationState: 'active', desired: 'start', desiredWhen: 'now',
        } });
        expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
        const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!prepared.ok) throw new Error('Expected prepared native source');
        const binding = { sessionId: f.session.id, accountId: f.creator.id, operation: 'install' as const,
            bindingKey: prepared.binding.safeFacet.bindingKey, expectedResourceRevision: f.credential.revision,
            expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
            requestId: randomUUID(), authentication: TEST_AUTHENTICATION };
        expect(await inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, binding))).toEqual({ ok: true, submitted: true });
        expect(await inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, { ...binding, outcome: 'confirmed',
            appliedPolicy: { ownedBindingKeys: [binding.bindingKey], desiredBindingKeys: [binding.bindingKey] } }))).toEqual({ ok: true });
        const installed = await db.sessionTeamCredentialBinding.findMany({ where: { nativeManagedId: f.row.id } });
        const admitted = await admitManagedControl({ actorAccountId: f.custodian.id, custodianAccountId: f.custodian.id,
            input: { requestId: randomUUID(), action: 'machines.managed.resize', input: {
                homeId: f.homeId, managedId: f.row.id, size: { memoryBytes: 4_294_967_296 } } } });
        expect(admitted.machine).toMatchObject({ id: f.row.id, desired: 'start', intentRevision: 1 });
        expect(await db.sessionTeamCredentialBinding.findMany({ where: { nativeManagedId: f.row.id } })).toEqual(installed);
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: f.row.id } })).toMatchObject({
            resource: before.resource, enrolledMachineId: f.guest.id, controllerMachineId: f.controller.id,
            controllerInstallationId: f.controller.installationId,
        });
    });

    it('executes the signed Action through the runner and settles after Manage and the declaration are withdrawn', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: owner.id, active: true,
            installationId: controller.installationId, installationPublicKey: keys.publicKey, pluginMaterializationRevision: 1n,
            metadata: encodePlainMachineStoredContent({ host: 'resize-controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: controller.machineId,
            principal: { kind: 'account', accountId: manager.id }, level: 'admin' }));
        const { fixture } = await import('../../../../../cli/src/plugins/runtime/invocation/actions/managedCustody.testkit');
        const results = { resize: { kind: 'confirmed' }, inspect: { availability: 'present', power: 'running', storage: 'retained',
            observedAt: 10, size: { cpuCores: 2, memoryBytes: 2_147_483_648, diskBytes: 17_179_869_184 } } };
        let nativeInput: unknown;
        const native = fixture({ privateNative: true, nativeCommandArgs: [], supportedIntents: ['start', 'stop', 'delete'],
            nativeRoleResults: results, onNativeRole: async (role, input) => {
                if (role !== 'resize') return;
                nativeInput = input;
                results.inspect = { ...results.inspect, observedAt: 20, size: { ...results.inspect.size, memoryBytes: 4_294_967_296 } };
                await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: controller.machineId,
                    principal: { kind: 'account', accountId: manager.id }, level: 'view' }));
                await db.accountPluginIntent.deleteMany({ where: { accountId: owner.id } });
            } });
        const manifest = await publishFixtureManifest(owner.id, homeId, controller.machineId, native.manifest);
        const provider = { pluginId: manifest.id, localId: 'vm' };
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider, schemaVersion: 1, name: 'Resize guest', choices: {} },
            resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            desired: 'start', desiredWhen: 'now', intentRevision: 3, observation: results.inspect,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const token = await auth.createToken(manager.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app as Parameters<typeof enableAuthentication>[0]);
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        registerExternalActionRoutes(app as Parameters<typeof registerExternalActionRoutes>[0]);
        machinesRoutes(app as Parameters<typeof machinesRoutes>[0]);
        const { installAxiosFastifyAdapter } = await import('../../../../../cli/src/testkit/http/axiosAdapter');
        const { createManagedMachineAcquisitionDriver } = await import('../../../../../cli/src/machines/managed/acquire');
        const { createManagedProviderOperationAuthority } = await import('../../../../../cli/src/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority');
        const { createConnectedAccountPurposeBindingOwner } = await import('../../../../../cli/src/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner');
        const { createConnectedAccountRequestAuthSubjectRegistry } = await import('../../../../../cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry');
        const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential transport'); };
        const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
            purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
                selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
                projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
            }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
            createRedactionLease: () => ({ add() {}, close() {} }),
        });
        const origin = 'https://resize-admission.test';
        const driver = createManagedMachineAcquisitionDriver({ token, credentials: { token, encryption: null },
            serverUrl: origin, homeId, controller, externalActionMachineRequestPrivateKey: keys.secretKey,
            managedProviderOperationAuthority: authority, runtimeRegistry: native.runtimeRegistry,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: origin, revision: 1, endpoints: [{ kind: 'https', url: origin }] }, authority: 'current_connection' }) });
        const restoreHttp = installAxiosFastifyAdapter({ app, origin });
        const requestId = randomUUID();
        const input = { homeId, managedId: row.id, size: { memoryBytes: 4_294_967_296 } };
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.resize'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope: { v: 1, requestId, target: { kind: 'machine', machineId: controller.machineId }, input } } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const output = await driver.execute('machines.managed.resize', input, { requestId, context: {
                operationAcceptance: { operationId: requestId, accept() {} }, operationOwnerUpdate: { update() {} },
                surface: 'cli', externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
            } });
            expect(output).toMatchObject({ result: { kind: 'confirmed' }, observation: { size: input.size } });
            expect(nativeInput).toMatchObject({ size: input.size });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))
                .toMatchObject({ intentRevision: 4, desired: 'start', observation: { size: input.size } });
        } finally { restoreHttp(); await app.close(); }
    }, 120_000);
});
