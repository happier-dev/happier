import axios from 'axios';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentEnvironmentDetailV1, EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import type { OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import type { ServerProfile } from '@/server/serverProfiles';
import { EnvironmentVariableBindingV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import * as installationStore from '@/daemon/identity/store';
import type { OwnServerDeploymentRuntimeRequest } from './ownServerDeploymentTarget';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import * as ownServerHostRuntime from './ownServerDeploymentHostRuntime';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { access, mkdir, mkdtemp, readFile, readdir, rm, watch, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { resolveDeploymentSourcePathForHost } from './paths';
import { createDeploymentGitRegistry } from './exactCommitRelease.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { registerDaemonDeploymentChildRpcHandler } from '@/deployments/daemonDeploymentChildRpc';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { readDeploymentEnvironmentForHost } from '@/deployments/readEnvironmentForHost';
import { createScmBackendRegistry } from '@/scm/registry';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { ProjectNativeRuntimeFacts } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

// Socket.IO is the network boundary; native ownership, crypto and RPC codecs stay real.
const serviceReferenceSocket = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: serviceReferenceSocket.io }));

const artifact = { contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1 };
const environment: DeploymentEnvironmentDetailV1 = {
    environment: { v: 1, id: 'environment', serverId: 'home', projectSourceId: 'source', revision: 2,
        owner: { kind: 'account', accountId: 'owner' }, protection: 'nonProduction', purpose: 'standard',
        deployerMode: 'managers', controllerMachineId: 'machine', buildMachineId: 'machine', runtimeTargetLinkId: 'link',
        ...artifact, capabilities: { role: 'manager', read: true, deploy: true, manage: true, manageBindings: true,
            manageTargets: true, delete: true }, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 },
    content: { name: 'Staging', retainPreviousDeployments: 1, bindings: [],
        definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } } },
    targetLinks: [{ targetLink: { v: 1, id: 'link', environmentId: 'environment', revision: 1,
        role: 'runtime', source: { kind: 'host', id: 'own-server' }, targetKind: 'ownServer', state: 'configured',
        machines: ['machine'], members: [{ machineId: 'machine', installationId: 'installation', state: 'active' }],
        createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, ...artifact }, content: {} }],
};
const receipt: OwnServerDeploymentReceipt = {
    deployment: createDeploymentReceiptHeaderV1({ v: 1, id: 'deployment', environmentId: 'environment', targetLinkId: 'link', revision: 1,
        operation: 'deploy', state: 'queued', requestKey: 'request', requestedByAccountId: 'actor',
        actionOperationId: 'operation', requestedAtMs: 1, ...artifact,
        acceptedExecution: { v: 1, controller: { machineId: 'machine', installationId: 'installation' },
            builder: { machineId: 'machine', installationId: 'installation' } } }),
    content: { sourceIntent: { kind: 'repository', projectSourceId: 'source', sourceRevision: 1, sha: 'a'.repeat(40),
        compose: { path: 'compose.yaml', profiles: [], services: [] } }, machines: ['machine'],
        buildMachineId: 'machine', onFailure: 'rollbackAll', images: [], machineResults: [], steps: [] },
};
const request = { actionId: 'deployments.deploy',
    input: { serverId: 'home', environmentId: 'environment', expectedRevision: 2, targetLinkId: 'link',
        expectedTargetLinkRevision: 1, requestKey: 'request', ...artifact },
    materialization: { kind: 'deployment', deploymentId: 'deployment' },
    context: { operationAcceptance: { operationId: 'operation', accept() {} } },
} satisfies OwnServerDeploymentRuntimeRequest;

function physicalOwnerSourceRequester() {
    const owner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveHostIdentity: async () => ({ machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }) });
    return {
        context: { ...request.context, authority: 'present_user' as const,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
            verifyMachineAdmissionCurrent: async () => true },
        async resolveRequesterIdentity(context: import('@happier-dev/protocol').ActionExecutorContext) {
            const requester = await owner.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        },
    };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(async () => {
    const settings = await persistence.readSettings();
    const profile: ServerProfile = {
        id: 'home', name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
        createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_runtime_home',
            canonicalServerUrl: 'https://home.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.test' }] }),
    };
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: profile } });
});

describe('own-server installed host acquisition', () => {
    it('refuses a provider-built repository source before staging native content', async () => {
        const keys = nacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const sourceRequester = physicalOwnerSourceRequester();
        mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'checkout', serverId: 'home',
            machineId: 'machine', rootPath: '/provider-built-source', source: { sourceId: 'source', revision: 1 }, createdAtMs: 1 })]);
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, canManage: true,
            source: { id: 'source', revision: 1, name: 'Source', audience: [], createdByAccountId: 'owner',
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'owner/source', cloneUrl: 'https://github.com/owner/source.git' }, protocol: 'https' } } } });
        const platformEnvironment = structuredClone(environment);
        platformEnvironment.content.definition = { kind: 'repository', ref: 'main' };
        // Artifact storage is the effect boundary; native-only content must never reach it.
        const stageContent = vi.fn(async () => { throw Object.assign(new Error('native_stage_reached'), { code: 'native_stage_reached' }); });
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
            resolveRequesterIdentity: sourceRequester.resolveRequesterIdentity,
            async acquirePluginRuntimeRegistryLease() { throw new Error('Native runtime must not be acquired'); } });
        await expect(runtime.acquireCandidate!({ environmentId: 'environment', targetLinkId: 'link',
            sha: 'a'.repeat(40), stageContent, context: sourceRequester.context }, platformEnvironment))
            .rejects.toMatchObject({ code: 'deployment_invalid' });
        expect(stageContent).not.toHaveBeenCalled();
    });

    it('preserves the shared source reader Use refusal before native acquisition effects', async () => {
        const keys = nacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, installationId: 'installation',
            createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
            resolveHostIdentity: async () => ({ machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' }) });
        const mounted = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        const sourceHttp = vi.spyOn(axios, 'request');
        try {
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'fixture', encryption: null },
                serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
                acquirePluginRuntimeRegistryLease: async () => {
                    const lease = mounted.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Fixture runtime retired');
                    return lease;
                },
                async resolveRequesterIdentity(context) {
                    const requester = await identityOwner.resolveActionRequester!(context);
                    try { return requester.identity; } finally { await requester.dispose(); }
                } });
            const context = { ...request.context, authority: 'present_user' as const, signal: new AbortController().signal,
                machineAdmission: { actorAccountId: 'use-grantee', custodianAccountId: 'owner', machineId: 'machine',
                    installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const },
                verifyMachineAdmissionCurrent: async () => true };
            await expect(runtime.acquire({ ...request, context }, { environment, content: receipt.content,
                deployment: receipt.deployment })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
            expect(sourceHttp).not.toHaveBeenCalled();
        } finally { await mounted.dispose(); }
    });
    it.for([
        { encryptionMode: 'plain', nativePath: 'build' }, { encryptionMode: 'e2ee', nativePath: 'build' },
        { encryptionMode: 'plain', nativePath: 'retention' }, { encryptionMode: 'e2ee', nativePath: 'retention' },
        { encryptionMode: 'plain', nativePath: 'member' }, { encryptionMode: 'e2ee', nativePath: 'member' },
    ] as const)('uses local cancellation without Home rechecks for admitted $encryptionMode child $nativePath commands', async ({ encryptionMode, nativePath }, context) => {
        const lifetime = new AbortController();
        context.onTestFinished(() => lifetime.abort());
        const signal = AbortSignal.any([context.signal, lifetime.signal]);
        const operation = new AbortController();
        const operationSignal = AbortSignal.any([signal, operation.signal]);
        const channel = await createRequesterCurrentnessSocketHarness();
        // No saved profile is enrolled in this fixture; use its canonical Home.
        const fixture = await createDeploymentChildRequesterHarness({ encryptionMode, profileId: 'srv_archive_home' });
        // Persisted profiles are the OS boundary, not another Home resolver.
        const settings = await persistence.readSettings();
        const profile: ServerProfile = {
            id: fixture.profileId, name: 'Home', serverUrl: fixture.serverHttpBaseUrl, webappUrl: fixture.serverHttpBaseUrl,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: fixture.homeIdentityId,
                canonicalServerUrl: fixture.serverHttpBaseUrl, revision: 1,
                endpoints: [{ kind: 'https', url: fixture.serverHttpBaseUrl }] }),
        };
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { [fixture.profileId]: profile } });
        let prepared: Awaited<ReturnType<typeof fixture.prepare>> | undefined;
        let mounted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        let root: string | undefined;
        let homeReads = 0;
        let installedReads = 0;
        let retentionAdmissions = 0;
        let installedCurrent = true;
        try {
            // Home HTTP and Docker are genuine system boundaries. The private
            // child context, public projections and installed runtime stay real.
            vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
                homeReads++;
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: fixture.root.binding.accountId } };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
                throw new Error('Unexpected requester read');
            });
            vi.spyOn(axios, 'request').mockImplementation(async config => {
                homeReads++;
                const path = new URL(config.url!).pathname;
                if (path.endsWith('/environment/secret-launch-admission')) return { status: 200,
                    data: { ok: true, grants: [] } };
                // The actual child settles before native acquisition while its
                // production composition lends this same retained runtime.
                if (path === '/v1/deployments/receipts/deployment') return { status: 404, data: {} };
                throw new Error('Unexpected source read');
            });
            const requester = await fixture.prepare(signal);
            prepared = requester;
            mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
                controller: pluginReloadController, runtimeOptions: { pluginIds: [],
                    contributes: createResolvedContributionRegistry({}) } });
            signal.throwIfAborted();
            root = await mkdtemp(join(tmpdir(), 'happier-runtime-requester-'));
            const docker = await createOwnServerDockerBoundary(join(root, 'bin'));
            vi.stubEnv('PATH', `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`);
            const document = 'services: {web: {image: app}}';
            const definition = { kind: 'stored' as const, contentRevision: 2, document,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] };
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'receiver-owner' })).toString('base64url')}.signature`;
            const verifyMachineAdmissionCurrent = async () => { homeReads++; return true; };
            const captured: { runtime?: ReturnType<typeof createOwnServerDeploymentRuntimeForHost> } = {};
            const createRuntime = ownServerHostRuntime.createOwnServerDeploymentRuntimeForHost;
            vi.spyOn(ownServerHostRuntime, 'createOwnServerDeploymentRuntimeForHost').mockImplementation(host => {
                const runtime = createRuntime(host);
                captured.runtime = runtime;
                return runtime;
            });
            const handlers = new Map<string, RpcHandler>();
            registerDaemonDeploymentChildRpcHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                machineId: fixture.job.machineId, signal,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                resolveRequesterRuntime: ingress => resolveAdmittedRequesterAccountReadRuntime({ ingress,
                    serverId: fixture.profileId, machineId: fixture.job.machineId,
                    installationId: fixture.installed.installationId, isInstalledCurrent: () => !signal.aborted }),
                // Installed credential storage is independent of requester custody.
                resolveInstalledRuntime: async () => ({ serverId: fixture.profileId, machineId: fixture.job.machineId,
                    accountId: 'receiver-owner', credentials: { ...fixture.ann, token }, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
                    isCurrent: async () => { installedReads++; return installedCurrent && !signal.aborted; } }),
                async acquirePluginRuntimeRegistryLease() { return mounted!.lease; },
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD);
            if (!handler) throw new Error('Installed child handler was not registered');
            await expect(handler(fixture.job, { signal, callerInputAuthorization: requester.authorization,
                originalActionEnvelope: fixture.envelope, workspaceSyncSourceExecution: fixture.packet,
                machineAdmission: { actorAccountId: fixture.root.binding.accountId, custodianAccountId: 'receiver-owner',
                    machineId: fixture.job.machineId, installationId: fixture.installed.installationId,
                    role: 'use', encryptionMode }, verifyMachineAdmissionCurrent })).resolves.toMatchObject({
                ok: false, errorCode: 'unsupported_action' });
            if (!captured.runtime) throw new Error('Installed child did not create its real native runtime');
            const runtime = captured.runtime;
            const runtimeRequest: OwnServerDeploymentRuntimeRequest = { ...request,
                executionRole: nativePath === 'member' ? 'runtime' : 'build',
                input: { ...request.input, serverId: fixture.homeIdentityId },
                context: { signal: operationSignal, verifyMachineAdmissionCurrent, externalActionExecutionAuthorization: prepared.authorization,
                    originalActionEnvelope: fixture.envelope, operationAcceptance: { operationId: 'operation', accept() {} } } };
            const installedReadsBeforeAcquisition = installedReads;
            let acquired: Pick<Awaited<ReturnType<typeof runtime.acquire>>, 'exec' | 'nativeIo' | 'release' | 'assertCurrent'>;
            let reacquire: () => Promise<unknown>;
            let cwd: string;
            if (nativePath === 'retention') {
                if (!runtime.acquireRetention) throw new Error('Installed retention runtime is unavailable');
                // Constructed owner-guard input: exact header/source retirement
                // admission remains covered by releaseRetention's owner suite.
                const retentionInput = { request: { ...runtimeRequest, actionId: 'deployments.deploy', input: { ...request.input, serverId: fixture.homeIdentityId }, receipt: { ok: true as const,
                    environmentId: 'environment', revision: 2, deploymentId: 'deployment', deploymentRevision: 1, state: 'succeeded' } },
                    machineId: fixture.job.machineId, installationId: fixture.installed.installationId,
                    settledTargetLinkRevision: 1, settledDeploymentRevision: 1, activeDeploymentId: 'deployment',
                } as const;
                const admitRetention = async () => { retentionAdmissions++; operationSignal.throwIfAborted(); };
                reacquire = () => runtime.acquireRetention!(retentionInput, admitRetention);
                const retained = await runtime.acquireRetention(retentionInput, admitRetention);
                acquired = retained;
                cwd = retained.deploymentRoot;
                await mkdir(cwd, { recursive: true });
            } else {
                const snapshot: Parameters<typeof runtime.acquire>[1] = {
                    deployment: createDeploymentReceiptHeaderV1({ ...receipt.deployment,
                        acceptedExecution: { v: 1,
                            controller: { machineId: fixture.job.machineId, installationId: fixture.installed.installationId },
                            builder: { machineId: fixture.job.machineId, installationId: fixture.installed.installationId } } }),
                    environment: { ...environment,
                        environment: { ...environment.environment, serverId: fixture.homeIdentityId,
                            controllerMachineId: fixture.job.machineId, buildMachineId: fixture.job.machineId },
                        content: { ...environment.content, definition },
                        targetLinks: environment.targetLinks.map(item => ({ ...item, targetLink: { ...item.targetLink,
                            machines: [fixture.job.machineId], members: [{ machineId: fixture.job.machineId,
                                installationId: fixture.installed.installationId, state: 'active' }] } })) },
                    content: { ...receipt.content, sourceIntent: definition,
                        machines: [fixture.job.machineId], buildMachineId: fixture.job.machineId },
                };
                reacquire = () => runtime.acquire(runtimeRequest, snapshot);
                const build = await runtime.acquire(runtimeRequest, snapshot);
                acquired = build;
                cwd = build.buildExecutionDirectory ?? resolveDeploymentSourcePathForHost(build.source);
                await mkdir(cwd, { recursive: true });
            }
            try {
                // The OS identity is authenticated at acquisition. Finite
                // phase custody must not reopen that file for every guard.
                const identityReads = vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mock.calls.length;
                expect.soft(installedReads - installedReadsBeforeAcquisition).toBe(1);
                const installedReadsAfterAcquisition = installedReads;
                await acquired.assertCurrent();
                await acquired.assertCurrent();
                expect(retentionAdmissions).toBe(nativePath === 'retention' ? 1 : 0);
                // Installed credential storage is the OS boundary. Admitted
                // local custody does not reopen it at each source/command guard.
                expect.soft(installedReads - installedReadsAfterAcquisition).toBe(0);
                // The next acquisition starts a new phase and may read installed identity.
                expect.soft(vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mock.calls.length).toBe(identityReads);
                installedCurrent = false;
                await expect(reacquire()).rejects.toMatchObject({ code: 'action_forbidden' });
                expect.soft(installedReads - installedReadsAfterAcquisition).toBe(1);
                installedCurrent = true;
                vi.mocked(installationStore.readInstallationIdentityIfExistsSync).mockReturnValue({ ...fixture.installed,
                    installationId: 'replacement-installation' });
                await expect(reacquire()).rejects.toMatchObject({ code: 'target_mismatch' });
                // Already admitted work retains its captured identity; the
                // changed installation cannot acquire another phase above.
                await acquired.assertCurrent();
                const tool = await acquired.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose' });
                // A finite child was admitted already. Command preparation
                // and its native input check must not re-admit it over Home.
                const launch = async () => authorizePluginExecLaunchForHost(acquired.exec, {
                    executable: tool.executable, cwd, args: ['compose', 'version', '--short'] }, { agentIsolation: null });
                const readsBeforeCommands = homeReads;
                const first = await launch();
                try {
                    await first.recheckInputs?.();
                    const result = await acquired.nativeIo.run({ command: first.command, args: first.args,
                        cwd: first.cwd!, env: first.env, signal });
                    expect(result.exitCode).toBe(0);
                } finally { await first.release(); }
                expect(await docker.readInvocations()).toHaveLength(1);
                expect.soft(homeReads).toBe(readsBeforeCommands);
                const retained = await launch();
                try {
                    await retained.recheckInputs?.();
                    expect((await acquired.nativeIo.run({ command: retained.command, args: retained.args,
                        cwd: retained.cwd!, env: retained.env, signal: operationSignal })).exitCode).toBe(0);
                } finally { await retained.release(); }
                expect.soft(homeReads).toBe(readsBeforeCommands);
                expect(await docker.readInvocations()).toHaveLength(2);
                operation.abort();
                // Do not pass a command signal: the acquired runtime must
                // retain the receiving operation's cancellation itself.
                await expect(acquired.exec.run({ executable: tool.executable, cwd,
                    args: ['compose', 'up', '--detach'] })).rejects.toMatchObject({ code: 'plugin_exec_aborted' });
                expect(await docker.readInvocations()).toHaveLength(2);
            } finally { await acquired.release(); }
        } finally {
            lifetime.abort();
            try { await mounted?.dispose(); }
            finally {
                try { await prepared?.dispose(); }
                finally { try { await channel.close(); } finally { if (root) await rm(root, { recursive: true, force: true }); } }
            }
        }
    });
    it.for(['build', 'runtime'] as const)('reads secret admission once per %s launch phase and re-admits the next phase', async (phase, context) => {
        const lifetime = new AbortController();
        context.onTestFinished(() => lifetime.abort());
        // The runner aborts context.signal on timeout, before restoring spies;
        // an overdue launch must not enter the next case's transport or native IO.
        const signal = AbortSignal.any([context.signal, lifetime.signal]);
        const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
            controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        if (signal.aborted) {
            await mounted.dispose();
            signal.throwIfAborted();
        }
        const keys = nacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const binding = EnvironmentVariableBindingV1Schema.parse({ purpose: 'variable', phase, name: 'PORT',
            source: { kind: 'value', value: '3000' } });
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues', environmentId: 'environment',
            machineId: 'machine', installationId: 'installation', binding: { purpose: 'variable', phase, name: 'PORT' } },
            installationPublicKey: keys.publicKey, content: { kind: 'environmentValues', definition: { kind: 'value', value: '3000' } } });
        let withdrawn = false;
        const network = vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (!config.url?.endsWith('/environment/secret-launch-admission')) throw new Error('Unexpected transport');
            return { status: 200, data: withdrawn ? { ok: false, error: 'secret_missing' }
                : { ok: true, grants: [grant] } };
        });
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-admission-'));
        const docker = await createOwnServerDockerBoundary(join(root, 'bin'));
        if (signal.aborted) {
            try { await mounted.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
            signal.throwIfAborted();
        }
        vi.stubEnv('PATH', `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`);
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const document = 'services: {web: {image: app}}';
        const definition = { kind: 'stored' as const, contentRevision: 2, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] };
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token, encryption: null }, serverId: 'home',
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
            async acquirePluginRuntimeRegistryLease() { return mounted.lease; } });
        try {
            const acquired = await runtime.acquire({ ...request, executionRole: phase,
                context: { signal, operationAcceptance: { operationId: 'operation', accept() {} } } }, {
                deployment: receipt.deployment,
                environment: { ...environment, content: { ...environment.content, definition, bindings: [binding] } },
                content: { ...receipt.content, sourceIntent: definition },
            });
            try {
                // The installed acquisition supplies the lazy producer and
                // refuses an unconfigured backup through its typed contract.
                await expect(acquired.preparePreMigrationBackupOperands?.()).rejects.toMatchObject({ data: { code: 'backup_required' } });
                const source = await createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(), admit: async () => ({ ...acquired.source,
                    deploymentRoot: join(root, 'releases'), artifactDirectory: join(root, 'artifacts'), assertCurrent: acquired.assertSourceCurrent }) })
                    .materialize({ environmentId: 'environment', deploymentId: 'deployment' }, { signal });
                try {
                    const port = createDeploymentExecEnvPortForHost({ source, phase, signal,
                        isCurrent: () => true,
                        prepare: () => prepareEnvironmentSecretBindingsForLaunch({ ...acquired.secrets,
                            environmentId: 'environment', machineId: 'machine', installationId: 'installation', phase,
                            bindings: [binding], assertCurrent: acquired.assertCurrent }) });
                    const tool = await acquired.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose' });
                    expect(tool.executablePath).toBe(docker.executablePath);
                    const cwd = phase === 'build' ? acquired.buildExecutionDirectory! : source.rootPath;
                    const attachment = await port.prepare({ source, phase });
                    const result = await acquired.exec.run({ executable: tool.executable, cwd, deploymentEnv: attachment,
                        args: ['compose', 'version', '--short'] });
                    expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                    // Material preparation, the public Exec path, and P41's
                    // native-helper tuple all consume this phase's admission.
                    await acquired.assertCurrent();
                    const preparedAgain = await port.prepare({ source, phase });
                    const withoutApp = await authorizePluginExecLaunchForHost(acquired.exec, { executable: tool.executable, cwd,
                        args: ['compose', 'version', '--short'] }, { agentIsolation: null });
                    try {
                        await source.assertCurrent();
                        await withoutApp.recheckInputs?.();
                        const nativeResult = await acquired.nativeIo.run({ command: withoutApp.command, args: withoutApp.args,
                            cwd: withoutApp.cwd!, env: withoutApp.env, signal });
                        expect(nativeResult.exitCode).toBe(0);
                    } finally { await withoutApp.release(); }
                    expect(await docker.readInvocations()).toHaveLength(2);
                    expect.soft(network.mock.calls).toHaveLength(1);

                    // A fresh acquisition is the natural phase boundary. Home
                    // uses this same refusal for withdrawn audience/grants and
                    // an installation it has replaced; local guards must not
                    // suppress that next authoritative read.
                    withdrawn = true;
                    const readsBeforeNextPhase = network.mock.calls.length;
                    await expect(runtime.acquire({ ...request, executionRole: phase === 'build' ? 'runtime' : 'build',
                        context: { signal, operationAcceptance: { operationId: 'operation', accept() {} } } }, {
                        deployment: receipt.deployment,
                        environment: { ...environment, content: { ...environment.content, definition, bindings: [binding] } },
                        content: { ...receipt.content, sourceIntent: definition },
                    })).rejects.toMatchObject({ code: 'secret_missing' });
                    expect(network.mock.calls.length - readsBeforeNextPhase).toBe(1);
                    expect(await docker.readInvocations()).toHaveLength(2);
                    // Release is the real finite host boundary, independent of
                    // the parent request signal or a committed source handle.
                    withdrawn = false;
                    await source.commit();
                    await acquired.release();
                    expect(signal.aborted).toBe(false);
                    expect(acquired.secrets.installationPrivateSeed.every(byte => byte === 0)).toBe(true);
                    await expect(acquired.assertCurrent()).rejects.toMatchObject({ code: 'deployment_source_unavailable' });
                    await expect(port.prepare({ source, phase })).rejects.toMatchObject({ code: 'deployment_source_unavailable' });
                    await expect(acquired.exec.run({ executable: tool.executable, cwd, deploymentEnv: preparedAgain,
                        args: ['compose', 'version', '--short'] })).rejects.toThrow();
                    expect(await docker.readInvocations()).toHaveLength(2);
                } finally { await source.abort(); }
            } finally { await acquired.release(); }
        } finally { try { await mounted.dispose(); } finally { await rm(root, { recursive: true, force: true }); } }
    });
    it.each(['deployment', 'restoration', 'review'] as const)('materializes exact deployment facts through installation grants for %s without fabricating unavailable values', async kind => {
        const mounted = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [] } });
        const keys = nacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const bindings = [
            { purpose: 'variable', phase: 'runtime', name: 'ENVIRONMENT_NAME', source: { kind: 'deploymentFact', fact: 'environmentName' } },
            { purpose: 'variable', phase: kind === 'review' ? 'build' : 'runtime', name: 'DEPLOYMENT_ID',
                source: { kind: 'deploymentFact', fact: 'deploymentId' } },
            { purpose: 'variable', phase: 'build', name: 'DATABASE_ENDPOINT',
                source: { kind: 'reference', environmentId: 'data', export: 'database', via: 'privateNetwork' } },
        ].map(binding => EnvironmentVariableBindingV1Schema.parse(binding));
        const grants = bindings.map(binding => {
            if (binding.source.kind === 'secret') throw new Error('Non-secret fixture required');
            return sealMachineSecretGrant({ subject: {
                v: 1, kind: 'environmentValues', environmentId: 'environment', machineId: 'machine', installationId: 'installation',
                binding: { purpose: 'variable', phase: binding.phase, name: binding.name },
            }, installationPublicKey: keys.publicKey, content: { kind: 'environmentValues', definition: binding.source } });
        });
        // The Home HTTP boundary admits the installation; sealing, opening,
        // exact definitions and phase selection remain the real P42 path.
        const materializations: unknown[] = [];
        const network = vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (!config.url?.endsWith('/environment/secret-launch-admission')) throw new Error('Unexpected source or native read');
            materializations.push(config.data.materialization);
            return { status: 200, data: { ok: true, grants } };
        });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const document = 'services: {web: {image: app}}';
        const definition = { kind: 'stored' as const, contentRevision: 2, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] };
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token, encryption: null }, serverId: 'home',
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
            async acquirePluginRuntimeRegistryLease() { return mounted.lease; } });
        try {
            const admittedEnvironment = { ...environment, content: { ...environment.content, definition, bindings } };
            const materialization = kind === 'review' ? { kind: 'review' as const, contentArtifactId: 'candidate-artifact' }
                : kind === 'restoration' ? { kind: 'restoration' as const, deploymentId: 'failed-operation', sourceDeploymentId: 'selected-receipt' }
                    : request.materialization;
            const acquired = await runtime.acquire({ ...request,
                materialization,
                context: { operationAcceptance: { operationId: 'operation', accept() {} } } }, {
                deployment: { ...receipt.deployment, id: kind === 'restoration' ? 'failed-operation' : receipt.deployment.id,
                    actionOperationId: kind === 'restoration' ? 'original-operation' : receipt.deployment.actionOperationId },
                environment: admittedEnvironment,
                content: { ...receipt.content, sourceIntent: definition },
            });
            try {
                expect(materializations).toEqual([kind === 'review' ? { kind: 'review', contentArtifactId: 'candidate-artifact' }
                    : { kind: 'deployment', deploymentId: kind === 'restoration' ? 'failed-operation' : 'deployment',
                        actionOperationId: kind === 'restoration' ? 'original-operation' : 'operation' }]);
                admittedEnvironment.content.name = 'Renamed after acquisition';
                const prepare = (phase: 'build' | 'runtime') => prepareEnvironmentSecretBindingsForLaunch({ ...acquired.secrets,
                    environmentId: 'environment', machineId: 'machine', installationId: 'installation',
                    phase, bindings, assertCurrent: acquired.assertCurrent });
                const readsBefore = network.mock.calls.length;
                const material = await prepare('runtime');
                try {
                    expect(material.env).toEqual({ ENVIRONMENT_NAME: 'Staging', ...(kind === 'review' ? {}
                        : { DEPLOYMENT_ID: kind === 'restoration' ? 'selected-receipt' : 'deployment' }) });
                    // Acquisition spent the phase admission; its captured facts
                    // do not acquire the same authority again during preparation.
                    expect(network.mock.calls.length - readsBefore).toBe(0);
                }
                finally { material.dispose(); }
                await expect(prepare('build')).rejects.toMatchObject({ code: 'reference_unavailable' });
            } finally { await acquired.release(); }
        } finally { await mounted.dispose(); }
    });
    it.for(['machine', 'remote'] as const)('resolves exact private references from retained published mappings on %s and refuses stale or unrelated facts', async sourceMachineId => {
        const mounted = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [] } });
        const keys = nacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const document = 'services: {db: {image: database}}';
        const definition = { kind: 'stored' as const, contentRevision: 1, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['db'] };
        const exported = { key: 'database', service: 'db', containerPort: 5432, scheme: 'postgres',
            exposure: 'privateNetwork' as const, privateNetwork: 'tailnet-exact' };
        const sourceEnvironment = { ...environment, environment: { ...environment.environment, id: 'data',
            runtimeTargetLinkId: 'data-link' }, content: { ...environment.content, definition,
            ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: false, serviceExports: [exported] } },
            targetLinks: [{ ...environment.targetLinks[0]!, targetLink: { ...environment.targetLinks[0]!.targetLink,
                id: 'data-link', environmentId: 'data', machines: [sourceMachineId],
                members: [{ machineId: sourceMachineId, installationId: 'installation', state: 'active' as const }], activeDeploymentId: 'data-deployment' } }] };
        let readable = true;
        let nativeFacts: ProjectNativeRuntimeFacts = { configuration: { name: 'db', replicas: null,
            resources: { cpus: null, memory: null }, restartPolicy: 'unless-stopped', healthcheck: 'absent', mounts: [],
            ports: [{ target: 5432, published: 15432, bindAddress: '127.0.0.1', protocol: 'tcp' },
                { target: '5432', published: '25432', bindAddress: '100.64.0.7', protocol: 'tcp' },
                { target: 5432, published: 35432, bindAddress: '100.64.0.7', protocol: 'udp' }] },
            observedAt: 123, freshness: 'current' };
        const binding = EnvironmentVariableBindingV1Schema.parse({ purpose: 'variable', phase: 'runtime', name: 'DATABASE_URL',
            source: { kind: 'reference', environmentId: 'data', export: 'database', via: 'privateNetwork' } });
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues', environmentId: 'environment',
            machineId: 'machine', installationId: 'installation', binding: { purpose: 'variable', phase: 'runtime', name: 'DATABASE_URL' } },
            installationPublicKey: keys.publicKey, content: { kind: 'environmentValues', definition: binding.source } });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        let privateAddress = '100.64.0.7';
        let networkState = 'ready';
        const http = vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (config.url?.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [grant] } };
            throw new Error('Unexpected HTTP request');
        });
        // OS/native facts and Home are the boundaries; source opening, owner
        // selection, retained projection and P42 grant preparation remain real.
        const machineHttp = vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/encryption-mode')) return { status: 200, data: { mode: 'plain' } };
            const machineId = String(url).endsWith('/v1/machines/remote') ? 'remote' : 'machine';
            if (!String(url).endsWith(`/v1/machines/${machineId}`)) throw new Error('Unexpected Machine read');
            return { status: 200, data: { machine: { id: machineId, kind: 'persistent', revokedAt: null, replacedByMachineId: null, seq: 1, active: true, activeAt: 1,
                createdAt: 1, updatedAt: 1, metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'fixture', platform: 'linux',
                    happyCliVersion: '0.0.0', homeDir: mounted.happyHomeDir, happyHomeDir: mounted.happyHomeDir })), metadataVersion: 1,
                daemonState: encodePlainMachineStoredContent({ status: 'running', reachability: { revision: 1, management: { daemon: 'ready', providers: [], publicSsh: 'closed' },
                    privateNetworks: [{ provider: { kind: 'builtin', id: 'tailscale' }, networkIdentity: 'tailnet-exact',
                        displayName: null, dnsName: null, addresses: [privateAddress], state: networkState, interfaceName: 'tailscale0',
                        sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: false }], ingress: [] } }),
                daemonStateVersion: 1, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, installationId: 'installation' } } };
        });
        const { environmentInstanceId, homeServerIdentityId } = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
            serverId: 'home', environmentId: 'data' });
        const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
            return { environmentId: 'data', environmentInstanceId, deploymentId: 'data-deployment', machineId: sourceMachineId,
                installationId: 'installation', deploymentRoot: join(mounted.happyHomeDir, 'deployments'),
                artifactDirectory: join(mounted.happyHomeDir, 'artifacts'), definition, async assertCurrent() {} };
        } });
        const release = await materializer.materialize({ environmentId: 'data', deploymentId: 'data-deployment' });
        await release.commit();
        try {
            const service = await mounted.lease.registry.projectManagedServices.superviseProject({ kind: 'environment', serverId: homeServerIdentityId, machineId: sourceMachineId,
                environmentId: 'data', environmentInstanceId, deploymentId: 'data-deployment', release, composeService: 'db',
                serviceId: `${environmentInstanceId}/db`, specIdentity: 'db', isCurrent: () => true,
                releaseObservation: async () => {}, nativeEffects: { keys: [] }, processSpec: { mode: { kind: 'native', builtinLifecycle: {
                    async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                    runtimeFacts() { return nativeFacts; }, async stop() { return { status: 'stopped' }; },
                } } } });
            serviceReferenceSocket.io.mockImplementation(() => createApiSessionSocketStub({
                emitWithAck(event, payload) {
                    expect(event).toBe('rpc-call');
                    expect(payload).toMatchObject({ method: 'remote:machines.services.list',
                        params: { environmentId: 'data', machineId: 'remote', serverId: 'home' } });
                    return { ok: true, result: { kind: 'snapshot', services: [mounted.lease.registry.projectManagedServices.machineServiceRows.read(service)] } };
                },
            }));
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token, encryption: null }, serverId: 'home',
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
                serverHttpBaseUrl: 'https://home.test', machineId: 'machine', async acquirePluginRuntimeRegistryLease() { return mounted.lease; } });
            const acquired = await runtime.acquire(request, { environment: { ...environment, content: { ...environment.content, definition, bindings: [binding],
                    ownServer: { rollout: 'recreate', autoRestorePreviousRelease: false, serviceExports: [exported] } } },
                content: { ...receipt.content, sourceIntent: definition }, deployment: receipt.deployment,
                readReferenceEnvironment: async request => {
                    const result = await readDeploymentEnvironmentForHost(request, {
                        async readMetadata({ environmentId }) { expect(environmentId).toBe('data');
                            if (!readable) throw Object.assign(new Error('denied'), { code: 'deployment_access_denied' });
                            return { ok: true, environment: sourceEnvironment.environment,
                                targetLinks: sourceEnvironment.targetLinks.map(link => link.targetLink) }; },
                        async open() { return { artifactId: 'artifact', revision: { headerVersion: 1, bodyVersion: 1 },
                            header: { kind: 'deployment-environment.v1', title: 'Data' }, body: JSON.stringify(sourceEnvironment.content) }; },
                        async assertCurrent() {},
                    });
                    return { ...result, targetLinks: sourceEnvironment.targetLinks };
                } });
            try {
                const prepare = () => prepareEnvironmentSecretBindingsForLaunch({ ...acquired.secrets,
                    environmentId: 'environment', machineId: 'machine', installationId: 'installation', phase: 'runtime',
                    bindings: [binding], assertCurrent: acquired.assertCurrent });
                const value = await prepare();
                try {
                    expect(value.env.DATABASE_URL).toBe('postgres://100.64.0.7:25432');
                    expect(value.referenceAddresses).toEqual([{ machineId: 'machine', installationId: 'installation',
                        phase: 'runtime', name: 'DATABASE_URL', source: binding.source, address: 'postgres://100.64.0.7:25432' }]);
                } finally { value.dispose(); }
                const readsBeforeDns = machineHttp.mock.calls.length;
                expect(await acquired.secrets.resolveNonSecret!({ kind: 'reference', environmentId: 'environment',
                    export: 'database', via: 'auto' })).toBe('postgres://db:5432');
                expect(machineHttp.mock.calls.length - readsBeforeDns).toBe(0);
                nativeFacts = { ...nativeFacts, freshness: 'unavailable' };
                await expect(prepare()).rejects.toMatchObject({ code: 'reference_unavailable' });
                nativeFacts = { ...nativeFacts, freshness: 'current' };
                networkState = 'stopped';
                await expect(prepare()).rejects.toMatchObject({ code: 'reference_unavailable' });
                networkState = 'ready'; privateAddress = '100.64.0.8';
                await expect(prepare()).rejects.toMatchObject({ code: 'reference_unavailable' });
                privateAddress = '100.64.0.7';
                sourceEnvironment.targetLinks[0]!.targetLink.activeDeploymentId = 'replacement';
                const partial = await prepare();
                try { expect(partial.env.DATABASE_URL).toBe('postgres://100.64.0.7:25432'); }
                finally { partial.dispose(); }
                sourceEnvironment.targetLinks[0]!.targetLink.activeDeploymentId = 'data-deployment'; readable = false;
                await expect(prepare()).rejects.toMatchObject({ code: 'deployment_access_denied' });
                expect(http.mock.calls.filter(([config]) => config.url?.endsWith('/secret-launch-admission'))).toHaveLength(1);
            } finally { await acquired.release(); }
        } finally { try { await mounted.dispose(); } finally { await release.abort(); } }
        expect(machineHttp).toHaveBeenCalled();
    });
    it.for(['deployment', 'restoration'] as const)('acquires the exact stored snapshot for %s without Source checkout or SCM reads', async (kind, context) => {
        const mounted = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [] } });
        const keys = nacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const network = vi.spyOn(axios, 'request').mockImplementation(async () => { throw new Error('Stored source must not read SCM or workspace rows'); });
        const document = 'services: {web: {image: app}}';
        const definition = { kind: 'stored' as const, contentRevision: 2, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] };
        const archive = { image: { service: 'web', platform: 'linux/amd64', configDigest: `sha256:${'a'.repeat(64)}`,
            manifestDigest: `sha256:${'b'.repeat(64)}` }, sizeBytes: 1024, sha256: 'c'.repeat(64),
            holder: { serverId: 'home', machineId: 'holder', installationId: 'holder-installation', rootPath: '/retained', path: '/retained/image.tar' } };
        const admissions: unknown[] = [];
        const registryUse = { purpose: 'registry', targetLinkId: 'link', registryOrigin: 'https://registry.example.test', access: 'pull',
            source: { kind: 'secret', ref: 'happier:shared-secret:v1:registry', resourceRevision: 1 } } as const satisfies EnvironmentSecretBindingV1;
        const registryGrant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment',
            machineId: 'machine', installationId: 'installation', resourceId: 'registry', resourceRevision: 1 },
            installationPublicKey: keys.publicKey,
            content: { kind: 'secret', value: JSON.stringify({ username: 'deploy', password: 'current-registry-sentinel' }) } });
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'token', encryption: null }, serverId: 'home',
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
            async readEnvironmentSecretLaunchAdmission(input) {
                admissions.push(input.materialization);
                return { grants: [registryGrant], async assertCurrent() {} };
            },
            async acquirePluginRuntimeRegistryLease() { return mounted.lease; } });
        try {
            const acquired = await runtime.acquire({ ...request, ...(kind === 'restoration' ? {
                materialization: { kind: 'restoration', deploymentId: 'deployment', sourceDeploymentId: 'uniform' },
            } : {}) }, { deployment: receipt.deployment,
                environment: { ...environment, content: { ...environment.content, definition, bindings: [registryUse] } },
                content: { ...receipt.content, sourceIntent: definition, images: [archive.image], ownServer: { imageArchives: [archive],
                    approvedInputBasis: { v: 1, environmentId: 'environment', environmentRevision: 2, targetLinkId: 'link', targetLinkRevision: 1,
                        sourceIntent: definition, members: [{ machineId: 'machine', installationId: 'installation' }], bindings: [], images: [archive.image],
                        manifestFingerprint: definition.composeDigest, configInputDigests: [], physicalProjectName: 'physical', toolVersion: '2.40.1',
                        services: ['web'], profiles: [] } } } });
            let registryDirectory: string | undefined;
            let neighboringDirectory: string | undefined;
            try {
                expect(acquired.source).toMatchObject({ definition });
                expect(acquired.source.deploymentId).toBe(kind === 'restoration' ? 'uniform' : 'deployment');
                expect(acquired.source.restorationForDeploymentId).toBe(kind === 'restoration' ? 'deployment' : undefined);
                expect(admissions).toEqual([{ kind: 'deployment', deploymentId: 'deployment' }]);
                expect(acquired.source).not.toHaveProperty('commitSha');
                expect(acquired.source).not.toHaveProperty('sourcePath');
                await acquired.assertCurrent();
                // A stored snapshot can run local/registry acquisition without a
                // transport profile, but archive demand cannot borrow ambient credentials.
                await expect(acquired.copyDeploymentImageArchive!({ archive, signal: new AbortController().signal,
                    async assertCurrent() {} })).rejects.toMatchObject({ code: 'filesystem_transfer_custody_required' });
                expect(network).not.toHaveBeenCalled();
                // Abandonment before a prepared attachment is consumed still
                // belongs to this finite runtime, not another daemon's config.
                expect(acquired.secrets.registryConfigBaseDir).toEqual(expect.any(String));
                neighboringDirectory = await mkdtemp(join(dirname(acquired.secrets.registryConfigBaseDir!), 'neighbor-fixture-'));
                await writeFile(join(neighboringDirectory, 'keep'), 'neighbor-owned');
                const material = await prepareEnvironmentSecretBindingsForLaunch({ ...acquired.secrets,
                    environmentId: 'environment', machineId: 'machine', installationId: 'installation',
                    bindings: [registryUse], use: registryUse, assertCurrent: acquired.assertCurrent });
                registryDirectory = material.env.DOCKER_CONFIG;
                expect(await readdir(registryDirectory)).toEqual(['config.json']);
                expect(JSON.parse(await readFile(join(registryDirectory, 'config.json'), 'utf8'))).toEqual({ auths: {
                    'registry.example.test': { auth: Buffer.from('deploy:current-registry-sentinel').toString('base64') },
                } });
                if (kind === 'deployment') {
                    // The actual native IO supervisor, not a mocked settlement,
                    // must retain this config until its process has stopped.
                    const controller = new AbortController();
                    const signal = AbortSignal.any([controller.signal, context.signal]);
                    // Readiness is a filesystem fact: short output is buffered
                    // by the real secret streaming sanitizer until it can emit.
                    const readiness = watch(registryDirectory, { signal });
                    const started = (async () => {
                        for await (const event of readiness) {
                            if (event.filename === 'native-ready') return;
                        }
                    })();
                    const redaction = createProviderRedactionLease({ values: material.secretValues });
                    const running = acquired.nativeIo.run({ command: process.execPath,
                        args: ['-e', 'const fs=require("node:fs"),path=require("node:path");fs.accessSync(path.join(process.env.DOCKER_CONFIG,"config.json"));fs.writeFileSync(path.join(process.env.DOCKER_CONFIG,"native-ready"),"");setInterval(()=>{},1000)'],
                        cwd: registryDirectory, env: material.env, signal,
                        output: { redaction, onChunk() {} } });
                    const stopped = expect(running).rejects.toMatchObject({ code: 'plugin_exec_aborted' });
                    try {
                        await Promise.race([started, running.then(() => { throw new Error('Native process exited before readiness'); })]);
                        let released = false;
                        const releasing = acquired.release().then(() => { released = true; });
                        await access(join(registryDirectory, 'config.json'));
                        expect(released).toBe(false);
                        controller.abort();
                        await stopped;
                        await releasing;
                    } finally { controller.abort(); await stopped; redaction.close(); }
                }
            } finally {
                try {
                    await acquired.release();
                    if (registryDirectory) await expect(access(registryDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
                    if (neighboringDirectory) expect(await readFile(join(neighboringDirectory, 'keep'), 'utf8')).toBe('neighbor-owned');
                } finally { if (neighboringDirectory) await rm(neighboringDirectory, { recursive: true, force: true }); }
            }
        } finally { await mounted.dispose(); }
    });
    it('keeps the accepted builder installation after future placement changes without granting runtime membership', async () => {
        const mounted = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [] } });
        const keys = nacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'builder-installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const document = 'services: {web: {image: app}}';
        const definition = { kind: 'stored' as const, contentRevision: 2, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web'] };
        const deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment,
            acceptedExecution: { v: 1, controller: { machineId: 'machine', installationId: 'installation' },
                builder: { machineId: 'builder', installationId: 'builder-installation' } } });
        const snapshot = { deployment, environment: { ...environment, environment: { ...environment.environment, buildMachineId: 'builder' },
            content: { ...environment.content, definition } }, content: { ...receipt.content, buildMachineId: 'builder', sourceIntent: definition } };
        // Home HTTP is the boundary; installed acquisition, source admission,
        // secret reader and registry lifetime remain their real implementation.
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (!config.url?.endsWith('/environment/secret-launch-admission')) throw new Error('Unexpected transport');
            return { status: 200, data: { ok: true, grants: [] } };
        });
        const capturedRequest = { ...request, executionRole: 'build' as const,
            context: { operationAcceptance: { operationId: deployment.actionOperationId, accept() {} } } };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token, encryption: null }, serverId: 'home',
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            serverHttpBaseUrl: 'https://home.test', machineId: 'builder',
            async acquirePluginRuntimeRegistryLease() { return mounted.lease; } });
        try {
            await expect(runtime.acquire(request, snapshot)).rejects.toMatchObject({ code: 'target_mismatch' });
            const acquired = await runtime.acquire(capturedRequest, snapshot);
            let buildDirectory: string | undefined;
            try {
                expect(acquired.source).toMatchObject({ machineId: 'builder', installationId: 'builder-installation', definition });
                buildDirectory = acquired.buildExecutionDirectory;
                expect(buildDirectory).toEqual(expect.any(String));
                expect(await readdir(buildDirectory!)).toEqual([]);
                expect(buildDirectory).not.toContain(join('releases', acquired.source.deploymentId));
                await acquired.assertCurrent();
            } finally { await acquired.release(); }
            await expect(access(buildDirectory!)).rejects.toMatchObject({ code: 'ENOENT' });
            const moved = { ...snapshot, environment: { ...snapshot.environment, environment: {
                ...snapshot.environment.environment, buildMachineId: 'another-builder', revision: environment.environment.revision + 1,
            } } };
            const retained = await runtime.acquire(capturedRequest, moved);
            try {
                expect(retained.source).toMatchObject({ machineId: 'builder', installationId: 'builder-installation', definition });
                await retained.assertCurrent();
            } finally { await retained.release(); }
            const changedInstallation = { ...deployment, acceptedExecution: { ...deployment.acceptedExecution!,
                builder: { machineId: 'builder', installationId: 'replacement-installation' } } };
            await expect(runtime.acquire(capturedRequest, { ...moved, deployment: changedInstallation }))
                .rejects.toMatchObject({ code: 'target_mismatch' });
            const substitutedBuilder = { ...deployment, acceptedExecution: { ...deployment.acceptedExecution!,
                builder: { machineId: 'another-builder', installationId: 'another-installation' } } };
            await expect(runtime.acquire(capturedRequest, { ...moved, deployment: substitutedBuilder }))
                .rejects.toMatchObject({ code: 'target_mismatch' });
            const uncaptured = { ...deployment, acceptedExecution: undefined };
            await expect(runtime.acquire(capturedRequest, { ...moved, deployment: uncaptured }))
                .rejects.toMatchObject({ code: 'target_mismatch' });
            await expect(runtime.acquire(capturedRequest, { ...moved, content: { ...moved.content, buildMachineId: 'another-builder' } }))
                .rejects.toMatchObject({ code: 'target_mismatch' });
        } finally { await mounted.dispose(); }
    });

    it.each([false, true])('resolves the admitted Source checkout and borrows its owner with PR selector %s', async pullRequest => {
        const sourceRequester = physicalOwnerSourceRequester();
        const mounted = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [] } });
        const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-host-pr-source-'));
        try {
        const checkout = join(sourceRoot, 'checkout');
        const base = join(sourceRoot, 'base.git');
        const cloneUrl = 'https://github.com/owner/source.git';
        const git = (args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
        await mkdir(checkout);
        git(['init', '--quiet']);
        git(['config', 'user.name', 'Host Source Fixture']);
        git(['config', 'user.email', 'host-source@example.test']);
        await writeFile(join(checkout, 'compose.yaml'), 'services: {web: {image: approved-H}}');
        git(['add', '.']); git(['commit', '--quiet', '-m', 'H']);
        const approvedSha = git(['rev-parse', 'HEAD']);
        git(['init', '--bare', '--quiet', base]);
        git(['remote', 'add', 'base', cloneUrl]);
        git(['config', `url.${pathToFileURL(base).href}.insteadOf`, cloneUrl]);
        git(['push', 'base', `${approvedSha}:refs/pull/7/head`]);
        await writeFile(join(checkout, 'compose.yaml'), 'services: {web: {image: base-B}}');
        git(['add', '.']); git(['commit', '--quiet', '-m', 'B']);
        const baseSha = git(['rev-parse', 'HEAD']);
        const installationKeys = nacl.sign.keyPair();
        const installed = { version: 1 as const, installationId: 'installation', createdAt: 1,
            publicKey: Buffer.from(installationKeys.publicKey).toString('base64url'), privateKey: Buffer.from(installationKeys.secretKey).toString('base64url') };
        const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installed);
        const binding = EnvironmentVariableBindingV1Schema.parse({ purpose: 'variable', phase: 'runtime', name: 'COMMIT_SHA',
            source: { kind: 'deploymentFact', fact: 'commitSha' } });
        if (binding.source.kind !== 'deploymentFact') throw new Error('Deployment fact fixture required');
        const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues', environmentId: 'environment',
            machineId: 'machine', installationId: 'installation',
            binding: { purpose: 'variable', phase: binding.phase, name: binding.name } }, installationPublicKey: installationKeys.publicKey,
            content: { kind: 'environmentValues', definition: binding.source } });
        mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'checkout', serverId: 'home',
            machineId: 'machine', rootPath: checkout, source: { sourceId: 'source', revision: 1 }, createdAtMs: 1 })]);
        let privateReads = 0;
        let sourceReads = 0;
        let sourceCurrentRevision = 1;
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (config.url?.endsWith('/secret-launch-admission')) {
                privateReads++;
                return { status: 200, data: { ok: true, grants: [grant] } };
            }
            sourceReads++;
            return { status: 200, data: { ok: true, canManage: true,
            source: { id: 'source', revision: sourceCurrentRevision, name: 'Source', audience: [], createdByAccountId: 'owner',
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'owner/source', cloneUrl: 'https://github.com/owner/source.git' }, protocol: 'https' } } } };
        });
        const nativeRoot = await mkdtemp(join(tmpdir(), 'happier-runtime-tools-'));
        const docker = await createOwnServerDockerBoundary(nativeRoot);
        vi.stubEnv('PATH', `${nativeRoot}${delimiter}${process.env.PATH ?? ''}`);
        vi.stubEnv('COMPOSE_PROJECT_NAME', 'unreviewed-ambient-project');
        vi.stubEnv('RUNTIME_SECRET', 'unreviewed-ambient-secret');
        try {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token, encryption: null }, serverId: 'home',
                serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
                resolveRequesterIdentity: sourceRequester.resolveRequesterIdentity,
                async acquirePluginRuntimeRegistryLease() { return mounted.lease; },
            });
            const sourceIntent = receipt.content.sourceIntent;
            if (sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
            const admittedIntent = { ...sourceIntent, sha: approvedSha, ...(pullRequest ? { pullRequestHead: { number: 7 } } : {}) };
            const acquired = await runtime.acquire({ ...request, context: sourceRequester.context },
                { deployment: receipt.deployment, environment: { ...environment, content: { ...environment.content, bindings: [binding] } },
                    content: { ...receipt.content, sourceIntent: admittedIntent } });
            try {
            expect(privateReads).toBeGreaterThan(0);
            const beforeSourceWitness = privateReads;
            expect(sourceReads).toBe(1);
            await acquired.assertSourceCurrent();
            sourceCurrentRevision = 2;
            await expect(acquired.assertSourceCurrent()).resolves.toBeUndefined();
            expect(sourceReads).toBe(1);
            await expect(runtime.acquire({ ...request, context: sourceRequester.context },
                { deployment: receipt.deployment, environment, content: { ...receipt.content, sourceIntent: admittedIntent } }))
                .rejects.toMatchObject({ code: 'deployment_conflict' });
            expect(sourceReads).toBe(2);
            expect(privateReads).toBe(beforeSourceWitness);
            sourceCurrentRevision = 1;
            expect(acquired.projectManagedServices).toBe(mounted.registry.projectManagedServices);
            expect(acquired.source).toMatchObject({ sourcePath: checkout, commitSha: approvedSha,
                environmentId: 'environment', deploymentId: 'deployment', installationId: 'installation' });
            if (pullRequest) expect(acquired.source).toMatchObject({ pullRequestHead: { number: 7 },
                repository: { repository: { nameWithOwner: 'owner/source' } } });
            const sourcePort = createDeploymentSourceMaterializationPort({ registry: createDeploymentGitRegistry(),
                async admit() { return { ...acquired.source, deploymentRoot: join(sourceRoot, 'releases'),
                    artifactDirectory: join(sourceRoot, 'artifacts'), assertCurrent: acquired.assertSourceCurrent }; } });
            const selectedSource = await sourcePort.materialize({ environmentId: 'environment', deploymentId: 'deployment' });
            try { expect(await readFile(join(selectedSource.rootPath, 'compose.yaml'), 'utf8')).toContain('approved-H'); }
            finally { await selectedSource.abort(); }
            if (pullRequest) {
                git(['push', '--force', 'base', `${baseSha}:refs/pull/7/head`]);
                await expect(sourcePort.materialize({ environmentId: 'environment', deploymentId: 'deployment' }))
                    .rejects.toMatchObject({ code: 'approval_stale' });
            }
            expect(git(['rev-parse', 'HEAD'])).toBe(baseSha);
            expect(acquired.secrets).not.toHaveProperty('credentials');
            expect(acquired.secrets).not.toHaveProperty('encryption');
            admittedIntent.sha = 'b'.repeat(40);
            const material = await prepareEnvironmentSecretBindingsForLaunch({ ...acquired.secrets,
                environmentId: 'environment', machineId: 'machine', installationId: 'installation',
                phase: 'runtime', bindings: [binding], assertCurrent: acquired.assertCurrent });
            try { expect(material.env).toEqual({ COMMIT_SHA: acquired.source.commitSha }); }
            finally { material.dispose(); }
            const tool = await acquired.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose' });
            expect(tool.executablePath).toBe(docker.executablePath);
            const releasePath = join(acquired.source.deploymentRoot, acquired.source.environmentInstanceId, 'releases', acquired.source.deploymentId);
            await mkdir(releasePath, { recursive: true });
            const launch = await authorizePluginExecLaunchForHost(acquired.exec, { executable: tool.executable,
                args: ['compose', 'version', '--short'],
                cwd: releasePath }, { agentIsolation: null });
            try {
                expect(launch.env.HOME).toBe(homedir());
                expect(launch.env.PATH).toBe(process.env.PATH);
                expect(launch.env.COMPOSE_PROJECT_NAME).toBeUndefined();
                expect(launch.env.RUNTIME_SECRET).toBeUndefined();
                await launch.recheckInputs?.();
                expect(sourceReads).toBe(2);
            } finally { await launch.release(); }
            const beforeInstallationWitness = privateReads;
            identity.mockReturnValue({ ...installed, installationId: 'replacement' });
            await acquired.assertSourceCurrent();
            expect(privateReads).toBe(beforeInstallationWitness);
            await acquired.assertCurrent();
            await acquired.release();
            await acquired.release();
            expect(acquired.secrets.installationPrivateSeed.every(value => value === 0)).toBe(true);
            } finally { await acquired.release(); }
        } finally { await rm(nativeRoot, { recursive: true, force: true }); }
        } finally { try { await mounted.dispose(); } finally { await rm(sourceRoot, { recursive: true, force: true }); } }
    });
    it('refuses a changed Source before acquiring native or managed-service custody', async () => {
        const sourceRequester = physicalOwnerSourceRequester();
        // HTTP and the installed-identity file are genuine system boundaries.
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.alloc(32).toString('base64url'),
            privateKey: Buffer.alloc(64).toString('base64url') });
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, canManage: true,
            source: { id: 'source', revision: 2, name: 'Source', audience: [], createdByAccountId: 'owner',
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'owner/source', cloneUrl: 'https://github.com/owner/source.git' }, protocol: 'https' } } } });
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'token', encryption: null }, serverId: 'home',
            serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
            resolveRequesterIdentity: sourceRequester.resolveRequesterIdentity,
            async readEnvironmentSecretLaunchAdmission() { throw new Error('No secret admission for stale Source'); },
            async acquirePluginRuntimeRegistryLease() { throw new Error('Native runtime must remain untouched for stale Source'); } });
        await expect(runtime.acquire({ ...request, context: sourceRequester.context }, { deployment: receipt.deployment, environment,
            content: receipt.content })).rejects.toMatchObject({ code: 'deployment_conflict' });
    });

    it('refuses a receipt Source substituted from another Environment before network reads', async () => {
        const network = vi.spyOn(axios, 'request');
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: { token: 'token', encryption: null }, serverId: 'home',
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            serverHttpBaseUrl: 'https://home.test', machineId: 'machine',
            async readEnvironmentSecretLaunchAdmission() { throw new Error('No secret admission for another Source'); },
            async acquirePluginRuntimeRegistryLease() { throw new Error('No registry acquisition is authorized'); } });
        if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
        await expect(runtime.acquire(request, { environment,
            content: { ...receipt.content,
                sourceIntent: { ...receipt.content.sourceIntent, projectSourceId: 'another-source' } } }))
            .rejects.toMatchObject({ code: 'target_mismatch' });
        expect(network).not.toHaveBeenCalled();
    });
});
