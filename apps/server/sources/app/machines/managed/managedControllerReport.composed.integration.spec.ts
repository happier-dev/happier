import { randomUUID } from 'node:crypto';
import axios from 'axios';
import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import type { LimaExecutor } from '@happier-dev/cli-common/machineLima';
import { API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, MachineOperationProtocolCapabilitiesV1Schema, signMachineInstallationProof } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedAdmissionOutputV1Schema, ManagedControllerSubmitOutputV1Schema, ManagedControllerMachineOutputV1Schema,
    ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_ACQUIRE_ACTION_ID_V1, MANAGED_CANCEL_ACTION_ID_V1, MANAGED_DELETE_ACTION_ID_V1, MANAGED_GET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1, readMachineProvisionerSelectionForLaunchV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AcquireResultV1Schema, type AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { revokeMachineInTx } from '@/app/machines/machineMutations';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { createPluginAvailabilityOperations } from '@/app/plugins/availability/operations';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { snapshotEnv, restoreEnv } from '@/testkit/env';
import { measure, seedBundledManagedAvailability } from './managedProjectionVolume.testkit';
import { readManagedAdmissionState } from './managedRows';
import { managedQb56Input } from '@/app/api/routes/actions/managedQb56Input.testkit';
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

// Runtime-loaded cross-package ports keep server compilation inside its root;
// implementations and their own alias/source resolution stay real.
interface ControllerClient {
    post<T>(path: string, body: unknown, schema: Readonly<{ parse(value: unknown): T }>): Promise<T>;
    submit(machine: ManagedMachineV1): Promise<ReturnType<typeof ManagedControllerSubmitOutputV1Schema.parse>>;
    reportIssuedAcquireFact(machine: ManagedMachineV1, fact: Extract<AcquireResultV1, { kind: 'bound' | 'pending' }>, configurationFacts?: ManagedMachineV1['reviewedFacts']): Promise<ManagedMachineV1>;
}

describe('managed native report through CLI, HTTP and disposable storage', () => {
    const homeId = managedQb56Input.selection.homeId;
    const initialEnv = snapshotEnv();
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        if (process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            if (process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) throw new Error('Use only the disposable PostgreSQL harness');
            Object.assign(process.env, { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HANDY_MASTER_SECRET: randomUUID() });
            initDbPostgres();
            await db.$connect();
            await auth.init();
        } else {
            harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-report-', initAuth: true,
                env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
        }
    }, 120_000);
    afterAll(async () => {
        try { if (harness) await harness.close(); else await db.$disconnect(); }
        finally { restoreEnv(initialEnv); }
    });

    const createController = async (accountId: string) => {
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId,
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey),
            active: true, pluginMaterializationRevision: 1n, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
        return { controller, keys };
    };

    it.each(['signed-credential', 'api-token', 'api-token-grant', 'machine-grant', 'controller-retired', 'controller-retired-unreviewed',
        'publication', 'legacy-missing', 'legacy-mismatched', 'MR-R1 lost bound report response', 'MR-R4 registration after Cancel'] as const)(
        'settles or explains a signed submitted Lima report (%s)', async withdrawal => {
        // Configurator admissions retain reviewed facts; Action/Session-originated
        // admissions may not, and report them with the issued native fact.
        const retired = withdrawal === 'controller-retired' || withdrawal === 'controller-retired-unreviewed';
        const unpublished = withdrawal === 'publication' || withdrawal === 'legacy-missing';
        const legacy = withdrawal === 'legacy-missing' || withdrawal === 'legacy-mismatched';
        const lostReport = withdrawal === 'MR-R1 lost bound report response';
        const cancelRegistration = withdrawal === 'MR-R4 registration after Cancel';
        const ordering = lostReport || cancelRegistration;
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const { controller, keys } = await createController(account.id);
        // Controller Manage reaches its native resources; Use does not.
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: controller.machineId, accountId: viewer.id,
            createdByAccountId: account.id, accessLevel: 'admin' } });
        // Only the Lima provisioner is exercised; unrelated bundled manifests stay out of this fixture.
        const manifest = await seedBundledManagedAvailability(account.id, homeId, controller, ['machine-lima.json']);
        const definition = manifest.contributes?.machineProvisioners?.find(entry => entry.id === 'lima');
        if (!definition) throw new Error('Bundled Lima provisioner missing');
        const requestId = randomUUID();
        const { createProtocolStoredReadSchema } = await vi.importActual<typeof import('@happier-dev/protocol/plugins/actions/protocol-composable-schema')>('@happier-dev/protocol/plugins/actions/protocol-composable-schema');
        const { LimaLaunchSchema } = await vi.importActual<typeof import('../../../../../../packages/plugins/machine-lima/src/machine/schemas')>('../../../../../../packages/plugins/machine-lima/src/machine/schemas');
        // Keep the historical QB56 capture intact. This test makes a new
        // allocation through the current Lima provider at its 4 GiB default.
        const choices = createProtocolStoredReadSchema(LimaLaunchSchema).parse({
            ...managedQb56Input.selection.launch.choices,
            memoryGiB: 4,
        });
        const launch = { ...managedQb56Input.selection.launch, name: 'happier-qb79-defaults',
            choices };
        const { reviewedFacts: _reviewedFacts, ...unreviewedInput } = managedQb56Input;
        const input = { ...unreviewedInput, selection: { ...managedQb56Input.selection, controller, launch } };
        const apiToken = withdrawal === 'signed-credential' || withdrawal === 'machine-grant' || unpublished || legacy || retired || ordering ? undefined : await auth.createApiToken({
            accountId: account.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, 'Acquire completion'),
        });
        const token = apiToken?.token ?? await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        enableAuthentication(app as Parameters<typeof enableAuthentication>[0]);
        registerExternalActionRoutes(app as Parameters<typeof registerExternalActionRoutes>[0], {
            dispatch: async () => { throw new Error('The report must not dispatch another Action'); },
        });
        machinesRoutes(app as Parameters<typeof machinesRoutes>[0]);
        registerAccountEncryptionRoutes(app as Parameters<typeof registerAccountEncryptionRoutes>[0]);
        const { installAxiosFastifyAdapter } = await vi.importActual<{
            installAxiosFastifyAdapter(params: { app: typeof app; origin: string }): () => void;
        }>('../../../../../cli/src/testkit/http/axiosAdapter');
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'http://managed-report.test' });
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope: { v: 1, requestId, target: { kind: 'machine', machineId: controller.machineId }, input } } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const { createManagedMachineControllerClient } = await vi.importActual<{
                createManagedMachineControllerClient(input: unknown, options: unknown, action: string): ControllerClient;
            }>('../../../../../cli/src/machines/managed/acquire');
            const { createResolvedContributionRegistry } = await vi.importActual<{
                createResolvedContributionRegistry(input: unknown): unknown;
            }>('../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry');
            const client = createManagedMachineControllerClient({ token, serverUrl: 'http://managed-report.test', homeId, controller,
                externalActionMachineRequestPrivateKey: keys.secretKey,
                runtimeRegistry: { contributes: createResolvedContributionRegistry({ machineProvisioners: [{ pluginId: manifest.id,
                    identity: { pluginId: manifest.id, localId: definition.id }, definition }] }) } },
                { requestId, context: { surface: 'cli', externalActionExecutionAuthorization: authorization,
                    externalActionTarget: authorization.binding.target } }, 'machines.managed.acquire');
            // Only native process execution is substituted; the actual Lima leaf
            // produces the resource consumed by the CLI and declared server schema.
            const { createLimaProvider } = await vi.importActual<{
                createLimaProvider(executor: LimaExecutor, observedAt: number, qemuAvailable: () => Promise<boolean>): {
                    acquire(input: unknown): Promise<unknown>;
                    destroy(input: unknown): Promise<unknown>;
                    inspect(input: unknown): Promise<unknown>;
                    options(input: unknown): Promise<unknown>;
                };
            }>('../../../../../../packages/plugins/machine-lima/src/machine/provider');
            let present = false;
            let nativeName = '';
            const native = () => ({ name: nativeName, dir: `${launch.choices.store}/${nativeName}`, status: 'Running',
                vmType: 'qemu', arch: 'x86_64', cpus: 1, memory: launch.choices.memoryGiB * 2 ** 30, disk: 4_294_967_296,
                config: { images: [{ location: launch.choices.image, arch: 'x86_64' }], mounts: [],
                    ssh: { forwardAgent: false }, containerd: { user: false, system: false } } });
            const capture: LimaExecutor['capture'] = async (_command, args) => ({ exitCode: 0, err: '',
                out: args[0] === '--version' ? 'limactl version 2.1.0'
                    : args[0] === 'info' ? JSON.stringify({ hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] })
                    : present ? JSON.stringify(native()) : '' });
            const executor: LimaExecutor = { capture, run: async (_command, args) => {
                if (ordering && args[0] === 'delete') {
                    expect(args).toEqual(['delete', '--force', nativeName]);
                    present = false;
                    return { exitCode: 0, out: '', err: '' };
                }
                if (args[0] !== 'create') throw new Error('Unexpected native effect');
                nativeName = args[args.indexOf('--name') + 1];
                present = true;
                return { exitCode: 0, out: '', err: '' };
            } };
            const provider = createLimaProvider(executor, Date.now(), async () => true);
            const options = MachineProvisionerOptionsResultV1Schema.parse(await provider.options(launch.choices));
            const configurationFacts = buildManagedConfigurationFactsV1({
                choicesSchema: createPluginJsonSchemaZodValueAdapter(definition.launchSchema), launch, controller,
                provisioner: definition, optionStatus: 'current', optionProjection: projectMachineProvisionerSelectionV1({ options, launchSchema: definition.launchSchema,
                    selection: readMachineProvisionerSelectionForLaunchV1(options, launch.choices) }),
                prerequisites: [], billing: definition.billing, retentionCapabilities: definition.retention,
                machineOverride: { retention: input.selection.retention, wakeOnAcceptedMessage: input.selection.wakeOnAcceptedMessage },
            });
            expect(configurationFacts).toMatchObject({ launch, optionStatus: 'current', nativeFacts: {
                size: { cpuCores: launch.choices.cpus, memoryBytes: launch.choices.memoryGiB * 2 ** 30,
                    diskBytes: launch.choices.diskGiB * 2 ** 30 }, image: { id: launch.choices.image },
            } });
            // The configurator admits one-off acquisitions with reviewed facts, so the
            // row retains its native declaration after the controller retires.
            const admissionBody = { input: withdrawal === 'controller-retired' ? { ...input, reviewedFacts: configurationFacts } : input,
                continuationPresent: false, requestId };
            const admitted = await client.post('/v1/machines/managed/controller/admit', admissionBody, ManagedAdmissionOutputV1Schema);
            expect(admitted).toMatchObject({ replayed: false, machine: { allocation: 'unsubmitted' } });
            expect(await client.post('/v1/machines/managed/controller/admit', admissionBody, ManagedAdmissionOutputV1Schema))
                .toMatchObject({ replayed: true, machine: { id: admitted.machine.id } });
            expect(await client.submit(admitted.machine)).toMatchObject({ submitted: true, machine: { allocation: 'may-exist' } });

            // Retiring the controller closes new effects; the purchase it already
            // submitted must still be able to return its native identity.
            if (unpublished) {
                const availability = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }),
                    resolveServerIdentityId: async () => homeId });
                const current = await db.machine.findUniqueOrThrow({ where: { id: controller.machineId },
                    select: { pluginMaterializationRevision: true } });
                const revision = Number(current.pluginMaterializationRevision);
                expect(await availability.reportMaterializations({ accountId: account.id, publisherMachineId: controller.machineId,
                    input: { expectedRevision: revision, snapshot: { serverIdentityId: homeId, machineId: controller.machineId, materializations: [] } } }))
                    .toEqual({ outcome: 'replaced', revision: revision + 1 });
            } else if (retired) expect(await inTx(tx => revokeMachineInTx(tx, { accountId: account.id,
                machineId: controller.machineId }))).toMatchObject({ ok: true });
            else if (apiToken) {
                if (withdrawal === 'api-token') await auth.revokeApiToken({ accountId: account.id, tokenId: apiToken.tokenId });
                else await auth.updateApiToken({ accountId: account.id, tokenId: apiToken.tokenId,
                    grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.managed.get'] } } });
            } else if (!legacy && !ordering) await auth.signOutEverywhere(account.id);
            const freshAcquire = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: controller.machineId }, input } } });
            expect(freshAcquire.statusCode, freshAcquire.body).toBe(unpublished || legacy || ordering ? 200 : withdrawal === 'api-token-grant' ? 403
                : retired ? 409 : 401);

            const fact = AcquireResultV1Schema.parse(await provider.acquire({ managedId: admitted.machine.id, launch: launch.choices }));
            if (fact.kind !== 'bound') throw new Error(`Lima did not bind: ${fact.kind}`);
            if (ordering) {
                const report = () => client.reportIssuedAcquireFact(admitted.machine, fact, configurationFacts);
                const personHeaders = { authorization: `Bearer ${token}` };
                const target = { homeId, managedId: admitted.machine.id };
                const readByRequest = async () => {
                    const read = await app.inject({ method: 'POST', url: managedMachineActionEndpointPathV1(MANAGED_GET_ACTION_ID_V1),
                        headers: personHeaders, payload: { homeId, creationRequestId: requestId } });
                    expect(read.statusCode, read.body).toBe(200);
                    return unwrapManagedMachineReadV1(ManagedMachineActionOutputSchemasV1[MANAGED_GET_ACTION_ID_V1].parse(read.json()));
                };
                if (lostReport) {
                    const { createHostActionOperationRuntime } = await vi.importActual<
                        typeof import('../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime')
                    >('../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime');
                    const operationId = randomUUID();
                    const operations = createHostActionOperationRuntime({ machineId: controller.machineId,
                        resolveAccountId: async () => account.id, generateOperationId: () => operationId });
                    const send = axios.post.bind(axios);
                    const dropBoundReport = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
                        const response = await send(url, body, config);
                        if (new URL(url).pathname === '/v1/machines/managed/controller/report') {
                            expect(response.status).toBe(200);
                            expect(ManagedControllerMachineOutputV1Schema.parse(response.data).machine)
                                .toMatchObject({ id: target.managedId, allocation: 'bound', resource: fact.resource });
                            throw new axios.AxiosError('Bound report response lost', 'ECONNRESET');
                        }
                        return response;
                    });
                    try {
                        const acquisition = operations.observeExecution({ actionId: MANAGED_ACQUIRE_ACTION_ID_V1,
                            actionRequestId: requestId, input, response: 'terminal',
                            execute: async ({ operationOwnerUpdate, operationAcceptance }) => {
                                const accepted = { managedId: target.managedId, operation: { operationId } };
                                operationOwnerUpdate.update({ domainRef: { kind: 'managedMachine', id: target.managedId } });
                                operationAcceptance?.accept(accepted);
                                await report();
                                return { ok: true, result: accepted };
                            } });
                        await expect(acquisition).rejects.toMatchObject({ code: 'ECONNRESET',
                            failureCause: { phase: 'managed.controller.report', errorCode: 'ECONNRESET' } });
                    } finally { dropBoundReport.mockRestore(); }
                    expect(ActionOperationGetV1ResponseSchema.parse(await operations.handlers.getV2({ operationId })))
                        .toMatchObject({ kind: 'found', operation: { state: 'failed',
                            domainRef: { kind: 'managedMachine', id: target.managedId }, error: { errorCode: 'ECONNRESET' } } });
                } else {
                    await report();
                }
                const bound = await readByRequest();
                expect(bound).toMatchObject({ id: target.managedId, allocation: 'bound', resource: fact.resource });
                expect(bound.enrolledMachineId).toBeUndefined();
                expect(bound.submittedNativeEffect).toBeUndefined();
                expect(await provider.inspect(fact.resource.value)).toMatchObject({ availability: 'present' });
                let revision = bound.intentRevision;
                if (cancelRegistration) {
                    const correlation = { ...target, requestId, controller, expectedIntentRevision: revision, resource: fact.resource };
                    const machineId = randomUUID();
                    const installationId = randomUUID();
                    const guestKeys = tweetnacl.sign.keyPair();
                    const guestToken = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
                    const { ApiClient } = await vi.importActual<typeof import('../../../../../cli/src/api/api')>('../../../../../cli/src/api/api');
                    const { encodeBase64Url } = await vi.importActual<{ encodeBase64Url(bytes: Uint8Array): string }>(
                        '../../../../../cli/src/api/encryption');
                    const { runWithServerHttpBaseUrl } = await vi.importActual<typeof import('../../../../../cli/src/api/client/serverHttpBaseUrl')>(
                        '../../../../../cli/src/api/client/serverHttpBaseUrl');
                    const guest = await ApiClient.create({ token: guestToken, encryption: null });
                    const atIngress = Promise.withResolvers<void>();
                    const release = Promise.withResolvers<void>();
                    const send = axios.post.bind(axios);
                    const hold = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
                        if (new URL(url).pathname === '/v1/machines' && body?.id === machineId) {
                            expect(body.managedEnrollment).toEqual(correlation);
                            atIngress.resolve();
                            await release.promise;
                        }
                        return send(url, body, config);
                    });
                    const pending = runWithServerHttpBaseUrl('http://managed-report.test', () => guest.getOrCreateMachine({
                        machineId, metadata: { host: 'guest', platform: 'linux', happyCliVersion: 'test',
                            homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' },
                        managedEnrollment: correlation, registrationIdentity: { installationId,
                            installationPublicKey: encodeBase64Url(guestKeys.publicKey),
                            installationProof: signMachineInstallationProof({ payload: { version: 1, machineId, installationId,
                                accountId: account.id }, privateKey: guestKeys.secretKey }) },
                    }));
                    try {
                        try {
                            await Promise.race([atIngress.promise, pending.then(() => {
                                throw new Error('Guest registration completed before Cancel');
                            })]);
                            const cancel = await app.inject({ method: 'POST', url: managedMachineActionEndpointPathV1(MANAGED_CANCEL_ACTION_ID_V1),
                                headers: personHeaders, payload: { ...target, expectedIntentRevision: revision } });
                            expect(cancel.statusCode, cancel.body).toBe(200);
                            const canceled = ManagedMachineActionOutputSchemasV1[MANAGED_CANCEL_ACTION_ID_V1].parse(cancel.json()).machine;
                            expect(canceled).toMatchObject({ creationState: 'canceled', allocation: 'bound', resource: fact.resource });
                            revision = canceled.intentRevision;
                        } finally { release.resolve(); }
                        await expect(pending).rejects.toMatchObject({ response: { status: 409, data: { reason: 'enrollment_retired' } } });
                    } finally {
                        await pending.catch(() => undefined);
                        hold.mockRestore();
                    }
                    expect(await db.machine.findUnique({ where: { id: machineId } })).toBeNull();
                }
                const action = MANAGED_DELETE_ACTION_ID_V1;
                const deleteRequestId = randomUUID();
                const deleteInput = { ...target, expectedRevision: revision, intent: 'delete', when: 'now', reviewedDependencies: true };
                const issuedDelete = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(action),
                    headers: personHeaders, payload: { v: 1, machineId: controller.machineId,
                        envelope: { v: 1, requestId: deleteRequestId, target: { kind: 'machine', machineId: controller.machineId }, input: deleteInput } } });
                expect(issuedDelete.statusCode, issuedDelete.body).toBe(200);
                const deleteAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(issuedDelete.json());
                const deletion = createManagedMachineControllerClient({ token, serverUrl: 'http://managed-report.test', homeId, controller,
                    externalActionMachineRequestPrivateKey: keys.secretKey }, { requestId: deleteRequestId, context: { surface: 'cli',
                    externalActionExecutionAuthorization: deleteAuthorization, externalActionTarget: deleteAuthorization.binding.target } }, action);
                const admittedDelete = await deletion.post('/v1/machines/managed/controller/admit-control',
                    { action, requestId: deleteRequestId, input: deleteInput }, ManagedAdmissionOutputV1Schema);
                const deleteCorrelation = { ...target, controller, requestId: deleteRequestId, expectedIntentRevision: admittedDelete.machine.intentRevision };
                expect(await deletion.post('/v1/machines/managed/controller/submit-intent', deleteCorrelation, ManagedControllerSubmitOutputV1Schema))
                    .toMatchObject({ submitted: true });
                const result = await provider.destroy(fact.resource.value);
                const observation = await provider.inspect(fact.resource.value);
                expect(result).toMatchObject({ kind: 'confirmed' });
                expect(observation).toMatchObject({ availability: 'absent' });
                const settled = await deletion.post('/v1/machines/managed/controller/report-intent',
                    { ...deleteCorrelation, result, observation }, ManagedControllerMachineOutputV1Schema);
                expect(settled.machine).toMatchObject({ id: target.managedId, allocation: 'confirmed-absent', observation: { availability: 'absent' } });
                expect(await db.managedMachine.findMany({ where: { homeId, custodianAccountId: account.id },
                    select: { id: true, allocation: true, enrolledMachineId: true } }))
                    .toEqual([{ id: target.managedId, allocation: 'confirmed-absent', enrolledMachineId: null }]);
                expect(await db.machine.findMany({ where: { accountId: account.id }, select: { id: true } })).toEqual([{ id: controller.machineId }]);
                return;
            }
            const reportBody = { homeId, managedId: admitted.machine.id, controller,
                expectedIntentRevision: admitted.machine.intentRevision, requestId, result: fact };
            const { resolveExternalActionServerRequestHeaders } = await vi.importActual<{
                resolveExternalActionServerRequestHeaders(input: unknown): { ok: true; headers: Record<string, string> } | { ok: false };
            }>('../../../../../cli/src/api/externalActionExecutionAuthorization');
            const reportHeaders = (body: unknown, privateKey = keys.secretKey) => {
                const signed = resolveExternalActionServerRequestHeaders({
                    context: { surface: 'cli', externalActionExecutionAuthorization: authorization,
                        externalActionTarget: authorization.binding.target },
                    effectActionId: 'machines.managed.acquire', method: 'POST', path: '/v1/machines/managed/controller/report', body,
                    daemonToken: token, serverIdentityId: homeId, installationId: controller.installationId, privateKey,
                });
                if (!signed.ok) throw new Error('Report signing unavailable');
                return signed.headers;
            };
            const tampered = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report', payload: reportBody,
                headers: reportHeaders(reportBody, tweetnacl.sign.keyPair().secretKey) });
            expect(tampered.statusCode, tampered.body).toBe(401);
            expect(tampered.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'machine_signature' });
            const wrongJob = { ...reportBody, requestId: randomUUID() };
            const mismatched = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report', payload: wrongJob,
                headers: reportHeaders(wrongJob) });
            if (retired) {
                // Only the exact submitted fact skips controller lifecycle; any
                // other signed call from the retired controller is refused there.
                expect(mismatched.statusCode, mismatched.body).toBe(401);
                expect(mismatched.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'machine_identity' });
                const wrongRow = { ...reportBody, managedId: randomUUID() };
                const unknownRow = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report', payload: wrongRow,
                    headers: reportHeaders(wrongRow) });
                expect(unknownRow.statusCode, unknownRow.body).toBe(401);
                expect(unknownRow.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'machine_identity' });
                // Another Account's current controller signs its own Action under
                // the same client-chosen request id; it cannot write this row.
                const intruder = await db.account.create({ data: { encryptionMode: 'plain' } });
                const foreign = await createController(intruder.id);
                await seedBundledManagedAvailability(intruder.id, homeId, foreign.controller, ['machine-lima.json']);
                const intruderToken = await auth.createToken(intruder.id, undefined, { kind: 'account', authority: 'present_user' });
                const foreignIssued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                    headers: { authorization: `Bearer ${intruderToken}` }, payload: { v: 1, machineId: foreign.controller.machineId,
                        envelope: { v: 1, requestId, target: { kind: 'machine', machineId: foreign.controller.machineId },
                            input: { ...input, selection: { ...input.selection, controller: foreign.controller } } } } });
                expect(foreignIssued.statusCode, foreignIssued.body).toBe(200);
                const foreignAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(foreignIssued.json());
                for (const body of [{ ...reportBody, controller: foreign.controller }, reportBody]) {
                    const signed = resolveExternalActionServerRequestHeaders({ context: { surface: 'cli',
                        externalActionExecutionAuthorization: foreignAuthorization, externalActionTarget: foreignAuthorization.binding.target },
                        effectActionId: 'machines.managed.acquire', method: 'POST', path: '/v1/machines/managed/controller/report', body,
                        daemonToken: intruderToken, serverIdentityId: homeId, installationId: foreign.controller.installationId,
                        privateKey: foreign.keys.secretKey });
                    if (!signed.ok) throw new Error('Foreign report signing unavailable');
                    const foreignReport = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/report', payload: body,
                        headers: signed.headers });
                    expect(foreignReport.statusCode, foreignReport.body).toBeGreaterThanOrEqual(400);
                    expect(foreignReport.statusCode, foreignReport.body).toBeLessThan(500);
                }
            } else {
                expect(mismatched.statusCode, mismatched.body).toBe(409);
                expect(mismatched.json()).toMatchObject({ code: 'request_conflict' });
            }
            const submittedRow = await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } });
            expect(submittedRow).toMatchObject({ allocation: 'may-exist', resource: null });
            if (legacy) {
                // Reconstruct pre-fix storage. The mismatch fixture carries a
                // declaration for a different schema on the same managed row.
                const legacyAdmission = { ...readManagedAdmissionState(submittedRow.admittedInput) };
                Reflect.deleteProperty(legacyAdmission, 'acquireProvisioner');
                await db.managedMachine.update({ where: { id: submittedRow.id }, data: {
                    admittedInput: legacyAdmission,
                    ...(withdrawal === 'legacy-mismatched' ? { reviewedFacts: { ...configurationFacts,
                        provisioner: { ...definition, schemaVersion: definition.schemaVersion + 1 } } } : {}),
                } });
                const code = withdrawal === 'legacy-missing' ? 'provider_declaration_missing' : 'provider_schema_mismatch';
                await expect(client.reportIssuedAcquireFact(admitted.machine, fact, configurationFacts))
                    .rejects.toMatchObject({ code, status: 409, failureCause: {
                        phase: 'managed.controller.report', errorCode: code, httpStatus: 409,
                    } });
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: submittedRow.id } }))
                    .toMatchObject({ allocation: 'may-exist', resource: null });
                return;
            }
            const before = await db.account.findMany({ where: { id: { in: [account.id, viewer.id] } }, select: { id: true, seq: true } });
            const report = () => client.reportIssuedAcquireFact(admitted.machine, fact, configurationFacts);
            const reported = withdrawal === 'publication' ? await measure('issued-acquire-report', report).then(({ value, queries }) => {
                expect(queries.filter(query => ['pluginMachineMaterialization', 'accountPluginIntent', 'accountPluginRelease'].includes(query.model)))
                    .toHaveLength(0);
                return value;
            }) : await report();
            expect(reported.reviewedFacts).toEqual(configurationFacts);
            // Report-time presentation facts never join the admitted request identity.
            if (withdrawal !== 'controller-retired') expect((await db.managedMachine.findUniqueOrThrow({ where: { id: reported.id } })).admittedInput)
                .not.toHaveProperty('computeInput.reviewedFacts');
            expect(reported).toMatchObject({ id: admitted.machine.id, allocation: 'bound', resource: fact.resource });
            expect(reported.enrolledMachineId).toBeUndefined();
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: reported.id } }))
                .toMatchObject({ allocation: 'bound', resource: fact.resource, enrolledMachineId: null, reviewedFacts: configurationFacts });
            for (const recipient of before) {
                expect(await db.account.findUniqueOrThrow({ where: { id: recipient.id }, select: { seq: true } })).toEqual({ seq: recipient.seq + 1 });
            }
            expect(await db.accountChange.findMany({ where: { entityId: reported.id }, select: { accountId: true }, orderBy: { accountId: 'asc' } }))
                .toEqual([account.id, viewer.id].sort().map(accountId => ({ accountId })));
            expect(await client.reportIssuedAcquireFact(admitted.machine, fact, { ...configurationFacts, optionStatus: 'unavailable' }))
                .toMatchObject({ id: reported.id, resource: fact.resource, reviewedFacts: configurationFacts });
            // A retired controller admits no further effects to exercise below.
            if (retired || withdrawal === 'publication') return;
            const installedReport = { homeId, managedId: reported.id, controller, expectedIntentRevision: reported.intentRevision,
                requestId, result: fact, bootstrapInstalled: true };
            const installed = await client.post('/v1/machines/managed/controller/report', installedReport, ManagedControllerMachineOutputV1Schema);
            expect(installed.machine).toMatchObject({ allocation: 'bound', bootstrapInstalled: true });
            expect(installed.machine.enrolledMachineId).toBeUndefined();
            const read = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/get',
                headers: { authorization: `Bearer ${await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' })}` },
                payload: { homeId, managedId: reported.id } });
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toMatchObject({ id: reported.id, bootstrapInstalled: true });
            const installedSeq = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            await client.post('/v1/machines/managed/controller/report', installedReport, ManagedControllerMachineOutputV1Schema);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(installedSeq);
            expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(1);
            expect(await db.savedSecretResource.count({ where: { ownerAccountId: account.id } })).toBe(0);

            let controlled = installed.machine;
            const controlActor = withdrawal === 'machine-grant'
                ? await db.account.create({ data: { encryptionMode: 'plain' } }) : account;
            await db.managedMachine.update({ where: { id: controlled.id }, data: {
                observation: { observedAt: 1, availability: 'present', power: 'running' },
            } });
            // This real Lima declaration admits Start/Stop/Delete. Resume and
            // Suspend are exercised by the controller fixture that supports them.
            const intents = withdrawal === 'signed-credential'
                ? ['start', 'stop', 'delete'] as const : ['stop', 'delete'] as const;
            for (const intent of intents) {
                const actionId = intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
                if (withdrawal === 'machine-grant') await db.machineGrant.create({ data: { principalKind: 'account',
                    machineId: controller.machineId, accountId: controlActor.id, createdByAccountId: account.id, accessLevel: 'admin',
                } });
                const controlApiToken = withdrawal === 'signed-credential' || withdrawal === 'machine-grant' ? undefined : await auth.createApiToken({
                    accountId: controlActor.id, tokenId: randomUUID(), label: await preparePlainAccountApiTokenLabel(controlActor.id, 'Native control completion'),
                });
                const controlToken = controlApiToken?.token ?? await auth.createToken(controlActor.id, undefined,
                    { kind: 'account', authority: 'present_user' });
                const controlRequestId = randomUUID();
                const controlInput = { homeId, managedId: controlled.id, expectedRevision: controlled.intentRevision,
                    intent, when: 'now', ...(intent === 'delete' ? { reviewedDependencies: true } : {}) };
                const mint = () => app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${controlToken}` }, payload: { v: 1, machineId: controller.machineId,
                        envelope: { v: 1, requestId: controlRequestId, target: { kind: 'machine', machineId: controller.machineId }, input: controlInput } } });
                const controlIssued = await mint();
                expect(controlIssued.statusCode, controlIssued.body).toBe(200);
                const controlAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(controlIssued.json());
                const controlClient = createManagedMachineControllerClient({ token: controlToken,
                    serverUrl: 'http://managed-report.test', homeId, controller,
                    externalActionMachineRequestPrivateKey: keys.secretKey },
                    { requestId: controlRequestId, context: { surface: 'cli', externalActionExecutionAuthorization: controlAuthorization,
                        externalActionTarget: controlAuthorization.binding.target } }, actionId);
                const admittedControl = await controlClient.post('/v1/machines/managed/controller/admit-control',
                    { action: actionId, requestId: controlRequestId, input: controlInput }, ManagedAdmissionOutputV1Schema);
                const correlation = { homeId, managedId: controlled.id, controller,
                    expectedIntentRevision: admittedControl.machine.intentRevision, requestId: controlRequestId };
                const reportPath = '/v1/machines/managed/controller/report-intent';
                const signedPost = (body: unknown, path = reportPath, privateKey = keys.secretKey) => {
                    const signed = resolveExternalActionServerRequestHeaders({ context: { surface: 'cli',
                        externalActionExecutionAuthorization: controlAuthorization, externalActionTarget: controlAuthorization.binding.target },
                        effectActionId: actionId, method: 'POST', path, body, daemonToken: controlToken,
                        serverIdentityId: homeId, installationId: controller.installationId, privateKey });
                    if (!signed.ok) throw new Error('Control report signing unavailable');
                    return app.inject({ method: 'POST', url: path, payload: body, headers: signed.headers });
                };
                const observation = intent === 'delete'
                    ? { observedAt: Date.now(), availability: 'absent' }
                    : { observedAt: Date.now(), availability: 'present', power: intent === 'start' ? 'running' : 'stopped' };
                const controlReport = { ...correlation, result: { kind: 'confirmed' }, observation };
                expect(await controlClient.post('/v1/machines/managed/controller/submit-intent', correlation,
                    ManagedControllerSubmitOutputV1Schema)).toMatchObject({ submitted: true });
                if (withdrawal === 'machine-grant') await db.machineGrant.deleteMany({
                    where: { principalKind: 'account', machineId: controller.machineId, accountId: controlActor.id },
                });
                else if (!controlApiToken) await auth.signOutEverywhere(account.id);
                else if (withdrawal === 'api-token') await auth.revokeApiToken({ accountId: account.id, tokenId: controlApiToken.tokenId });
                else await auth.updateApiToken({ accountId: account.id, tokenId: controlApiToken.tokenId,
                    grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.managed.get'] } } });
                expect((await mint()).statusCode).toBe(withdrawal === 'machine-grant' ? 409 : withdrawal === 'api-token-grant' ? 403 : 401);
                const probes = await Promise.all([
                    signedPost({ ...controlReport, requestId: randomUUID() }),
                    signedPost({ ...controlReport, managedId: randomUUID() }),
                    signedPost({ ...controlReport, controller: { ...controller, installationId: randomUUID() } }),
                    signedPost({ ...controlReport, expectedIntentRevision: correlation.expectedIntentRevision + 1 }),
                    signedPost(controlReport, reportPath, tweetnacl.sign.keyPair().secretKey),
                ]);
                expect(probes.map(response => response.statusCode), JSON.stringify(probes.map(response => {
                    const body = response.json();
                    return { code: body.code, error: body.error };
                }))).toEqual(withdrawal === 'machine-grant' ? [409, 401, 409, 409, 401] : [401, 401, 401, 401, 401]);
                if (withdrawal === 'machine-grant') {
                    for (const index of [0, 2, 3]) expect(probes[index]!.json()).toEqual({ code: 'request_conflict' });
                }
                const replay = await signedPost(correlation, '/v1/machines/managed/controller/submit-intent');
                // Home preserves exact power continuations. Submitting Delete still needs a current principal.
                if (intent === 'delete' && withdrawal !== 'machine-grant') {
                    expect(replay.statusCode, replay.body).toBe(401);
                } else {
                    expect(replay.statusCode, replay.body).toBe(200);
                    expect(ManagedControllerSubmitOutputV1Schema.parse(replay.json())).toMatchObject({
                        submitted: false, machine: { id: controlled.id, submittedNativeEffect: { requestId: controlRequestId } },
                    });
                }
                // An independent Inspect can settle custody before the original
                // native command reports its newer outcome. Both are facts of
                // this admitted request, including after credential withdrawal.
                const inspected = await signedPost({ ...controlReport, result: { kind: 'unknown' }, observation: {
                    ...observation, observedAt: observation.observedAt - 1,
                    ...(intent === 'delete' ? {} : { power: intent === 'stop' ? 'running' : 'stopped' }),
                } });
                expect(inspected.statusCode, inspected.body).toBe(200);
                expect(ManagedControllerMachineOutputV1Schema.parse(inspected.json()).machine.submittedNativeEffect).toBeUndefined();
                const settled = await signedPost(controlReport);
                expect(settled.statusCode, settled.body).toBe(200);
                controlled = ManagedControllerMachineOutputV1Schema.parse(settled.json()).machine;
                expect(controlled).toMatchObject({ desired: intent, observation });
                expect(controlled.submittedNativeEffect).toBeUndefined();
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: controlled.id } }))
                    .toMatchObject({ allocation: intent === 'delete' ? 'confirmed-absent' : 'bound', observation });
                const repeated = await signedPost(controlReport);
                expect(repeated.statusCode, repeated.body).toBe(200);
                expect(ManagedControllerMachineOutputV1Schema.parse(repeated.json()).machine).toMatchObject({ observation });
                const stale = await signedPost({ ...controlReport, observation: { ...observation, observedAt: observation.observedAt - 2 } });
                expect(stale.statusCode, stale.body).toBe(200);
                expect(ManagedControllerMachineOutputV1Schema.parse(stale.json()).machine).toMatchObject({ observation });
            }
        } finally { restoreHttp(); await app.close(); }
    }, 120_000);
});
