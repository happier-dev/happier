import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import type { LimaExecutor } from '@happier-dev/cli-common/machineLima';
import { API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedAdmissionOutputV1Schema, ManagedControllerSubmitOutputV1Schema, ManagedControllerMachineOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1, readMachineProvisionerSelectionForLaunchV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { AcquireResultV1Schema, type AcquireResultV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { db, initDbPostgres } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { snapshotEnv, restoreEnv } from '@/testkit/env';
import { seedBundledManagedAvailability } from './managedProjectionVolume.testkit';
import { managedQb56Input } from '@/app/api/routes/actions/managedQb56Input.testkit';

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

    it.each(['signed-credential', 'api-token', 'api-token-grant', 'machine-grant'] as const)('persists signed submitted Lima acquire, power and delete results after %s withdrawal and rejects fresh admission and tampering', async (withdrawal) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        const keys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey),
            active: true, pluginMaterializationRevision: 1n, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
        await db.machineAccountGrant.create({ data: { machineId: controller.machineId, accountId: viewer.id,
            createdByAccountId: account.id, accessLevel: 'view' } });
        const manifest = await seedBundledManagedAvailability(account.id, homeId, controller);
        const definition = manifest.contributes?.machineProvisioners?.find(entry => entry.id === 'lima');
        if (!definition) throw new Error('Bundled Lima provisioner missing');
        const requestId = randomUUID();
        const { createProtocolStoredReadSchema } = await vi.importActual<typeof import('@happier-dev/protocol/plugins/actions/protocol-composable-schema')>('@happier-dev/protocol/plugins/actions/protocol-composable-schema');
        const { LimaLaunchSchema } = await vi.importActual<typeof import('../../../../../../packages/plugins/machine-lima/src/machine/schemas')>('../../../../../../packages/plugins/machine-lima/src/machine/schemas');
        // QB56 is a preserved historical capture. The current producer owns
        // its nameless launch projection and allocation-derived native name.
        const choices = createProtocolStoredReadSchema(LimaLaunchSchema).parse(managedQb56Input.selection.launch.choices);
        const launch = { ...managedQb56Input.selection.launch, name: 'happier-qb79-defaults',
            choices };
        const { reviewedFacts: _reviewedFacts, ...unreviewedInput } = managedQb56Input;
        const input = { ...unreviewedInput, selection: { ...managedQb56Input.selection, controller, launch } };
        const apiToken = withdrawal === 'signed-credential' || withdrawal === 'machine-grant' ? undefined : await auth.createApiToken({
            accountId: account.id, tokenId: randomUUID(), label: 'Acquire completion',
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
            const admissionBody = { input, continuationPresent: false, requestId };
            const admitted = await client.post('/v1/machines/managed/controller/admit', admissionBody, ManagedAdmissionOutputV1Schema);
            expect(admitted).toMatchObject({ replayed: false, machine: { allocation: 'unsubmitted' } });
            expect(await client.post('/v1/machines/managed/controller/admit', admissionBody, ManagedAdmissionOutputV1Schema))
                .toMatchObject({ replayed: true, machine: { id: admitted.machine.id } });
            expect(await client.submit(admitted.machine)).toMatchObject({ submitted: true, machine: { allocation: 'may-exist' } });

            if (!apiToken) await auth.signOutEverywhere(account.id);
            else if (withdrawal === 'api-token') await auth.revokeApiToken({ accountId: account.id, tokenId: apiToken.tokenId });
            else await auth.updateApiToken({ accountId: account.id, tokenId: apiToken.tokenId,
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.managed.get'] } } });
            const freshAcquire = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.acquire'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: controller.machineId }, input } } });
            expect(freshAcquire.statusCode, freshAcquire.body).toBe(withdrawal === 'api-token-grant' ? 403 : 401);

            // Only native process execution is substituted; the actual Lima leaf
            // produces the resource consumed by the CLI and declared server schema.
            const { createLimaProvider } = await vi.importActual<{
                createLimaProvider(executor: LimaExecutor, observedAt: number, qemuAvailable: () => Promise<boolean>): {
                    acquire(input: unknown): Promise<unknown>;
                    options(input: unknown): Promise<unknown>;
                };
            }>('../../../../../../packages/plugins/machine-lima/src/machine/provider');
            let present = false;
            let nativeName = '';
            const native = () => ({ name: nativeName, dir: `${launch.choices.store}/${nativeName}`, status: 'Running',
                vmType: 'qemu', arch: 'x86_64', cpus: 1, memory: 1_073_741_824, disk: 4_294_967_296,
                config: { images: [{ location: launch.choices.image, arch: 'x86_64' }], mounts: [],
                    ssh: { forwardAgent: false }, containerd: { user: false, system: false } } });
            const capture: LimaExecutor['capture'] = async (_command, args) => ({ exitCode: 0, err: '',
                out: args[0] === '--version' ? 'limactl version 2.1.0'
                    : args[0] === 'info' ? JSON.stringify({ hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] })
                    : present ? JSON.stringify(native()) : '' });
            const executor: LimaExecutor = { capture, run: async (_command, args) => {
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
                machineOverride: { retention: admitted.machine.retention, wakeOnAcceptedMessage: admitted.machine.wakeOnAcceptedMessage },
            });
            expect(configurationFacts).toMatchObject({ launch, optionStatus: 'current', nativeFacts: {
                size: { cpuCores: launch.choices.cpus, memoryBytes: launch.choices.memoryGiB * 2 ** 30,
                    diskBytes: launch.choices.diskGiB * 2 ** 30 }, image: { id: launch.choices.image },
            } });
            const fact = AcquireResultV1Schema.parse(await provider.acquire({ managedId: admitted.machine.id, launch: launch.choices }));
            if (fact.kind !== 'bound') throw new Error(`Lima did not bind: ${fact.kind}`);
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
            expect(mismatched.statusCode, mismatched.body).toBe(401);
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } }))
                .toMatchObject({ allocation: 'may-exist', resource: null });
            const before = await db.account.findMany({ where: { id: { in: [account.id, viewer.id] } }, select: { id: true, seq: true } });
            const reported = await client.reportIssuedAcquireFact(admitted.machine, fact, configurationFacts);
            expect(reported.reviewedFacts).toEqual(configurationFacts);
            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: reported.id } })).admittedInput)
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
            for (const intent of ['stop', 'delete'] as const) {
                const actionId = intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
                if (withdrawal === 'machine-grant') await db.machineAccountGrant.create({ data: {
                    machineId: controller.machineId, accountId: controlActor.id, createdByAccountId: account.id, accessLevel: 'admin',
                } });
                const controlApiToken = withdrawal === 'signed-credential' || withdrawal === 'machine-grant' ? undefined : await auth.createApiToken({
                    accountId: controlActor.id, tokenId: randomUUID(), label: 'Native control completion',
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
                    : { observedAt: Date.now(), availability: 'present', power: 'stopped' };
                const controlReport = { ...correlation, result: { kind: 'confirmed' }, observation };
                expect(await controlClient.post('/v1/machines/managed/controller/submit-intent', correlation,
                    ManagedControllerSubmitOutputV1Schema)).toMatchObject({ submitted: true });
                if (withdrawal === 'machine-grant') await db.machineAccountGrant.deleteMany({
                    where: { machineId: controller.machineId, accountId: controlActor.id },
                });
                else if (!controlApiToken) await auth.signOutEverywhere(account.id);
                else if (withdrawal === 'api-token') await auth.revokeApiToken({ accountId: account.id, tokenId: controlApiToken.tokenId });
                else await auth.updateApiToken({ accountId: account.id, tokenId: controlApiToken.tokenId,
                    grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.managed.get'] } } });
                expect((await mint()).statusCode).toBe(withdrawal === 'machine-grant' ? 409 : withdrawal === 'api-token-grant' ? 403 : 401);
                expect((await signedPost({ ...controlReport, requestId: randomUUID() })).statusCode).toBe(401);
                expect((await signedPost({ ...controlReport, managedId: randomUUID() })).statusCode).toBe(401);
                expect((await signedPost({ ...controlReport, controller: { ...controller, installationId: randomUUID() } })).statusCode).toBe(401);
                expect((await signedPost({ ...controlReport, expectedIntentRevision: correlation.expectedIntentRevision + 1 })).statusCode).toBe(401);
                expect((await signedPost(controlReport, reportPath, tweetnacl.sign.keyPair().secretKey)).statusCode).toBe(401);
                expect((await signedPost(correlation, '/v1/machines/managed/controller/submit-intent')).statusCode).toBe(401);
                const settled = await signedPost(controlReport);
                expect(settled.statusCode, settled.body).toBe(200);
                controlled = ManagedControllerMachineOutputV1Schema.parse(settled.json()).machine;
                expect(controlled).toMatchObject({ desired: intent, observation });
                expect(controlled.submittedNativeEffect).toBeUndefined();
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: controlled.id } }))
                    .toMatchObject({ allocation: intent === 'delete' ? 'confirmed-absent' : 'bound', observation });
            }
        } finally { restoreHttp(); await app.close(); }
    }, 120_000);
});
