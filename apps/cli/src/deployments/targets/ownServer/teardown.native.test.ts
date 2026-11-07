import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { nativeCaddyImage } from '@happier-dev/cli-common/machineSetup';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { DeploymentChildRpcV1Schema, type DeploymentChildRpcV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import * as installationStore from '@/daemon/identity/store';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { createOwnServerTeardownForHost } from './teardown';

// The canonical executable Docker fixture uses a POSIX shebang.
it.skipIf(process.platform === 'win32').each(['remote-native', 'remote-caddy', 'remote-caddy-other-endpoint', 'remote-observation-denied', 'never-deployed', 'other-link', 'missing-tool', 'engine-unreachable', 'observation-denied', 'removal-denied'] as const)(
    'settles native teardown truthfully: %s', async (scenario) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-teardown-cause-'));
        const originalHome = configuration.happyHomeDir;
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const remote = scenario.startsWith('remote-');
        if (remote) environment.environment.controllerMachineId = 'controller-machine';
        link.machines = ['machine-a'];
        link.members = [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }];
        delete link.activeDeploymentId;
        if (scenario === 'other-link') environment.targetLinks.push({ ...environment.targetLinks[0], targetLink: {
            ...structuredClone(link), id: 'retained-target-link',
        } });
        const prior = createDeploymentReceiptDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        receipt.deployment = { ...receipt.deployment, operation: 'teardown', state: 'queued', revision: 1,
            environmentId: environment.environment.id, targetLinkId: link.id };
        receipt.content = DeploymentOwnServerContentV1Schema.parse({ ...receipt.content, teardown: {
            reason: 'manual', targetLinkRevision: link.revision,
            machines: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            resources: [{ id: environment.environment.id, kind: 'workload', machineId: 'machine-a', ownership: 'owned', disposition: 'remove' }], proofs: [],
        } });
        const credentials = { token: 'test-token', encryption: null };
        // Substitute persisted Home/installation records and the OS process port only.
        // Tool lookup, native runtime, own-server boundary and receipt continuation are real.
        const settings = await persistence.readSettings();
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: {
            id: 'home', name: 'Home', serverUrl: 'https://teardown-home.test', webappUrl: 'https://teardown-home.test',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_teardown_home',
                canonicalServerUrl: 'https://teardown-home.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://teardown-home.test' }] }),
        } } });
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation-a', createdAt: 1, publicKey: '', privateKey: '' });
        try {
            Reflect.set(configuration, 'happyHomeDir', root);
            const tools = join(root, 'tools');
            const processFailure = scenario.endsWith('denied') || scenario === 'engine-unreachable';
            const caddy = scenario.startsWith('remote-caddy');
            const caddyId = 'c'.repeat(64);
            const docker = scenario === 'remote-native' || caddy ? await createOwnServerDockerBoundary(tools, caddy ? {
                nativeCaddy: { Id: caddyId, Name: '/happier-caddy',
                    Config: { Image: nativeCaddyImage, Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'],
                        Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' } },
                    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Mounts: [] },
                    State: { Running: true, Status: 'running' },
                    NetworkSettings: { Networks: { app: { NetworkID: 'owned-network' }, sibling: { NetworkID: 'foreign-network' } } } },
            } : undefined) : undefined;
            if (processFailure) await createOwnServerDockerBoundary(tools);
            vi.stubEnv('PATH', processFailure || docker ? `${tools}${delimiter}${process.env.PATH ?? ''}` : tools);
            const nativeRuntime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home',
                serverHttpBaseUrl: 'https://teardown-home.test', machineId: 'machine-a',
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                async acquirePluginRuntimeRegistryLease() { throw new Error('Teardown must not acquire source runtime'); } });
            const runtime = { ...nativeRuntime, acquireTeardown: async (...args: Parameters<NonNullable<typeof nativeRuntime.acquireTeardown>>) => {
                    const native = await nativeRuntime.acquireTeardown!(...args);
                    if (docker) await mkdir(native.deploymentRoot, { recursive: true });
                    if (!processFailure) return native;
                    await mkdir(native.deploymentRoot, { recursive: true });
                    let inventories = 0;
                    const run: typeof native.nativeIo.run = async request => {
                        if (request.args[0] === 'info') return { exitCode: 0, stdout: JSON.stringify({ ID: 'engine-a', OperatingSystem: 'Linux' }), stderr: '' };
                        if (scenario === 'removal-denied' && inventories++ === 0) return { exitCode: 0, stdout: 'owned-container\n', stderr: '' };
                        throw Object.assign(new Error('private-command-output token=PRIVATE_SENTINEL'), {
                            code: scenario === 'engine-unreachable' ? 'ECONNREFUSED' : scenario.endsWith('observation-denied') ? 'EACCES' : 'ENOSPC',
                        });
                    };
                    return { ...native, nativeIo: { ...native.nativeIo, run } };
                } };
            const host: OwnServerDeploymentTargetHostInput = { credentials, serverId: 'home',
                serverHttpBaseUrl: 'https://teardown-home.test', machineId: 'machine-a', runtime,
                async readEnvironment() { return structuredClone(environment); },
                async readReceipt() { return structuredClone(receipt); },
                async *readBuildHistory() {
                    yield structuredClone(receipt);
                    if (scenario !== 'never-deployed' && scenario !== 'other-link') yield structuredClone(prior);
                },
                async writeTransition(input) {
                    receipt.content = DeploymentOwnServerContentV1Schema.parse(input.content);
                    receipt.deployment = { ...receipt.deployment, state: input.state, revision: receipt.deployment.revision + 1 };
                    return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                        deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: input.state };
                } };
            const targetTeardown = createOwnServerTeardownForHost({ ...host, async findReceipt() { return null; },
                async createCandidate() { throw new Error('Native child cannot create a candidate'); } });
            const remoteJobs: string[] = [];
            if (docker) {
                const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: root,
                    serverId: 'home', environmentId: environment.environment.id });
                await docker.seedComposeGeneration(identity.projectName);
                await docker.seedNetwork('owned-network', identity.projectName,
                    caddy ? [caddyId, ...(scenario === 'remote-caddy-other-endpoint' ? ['unrelated-endpoint'] : [])] : []);
                await docker.seedNetwork('foreign-network', 'unrelated-project', caddy ? [caddyId] : []);
            }
            const teardown = createOwnServerTeardownForHost({ ...host,
                ...(remote ? { machineId: 'controller-machine',
                    runtime: { ...host.runtime, async acquireTeardown() { throw new Error('Controller cannot acquire native target'); } },
                    async sendChild(job: DeploymentChildRpcV1, childContext: ActionExecutorContext) {
                        const parsed = DeploymentChildRpcV1Schema.parse(job);
                        if (parsed.kind !== 'teardown') throw new Error('Expected finite teardown child');
                        remoteJobs.push(`${parsed.step}:${parsed.mode}`);
                        return targetTeardown.executeNative(parsed, childContext);
                    } } : {}), async findReceipt() { return null; },
                async createCandidate() { throw new Error('Receipt supplied at storage boundary'); } });
            const result = await teardown.execute({ actionId: 'deployments.teardown', input: {
                serverId: 'home', environmentId: environment.environment.id, targetLinkId: link.id,
                expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
                requestKey: receipt.deployment.requestKey, reason: 'manual', contentArtifactId: receipt.deployment.contentArtifactId,
                contentHeaderVersion: 1, contentBodyVersion: 1 }, receipt: { ok: true,
                environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: 1, state: 'queued' },
                context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } });
            if (scenario === 'never-deployed' || scenario === 'remote-native' || scenario === 'remote-caddy') {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: 'succeeded' });
                expect(receipt.content.teardown?.proofs.find(proof => proof.step === 'removeTarget'))
                    .toMatchObject({ state: 'succeeded', resources: [{ resourceId: environment.environment.id, disposition: 'absent' }] });
            } else {
                const reason = scenario === 'remote-caddy-other-endpoint' ? 'network_removal_unproved' : scenario === 'missing-tool' || scenario === 'other-link' ? 'plugin_exec_system_tool_unavailable'
                    : scenario === 'engine-unreachable' ? 'ECONNREFUSED' : scenario.endsWith('observation-denied') ? 'EACCES' : 'ENOSPC';
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
                    details: { step: 'removeTarget', reason },
                    ...(scenario === 'remote-caddy-other-endpoint' ? {} : { failureCause: { errorCode: reason } }) });
                expect(receipt.content.teardown?.proofs.find(proof => proof.step === 'removeTarget'))
                    .toMatchObject({ state: 'outcome_unknown', reason });
            }
            if (docker) {
                expect(remoteJobs).toEqual(scenario === 'remote-caddy-other-endpoint'
                    ? ['removeTarget:observe', 'removeTarget:execute'] : ['removeTarget:observe', 'removeTarget:execute', 'verify:observe']);
                expect(await docker.readNetworkIds()).toEqual(scenario === 'remote-caddy-other-endpoint'
                    ? ['owned-network', 'foreign-network'] : ['foreign-network']);
                if (caddy) {
                    expect(await docker.readNativeCaddyAttachments()).toEqual({ containerId: caddyId, networkIds: ['foreign-network'] });
                    expect(await docker.readNetworkEndpoints('foreign-network')).toEqual([caddyId]);
                    if (scenario === 'remote-caddy-other-endpoint') {
                        expect(await docker.readNetworkEndpoints('owned-network')).toEqual(['unrelated-endpoint']);
                    }
                }
            }
            expect(JSON.stringify({ result, receipt })).not.toContain('PRIVATE_SENTINEL');
            expect(JSON.stringify({ result, receipt })).not.toContain('private-command-output');
        } finally {
            Reflect.set(configuration, 'happyHomeDir', originalHome);
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    });
