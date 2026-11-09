import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import axios from 'axios';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { managedQb56Input } from '@/app/api/routes/actions/managedQb56Input.testkit';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ProviderObservationV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { LIMA_PLUGIN } from '../../../../../../packages/plugins/machine-lima/src/manifest';

async function seedLimaAvailability(accountId: string, homeId: string, machineId: string) {
    const manifest = PluginManifestV2Schema.parse(LIMA_PLUGIN.manifest);
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.accountPluginIntent.create({ data: { accountId, pluginId: manifest.id,
        enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
    await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId,
        machineId, materializationId: randomUUID(), pluginId: manifest.id, version: manifest.version,
        sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
        uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    return manifest;
}

describe('managed power admission across the signed Home route and controller', () => {
    const homeId = managedQb56Input.selection.homeId;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-power-admission-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['stopped', 'running', 'unknown', 'stale'] as const)(
        'reconciles a retained unknown Start from fresh %s inspection before the newer Stop', async power => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey), active: true,
            pluginMaterializationRevision: 1n, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
        const manifest = await seedLimaAvailability(account.id, homeId, controller.machineId);
        const launch = managedQb56Input.selection.launch;
        const { memoryGiB, diskGiB, ...identity } = launch.choices;
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: {}, launch, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: launch.provider, schemaVersion: 1,
                value: { ...identity, memoryBytes: Number(memoryGiB) * 1_073_741_824, diskBytes: Number(diskGiB) * 1_073_741_824 } },
            desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: 10 } } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app as Parameters<typeof enableAuthentication>[0]);
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        registerExternalActionRoutes(app as Parameters<typeof registerExternalActionRoutes>[0]);
        machinesRoutes(app as Parameters<typeof machinesRoutes>[0]);
        const { installAxiosFastifyAdapter } = await import('../../../../../cli/src/testkit/http/axiosAdapter');
        const { createManagedMachineAcquisitionDriver } = await import('../../../../../cli/src/machines/managed/acquire');
        const { fixture } = await import('../../../../../cli/src/plugins/runtime/invocation/actions/managedCustody.testkit');
        const { normalizePluginManifestV2 } = await import('../../../../../cli/src/plugins/manifest/normalize');
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
        let observation = ProviderObservationV1Schema.parse({ observedAt: 10, availability: 'present', power: 'unknown' });
        const effects: string[] = [];
        const results = { power: { kind: 'unknown' }, inspect: observation };
        const native = fixture({ privateNative: true, fixtureManifest: normalizePluginManifestV2(manifest),
            // Lima declares process access. Bind the canonical test Exec service;
            // both exercised handlers return the substituted native facts below.
            nativeCommandArgs: [],
            nativeRoleResults: results, onNativeRole: (role, input) => {
                if (role !== 'power' || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unexpected native effect');
                effects.push(String(input.intent));
                results.power = { kind: input.intent === 'stop' ? 'confirmed' : 'unknown' };
            } });
        const driver = createManagedMachineAcquisitionDriver({ token, credentials: { token, encryption: null },
            serverUrl: 'https://power-admission.test', homeId, controller, externalActionMachineRequestPrivateKey: keys.secretKey,
            managedProviderOperationAuthority: authority, runtimeRegistry: native.runtimeRegistry,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://power-admission.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://power-admission.test' }] }, authority: 'current_connection' }) });
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'https://power-admission.test' });
        const execute = async (intent: 'start' | 'stop' | 'inspect', expectedRevision: number) => {
            const requestId = randomUUID();
            const actionId = intent === 'inspect' ? 'machines.managed.inspect' : 'machines.managed.power.set';
            const input = intent === 'inspect' ? { homeId, managedId: row.id }
                : { homeId, managedId: row.id, expectedRevision, when: 'now' as const, intent };
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope: { v: 1, requestId, target: { kind: 'machine', machineId: controller.machineId }, input } } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            return await driver.execute(actionId, input, { requestId, context: {
                operationAcceptance: { operationId: requestId, accept() {} }, operationOwnerUpdate: { update() {} },
                surface: 'cli', externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
            } });
        };
        try {
            await expect(execute('start', 1)).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
            const storedStart = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            expect(storedStart).toMatchObject({ desired: 'start', intentRevision: 2, admittedInput: { submittedEffect: { intent: 'start' } } });
            // The actual native inspection boundary changes; Home report storage,
            // exact old-effect correlation and current Stop admission stay real.
            observation = ProviderObservationV1Schema.parse({ observedAt: power === 'stale' ? 9 : 20,
                availability: 'present', power: power === 'stale' ? 'stopped' : power });
            results.inspect = observation;
            const result = await execute('stop', 2);
            const storedStop = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            expect(storedStop).toMatchObject({ desired: 'stop', intentRevision: 3 });
            if (power === 'unknown' || power === 'stale') {
                expect(result).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
                expect(storedStop.admittedInput).toMatchObject({ submittedEffect: { intent: 'start', expectedIntentRevision: 2 } });
                expect(effects).toEqual(['start']);
            } else {
                expect(result).toMatchObject({ kind: 'accepted', managedId: row.id, intentRevision: 3 });
                expect(effects).toEqual(['start', 'stop']);
                // Stop's own settlement still requires its observed result.
                results.inspect = { ...observation, observedAt: 30, power: 'stopped' };
                const inspected = await execute('inspect', 3);
                expect(ManagedMachineActionOutputSchemasV1['machines.managed.inspect'].parse(inspected).machine).toMatchObject({ desired: 'stop', intentRevision: 3,
                    observation: { power: 'stopped', observedAt: 30 } });
                expect((await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).admittedInput).not.toHaveProperty('submittedEffect');
                expect(effects).toEqual(['start', 'stop']);
            }
        } finally { restoreHttp(); await app.close(); }
    }, 120_000);

    it.each([
        { failureBoundary: 'submit-intent', intent: 'start' },
        { failureBoundary: 'admission-acknowledgement', intent: 'start' },
        { failureBoundary: 'admission-503', intent: 'stop' },
    ] as const)('projects committed $intent after unavailable $failureBoundary according to native invocation evidence', async ({ failureBoundary, intent }) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey), active: true,
            pluginMaterializationRevision: 1n, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
        const manifest = await seedLimaAvailability(account.id, homeId, controller.machineId);
        const definition = manifest.contributes?.machineProvisioners?.find(entry => entry.id === 'lima');
        if (!definition) throw new Error('Bundled Lima declaration missing');
        const launch = managedQb56Input.selection.launch;
        const { memoryGiB, diskGiB, ...identity } = launch.choices;
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: {}, launch, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: launch.provider, schemaVersion: 1,
                value: { ...identity, memoryBytes: Number(memoryGiB) * 1_073_741_824, diskBytes: Number(diskGiB) * 1_073_741_824 } },
            desired: intent === 'start' ? 'stop' : 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: 1 } } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app as Parameters<typeof enableAuthentication>[0]);
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        registerExternalActionRoutes(app as Parameters<typeof registerExternalActionRoutes>[0]);
        machinesRoutes(app as Parameters<typeof machinesRoutes>[0]);
        const { installAxiosFastifyAdapter } = await import('../../../../../cli/src/testkit/http/axiosAdapter');
        const { createManagedMachineAcquisitionDriver } = await import('../../../../../cli/src/machines/managed/acquire');
        const { normalizePluginManifestV2 } = await import('../../../../../cli/src/plugins/manifest/normalize');
        const { createHostActionOperationRuntime } = await import('../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime');
        const { fixture } = await import('../../../../../cli/src/plugins/runtime/invocation/actions/managedCustody.testkit');
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
        const native = fixture({ privateNative: true, fixtureManifest: normalizePluginManifestV2(manifest), nativeCommandArgs: [] });
        const driver = createManagedMachineAcquisitionDriver({ token, credentials: { token, encryption: null },
            serverUrl: 'https://power-admission.test', homeId, controller, externalActionMachineRequestPrivateKey: keys.secretKey,
            managedProviderOperationAuthority: authority,
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://power-admission.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://power-admission.test' }] }, authority: 'current_connection' }),
            runtimeRegistry: native.runtimeRegistry });
        const requestId = randomUUID();
        const input = { homeId, managedId: row.id, expectedRevision: 1, when: 'now' as const, intent };
        const operations = createHostActionOperationRuntime({ machineId: controller.machineId,
            resolveAccountId: async () => account.id, generateOperationId: () => 'committed-power' });
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'https://power-admission.test' });
        const httpPost = axios.post.bind(axios);
        let reachedSubmission = false;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            // Only the failed Home HTTP response is substituted; admission,
            // signed proof, row write, projection, driver and operation stay real.
            if (failureBoundary === 'submit-intent' && String(url).endsWith('/controller/submit-intent')) {
                reachedSubmission = true;
                return { status: 503, data: { error: 'database_connection_unavailable' } };
            }
            if ((failureBoundary === 'admission-acknowledgement' || failureBoundary === 'admission-503')
                && String(url).endsWith('/controller/admit-control')) {
                const response = await httpPost(url, body, config);
                expect(response.status).toBe(200);
                if (failureBoundary === 'admission-503') {
                    return { status: 503, data: { error: 'database_connection_unavailable', statusCode: 503 } };
                }
                throw new axios.AxiosError('Admission acknowledgement lost', 'ECONNRESET');
            }
            return httpPost(url, body, config);
        });
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.power.set'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope: { v: 1, requestId, target: { kind: 'machine', machineId: controller.machineId }, input } } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            let work: ReturnType<typeof driver.execute> | undefined;
            const result = await operations.observeExecution({ actionId: 'machines.managed.power.set', input, actionRequestId: requestId,
                execute: async context => {
                    work = driver.execute('machines.managed.power.set', input, { requestId, signal: context.signal,
                        context: { ...context, surface: 'cli', externalActionExecutionAuthorization: authorization,
                            externalActionTarget: authorization.binding.target } });
                    const result = await work;
                    const failure = ActionExecuteFailureSchema.safeParse(result);
                    return failure.success ? failure.data : { ok: true, result };
                } });
            expect(result).toMatchObject(failureBoundary === 'submit-intent'
                ? { ok: true, result: { kind: 'accepted', managedId: row.id, intentRevision: 2 } }
                : { ok: false, errorCode: 'action_outcome_unknown' });
            await expect(work).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
            expect(reachedSubmission).toBe(failureBoundary === 'submit-intent');
            const stored = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
            expect(stored).toMatchObject({
                desired: intent, intentRevision: 2, observation: row.observation, admittedInput: {
                    currentAdmission: { kind: 'control', request: { requestId, action: 'machines.managed.power.set' } },
                } });
            expect(ActionOperationGetV1ResponseSchema.parse(await operations.handlers.getV2({ operationId: 'committed-power' })))
                .toMatchObject({ kind: 'found', operation: { domainRef: { kind: 'managedMachine', id: row.id },
                    state: 'running', observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } } });
            expect(native.effects()).toBe(0);
        } finally { post.mockRestore(); restoreHttp(); await app.close(); }
    }, 120_000);
});
