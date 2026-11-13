import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { createActionExecutor, buildActionExecuteResultFromRecordedApprovalExecution } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { MachineServicesListResultV1Schema, ManagedServiceNativeLogResultV1Schema,
    DeploymentEnvironmentAccessInputV1Schema, DeploymentEnvironmentAccessResultV1Schema,
    DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentListResultV1Schema, DeploymentReceiptGetResultV1Schema } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import axios from 'axios';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { delimiter } from 'node:path';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DeploymentContentV1Schema, createDeploymentReceiptArtifactHeaderV1,
    EnvironmentSecretLaunchAdmissionInputV1Schema, computeEnvironmentSecretLaunchAdmissionDigestV1,
    type DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { resolveOwnServerDeploymentIdentityForHost } from '@/deployments/targets/ownServer/paths';
import { captureOwnServerDeploymentSource } from '@/deployments/targets/ownServer/sourceProvenance';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createNativeComposeLifecycle, type NativeComposeEnvironmentProject } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { produceEnvironmentProjectServices } from '@/daemon/local/services/launch/projectDeclarations';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createStablePluginExecService, createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import * as installationStore from '@/daemon/identity/store';
import * as credentialStore from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

it('serves Machine service Actions and accepted Project Starts through the installed Api lifecycle and existing RPC registration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-api-machine-services-'));
    const previous = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
        activeServerId: configuration.activeServerId, serversDir: configuration.serversDir };
    Object.assign(configuration, { happyHomeDir: home, settingsFile: join(home, 'settings.json'), serversDir: join(home, 'servers') });
    const owner = createManagedServicesOwner({
        processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
        dependencies: () => { throw new Error('No installed native adapter is required for saved intent'); }, resolveScope: scope => scope,
    });
    let client: ApiMachineClient | undefined;
    const services = createLocalServicesDaemonRuntime({ machineId: 'machine', accountId: 'owner', startLoop: false,
        inventoryEnabled: () => true, projectManagedServices: owner, runTargets: () => [],
        scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }) });
    try {
        const profile = await addServerProfile({ name: 'services', serverUrl: 'https://services.invalid', webappUrl: 'https://services.invalid' });
        const target = { serverId: 'srv_machine_services', machineId: 'machine' };
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: target.serverId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        configuration.activeServerId = profile.id;
        const watch = { v: 1 as const, watchId: 'saved-watch', name: 'Saved worker', adapter: {
            pluginId: 'acme.unavailable', localId: 'native' }, nativeResourceId: 'worker.service', lifecyclePurpose: 'deployment' as const };
        const machine: Machine = { id: target.machineId, encryptionMode: 'plain', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
            metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier',
                displayName: 'Preserved', serviceWatchesV1: { v: 1, watches: [watch] } } };
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        client = new ApiMachineClient(token, machine);
        let writes = 0;
        // Socket transport is the only substituted boundary. The actual metadata
        // codec, CAS, façade, Action executor and registration stay real.
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, raw) => {
            if (event !== 'machine-update-metadata') throw new Error('Unexpected transport effect');
            writes++;
            const request = raw as { metadata: string; expectedVersion: number };
            return { result: 'success', version: request.expectedVersion + 1, metadata: request.metadata };
        } });
        Reflect.set(client, 'socket', socket);
        const installed = client;
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null }, mode: 'plain', ctx: null,
            sessionId: 'cli-global', serverId: target.serverId, serverHttpBaseUrl: profile.serverUrl,
            machineActionDirectTargetTransport: { machineId: target.machineId,
                machineServiceAction: request => installed.executeMachineServiceAction(request),
                invoke: async () => { throw new Error('Service Action must not re-enter Machine RPC'); } },
        });
        let currentExecutor = executor;
        client.registerLocalServicesRoutes({ machineId: target.machineId, serverId: profile.id, accountId: 'owner',
            projectManagedServices: owner, localServicesLauncher: services.launcherRoutes,
            localServicesInventory: services.inventoryRoutes, resolveLauncherActionExecutor: async () => currentExecutor });
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const start = client.observeActionExecution({ actionId: 'localServices.launcher.start', input: {},
            rpcContext: { machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: target.machineId,
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true },
            execute: async operation => {
            operation.operationOwnerUpdate.update({ state: 'running', domainRef: { kind: 'projectService', purpose: 'start',
                sourceWorkspace: { serverId: target.serverId, refId: 'checkout' },
                workspace: { ...target, workspaceId: 'checkout', rootPath: home },
                declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'worker' } } } });
            enter(); await gate; return { ok: true, result: {} };
        } });
        try {
            await Promise.race([entered, start.then(result => {
                throw new Error('Start settled before its preparation observation: ' + JSON.stringify(result));
            })]);
            const pending = LocalServiceLauncherSnapshotV1Schema.parse(await services.launcherRoutes.getSnapshot({ scope: 'machine', discovery: 'cached' }));
            expect(pending.targets).toEqual([expect.objectContaining({ state: 'starting', serviceState: 'starting',
                machineId: target.machineId, workspaceId: 'checkout' })]);
            expect((await services.launcherRoutes.getSnapshot({ scope: 'machine', projection: 'managed_bindings' })).targets).toEqual([]);
        } finally { release(); await start; }
        // Active profile focus is not the captured daemon's Home identity.
        configuration.activeServerId = 'unrelated-profile';
        const method = getActionSpec('machines.services.list').bindings?.rpcMethod;
        if (!method) throw new Error('Missing canonical Machine-service RPC binding');
        const received = await client.invokeLocalMachineAction(method, target);
        expect(received).toMatchObject({ kind: 'snapshot' });
        const listed = MachineServicesListResultV1Schema.parse(received);
        expect(listed).toMatchObject({ kind: 'snapshot', services: [{ serviceId: watch.watchId, authority: 'machine',
            state: 'unknown', lifecyclePurpose: 'deployment' }] });
        const memberToken = `e30.${Buffer.from(JSON.stringify({ sub: 'member' })).toString('base64url')}.signature`;
        const memberExecutor = createCliActionExecutor({ token: memberToken, credentials: { token: memberToken, encryption: null },
            mode: 'plain', ctx: null, sessionId: 'member-cli', serverId: target.serverId, serverHttpBaseUrl: profile.serverUrl,
            machineActionDirectTargetTransport: { machineId: target.machineId,
                machineServiceAction: request => installed.executeMachineServiceAction(request),
                invoke: async () => { throw new Error('Service Action must not re-enter Machine RPC'); } },
        });
        currentExecutor = memberExecutor;
        const sharedList = await client.invokeLocalMachineAction(method, target, { rpcContext: {
            machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: target.machineId,
                installationId: 'installation', role: 'use', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true,
        } });
        expect(sharedList).toMatchObject({ kind: 'snapshot', services: [{ serviceId: watch.watchId }] });
        currentExecutor = executor;
        if (listed.kind !== 'snapshot' || !listed.services[0]?.watchRevision) throw new Error('Expected retained watch revision');
        const unwatchMethod = getActionSpec('machines.services.unwatch').bindings?.rpcMethod;
        if (!unwatchMethod) throw new Error('Missing canonical Unwatch RPC binding');
        expect(await client.invokeLocalMachineAction(unwatchMethod, { ...target, watchId: watch.watchId,
            expectedRevision: listed.services[0].watchRevision }, { rpcContext: {
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: target.machineId,
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true,
        } })).toMatchObject({ kind: 'applied' });
        expect(writes).toBe(1);
        expect(client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadata: {
            displayName: 'Preserved', serviceWatchesV1: { v: 1, watches: [] } } });
        await client.shutdown();
        expect(await client.executeMachineServiceAction({ actionId: 'machines.services.list', input: target,
            context: { surface: 'cli', authority: 'present_user' }, canReadEnvironment: async () => false, requesterAccountId: 'owner' }))
            .toMatchObject({ ok: false, errorCode: 'admission_unavailable',
                failureCause: { phase: 'service.runtime.closed', errorCode: 'admission_unavailable' } });
        client = undefined;
    } finally {
        await client?.shutdown();
        await services.stop();
        await owner.dispose();
        Object.assign(configuration, previous);
        await rm(home, { recursive: true, force: true });
    }
});

it('preserves the public service failure cause and retries an incomplete installed Home inventory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-api-service-inventory-'));
    const previous = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
        activeServerId: configuration.activeServerId, serversDir: configuration.serversDir,
        installationIdentityFile: configuration.installationIdentityFile };
    Object.assign(configuration, { happyHomeDir: home, settingsFile: join(home, 'settings.json'),
        serversDir: join(home, 'servers'), installationIdentityFile: join(home, 'installation-identity.json') });
    let client: ApiMachineClient | undefined;
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    const inventory = (complete: boolean) => DeploymentEnvironmentListResultV1Schema.parse({ ok: true,
        items: [], nextCursor: null, ...(complete ? { coverage: 'complete', runtimeTargetLinks: [] } : {}) });
    let complete = false;
    try {
        const profile = await addServerProfile({ name: 'service-inventory', serverUrl: 'https://service-inventory.invalid',
            webappUrl: 'https://service-inventory.invalid' });
        const target = { serverId: 'srv_service_inventory', machineId: 'machine' };
        configuration.activeServerId = profile.id;
        await installationStore.readOrCreateInstallationIdentity();
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        await credentialStore.writeStoredCredentialsForServerId(profile.id, credentials);
        const respond = (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'owner' }) };
            if (path === '/v1/account/encryption') return { status: 200,
                data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) };
            if (path === '/v1/deployments/environments') return { status: 200, data: inventory(complete) };
            throw new Error(`Unexpected service inventory HTTP request: ${path}`);
        };
        // HTTP and the socket are genuine external boundaries. The installed
        // identity, credential store, restoration, RPC and Action owners stay real.
        vi.spyOn(axios, 'request').mockImplementation(async request => respond(request.url!));
        vi.spyOn(axios, 'get').mockImplementation(async url => respond(String(url)));
        fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        const machine: Machine = { id: target.machineId, encryptionMode: 'plain', metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0, metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev',
                homeDir: home, happyHomeDir: home, serviceWatchesV1: { v: 1, watches: [] } } };
        client = await runWithServerHttpBaseUrl(profile.serverUrl, () => new ApiMachineClient(token, machine));
        Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true }));
        const installed = client;
        const executor = createCliActionExecutor({ token, credentials, mode: 'plain', ctx: null,
            sessionId: 'cli-global', serverId: target.serverId, serverHttpBaseUrl: profile.serverUrl,
            machineActionDirectTargetTransport: { machineId: target.machineId,
                machineServiceAction: request => installed.executeMachineServiceAction(request),
                invoke: async () => { throw new Error('Service Action must use its installed owner'); } },
        });
        client.registerLocalServicesRoutes({ machineId: target.machineId, serverId: profile.id, accountId: 'owner',
            projectManagedServices: fixture.registry.projectManagedServices, resolveLauncherActionExecutor: async () => executor });
        const method = getActionSpec('machines.services.list').bindings?.rpcMethod;
        if (!method) throw new Error('Missing canonical Machine-service RPC binding');
        expect(await client.invokeLocalMachineAction(method, target)).toMatchObject({ ok: false,
            failureCause: { phase: 'service.home_identity', errorClass: 'Error', errorCode: 'admission_unavailable' } });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: target.serverId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        expect(await client.invokeLocalMachineAction(method, target)).toMatchObject({ ok: false,
            failureCause: { phase: 'service.environment_inventory', errorClass: 'Error', errorCode: 'admission_unavailable' } });
        complete = true;
        expect(await client.invokeLocalMachineAction(method, target)).toMatchObject({ kind: 'snapshot', services: [] });
    } finally {
        await client?.shutdown();
        await fixture?.dispose();
        vi.restoreAllMocks();
        Object.assign(configuration, previous);
        await rm(home, { recursive: true, force: true });
    }
});

it('adopts saved Machine services on registration and adapter installation, detaching metadata removal and shutdown without native Stop', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-api-machine-service-observation-'));
    const previous = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
        activeServerId: configuration.activeServerId, serversDir: configuration.serversDir };
    Object.assign(configuration, { happyHomeDir: home, settingsFile: join(home, 'settings.json'), serversDir: join(home, 'servers') });
    const nativeState = join(home, 'native.json');
    let client: ApiMachineClient | undefined;
    let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    let replacement: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    try {
        const profile = await addServerProfile({ name: 'observed-services', serverUrl: 'https://observed-services.invalid', webappUrl: 'https://observed-services.invalid' });
        const target = { serverId: 'srv_observed_services', machineId: 'machine' };
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: target.serverId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        configuration.activeServerId = profile.id;
        await writeFile(nativeState, JSON.stringify({ inspect: 0, stop: 0 }));
        const pluginId = 'acme.api-machine-services';
        const contributes = { projectNativeAdapters: [{ id: 'native', files: ['native.json'], roles: ['nativeServiceLifecycle'] }] };
        const files = { 'daemon.mjs': `import { readFile, writeFile } from 'node:fs/promises';
                    const path = ${JSON.stringify(nativeState)};
                    async function count(key) { const value = JSON.parse(await readFile(path, 'utf8')); value[key]++; await writeFile(path, JSON.stringify(value)); }
                    export function activate(api) { api.projectNativeAdapters.register('native', { nativeServiceLifecycle: {
                        async inspect() { await count('inspect'); return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                        async stop() { await count('stop'); return { status: 'stopped' }; }
                    } }); }` };
        fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId, contributes }), files }] });
        const owner = fixture.lease.registry.projectManagedServices;
        const watch = { v: 1 as const, watchId: 'observed-watch', name: 'Observed worker', adapter: { pluginId, localId: 'native' },
            nativeResourceId: 'worker.service', lifecyclePurpose: 'infrastructure' as const };
        const machine: Machine = { id: target.machineId, encryptionMode: 'plain', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
            metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: home, happyHomeDir: home,
                serviceWatchesV1: { v: 1, watches: [watch] } } };
        client = new ApiMachineClient('token', machine);
        Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
            const request = raw as { metadata: string; expectedVersion: number };
            return { result: 'success', version: request.expectedVersion + 1, metadata: request.metadata };
        } }));
        const routes = { machineId: target.machineId, serverId: profile.id, projectManagedServices: owner };
        client.registerLocalServicesRoutes(routes);
        client.registerLocalServicesRoutes(routes);
        await vi.waitFor(() => expect(owner.listMachineServices()).toHaveLength(1));
        expect(owner.listMachineServices()[0]?.serverId).toBe(target.serverId);
        expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ inspect: 1, stop: 0 });
        const first = owner.listMachineServices()[0];
        for (let index = 0; index < 3; index++) await client.updateMachineMetadata(current => ({ ...current!, displayName: `Name ${index}` }));
        expect(owner.listMachineServices()[0]).toBe(first);
        expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ inspect: 1, stop: 0 });
        await client.updateMachineMetadata(current => ({ ...current!, serviceWatchesV1: { v: 1, watches: [] } }));
        await vi.waitFor(() => expect(owner.listMachineServices()).toHaveLength(0));
        await client.updateMachineMetadata(current => ({ ...current!, serviceWatchesV1: { v: 1, watches: [watch] } }));
        await vi.waitFor(() => expect(owner.listMachineServices()).toHaveLength(1));
        const installedPluginId = 'acme.new-api-machine-services';
        const installedWatch = { ...watch, watchId: 'installed-watch', nativeResourceId: 'new-worker.service',
            adapter: { pluginId: installedPluginId, localId: 'native' } };
        await client.updateMachineMetadata(current => ({ ...current!, serviceWatchesV1: { v: 1, watches: [watch, installedWatch] } }));
        expect(owner.listMachineServices().find(handle => handle.watch.watchId === installedWatch.watchId)).toBeUndefined();
        const installedState = join(home, 'installed-native.json');
        await writeFile(installedState, JSON.stringify({ inspect: 0, stop: 0 }));
        // Real daemon readers release their old registry lease after a call.
        // Do not let fixture custody hide predecessor disposal at publication.
        await fixture.lease.release();
        // Use the whole canonical authored install/publication producer, not a
        // hand-built partial registry. The saved unknown watch must wake now.
        replacement = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: installedPluginId, contributes }),
                files: { 'daemon.mjs': files['daemon.mjs'].replace(JSON.stringify(nativeState), JSON.stringify(installedState)) } }] });
        const replacementOwner = replacement.registry.projectManagedServices;
        await vi.waitFor(() => expect(replacementOwner.listMachineServices().find(handle => handle.watch.watchId === installedWatch.watchId))
            .toMatchObject({ serverId: target.serverId, machineId: target.machineId }));
        await client.shutdown();
        expect(replacementOwner.listMachineServices()).toHaveLength(0);
        expect(JSON.parse(await readFile(installedState, 'utf8'))).toEqual({ inspect: 1, stop: 0 });
        expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ stop: 0 });
        client = undefined;
    } finally {
        await client?.shutdown();
        await replacement?.dispose();
        await fixture?.dispose();
        Object.assign(configuration, previous);
        await rm(home, { recursive: true, force: true });
    }
});

it.each(['current', 'full-key', 'missing-grant', 'keyless-basis', 'restoration', 'substituted-grant', 'live-establishment',
    'activation-handoff', 'restoration-activation-handoff', 'activation-up-wait', 'closed-capture-reactivation'] as const)(
    'keeps native deployment log disclosure bound to %s custody', async custody => {
    const home = await mkdtemp(join(tmpdir(), 'happier-api-generation-restart-'));
    const previous = { happyHomeDir: configuration.happyHomeDir, settingsFile: configuration.settingsFile,
        activeServerId: configuration.activeServerId, serversDir: configuration.serversDir };
    Object.assign(configuration, { happyHomeDir: home, settingsFile: join(home, 'settings.json'), serversDir: join(home, 'servers') });
    vi.stubEnv('HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', undefined);
    const target = { serverId: 'srv_generation_restart', machineId: 'machine' };
    const environmentId = 'environment', deploymentId = 'original-A', installationId = 'installation';
    const key = nacl.sign.keyPair();
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner', session: 'generation-restart-terminal',
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const authorKey = nacl.box.keyPair();
    const authorCredentials = { token, encryption: { type: 'dataKey' as const,
        machineKey: authorKey.secretKey, publicKey: authorKey.publicKey } };
    const keyHoldingAccount = custody === 'full-key' || custody === 'substituted-grant';
    const credentialMaterial = keyHoldingAccount ? authorCredentials : { token, encryption: null };
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, installationId, createdAt: 1,
        publicKey: Buffer.from(key.publicKey).toString('base64url'), privateKey: Buffer.from(key.secretKey).toString('base64url') });
    let client: ApiMachineClient | undefined;
    let mounted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let project: NativeComposeEnvironmentProject | undefined;
    let replacementProject: NativeComposeEnvironmentProject | undefined;
    let releaseActivationHandoff: (() => void) | undefined;
    let activationRun: Promise<import('@/daemon/local/services/launch/nativeComposeLifecycle').NativeComposeActivatedProject> | undefined;
    let releaseNativeActivation: (() => Promise<void>) | undefined;
    try {
        const profile = await addServerProfile({ name: 'generation-restart', serverUrl: 'https://generation-restart.invalid',
            webappUrl: 'https://generation-restart.invalid' });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: target.serverId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        configuration.activeServerId = profile.id;
        await credentialStore.writeStoredCredentialsForServerId(profile.id, credentialMaterial);
        const credentials = await credentialStore.readStoredCredentialsForServerId(profile.id);
        if (!credentials) throw new Error('The persisted terminal credential was not readable');
        const deploymentIdentity = await resolveOwnServerDeploymentIdentityForHost({
            happierHomeDir: home, serverId: target.serverId, environmentId,
        });
        const serviceId = `${deploymentIdentity.environmentInstanceId}/web`;
        mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        const owner = mounted.registry.projectManagedServices;
        const docker = await createOwnServerDockerBoundary(join(home, 'tools'));
        vi.stubEnv('PATH', `${join(home, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
        const image = await docker.registerImage('web', 'same-image-A-and-B');
        const document = JSON.stringify({ services: { web: { image: image.registryReference,
            environment: { SECRET: '${SECRET:?required}', PORT: '3000' } } } });
        const definition = { kind: 'stored' as const, contentRevision: 1, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] };
        const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'SECRET',
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('original-secret'), resourceRevision: 3 } };
        const sentinel = 'original-generation-secret-7210';
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId,
            machineId: target.machineId, installationId, resourceId: 'original-secret', resourceRevision: 3 },
            installationPublicKey: key.publicKey, content: { kind: 'secret', value: sentinel } });
        const newerBinding = { ...binding, source: { ...binding.source,
            ref: formatSharedSavedSecretRefV1('newer-secret'), resourceRevision: 4 } };
        const newerGrant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId,
            machineId: target.machineId, installationId, resourceId: 'newer-secret', resourceRevision: 4 },
            installationPublicKey: key.publicKey, content: { kind: 'secret', value: 'newer-generation-secret-9162' } });
        // The Home knows the installation public key and exact public subject.
        // It can return a valid first-read seal without knowing A's real value.
        const substitutedGrant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId,
            machineId: target.machineId, installationId, resourceId: 'original-secret', resourceRevision: 3 },
            installationPublicKey: key.publicKey, content: { kind: 'secret', value: 'home-authored-decoy-6841' } });
        const restoration = custody === 'restoration' || custody === 'restoration-activation-handoff';
        const activationHandoff = custody === 'activation-handoff' || custody === 'restoration-activation-handoff';
        const activationUpWait = custody === 'activation-up-wait';
        const runtimeSentinel = restoration ? 'newer-generation-secret-9162' : sentinel;
        const admission = { environmentId, environmentInstanceId: deploymentIdentity.environmentInstanceId, deploymentId,
            machineId: target.machineId, installationId, deploymentRoot: deploymentIdentity.deploymentRoot,
            ...(restoration ? { restorationForDeploymentId: 'newer-B' } : {}),
            artifactDirectory: join(home, 'artifacts'), definition, async assertCurrent() {} };
        const source = await createDeploymentSourceMaterializationPort({ async admit() { return admission; } })
            .materialize({ environmentId, deploymentId });
        const executable = { kind: 'systemTool', id: 'docker' } as const;
        const signal = new AbortController().signal;
        const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
            resolveExecutable: async () => ({ command: docker.executablePath }), resolvePath: async () => source.rootPath,
            environment: { PATH: process.env.PATH!, HOME: home }, systemTools: { async resolve() {
                return { executablePath: docker.executablePath, launch: { executablePath: docker.executablePath } };
            } } });
        const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal, isCurrent: () => true,
            prepare: () => prepareEnvironmentSecretBindingsForLaunch({ environmentId, machineId: target.machineId, installationId,
                installationPrivateSeed: key.secretKey.slice(0, 32),
                bindings: [restoration ? newerBinding : binding], phase: 'runtime', grants: [grant, newerGrant],
                async assertCurrent() {} }) });
        const nativeCaptures = new Set<import('@/plugins/runtime/invocation/services/exec').ProjectNativeEffectCaptureForHost>();
        const nativeIo = createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } }).createInvocation({ signal,
            retainCapture(capture) { nativeCaptures.add(capture); } });
        const createProject = () => createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
            files: ['compose.yaml'], services: ['web'], images: [image], sourceKind: 'stored', io: nativeIo,
            async settleNative() { await Promise.all([...nativeCaptures].map(capture => capture.waitForSettlement())); } });
        const activated = createProject();
        project = activated;
        const render = await activated.render();
        let activatedReady!: (project: import('@/daemon/local/services/launch/nativeComposeLifecycle').NativeComposeActivatedProject) => void;
        const activationReady = new Promise<import('@/daemon/local/services/launch/nativeComposeLifecycle').NativeComposeActivatedProject>(resolve => { activatedReady = resolve; });
        const handoff = new Promise<void>(resolve => { releaseActivationHandoff = resolve; });
        if (activationUpWait) {
            await docker.holdActivationReply(true);
            releaseNativeActivation = () => docker.holdActivationReply(false);
        }
        activationRun = machineNativeEffectAdmission.run({ operation: { operationId: 'original-generation', kind: 'deploy' }, keys: render.keys },
            async context => {
                await activated.prepareRuntimeImages({ render, context });
                const result = await activated.activate({ render, context });
                activatedReady(result);
                if (activationHandoff) await handoff;
                return result;
            });
        const originalActivation = activationUpWait ? undefined : await Promise.race([activationReady, activationRun]);
        if (activationUpWait) await Promise.race([docker.waitForActivationReplyHeld(), activationRun.then(() => {
            throw new Error('Activation settled before the held native reply');
        })]);
        else if (!activationHandoff) await activationRun;
        const sourceProof = await captureOwnServerDeploymentSource({ source, admission });
        const content = DeploymentContentV1Schema.parse({ sourceIntent: definition, machines: [target.machineId], buildMachineId: target.machineId,
            onFailure: 'keepPartial', images: [image], machineResults: [{ machineId: target.machineId, installationId,
                currentDeploymentId: deploymentId, activation: 'succeeded', health: 'healthy', steps: [] }], steps: [],
            ownServer: { sources: custody === 'restoration' ? [] : [sourceProof], approvedInputBasis: { v: 1, environmentId, environmentRevision: 1,
                targetLinkId: 'runtime-link', targetLinkRevision: 1, sourceIntent: definition, ...render.basis,
                services: render.services, profiles: [], members: [{ machineId: target.machineId, installationId }], bindings: [binding], images: [image] } } });
        await source.commit();
        if (custody !== 'live-establishment' && custody !== 'closed-capture-reactivation' && !activationHandoff && !activationUpWait) {
            await activated.dispose(); // Retire all incumbent redaction memory, keep the detached container.
            project = undefined;
        }
        expect(owner.listProjectServices()).toEqual([]);
        await docker.emitRuntimeLogFromEnvironment('web', 'SECRET');
        if (custody === 'substituted-grant') {
            // Security discriminator for the proposed reconstruction, before any
            // startup recovery wiring exists: the canonical opener authenticates
            // the exact subject/use, while the native incumbent retains A's bytes.
            const reopened = await prepareEnvironmentSecretBindingsForLaunch({ environmentId,
                machineId: target.machineId, installationId, installationPrivateSeed: key.secretKey.subarray(0, 32),
                bindings: [binding], phase: 'runtime', grants: [substitutedGrant],
                async assertCurrent() {} });
            const reconstructed = createProviderRedactionLease({ values: reopened.secretValues });
            try {
                const ids = await exec.run({ executable, args: ['ps', '--all', '--no-trunc', '--filter',
                    `label=com.docker.compose.project=${render.basis.physicalProjectName}`, '--format', '{{.ID}}'], cwd: source.rootPath });
                expect(ids.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                const selectedIds = new TextDecoder().decode(ids.stdout).trim().split('\n');
                expect(selectedIds).toHaveLength(1);
                const actual = await exec.run({ executable, args: ['logs', selectedIds[0]!], cwd: source.rootPath });
                expect(actual.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                const nativeText = new TextDecoder().decode(actual.stdout) + new TextDecoder().decode(actual.stderr);
                const exactSubjectAccepted = reopened.env.SECRET === 'home-authored-decoy-6841';
                const incumbentSecretPresent = nativeText.includes(sentinel);
                const incumbentSecretSurvives = reconstructed.redact(nativeText).includes(sentinel);
                expect({ exactSubjectAccepted, incumbentSecretPresent, incumbentSecretSurvives })
                    .toEqual({ exactSubjectAccepted: true, incumbentSecretPresent: true, incumbentSecretSurvives: true });
            } finally { reconstructed.close(); reopened.dispose(); }
        }
        const artifact = { contentArtifactId: 'original-receipt', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment: DeploymentEnvironmentDetailV1['environment'] = { v: 1, id: environmentId, serverId: target.serverId,
            projectSourceId: 'source', revision: 7, owner: { kind: 'account', accountId: 'owner' }, protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', controllerMachineId: target.machineId, buildMachineId: target.machineId,
            runtimeTargetLinkId: 'runtime-link', ...artifact, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
            capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true, manageTargets: true, delete: true } };
        const link: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink'] = { v: 1, id: 'runtime-link',
            environmentId, revision: 2, role: 'runtime', source: { kind: 'host', id: 'own-server' }, targetKind: 'ownServer',
            state: 'deployed', activeDeploymentId: 'newer-B', machines: [target.machineId],
            members: [{ machineId: target.machineId, installationId, state: 'active' }],
            ...artifact, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 };
        const receipt = { v: 1, id: deploymentId, environmentId, targetLinkId: link.id, revision: 2,
            operation: 'deploy', state: 'failed', requestKey: 'original-request', requestedByAccountId: 'owner',
            actionOperationId: 'original-operation', requestedAtMs: 1, ...artifact };
        const newerContent = DeploymentContentV1Schema.parse({ ...content,
            machineResults: [{ ...content.machineResults[0], currentDeploymentId: 'newer-B' }],
            ownServer: { ...content.ownServer, sources: custody === 'restoration' ? [sourceProof] : [], approvedInputBasis: {
                ...content.ownServer!.approvedInputBasis, bindings: [newerBinding] } } });
        const newerReceipt = { ...receipt, id: 'newer-B', state: 'succeeded', contentArtifactId: 'newer-receipt' };
        // Only the original author prepares this encrypted receipt. The new
        // installed reader below gets the author's existing key only in the
        // explicit full-key control; keyless-basis never borrows that material.
        const storeReceipt = async (selected: typeof content) => {
            const header = createDeploymentReceiptArtifactHeaderV1('Original generation', selected);
            const body = { body: JSON.stringify(selected) };
            if (custody !== 'keyless-basis' && !keyHoldingAccount) return { encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent(body) };
            const receiptKey = await createResourceDataKey({ mode: 'e2ee', credentials: authorCredentials });
            if (receiptKey.mode !== 'e2ee') throw new Error('Expected the original author receipt key');
            return { encryptionMode: 'e2ee', dataEncryptionKey: receiptKey.dataEncryptionKey,
                header: encodeBase64(encryptWithDataKey(header, receiptKey.dataKey), 'base64'),
                body: encodeBase64(encryptWithDataKey(body, receiptKey.dataKey), 'base64') };
        };
        const storedReceipt = await storeReceipt(content);
        const storedNewerReceipt = await storeReceipt(newerContent);
        const approvalArtifacts = new Map<string, { id: string } & Record<string, unknown>>();
        const agentApprovalSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'deployments.logs.read': { approvalRequiredSurfaces: ['agent'] },
        } });
        const reads: string[] = [];
        let canReadEnvironment = true;
        const environmentAccessResponse = DeploymentEnvironmentAccessResultV1Schema.parse({ ok: true,
            items: [{ environmentId, read: true, deploy: false }] });
        const deniedEnvironmentAccessResponse = DeploymentEnvironmentAccessResultV1Schema.parse({ ok: true, items: [] });
        const environmentResponse = DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment, targetLinks: [link] });
        const receiptResponse = DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt });
        const newerReceiptResponse = DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: newerReceipt });
        const respond = (url: string) => {
            const path = new URL(url).pathname;
            reads.push(path);
            if (path === '/v1/account/encryption') return { status: 200, data: AccountEncryptionModeResponseSchema.parse({
                mode: custody === 'keyless-basis' || keyHoldingAccount ? 'e2ee' : 'plain', updatedAt: 1,
            }) };
            if (path.includes('/encryption')) return { status: 200, data: { mode: custody === 'keyless-basis' || keyHoldingAccount ? 'e2ee' : 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/deployments/environments/access') return { status: 200,
                data: canReadEnvironment ? environmentAccessResponse : deniedEnvironmentAccessResponse };
            if (path.endsWith(`/environments/${environmentId}`)) return { status: 200, data: environmentResponse };
            if (path.endsWith(`/receipts/${deploymentId}`)) return { status: 200, data: receiptResponse };
            if (path.endsWith('/receipts/newer-B')) return { status: 200, data: newerReceiptResponse };
            if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'owner' }) };
            if (path === '/v2/account/settings') return { status: 200, data: {
                content: { t: 'plain', v: { actionsSettingsV1: agentApprovalSettings } }, version: 1,
            } };
            if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true,
                grants: custody === 'missing-grant' ? [newerGrant] : [custody === 'substituted-grant' ? substitutedGrant : grant, newerGrant] } };
            if (path === '/v1/artifacts/original-receipt' || path === '/v1/artifacts/newer-receipt') return { status: 200, data: {
                id: path.endsWith('/original-receipt') ? 'original-receipt' : 'newer-receipt', ownerAccountId: 'owner',
                access: 'owner', publicAudience: 'none', ...(path.endsWith('/original-receipt') ? storedReceipt : storedNewerReceipt),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
            if (path.startsWith('/v1/artifacts/')) {
                const row = approvalArtifacts.get(decodeURIComponent(path.split('/').at(-1)!));
                return row ? { status: 200, data: row } : { status: 404, data: { error: 'artifact_not_found' } };
            }
            throw new Error(`Unexpected generation-read transport: ${path}`);
        };
        // HTTP and native Docker are the only substituted systems. Installed
        // custody, Artifact opening, schemas, phase selection and supervision stay real.
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (new URL(request.url!).pathname.endsWith('/secret-launch-admission')) {
                const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(request.data);
                expect(body).toMatchObject({ ...target, environmentId, targetLinkId: link.id, installationId,
                    materialization: { kind: 'generation', deploymentId: custody === 'restoration' ? 'newer-B' : deploymentId } });
                expect(verifyMachineInstallationProof({ payload: { version: 1, accountId: 'owner', machineId: target.machineId,
                    installationId, deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
                    proof, publicKey: key.publicKey })).toBe(true);
            }
            return respond(request.url!);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => respond(String(url)));
        const machine: Machine = { id: target.machineId, encryptionMode: 'plain', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
            metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: home, happyHomeDir: home,
                serviceWatchesV1: { v: 1, watches: [] } } };
        client = await runWithServerHttpBaseUrl(profile.serverUrl, () => new ApiMachineClient(token, machine));
        Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (event, raw) => {
            if (event !== 'machine-update-metadata') throw new Error('Unexpected generation-read socket effect');
            const request = raw as { metadata: string; expectedVersion: number };
            return { result: 'success', version: request.expectedVersion + 1, metadata: request.metadata };
        } }));
        client.registerLocalServicesRoutes({ machineId: target.machineId, serverId: profile.id, accountId: 'owner', projectManagedServices: owner });
        // Binding the optional recovery capability must not eagerly read private
        // receipts. Ordinary Machine discovery and unrelated metadata are not demand.
        await client.executeMachineServiceAction({ actionId: 'machines.services.discovery', input: target,
            context: { surface: 'cli', authority: 'present_user' } });
        await client.updateMachineMetadata(current => ({ ...current!, displayName: 'Unrelated display name' }));
        expect(reads.some(path => path.includes('/artifacts/') || path.includes('/environments/')
            || path.includes('/receipts/') || path.endsWith('/secret-launch-admission'))).toBe(false);
        const listed = await client.executeMachineServiceAction({ actionId: 'machines.services.list', input: target,
            context: { surface: 'cli', authority: 'present_user' }, canReadEnvironments: async ids => new Set(ids.filter(id => id === environmentId)),
            requesterAccountId: 'owner' });
        const installed = client;
        const executor = createCliActionExecutor({ token, credentials, mode: 'plain', ctx: null, sessionId: 'cli-global',
            serverId: target.serverId, serverHttpBaseUrl: profile.serverUrl,
            machineActionDirectTargetTransport: { machineId: target.machineId,
                machineServiceAction: request => installed.executeMachineServiceAction(request),
                async invoke() { throw new Error('Installed Machine log reads must not re-enter Machine RPC'); } } });
        if (activationHandoff || activationUpWait) {
            expect(owner.listProjectServices()).toEqual([]);
            const person = await executor.execute('machines.services.logs.read', { ...target, serviceId },
                { surface: 'cli', authority: 'present_user' });
            const beforeAgent = (await docker.readInvocations()).filter(request => request.args[0] === 'logs').length;
            const agent = await executor.execute('machines.services.logs.read', { ...target, serviceId },
                { surface: 'mcp', authority: 'account_automation' });
            const observe = (result: typeof person) => {
                const parsed = result.ok ? ManagedServiceNativeLogResultV1Schema.parse(result.result) : null;
                return { ok: result.ok, errorCode: result.ok ? null : result.errorCode,
                    secretMasking: parsed?.kind === 'page' ? parsed.page.secretMasking ?? 'complete' : null,
                    disclosedOriginalValue: JSON.stringify(result).includes(runtimeSentinel),
                    redacted: parsed?.kind === 'page' && parsed.page.text.includes('[REDACTED]') };
            };
            expect({ person: observe(person), agent: observe(agent) }).toEqual({
                person: { ok: true, errorCode: null, secretMasking: activationUpWait ? 'incomplete' : 'complete', disclosedOriginalValue: false, redacted: true },
                agent: activationUpWait ? { ok: false, errorCode: 'secret_redaction_unavailable', secretMasking: null, disclosedOriginalValue: false, redacted: false }
                    : { ok: true, errorCode: null, secretMasking: 'complete', disclosedOriginalValue: false, redacted: true },
            });
            if (activationUpWait) expect((await docker.readInvocations()).filter(request => request.args[0] === 'logs')).toHaveLength(beforeAgent);
            expect(reads.some(path => path.endsWith('/secret-launch-admission'))).toBe(false);
            expect((await docker.readInvocations()).some(request => request.args.includes('stop') || request.args.includes('rm'))).toBe(false);
            expect(await docker.readRuntimeEnvironment('web')).toMatchObject({ SECRET: runtimeSentinel });
            if (activationHandoff) {
                // Closing the original capture while the SAME admission is
                // still pending must end the borrow, without native Stop or
                // any engine probe to reconstruct unavailable masking.
                await activated.dispose();
                const beforeClosed = await docker.readInvocations();
                const personAfterClose = await executor.execute('machines.services.logs.read', { ...target, serviceId },
                    { surface: 'cli', authority: 'present_user' });
                const agentAfterClose = await executor.execute('machines.services.logs.read', { ...target, serviceId },
                    { surface: 'mcp', authority: 'account_automation' });
                expect(personAfterClose).toMatchObject({ ok: true, result: { kind: 'page', page: { secretMasking: 'incomplete' } } });
                expect(agentAfterClose).toMatchObject({ ok: false, errorCode: 'secret_redaction_unavailable' });
                const afterClosed = (await docker.readInvocations()).slice(beforeClosed.length);
                expect(afterClosed.filter(request => request.args[0] === 'info')).toHaveLength(0);
                expect(afterClosed.filter(request => request.args[0] === 'logs')).toHaveLength(1);
                expect(await docker.readRuntimeEnvironment('web')).toMatchObject({ SECRET: runtimeSentinel });
            }
            return;
        }
        if (custody === 'live-establishment' || custody === 'closed-capture-reactivation') {
            if (!originalActivation) throw new Error('Missing original activation');
            await docker.holdNextContainerInspection(true);
            const supervising = produceEnvironmentProjectServices({ owner, serverId: target.serverId, release: source,
                specIdentity: 'live-original-generation', isCurrent: () => true,
                nativeEffects: { keys: render.keys, settleNative: activated.settleNative }, io: nativeIo, project: originalActivation });
            try {
                await vi.waitFor(async () => expect(await docker.isContainerInspectionHeld()).toBe(true));
                if (custody === 'closed-capture-reactivation') {
                    // Construct the retained failed-capture neighbor without
                    // mocking the owner: close its real original lease while
                    // the semantic entry still awaits its native inspection.
                    const oldCapture = originalActivation.authorizeServiceObserver();
                    if (!oldCapture.secretRedactionLease) throw new Error('Missing original capture masking');
                    oldCapture.secretRedactionLease.close();
                    await oldCapture.release();
                    const next = createProject();
                    replacementProject = next;
                    const nextRender = await next.render();
                    let nextReady!: () => void;
                    const ready = new Promise<void>(resolve => { nextReady = resolve; });
                    const complete = new Promise<void>(resolve => { releaseActivationHandoff = resolve; });
                    activationRun = machineNativeEffectAdmission.run({ operation: { operationId: 'reactivation', kind: 'deploy' }, keys: nextRender.keys }, async context => {
                        await next.prepareRuntimeImages({ render: nextRender, context });
                        const result = await next.activate({ render: nextRender, context });
                        nextReady(); await complete; return result;
                    });
                    await Promise.race([ready, activationRun]);
                }
                expect(owner.resolveEnvironmentService(target.serverId, { kind: 'deployment', machineId: target.machineId,
                    environmentId, environmentInstanceId: deploymentIdentity.environmentInstanceId, composeService: 'web', serviceId })).toBeNull();
                const person = await executor.execute('machines.services.logs.read', { ...target, serviceId },
                    { surface: 'cli', authority: 'present_user' });
                const agent = await executor.execute('machines.services.logs.read', { ...target, serviceId },
                    { surface: 'mcp', authority: 'account_automation' });
                const observe = (result: typeof person) => {
                    const parsed = result.ok ? ManagedServiceNativeLogResultV1Schema.parse(result.result) : null;
                    return { ok: result.ok, errorCode: result.ok ? null : result.errorCode,
                        secretMasking: parsed?.kind === 'page' ? parsed.page.secretMasking ?? 'complete' : null,
                        disclosedOriginalValue: JSON.stringify(result).includes(runtimeSentinel),
                        redacted: parsed?.kind === 'page' && parsed.page.text.includes('[REDACTED]') };
                };
                expect({ person: observe(person), agent: observe(agent) }).toEqual({
                    person: { ok: true, errorCode: null, secretMasking: 'complete', disclosedOriginalValue: false, redacted: true },
                    agent: { ok: true, errorCode: null, secretMasking: 'complete', disclosedOriginalValue: false, redacted: true },
                });
            } finally {
                releaseActivationHandoff?.();
                await activationRun;
                await docker.holdNextContainerInspection(false);
                const handles = await supervising;
                await Promise.all(handles.map(handle => handle.dispose()));
            }
            return;
        }
        expect(listed).toMatchObject({ kind: 'snapshot', services: [] });
        expect(owner.listProjectServices()).toEqual([]);
        const machineLogs = await executor.execute('machines.services.logs.read', { ...target,
            serviceId }, { surface: 'cli', authority: 'present_user' });
        // Owner C12 (2026-10-30): Home-held grants and full Account keys do
        // not recover the original deployment's lost in-memory masking basis.
        expect(machineLogs.ok, JSON.stringify(machineLogs)).toBe(true);
        if (!machineLogs.ok) throw new Error('The person lost live-log access after restart');
        const page = ManagedServiceNativeLogResultV1Schema.parse(machineLogs.result);
        expect(page).toMatchObject({ kind: 'page', page: { secretMasking: 'incomplete',
            text: expect.stringContaining('secret masking may be incomplete until the next deploy'),
        } });
        expect(JSON.stringify(page)).toContain('3000');
        const beforeAgent = (await docker.readInvocations()).filter(request => request.args[0] === 'logs').length;
        const agentLogs = await executor.execute('machines.services.logs.read', { ...target,
            serviceId }, { surface: 'mcp', authority: 'account_automation' });
        expect(agentLogs).toMatchObject({ ok: false, errorCode: 'secret_redaction_unavailable' });
        expect(JSON.stringify(agentLogs)).not.toContain(runtimeSentinel);
        expect((await docker.readInvocations()).filter(request => request.args[0] === 'logs')).toHaveLength(beforeAgent);
        if (custody === 'missing-grant') {
            const personMcpLogs = await executor.execute('machines.services.logs.read', { ...target,
                serviceId }, { surface: 'mcp', authority: 'present_user' });
            expect(personMcpLogs).toMatchObject({ ok: false, errorCode: 'secret_redaction_unavailable' });
            expect((await docker.readInvocations()).filter(request => request.args[0] === 'logs')).toHaveLength(beforeAgent);
            canReadEnvironment = false;
            try {
                const deniedPersonLogs = await executor.execute('machines.services.logs.read', { ...target,
                    serviceId }, { surface: 'cli', authority: 'present_user' });
                expect(deniedPersonLogs).toMatchObject({ ok: false, errorCode: 'service_unavailable' });
                expect((await docker.readInvocations()).filter(request => request.args[0] === 'logs')).toHaveLength(beforeAgent);
            } finally { canReadEnvironment = true; }
        }
        const runtime = createOwnServerDeploymentRuntimeForHost({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: target.serverId,
            serverHttpBaseUrl: profile.serverUrl, machineId: target.machineId,
            async acquirePluginRuntimeRegistryLease() { return mounted!.lease; } });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: target.serverId,
            serverHttpBaseUrl: profile.serverUrl, machineId: target.machineId, runtime });
        const deploymentLogInput = { ...target, environmentId,
            installationId, targetLinkId: link.id, deploymentId, kind: 'runtime' as const, service: { kind: 'deployment' as const,
                machineId: target.machineId, environmentId, environmentInstanceId: deploymentIdentity.environmentInstanceId,
                serviceId, composeService: 'web' } };
        const logs = await deps.deploymentAction!('deployments.logs.read', deploymentLogInput,
            { surface: 'cli', authority: 'present_user' });
        expect(logs).toMatchObject({ ok: true });
        expect(JSON.stringify(logs)).toContain('secret masking may be incomplete until the next deploy');
        expect(JSON.stringify(logs)).toContain('3000');
        const beforeDeploymentAgent = (await docker.readInvocations()).filter(request => request.args[0] === 'logs').length;
        const deploymentAgentLogs = await deps.deploymentAction!('deployments.logs.read', deploymentLogInput,
            { surface: 'mcp', authority: 'account_automation' });
        expect(deploymentAgentLogs).toMatchObject({ ok: false, errorCode: 'secret_redaction_unavailable' });
        expect(JSON.stringify(deploymentAgentLogs)).not.toContain(runtimeSentinel);
        expect((await docker.readInvocations()).filter(request => request.args[0] === 'logs')).toHaveLength(beforeDeploymentAgent);
        if (custody === 'missing-grant') {
            const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {
                serverIdentity: { serverIdentityId: target.serverId },
            } });
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
            // Home HTTP persistence is substituted; the real Artifact codec,
            // approval CAS/transition, replay and result projection stay live.
            vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/artifacts/read') return artifactReadResponse(raw, id => approvalArtifacts.get(id) ?? null);
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Artifact HTTP write');
                const body = raw as Record<string, unknown>;
                if (path === '/v1/artifacts' && typeof body.id === 'string') {
                    const { idScope: _idScope, ...stored } = body;
                    approvalArtifacts.set(body.id, { ...stored, id: body.id, ownerAccountId: 'owner', access: 'owner',
                        encryptionMode: 'plain', publicAudience: 'none', headerVersion: 1, bodyVersion: 1,
                        seq: 1, createdAt: 1, updatedAt: 1 });
                    return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
                }
                const row = approvalArtifacts.get(decodeURIComponent(path.split('/').at(-1)!));
                if (!row) return { status: 404, data: { error: 'artifact_not_found' } };
                if (row.headerVersion !== body.expectedHeaderVersion || row.bodyVersion !== body.expectedBodyVersion)
                    return { status: 200, data: { success: false, error: 'version-mismatch' } };
                Object.assign(row, { header: body.header, body: body.body, headerVersion: Number(row.headerVersion) + 1,
                    bodyVersion: Number(row.bodyVersion) + 1, seq: Number(row.seq) + 1, updatedAt: Number(row.updatedAt) + 1 });
                return { status: 200, data: { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
            });
            const approvals = createCliApprovalsArtifactStore({ credentials, serverId: target.serverId,
                serverHttpBaseUrl: profile.serverUrl });
            // Match the real Account host's loaded Settings producer before
            // replay currentness consumes the Agent's captured spawn policy.
            const settings = await runWithServerHttpBaseUrl(profile.serverUrl,
                () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' }));
            expect(settings.source).toBe('network');
            const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
                serverId: target.serverId, serverApiUrl: profile.serverUrl, machineId: target.machineId });
            if (!currentness) throw new Error('Missing real approval currentness owner');
            // The shared executor is also the UI's production approval owner.
            // No caller fabricates the approved replay context it sends to the
            // daemon's installed typed deployment Action port below.
            const app = createActionExecutor({ ...deps, ...approvals, isApprovalExecutionOriginCurrent: currentness });
            const proposal = await runWithServerHttpBaseUrl(profile.serverUrl, () => app.execute('deployments.logs.read',
                deploymentLogInput, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                    serverId: target.serverId, serverIdentityId: target.serverId, runtimeAccountId: 'owner',
                    actionsSettings: agentApprovalSettings,
                    defaultSessionId: 'log-requesting-agent', defaultSessionMachineId: target.machineId,
                    externalActionTarget: { kind: 'machine', machineId: target.machineId }, actionRequestId: 'agent-runtime-logs' }));
            expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!proposal.ok || !proposal.result || typeof proposal.result !== 'object' || !('artifactId' in proposal.result)
                || typeof proposal.result.artifactId !== 'string') throw new Error('Missing agent approval Artifact');
            const artifactId = proposal.result.artifactId;
            const open = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(profile.serverUrl,
                () => approvals.approvalsGet({ artifactId })));
            expect(open.executionOriginV1).toMatchObject({ surface: 'agent', authority: 'account_automation' });
            const beforeApprovalLogs = (await docker.readInvocations()).filter(request => request.args[0] === 'logs').length;
            const decision = await runWithServerHttpBaseUrl(profile.serverUrl, () => app.execute('approval.request.decide',
                { artifactId, decision: 'approve' }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: target.serverId, serverIdentityId: target.serverId, runtimeAccountId: 'owner' }));
            const settled = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(profile.serverUrl,
                () => approvals.approvalsGet({ artifactId })));
            const agentResult = buildActionExecuteResultFromRecordedApprovalExecution(settled);
            expect({ decision, agentResult, storedExecution: settled.execution,
                nativeLogReads: (await docker.readInvocations()).filter(request => request.args[0] === 'logs').length - beforeApprovalLogs,
                disclosedOriginalValue: JSON.stringify({ agentResult, storedExecution: settled.execution }).includes(runtimeSentinel) },
                JSON.stringify({ decision, settled }))
                .toMatchObject({ decision: { ok: true, result: { status: 'failed' } },
                    agentResult: { ok: false, errorCode: 'secret_redaction_unavailable' },
                    storedExecution: { ok: false, errorCode: 'secret_redaction_unavailable' }, nativeLogReads: 0, disclosedOriginalValue: false });
        }
        expect(owner.listProjectServices()).toEqual([]);
        // Re-fetching a public-key-sealed envelope from Home cannot establish
        // which bytes this Machine delivered before its sanitizer was lost.
        expect(reads.some(path => path.endsWith('/secret-launch-admission'))).toBe(false);
        const native = await docker.readInvocations();
        expect(native.filter(request => request.args.includes('up'))).toHaveLength(1);
        expect(native.some(request => request.args.includes('stop') || request.args.includes('rm'))).toBe(false);
        expect(await docker.readRuntimeEnvironment('web')).toMatchObject({ SECRET: runtimeSentinel });
        if (custody === 'missing-grant') {
            // The same installation/root can serve another Home. Its current
            // Environment ACL cannot establish ownership of A's native logs.
            await client.shutdown();
            client = undefined;
            const foreignProfile = await addServerProfile({ name: 'other-generation-home',
                serverUrl: 'https://other-generation-home.invalid', webappUrl: 'https://other-generation-home.invalid' });
            const foreignTarget = { serverId: 'srv_other_generation_home', machineId: target.machineId };
            await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: foreignProfile.id, observation: 'exact', descriptor: {
                v: 1, homeServerIdentityId: foreignTarget.serverId, canonicalServerUrl: foreignProfile.serverUrl, revision: 1,
                endpoints: [{ kind: 'https', url: foreignProfile.serverUrl }],
            } });
            configuration.activeServerId = foreignProfile.id;
            const foreignIdentity = await resolveOwnServerDeploymentIdentityForHost({
                happierHomeDir: home, serverId: foreignTarget.serverId, environmentId,
            });
            const foreignToken = `e30.${Buffer.from(JSON.stringify({ sub: 'other-home-owner', session: 'other-home-terminal',
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            await credentialStore.writeStoredCredentialsForServerId(foreignProfile.id, { token: foreignToken, encryption: null });
            const foreignCredentials = await credentialStore.readStoredCredentialsForServerId(foreignProfile.id);
            if (!foreignCredentials) throw new Error('The persisted foreign terminal credential was not readable');
            vi.mocked(axios.request).mockImplementation(async request => {
                const url = new URL(request.url!);
                if (url.origin !== foreignProfile.serverUrl || url.pathname !== '/v1/deployments/environments/access') {
                    throw new Error(`Unexpected foreign Home transport: ${url.pathname}`);
                }
                expect(DeploymentEnvironmentAccessInputV1Schema.parse(request.data))
                    .toEqual({ serverId: foreignTarget.serverId, environmentIds: [environmentId] });
                return { status: 200, data: environmentAccessResponse };
            });
            const foreignMachine = { ...machine, id: foreignTarget.machineId };
            client = await runWithServerHttpBaseUrl(foreignProfile.serverUrl, () => new ApiMachineClient(foreignToken, foreignMachine));
            Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true }));
            client.registerLocalServicesRoutes({ machineId: foreignTarget.machineId, serverId: foreignProfile.id,
                accountId: 'other-home-owner', projectManagedServices: owner });
            const foreignInstalled = client;
            const foreignExecutor = createCliActionExecutor({ token: foreignToken, credentials: foreignCredentials,
                mode: 'plain', ctx: null, sessionId: 'other-home-global', serverId: foreignTarget.serverId,
                serverHttpBaseUrl: foreignProfile.serverUrl,
                machineActionDirectTargetTransport: { machineId: foreignTarget.machineId,
                    machineServiceAction: request => foreignInstalled.executeMachineServiceAction(request),
                    async invoke() { throw new Error('Foreign Home logs must use the installed Machine owner'); } } });
            const beforeForeignLogs = (await docker.readInvocations()).filter(request => request.args[0] === 'logs').length;
            const foreignLogs = await foreignExecutor.execute('machines.services.logs.read', { ...foreignTarget,
                serviceId: `${foreignIdentity.environmentInstanceId}/web` }, { surface: 'cli', authority: 'present_user' });
            const afterForeignLogs = (await docker.readInvocations()).filter(request => request.args[0] === 'logs').length;
            expect({ result: foreignLogs.ok ? 'page' : foreignLogs.errorCode,
                nativeLogReads: afterForeignLogs - beforeForeignLogs,
                disclosedOriginalValue: JSON.stringify(foreignLogs).includes(runtimeSentinel) })
                .toEqual({ result: 'service_unavailable', nativeLogReads: 0, disclosedOriginalValue: false });
        }
    } finally {
        resetInMemoryAccountSettingsContextForTests();
        await client?.shutdown();
        releaseActivationHandoff?.();
        await releaseNativeActivation?.();
        await activationRun;
        await replacementProject?.dispose();
        await project?.dispose();
        await mounted?.dispose();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        Object.assign(configuration, previous);
        await rm(home, { recursive: true, force: true });
    }
});
