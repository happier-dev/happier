import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { authRoutes } from './authRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { machinesRoutes } from '../machines/machinesRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { createFileHomeConnectionDescriptorContinuityStore } from '@/app/features/homeConnectionDescriptorContinuity';
import { readHomeConnectionDescriptor } from '@/app/features/homeConnectionDescriptorPublication';
import { seedCliTokenOnlyAuthForServer, seedCliDataKeyAuthForServer } from '../../../../../../../packages/tests/src/testkit/cliAuth';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import tweetnacl from 'tweetnacl';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { terminateProcessTreeByPid } from '../../../../../../../packages/tests/src/testkit/process/processTree';

describe('remote managed enrollment through real CLI processes and Home', () => {
    let harness: LightSqliteHarness;
    const requests: Array<{ path: string; status: number }> = [];
    let claimUnavailable = false;
    let claimReset = false;
    let injectedClaimResets = 0;
    let registrationUnavailable = false;
    let registrationUnavailableOnce = false;
    let accountModeUnavailableOnce = false;
    let authenticatedFeaturesUnavailableOnce = false;
    let successfulClaims = 0;
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-qb73-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_qb73_home', TERMINAL_AUTH_REQUEST_TTL_SECONDS: '60' } });
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
        // Inject Home unavailability at its HTTP boundary; keep claim, approval,
        // registration and both real CLI processes unchanged beneath it.
        app.addHook('onRequest', async (request, reply) => {
            if ((registrationUnavailable || registrationUnavailableOnce) && request.method === 'POST' && request.url === '/v1/machines') {
                registrationUnavailableOnce = false;
                return reply.code(503).send({ error: 'database_transaction_conflict_exhausted', message: 'private-registration-response', token: 'private-registration-token' });
            }
            if (accountModeUnavailableOnce && successfulClaims === 2 && request.url === '/v1/account/encryption') {
                accountModeUnavailableOnce = false;
                return reply.code(503).send({ error: 'database_connection_unavailable' });
            }
            if (authenticatedFeaturesUnavailableOnce && successfulClaims > 0 && request.url === '/v1/features/authenticated') {
                authenticatedFeaturesUnavailableOnce = false;
                return reply.code(503).send({ error: 'database_connection_unavailable' });
            }
            if (claimReset && request.url === '/v1/auth/request/claim') {
                injectedClaimResets++;
                request.raw.socket.destroy();
                return reply;
            }
            if (claimUnavailable && request.url === '/v1/auth/request/claim') {
                return reply.code(503).send({ error: 'unavailable' });
            }
        });
        app.addHook('onResponse', async (request, reply) => {
            if (request.url === '/v1/auth/request/claim' && reply.statusCode === 200) successfulClaims++;
            requests.push({ path: request.url.split('?')[0]!, status: reply.statusCode });
        });
        enableAuthentication(app);
        authRoutes(app); machinesRoutes(app); registerAccountEncryptionRoutes(app); registerAccountProfileRoute(app);
        featuresRoutes(app, { homeConnectionDescriptorContinuityStore: createFileHomeConnectionDescriptorContinuityStore(join(harness.baseDir, 'descriptor.json')) });
        await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);
    afterAll(async () => { await app.close(); if (harness) await harness.close(); });

    it.each(['current', 'current-e2ee', 'retired', 'misbound-approval', 'expired-consent', 'claim-unavailable', 'claim-reset', 'wait-process-killed', 'registration-unavailable', 'registration-transient', 'registration-transient-e2ee', 'post-claim-features-transient', 'retry-after-partial'] as const)('enrolls only the current exact admission (%s)', async admission => {
        const succeeds = ['current', 'current-e2ee', 'registration-transient', 'registration-transient-e2ee', 'post-claim-features-transient', 'retry-after-partial'].includes(admission);
        const e2ee = admission === 'current-e2ee' || admission === 'registration-transient-e2ee';
        claimUnavailable = admission === 'claim-unavailable';
        claimReset = admission === 'claim-reset';
        injectedClaimResets = 0;
        registrationUnavailable = admission === 'registration-unavailable' || admission === 'retry-after-partial';
        registrationUnavailableOnce = admission === 'registration-transient' || admission === 'registration-transient-e2ee';
        accountModeUnavailableOnce = false;
        authenticatedFeaturesUnavailableOnce = admission === 'post-claim-features-transient';
        successfulClaims = 0;
        requests.length = 0;
        const beforeRequestIds = new Set((await db.terminalAuthRequest.findMany({ select: { id: true } })).map(request => request.id));
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('missing test listener');
        const endpoint = `http://127.0.0.1:${address.port}`;
        // Distinct canonical audience and application route, as in the QA forward.
        process.env.HAPPIER_CANONICAL_SERVER_URL = `http://localhost:${address.port}`;
        process.env.HAPPIER_PUBLIC_SERVER_URL = endpoint;
        const descriptor = await readHomeConnectionDescriptor({ visibility: 'authenticated',
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(join(harness.baseDir, 'descriptor.json')) });
        expect(descriptor).toBeDefined();
        const contentKeys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: e2ee
            ? { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(contentKeys.publicKey) }
            : { encryptionMode: 'plain' } });
        const token = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const controllerHome = join(harness.baseDir, `controller-${admission}`);
        const guestHome = join(harness.baseDir, `guest-${admission}`);
        await mkdir(guestHome, { recursive: true });
        const seeded = e2ee
            ? await seedCliDataKeyAuthForServer({ cliHome: controllerHome, serverUrl: endpoint, token, machineKey: contentKeys.secretKey })
            : await seedCliTokenOnlyAuthForServer({ cliHome: controllerHome, serverUrl: endpoint, token });
        const settingsPath = join(controllerHome, 'settings.json');
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
        settings.servers[seeded.serverId].homeConnectionDescriptor = descriptor;
        await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
        const controller = { machineId: seeded.machineId, installationId: randomUUID() };
        const controllerKeys = tweetnacl.sign.keyPair();
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, installationId: controller.installationId,
            installationPublicKey: Buffer.from(controllerKeys.publicKey), pluginMaterializationRevision: BigInt(1), metadata: '{}' } });
        const launch = defineProtocolObject({}, { policy: 'closed' });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.compute', version: '1.0.0', displayName: 'Enrollment fixture',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
                    launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' }, surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: descriptor!.homeServerIdentityId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const resource = { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1, value: { id: 'retained' } };
        const row = await db.managedMachine.create({ data: { homeId: descriptor!.homeServerIdentityId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: admission === 'retired' ? 'canceled' : 'active',
            resource, launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const root = fileURLToPath(new URL('../../../../../../../', import.meta.url));
        const runController = () => new Promise<{ status: number; stdout: string; stderr: string }>((resolveResult, reject) => {
            const runtime = process.env.HAPPIER_TEST_REMOTE_ENROLLMENT_RUNTIME ?? process.execPath;
            const child = spawn(runtime, ['--conditions=happier-source', ...(runtime === process.execPath ? ['--import', 'tsx'] : []),
                resolve(root, 'apps/cli/src/testkit/process/fixtures/remoteEnrollmentController.ts')], {
                cwd: resolve(root, 'apps/cli'), stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, DATABASE_URL: undefined, DATABASE_URL_DIRECT: undefined,
                    HAPPIER_HOME_DIR: controllerHome, HAPPIER_SERVER_URL: endpoint,
                    TSX_TSCONFIG_PATH: resolve(root, 'apps/cli/tsconfig.json') },
            });
            const stdout: Buffer[] = [], stderr: Buffer[] = [];
            onTestFinished(async context => {
                if (context.task.result?.state === 'fail') console.log({ requests, controllerOutput: Buffer.concat(stdout).toString('utf8'), controllerError: Buffer.concat(stderr).toString('utf8') });
                if (child.exitCode === null && child.pid) await terminateProcessTreeByPid(child.pid);
            });
            child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
            child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
            child.on('error', reject);
            child.on('close', status => resolveResult({ status: status ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
            child.stdin.end(JSON.stringify({ descriptor, guestHome, guestEntrypoint: process.env.HAPPIER_TEST_REMOTE_ENROLLMENT_ENTRYPOINT,
                guestExecutable: process.env.HAPPIER_TEST_REMOTE_ENROLLMENT_EXECUTABLE,
                killWaitProcess: admission === 'wait-process-killed',
                observeWaitDiagnostic: admission === 'registration-unavailable',
                // The server's supported minimum policy is the old effective
                // cutoff in this fixture. Use real wall time and CLI processes.
                ...(admission === 'expired-consent' ? { approvalDelayMs: 61_000 } : {}),
                misbind: admission === 'misbound-approval', correlation: { homeId: descriptor!.homeServerIdentityId,
                managedId: row.id, requestId: row.admittedActionRequestId, expectedIntentRevision: row.intentRevision, controller, resource } }));
        });
        let result = await runController();
        if (admission === 'retry-after-partial') {
            expect(result.status).toBe(1);
            expect(JSON.parse(result.stdout).operation.error.error).toContain('AUTH_WAIT_HOME_UNAVAILABLE');
            expect(requests).toContainEqual({ path: '/v1/auth/request/claim', status: 200 });
            expect(requests).toContainEqual({ path: '/v1/machines', status: 503 });
            const partialSettings = JSON.parse(await readFile(join(guestHome, 'settings.json'), 'utf8'));
            const partialMachineIds = Object.values(partialSettings.machineIdByServerId ?? {});
            expect(partialMachineIds).toHaveLength(1);
            expect(await db.machine.count({ where: { accountId: account.id } })).toBe(1);
            // The product starts a fresh bootstrap against the same retained
            // guest and admission. Do not reset guest state between attempts.
            registrationUnavailable = false;
            accountModeUnavailableOnce = true;
            result = await runController();
            expect(successfulClaims).toBe(2);
            expect(requests).toContainEqual({ path: '/v1/account/encryption', status: 503 });
            const retriedSettings = JSON.parse(await readFile(join(guestHome, 'settings.json'), 'utf8'));
            expect(Object.values(retriedSettings.machineIdByServerId ?? {})).toEqual(partialMachineIds);
        }
        if (admission !== 'claim-reset') {
            expect(result.stdout, JSON.stringify(requests)).toContain(succeeds ? '"ok":true' : ['retired', 'claim-unavailable', 'wait-process-killed', 'registration-unavailable'].includes(admission) ? 'auth wait' : admission === 'expired-consent' ? 'auth_request_expired' : 'approval_wiring_failed');
        }
        expect(result.status, result.stdout).toBe(succeeds ? 0 : 1);
        if (admission !== 'misbound-approval') {
            const outcome = JSON.parse(result.stdout);
            expect(outcome.task.ok).toBe(succeeds);
            expect(outcome.operation.state).toBe(succeeds ? 'succeeded' : 'failed');
            if (admission === 'retired') expect(outcome.operation.error.error).toMatch(/auth wait \(exit 1; code ERR_BAD_REQUEST; category http_error; HTTP 409\)/u);
            if (admission === 'claim-unavailable') {
                expect(outcome.operation.error.error).toMatch(/code AUTH_WAIT_HOME_UNAVAILABLE; category http_error; HTTP 503/u);
                expect(requests).toContainEqual({ path: '/v1/auth/request/claim', status: 503 });
            }
            if (admission === 'registration-unavailable') {
                expect(outcome.waitDiagnostic).toEqual({ v: 1, ok: false, kind: 'auth_wait', code: 'AUTH_WAIT_HOME_UNAVAILABLE', status: 503 });
                expect(requests).toContainEqual({ path: '/v1/auth/request/claim', status: 200 });
                expect(requests).toContainEqual({ path: '/v1/machines', status: 503 });
                expect(outcome.operation.error.error).toContain('code AUTH_WAIT_HOME_UNAVAILABLE; category http_error; HTTP 503');
                expect(outcome.operation.error.error).toContain('server code database_transaction_conflict_exhausted');
                expect(JSON.stringify(outcome)).not.toMatch(/private-registration-response|private-registration-token/);
                expect(outcome.operation.error.error).not.toMatch(/diagnostic invalid|AUTH_WAIT_PROCESS_FAILED/);
            }
            if (admission === 'registration-transient' || admission === 'registration-transient-e2ee') {
                expect(requests.filter(request => request.path === '/v1/auth/request/claim')).toEqual([{ path: '/v1/auth/request/claim', status: 200 }]);
                expect(requests.filter(request => request.path === '/v1/machines')).toEqual([
                    { path: '/v1/machines', status: 503 }, { path: '/v1/machines', status: 200 },
                ]);
            }
            if (admission === 'post-claim-features-transient') {
                expect(requests.filter(request => request.path === '/v1/auth/request/claim')).toHaveLength(1);
                const postClaimRequests = requests.slice(requests.findIndex(request => request.path === '/v1/auth/request/claim') + 1);
                const registrationIndex = postClaimRequests.findIndex(request => request.path === '/v1/machines');
                expect(registrationIndex).toBeGreaterThanOrEqual(0);
                expect(postClaimRequests.slice(0, registrationIndex).filter(request => request.path === '/v1/features/authenticated')).toEqual([
                    { path: '/v1/features/authenticated', status: 503 }, { path: '/v1/features/authenticated', status: 200 },
                ]);
            }
            if (admission === 'wait-process-killed') {
                expect(outcome.operation.error.error).toContain('code AUTH_WAIT_PROCESS_FAILED');
                expect(outcome.operation.error.error).not.toContain('DIAGNOSTIC_UNAVAILABLE');
            }
            if (admission === 'claim-reset') {
                expect(injectedClaimResets).toBeGreaterThan(0);
                expect(outcome.task.error).toMatchObject({ code: 'home_not_guest_reachable' });
                expect(outcome.operation.error).toMatchObject({ errorCode: 'home_not_guest_reachable' });
            }
            if (admission === 'expired-consent') {
                expect(outcome.operation.error.error).toContain('Retry');
                expect(outcome.lateConsent).toEqual({ rejected: true, waitStatus: 1, waitCode: 'AUTH_REQUEST_EXPIRED' });
            }
        }
        const pending = await db.terminalAuthRequest.findMany();
        // Creating a fresh request may prune expired earlier scenarios. Count
        // this invocation's new row without depending on global retention.
        const newPending = pending.filter(request => !beforeRequestIds.has(request.id));
        if (admission === 'retry-after-partial') {
            // The second request can prune the expired first attempt.
            expect(newPending.length).toBeGreaterThanOrEqual(1);
            expect(newPending.length).toBeLessThanOrEqual(2);
        } else expect(newPending).toHaveLength(1);
        const ownPending = pending.find(request => request.responseAccountId === account.id);
        if (admission === 'misbound-approval' || admission === 'expired-consent') expect(ownPending).toBeUndefined();
        else {
            expect(ownPending).toBeDefined();
            if (admission === 'claim-unavailable' || admission === 'claim-reset' || admission === 'wait-process-killed') expect(ownPending?.claimedAt).toBeNull();
            else expect(ownPending?.claimedAt).not.toBeNull();
        }
        expect(await db.machine.count({ where: { accountId: account.id } })).toBe(succeeds ? 2 : 1);
        const retained = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
        if (succeeds) expect(retained.enrolledMachineId).toEqual(expect.any(String));
        else expect(retained.enrolledMachineId).toBeNull();
    }, 600_000);
});
