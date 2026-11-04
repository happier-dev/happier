import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { MachineServiceAdoptResultV1Schema } from '@happier-dev/protocol/local/services/adoptionV1';
import { ActionsSettingsV1Schema, MachineInstallationIdentityV1Schema,
    MachineServicesDiscoveryResultV1Schema, MachineServicesListResultV1Schema, accountSettingsParse,
    type MachineMetadataFieldReadV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineServicesRuntime } from '@/daemon/local/services/launch/machineServices';
import * as installationStore from '@/daemon/identity/store';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('watched Compose adoption through the Action host', () => {
    it.skipIf(process.platform === 'win32').each([
        { mode: 'plain', bindingFailure: 'before' }, { mode: 'plain', bindingFailure: 'after' },
        { mode: 'e2ee', bindingFailure: 'before' }, { mode: 'e2ee', bindingFailure: 'after' },
    ] as const)('reviews value-free input and continues $mode binding failure $bindingFailure application without changing native custody', async ({ mode, bindingFailure }) => {
        let phase = 'fixture';
        const requests: string[] = [];
        onTestFailed(() => { console.error(`Compose adoption failed during ${phase}; HTTP ${requests.join(', ')}`); });
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-action-'));
        const callsPath = join(root, 'calls.jsonl');
        const composePath = join(root, 'compose.json');
        const dockerPath = join(root, 'docker');
        const ids = ['a'.repeat(64), 'b'.repeat(64)];
        const model = { name: 'existing-production', services: { web: { image: 'example/web:1',
            command: 'connect https://${PASSWORD:-default-private}@example',
            environment: { ODD: 'literal-private', INHERITED: null }, env_file: ['private.env'],
            volumes: [{ type: 'bind', source: join(root, 'data'), target: '/data' }] },
            worker: { image: 'example/worker:1', profiles: ['jobs'] } }, volumes: { state: { name: 'existing-production_state' } } };
        await writeFile(composePath, JSON.stringify(model));
        // Only the external Docker process is replaced. Installed plugin admission,
        // capture, Compose normalization, Action policy/children and P42 stay real.
        await writeFile(dockerPath, `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),ids=${JSON.stringify(ids)};
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({args,profiles:process.env.COMPOSE_PROFILES})+'\\n');
if(args.includes('info'))process.stdout.write(args.includes('{{.ID}}')?'engine-a':JSON.stringify({ID:'engine-a',OSType:'linux',Architecture:'x86_64'}));
else if(args[0]==='ps')process.stdout.write(ids.join('\\n'));
else if(args[0]==='inspect')process.stdout.write(JSON.stringify(ids.map((Id,i)=>({Id,Image:'sha256:'+'c'.repeat(64),Config:{Labels:{'com.docker.compose.project':'existing-production','com.docker.compose.service':i?'worker':'web','com.docker.compose.oneoff':'False','com.docker.compose.project.working_dir':${JSON.stringify(root)},'com.docker.compose.project.config_files':${JSON.stringify(composePath)}}},State:{Status:'running'},Mounts:[],NetworkSettings:{Ports:{}}}))));
else if(args.includes('config')){if(process.env.COMPOSE_PROFILES!=='')process.exit(22);process.stdout.write(JSON.stringify(args.includes('--variables')?{PASSWORD:{Name:'PASSWORD',Required:false,DefaultValue:'default-private'}}:args.includes('--no-env-resolution')?${JSON.stringify(model)}:{services:{web:{environment:{ODD:'literal-private',INHERITED:null,UNUSUAL:'envfile-private'}},worker:{}}}));}
else process.exit(23);
`, { mode: 0o700 });
        vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH ?? ''}`);
        // A real Docker executable does not load Node's source bootstrap hooks.
        vi.stubEnv('NODE_OPTIONS', '');
        const target = { serverId: 'home', machineId: 'machine-a' };
        const adapter = { pluginId: 'happier.machine.services', localId: 'compose' };
        const keyPair = tweetnacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(MachineInstallationIdentityV1Schema.parse({
            version: 1, installationId: 'installation-a', createdAt: 1,
            publicKey: Buffer.from(keyPair.publicKey).toString('base64url'), privateKey: Buffer.from(keyPair.secretKey).toString('base64url') }));
        const context: RpcActionExecutorContext = { authority: 'present_user', surface: 'cli', serverId: 'home',
            serverIdentityId: 'home', runtimeAccountId: 'owner', signal: new AbortController().signal,
            interactivePresentation: 'unavailable', actionCaller: { kind: 'host' },
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
                'machines.services.adopt': ['cli'], 'deployments.environments.create': ['cli'], 'deployments.bindings.set': ['cli'] } }),
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine-a',
                installationId: 'installation-a', role: 'manage', encryptionMode: mode }, verifyMachineAdmissionCurrent: async () => true };
        let metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1, metadata: { displayName: 'Original' } };
        const port: MachineMetadataFieldPortV1 = { read: async () => metadata, compareAndSwap: async input => {
            if (metadata.status !== 'ready') return metadata;
            if (metadata.metadataVersion !== input.expectedMetadataVersion) return { ...metadata, status: 'conflict' };
            metadata = { status: 'ready', metadataVersion: metadata.metadataVersion + 1, metadata: input.metadata };
            return { ...metadata, status: 'applied' };
        } };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => port });
        let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        try {
            fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
                runtimeOptions: { pluginIds: ['happier.machine.services'] } });
            phase = 'discovery';
            const discovered = MachineServicesDiscoveryResultV1Schema.parse(await runtime.execute({
                actionId: 'machines.services.discovery', input: { ...target, adapter }, context }));
            if (discovered.kind !== 'snapshot' || discovered.candidates.length !== 1) throw new Error('Expected native project');
            const candidate = discovered.candidates[0]!;
            phase = 'watch';
            expect(await runtime.execute({ actionId: 'machines.services.watch', context, input: { ...target,
                candidateId: candidate.candidateId, expectedRevision: candidate.revision, lifecyclePurpose: 'deployment' } }))
                .toMatchObject({ kind: 'applied' });
            const listed = MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context }));
            if (listed.kind !== 'snapshot') throw new Error('Expected watch');
            const watched = fixture.registry.projectManagedServices.listMachineServices()[0]!;
            const originalMetadata = structuredClone(metadata);
            const machineKey = new Uint8Array(32).fill(47);
            const credentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
                encryption: mode === 'plain' ? null : { type: 'dataKey', machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey) } };
            const serverHttpBaseUrl = 'https://adoption.test';
            const operation = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
                credentials, serverHttpBaseUrl, isCurrent: async () => true,
                snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                    scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] } }));
            const documents = new Map<string, Record<string, unknown>>();
            const environment = createDeploymentEnvironmentDetailV1();
            environment.environment.id = 'adopted-environment';
            environment.environment.projectSourceId = 'source';
            environment.environment.owner = { kind: 'account', accountId: 'owner' };
            let creates = 0;
            let loseBindingResponse = true;
            const writes: string[] = [];
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
                const row = documents.get(decodeURIComponent(path.split('/').at(-1)!));
                if (row) return { status: 200, data: row };
                throw new Error(`Unexpected HTTP read ${path}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
                expect(url).toBe(`${serverHttpBaseUrl}/v1/artifacts`);
                const mutation = readCarrierMutation(value); const id = String(mutation.id);
                documents.set(id, { ...mutation, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                    encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
            });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const path = new URL(String(request.url)).pathname;
                requests.push(`${request.method} ${path}`);
                if (request.method === 'GET' && path === '/v1/projects/sources/source') return { status: 200, data: { ok: true,
                    canManage: true, source: { id: 'source', revision: 1, name: 'Existing source', owner: { kind: 'account', accountId: 'owner' },
                        audience: [], createdByAccountId: 'owner' } } };
                if (request.method === 'GET' && path === '/v1/projects/source/deployment-defaults') return { status: 200,
                    data: { ok: true, projectSourceId: 'source', sourceRevision: 1, revision: 0, content: null } };
                if (request.method === 'GET' && path === '/v1/deployments/environments/adopted-environment') return { status: 200,
                    data: { ok: true, environment: environment.environment, targetLinks: environment.targetLinks.map(row => row.targetLink) } };
                if (request.method === 'POST' && path === '/v1/deployments/targets/list') return { status: 200, data: { ok: true,
                    items: creates ? [{ environment: environment.environment, targetLink: environment.targetLinks[0]!.targetLink }] : [],
                    nextCursor: null, coverage: 'complete' } };
                if (request.method === 'POST' && path === '/v1/deployments/environments') {
                    creates++; writes.push(path);
                    const input = request.data as { contentArtifactId: string; firstTargetLink: { contentArtifactId: string } };
                    environment.environment.contentArtifactId = input.contentArtifactId;
                    environment.environment.runtimeTargetLinkId = 'native-target';
                    environment.environment.revision = 1;
                    environment.environment.buildMachineId = 'machine-a';
                    const link = environment.targetLinks[0]!.targetLink;
                    link.id = 'native-target'; link.environmentId = environment.environment.id;
                    link.contentArtifactId = input.firstTargetLink.contentArtifactId;
                    return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: 1 } };
                }
                if (request.method === 'POST' && path.endsWith('/secret-launch-admission')) {
                    const installation = { machineId: 'machine-a', installationId: 'installation-a',
                        publicKey: Buffer.from(keyPair.publicKey).toString('base64url') };
                    return { status: 200, data: { ok: true, grants: [],
                        bindingPreparation: { runtimeInstallations: [installation], buildInstallation: installation } } };
                }
                if (request.method === 'POST' && path === '/v1/deployments/environments/adopted-environment/bindings') {
                    if (loseBindingResponse && bindingFailure === 'before') {
                        loseBindingResponse = false;
                        throw new Error('Binding transport failed before application');
                    }
                    writes.push(path);
                    const input = request.data as { contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number };
                    environment.environment.contentArtifactId = input.contentArtifactId;
                    environment.environment.contentHeaderVersion = input.contentHeaderVersion;
                    environment.environment.contentBodyVersion = input.contentBodyVersion;
                    environment.environment.revision++;
                    // HTTP applied the canonical bindings CAS, then lost its reply.
                    // Retry must inspect the retained records under the same Action key.
                    if (loseBindingResponse) { loseBindingResponse = false; throw new Error('Lost binding acknowledgement'); }
                    return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision } };
                }
                throw new Error(`Unexpected HTTP ${request.method} ${path}`);
            });
            const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine-a', resolveAccountId: async () => 'owner' });
            const deps = createDaemonDeploymentActionDeps({ credentials, ...target, serverHttpBaseUrl, savedSecretOperationContext: operation,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
                runActionOperation: operations.runActionOperation,
                readOperation: async operationId => operations.store.get({ accountId: 'owner', machineId: 'machine-a' }, operationId),
                acquirePluginRuntimeRegistryLease: async () => {
                    const lease = pluginReloadController.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Expected active installed runtime');
                    return lease;
                }, runtime: { async acquire() { throw new Error('Adoption cannot acquire native deploy custody'); } } });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps, runActionOperation: operations.runActionOperation });
            const base = { ...target, serviceId: watched.serviceId, expectedGeneration: watched.instanceId, profiles: [], requestKey: 'adopt-once' };
            phase = 'review';
            expect(await executor.execute('machines.services.adopt', { ...target, serviceId: watched.serviceId,
                expectedGeneration: watched.instanceId, requestKey: 'missing-profiles', mode: 'review' }, context))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            const reviewedResult = await executor.execute('machines.services.adopt', { ...base, mode: 'review' }, context);
            expect(reviewedResult).toMatchObject({ ok: true, result: { kind: 'review', originalProfiles: 'unknown', profiles: [] } });
            if (!reviewedResult.ok) throw new Error('Expected adoption review');
            const review = MachineServiceAdoptResultV1Schema.parse(reviewedResult.result);
            if (review.kind !== 'review') throw new Error('Expected review');
            expect(review.variables.map(row => row.name)).toEqual(['INHERITED', 'ODD', 'PASSWORD', 'UNUSUAL']);
            expect(JSON.stringify(review)).not.toMatch(/default-private|literal-private|envfile-private/);
            expect(review.document).not.toContain('env_file');
            expect(documents.size).toBe(0);
            const apply = { ...base, mode: 'apply', reviewedDigest: review.reviewedDigest, bindingsConfirmed: true,
                destination: { projectSourceId: 'source', name: 'Adopted', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' },
                bindings: review.variables.map(row => ({ purpose: 'variable', name: row.name, phase: row.phase, source: { kind: 'value', value: 'confirmed-public' } })) };
            phase = 'protected adoption approval';
            const approvals: unknown[] = [];
            const reviewExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                approvalsCreate: async ({ request }) => { approvals.push(request); return { artifactId: 'adoption-review' }; } });
            const queued = await reviewExecutor.execute('machines.services.adopt', { ...apply, requestKey: 'approval-preview' }, {
                ...context, surface: 'agent', authority: 'account_automation', interactivePresentation: undefined,
                actionRequestId: 'adoption-preview-request',
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
            });
            expect(queued, JSON.stringify(queued)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(approvals).toMatchObject([{ preview: { hostReviewedContent: review } }]);
            expect(JSON.stringify(approvals)).not.toMatch(/default-private|literal-private|envfile-private/);
            expect(creates).toBe(0);
            phase = 'binding refusal';
            expect(await executor.execute('machines.services.adopt', { ...apply, bindings: [] }, context))
                .toMatchObject({ ok: false, errorCode: 'secret_binding_required' });
            expect(await executor.execute('machines.services.adopt', { ...apply, bindingsConfirmed: false }, context))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            expect(creates).toBe(0);
            phase = 'apply and lost binding response';
            const composeCalls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n')
                .map(line => JSON.parse(line) as { args: string[] }).filter(call => call.args.includes('config')).length;
            const beforeApply = await composeCalls();
            expect(await executor.execute('machines.services.adopt', apply, context)).toMatchObject({ ok: true,
                result: { kind: 'partial', environmentId: 'adopted-environment', targetLinkId: 'native-target', errorCode: 'outcome_unknown' } });
            expect(await composeCalls() - beforeApply).toBe(3);
            phase = 'same request continuation';
            const result = await executor.execute('machines.services.adopt', apply, context);
            expect(result).toMatchObject({ ok: true, result: { kind: 'adopted', environmentId: 'adopted-environment', targetLinkId: 'native-target' } });
            expect(await executor.execute('machines.services.adopt', apply, context)).toEqual(result);
            phase = 'new request existing native link';
            expect(await executor.execute('machines.services.adopt', { ...apply, requestKey: 'adopt-existing' }, context)).toEqual(result);
            phase = 'protected stored content';
            const store = createCredentialedAccountArtifactStore(credentials);
            const environmentArtifact = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.read(environment.environment.contentArtifactId,
                { prepareRecipients: false, includeSharedAudience: false }));
            if (!environmentArtifact || typeof environmentArtifact.body !== 'string') throw new Error('Expected opened Environment content');
            const content = DeploymentEnvironmentContentV1Schema.parse(JSON.parse(environmentArtifact.body));
            expect(content.definition).toMatchObject({ kind: 'stored', contentRevision: 1, profiles: [] });
            expect(content.bindings).toEqual(apply.bindings);
            const originId = environment.targetLinks[0]!.targetLink.contentArtifactId;
            const originArtifact = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => store.read(originId,
                { prepareRecipients: false, includeSharedAudience: false }));
            if (!originArtifact || typeof originArtifact.body !== 'string') throw new Error('Expected opened native origin');
            expect(JSON.parse(originArtifact.body)).toMatchObject({ nativeOrigin: { projectName: 'existing-production', dockerEndpoint: 'engine-a',
                workingDirectory: root, capture: { installationId: 'installation-a' } } });
            expect(documents.get(originId)).toMatchObject({ encryptionMode: mode });
            if (mode === 'e2ee') expect(JSON.stringify(documents.get(originId))).not.toContain('existing-production');
            expect(creates).toBe(1);
            expect(writes).toEqual(['/v1/deployments/environments', '/v1/deployments/environments/adopted-environment/bindings']);
            expect(metadata).toEqual(originalMetadata);
            expect(await runtime.execute({ actionId: 'machines.services.list', input: target, context }))
                .toMatchObject({ kind: 'snapshot', services: [{ authority: 'machine' }] });
            const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; profiles?: string });
            expect(calls.filter(call => call.args.some(arg => ['start', 'stop', 'restart', 'up', 'down', 'run', 'build', 'pull'].includes(arg)))).toEqual([]);
            expect(calls.some(call => call.args.includes('--no-interpolate') && call.args.includes('--no-env-resolution') && call.profiles === '')).toBe(true);
        } finally { await runtime.dispose(); await fixture?.dispose(); await rm(root, { recursive: true, force: true }); }
    });
});
