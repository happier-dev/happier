import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

it.each(['remote-refusal', 'unsupported-placement', 'remote-throw'] as const)(
    'preserves the native volume review refusal for recovery: %s', async scenario => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.controllerMachineId = 'controller-machine';
        const link = environment.targetLinks[0].targetLink;
        link.machines = ['machine-a'];
        link.members = [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }];
        if (scenario === 'unsupported-placement') link.members.push({ machineId: 'machine-b',
            installationId: 'installation-b', state: 'active' });
        const refusal = { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action',
            effectAttempted: false, details: { reason: 'native_executor_unavailable',
                remedy: 'Update the target Machine daemon before reviewing its named volumes.' },
            failureCause: { phase: 'deployment.teardown.preview', errorClass: 'Error' as const,
                errorCode: 'unsupported_action', httpStatus: null } };
        // Home records and the cross-Machine transport are genuine IO boundaries.
        const teardown = createOwnServerTeardownForHost({ serverId: 'home', machineId: 'controller-machine',
            credentials: { token: 'test-token', encryption: null }, serverHttpBaseUrl: 'https://unused-home.test',
            runtime: { async acquire() { throw new Error('Review cannot acquire workload execution'); } },
            async readEnvironment() { return environment; },
            async *readBuildHistory() { yield createDeploymentReceiptDetailV1(); },
            async readReceipt() { throw new Error('No receipt mutation is admitted'); },
            async writeTransition() { throw new Error('No receipt mutation is admitted'); },
            async findReceipt() { return null; },
            async createCandidate() { throw new Error('Preview cannot create a candidate'); },
            async sendChild() {
                if (scenario === 'remote-throw') throw Object.assign(new Error('machine_unavailable'), { code: 'machine_unavailable' });
                return refusal;
            },
        });
        const result = await teardown.preview({ serverId: 'home', environmentId: environment.environment.id,
            targetLinkId: link.id, reason: 'manual', mode: 'preview' }, {});
        if (scenario === 'remote-refusal') expect(result).toEqual(refusal);
        else if (scenario === 'remote-throw') expect(result).toMatchObject({ ok: false, errorCode: 'machine_unavailable',
            effectAttempted: false, failureCause: { phase: 'deployment.teardown.preview', errorClass: 'Error',
                errorCode: 'machine_unavailable', httpStatus: null } });
        else expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action', effectAttempted: false,
            details: { reason: 'target_placement_unsupported', requiredFact: 'controllerMachineId=controller-machine' } });
    });

it.each(['exact', 'changed-input'] as const)(
    'retains the person’s confirmation through never-deployed Compose removal preparation: %s', async confirmation => {
        const actionId = 'deployments.teardown';
        const environment = createDeploymentEnvironmentDetailV1();
        delete environment.targetLinks[0].targetLink.activeDeploymentId;
        const input = { serverId: 'home', environmentId: environment.environment.id,
            targetLinkId: 'target-link', requestKey: 'remove-confirmed-empty', reason: 'manual' as const,
            removeEnvironment: true as const, volumes: [] };
        // Home records and Artifact persistence are host IO. Preparation,
        // confirmation custody and approval policy use their real owners.
        const teardown = createOwnServerTeardownForHost({ serverId: 'home', machineId: 'machine-a',
            credentials: { token: 'test-token', encryption: null }, serverHttpBaseUrl: 'https://unused-home.test',
            runtime: { async acquire() { throw new Error('No native work was admitted'); } },
            async readEnvironment() { return environment; },
            async *readBuildHistory() {},
            async readReceipt() { throw new Error('No receipt is required'); },
            async writeTransition() { throw new Error('No receipt is required'); },
            async findReceipt() { return null; },
            async createCandidate() { throw new Error('No content is required'); },
        });
        let approvals = 0;
        const effects: unknown[] = [];
        const storage: NonNullable<ActionExecutorDeps['deploymentAction']> = async (id, admitted) => {
            if (id === 'deployments.environments.get') return { ok: true,
                environment: environment.environment, targetLinks: environment.targetLinks.map(row => row.targetLink) };
            expect(id).toBe(actionId);
            effects.push(admitted);
            return { ok: true, environmentId: input.environmentId, revision: environment.environment.revision + 1,
                nothingDeployed: true, environmentRemoved: true };
        };
        const executor = createActionExecutor({ deploymentAction: storage,
            resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(storage),
            prepareDeploymentTeardown: teardown.prepare,
            approvalsCreate: async () => { approvals++; return { artifactId: 'duplicate-person-review' }; },
        });
        const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner',
            actionRequestId: input.requestKey, externalActionTarget: { kind: 'machine', machineId: 'machine-a' },
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }),
            presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId,
                confirmation === 'exact' ? input : { ...input, environmentId: 'another-environment' }),
                accountId: 'owner', serverId: 'home', requestId: input.requestKey,
                target: { kind: 'machine', machineId: 'machine-a' } },
        });
        if (confirmation === 'exact') {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { environmentRemoved: true } });
            expect(effects).toEqual([expect.objectContaining({ environmentId: input.environmentId,
                nothingDeployed: true, removeEnvironment: true, expectedRevision: environment.environment.revision })]);
            expect(approvals).toBe(0);
        } else {
            // Changed operands need a fresh product review; an own-UI request
            // cannot replace that review with a self-approval Artifact.
            expect(result, JSON.stringify(result)).toMatchObject({ ok: false,
                errorCode: 'action_interactive_review_required' });
            expect(effects).toEqual([]);
            expect(approvals).toBe(0);
        }
    });

it.each(['empty', 'unavailable', 'other-target-deployed'] as const)(
    'removes a never-deployed repository Environment without content or native preparation: %s', async history => {
        const environment = createDeploymentEnvironmentDetailV1();
        delete environment.targetLinks[0].targetLink.activeDeploymentId;
        const prior = createDeploymentReceiptDetailV1();
        prior.deployment.targetLinkId = 'other-target';
        const teardown = createOwnServerTeardownForHost({ serverId: 'home', machineId: 'machine-a',
            credentials: { token: 'test-token', encryption: null }, serverHttpBaseUrl: 'https://unused-home.test',
            runtime: { async acquire() { throw new Error('No native work was admitted'); } },
            async readEnvironment() { return environment; },
            async *readBuildHistory(request) {
                if (history === 'unavailable') throw Object.assign(new Error('History is incomplete'), { code: 'deployment_content_unavailable' });
                if (history === 'other-target-deployed' && request.targetLinkId === undefined) yield prior;
            },
            async readReceipt() { throw new Error('No receipt is required'); },
            async writeTransition() { throw new Error('No receipt is required'); },
            async findReceipt() { return null; },
            async createCandidate() { throw new Error('No content is required'); },
        });
        const prepared = await teardown.prepare({ input: { serverId: 'home', environmentId: environment.environment.id,
            targetLinkId: 'target-link', requestKey: 'remove-empty', reason: 'manual', removeEnvironment: true, volumes: [] }, context: {} });
        if (history === 'empty') expect(prepared).toMatchObject({ input: { nothingDeployed: true, removeEnvironment: true } });
        else expect(prepared).toMatchObject({ ok: false });
    });

// The canonical executable Docker fixture uses a POSIX shebang.
it.skipIf(process.platform === 'win32').each(['local-native', 'remote-already-absent', 'remote-native', 'remote-retry', 'remote-caddy', 'remote-caddy-other-endpoint', 'remote-observation-denied', 'never-deployed', 'other-link', 'missing-tool', 'engine-unreachable', 'observation-denied', 'removal-denied'] as const)(
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
        if (scenario === 'remote-retry') {
            receipt.deployment.state = 'outcome_unknown';
            receipt.deployment.revision = 3;
            receipt.content.failure = { code: 'domain_native_failed', phase: 'cleanup', remedy: 'Retry Domain retirement.' };
            receipt.content.teardown!.proofs = [
                ...(['admit', 'settleDeploy'] as const).map(step => ({ step, machineId: 'machine-a',
                    installationId: 'installation-a', state: 'succeeded' as const, resources: [] })),
                { step: 'removeTarget', machineId: 'machine-a', installationId: 'installation-a',
                    state: 'outcome_unknown', resources: [], reason: 'removal_unproved' },
            ];
        }
        const credentials = { token: 'test-token', encryption: null };
        const observesRetirement = scenario === 'local-native' || scenario === 'remote-already-absent'
            || scenario === 'remote-native' || scenario === 'remote-observation-denied' || scenario === 'remote-caddy-other-endpoint';
        let mounted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        let observerStops = 0;
        // Substitute persisted Home/installation records and the OS process port only.
        // Tool lookup, native runtime, own-server boundary and receipt continuation are real.
        const settings = await persistence.readSettings();
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: {
            id: 'home', name: 'Home', serverUrl: 'https://teardown-home.test', webappUrl: 'https://teardown-home.test',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_teardown_home',
                canonicalServerUrl: 'https://teardown-home.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://teardown-home.test' }] }),
        }, 'other-home': {
            id: 'other-home', name: 'Other Home', serverUrl: 'https://other-teardown-home.test', webappUrl: 'https://other-teardown-home.test',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_other_teardown_home',
                canonicalServerUrl: 'https://other-teardown-home.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://other-teardown-home.test' }] }),
        } } });
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation-a', createdAt: 1, publicKey: '', privateKey: '' });
        try {
            Reflect.set(configuration, 'happyHomeDir', root);
            mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: root,
                runtimeOptions: { pluginIds: [] } });
            const tools = join(root, 'tools');
            const processFailure = scenario.endsWith('denied') || scenario === 'engine-unreachable';
            const caddy = scenario.startsWith('remote-caddy');
            const caddyId = 'c'.repeat(64);
            const docker = scenario === 'local-native' || scenario === 'remote-already-absent'
                || scenario === 'remote-native' || scenario === 'remote-retry' || caddy ? await createOwnServerDockerBoundary(tools, caddy ? {
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
                async acquirePluginRuntimeRegistryLease() {
                    const lease = mounted?.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Installed runtime unavailable');
                    return lease;
                } });
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
            if (scenario === 'never-deployed') {
                const { acquireTeardownReview: _review, ...withoutVolumeReview } = host.runtime;
                const neverDeployed = createOwnServerTeardownForHost({ ...host, runtime: withoutVolumeReview,
                    async findReceipt() { return null; },
                    async createCandidate() { throw new Error('Preview must not create a candidate'); } });
                expect(await neverDeployed.preview({ serverId: 'home', environmentId: environment.environment.id,
                    targetLinkId: link.id, reason: 'manual', mode: 'preview' }, {}))
                    .toEqual({ ok: true, kind: 'preview', volumes: [] });
            }
            const remoteJobs: string[] = [];
            if (docker) {
                const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: root,
                    serverId: 'home', environmentId: environment.environment.id });
                await mkdir(identity.deploymentRoot, { recursive: true });
                if (scenario !== 'remote-already-absent') await docker.seedComposeGeneration(identity.projectName);
                if (scenario === 'remote-native') {
                    await docker.seedVolume('app_data', identity.projectName);
                    await docker.seedVolume('app_logs', identity.projectName);
                    await docker.seedVolume('foreign_data', 'unrelated-project');
                }
                if (scenario !== 'remote-already-absent') await docker.seedNetwork('owned-network', identity.projectName,
                    caddy ? [caddyId, ...(scenario === 'remote-caddy-other-endpoint' ? ['unrelated-endpoint'] : [])] : []);
                await docker.seedNetwork('foreign-network', 'unrelated-project', caddy ? [caddyId] : []);
            }
            if (observesRetirement) {
                const document = JSON.stringify({ services: { web: { image: 'example/web:1' } } });
                for (const [serverId, environmentId] of [['home', environment.environment.id], ['home', 'unrelated-environment'],
                    ['other-home', environment.environment.id]] as const) {
                    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: root, serverId, environmentId });
                    const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]),
                        async admit() { return { environmentId, environmentInstanceId: identity.environmentInstanceId,
                            deploymentId: `observer-${serverId}-${environmentId}`, machineId: 'machine-a', installationId: 'installation-a',
                            deploymentRoot: identity.deploymentRoot, artifactDirectory: join(root, 'artifacts', serverId, environmentId),
                            definition: { kind: 'stored' as const, contentRevision: 1, document,
                                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, services: ['web'], profiles: [] },
                            async assertCurrent() {} }; } });
                    const release = await materializer.materialize({ environmentId, deploymentId: `observer-${serverId}-${environmentId}` });
                    await release.commit();
                    await mounted.registry.projectManagedServices.superviseProject({ kind: 'environment', serverId,
                        machineId: 'machine-a', environmentId, environmentInstanceId: release.environmentInstanceId,
                        deploymentId: release.deploymentId, release, composeService: 'web', serviceId: `${release.environmentInstanceId}/web`,
                        specIdentity: release.deploymentId, isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [] },
                        processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
                            async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                            async stop() { observerStops++; return { status: 'stopped' }; },
                        } } },
                    });
                }
                await mounted.registry.projectManagedServices.superviseMachine({ serverId: 'home', machineId: 'machine-a',
                    watch: { v: 1, watchId: 'unrelated-watch', name: 'Keep watched service', adapter: { pluginId: 'example.native', localId: 'compose' },
                        nativeResourceId: 'unrelated-native', lifecyclePurpose: 'deployment' },
                    isCurrent: () => true, releaseObservation: async () => {}, lifecycle: {
                        async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                        async stop() { observerStops++; return { status: 'stopped' }; },
                    } });
            }
            const teardown = createOwnServerTeardownForHost({ ...host,
                ...(remote ? { machineId: 'controller-machine',
                    runtime: { ...host.runtime, async acquireTeardown() { throw new Error('Controller cannot acquire native target'); } },
                    async sendChild(job: DeploymentChildRpcV1, childContext: ActionExecutorContext) {
                        const parsed = DeploymentChildRpcV1Schema.parse(job);
                        if (parsed.kind === 'prepare' && parsed.actionId === 'deployments.teardown') return targetTeardown.executeNative(parsed, childContext);
                        if (parsed.kind !== 'teardown') throw new Error('Expected finite teardown child');
                        remoteJobs.push(`${parsed.step}:${parsed.mode}`);
                        return targetTeardown.executeNative(parsed, childContext);
                    } } : {}), async findReceipt() { return null; },
                async createCandidate(_environment, content) {
                    if (scenario !== 'remote-native') throw new Error('Receipt supplied at storage boundary');
                    receipt.content = DeploymentOwnServerContentV1Schema.parse(content);
                    return { contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
                } });
            if (scenario === 'remote-native') {
                expect(await teardown.preview({ serverId: 'home', environmentId: environment.environment.id,
                    targetLinkId: link.id, reason: 'manual', mode: 'preview' }, {})).toEqual({ ok: true, kind: 'preview',
                    volumes: [{ name: 'app_data', machineId: 'machine-a' }, { name: 'app_logs', machineId: 'machine-a' }] });
                expect(await docker!.readVolumeNames()).toEqual(['app_data', 'app_logs', 'foreign_data']);
                expect(await docker!.readNetworkIds()).toEqual(['owned-network', 'foreign-network']);
                const prepared = await teardown.prepare({ input: { serverId: 'home', environmentId: environment.environment.id,
                    targetLinkId: link.id, reason: 'manual', requestKey: receipt.deployment.requestKey,
                    volumes: [{ name: 'app_data', disposition: 'delete', confirmation: 'app_data' },
                        { name: 'app_logs', disposition: 'keep' }] }, context: {} });
                expect(prepared).toHaveProperty('input');
                expect(mounted!.registry.projectManagedServices.listProjectServices()).toHaveLength(3);
                if (!('input' in prepared)) throw new Error('Expected native volume preparation');
                expect(await teardown.admit(environment, link.id, receipt.content, prepared.input, {})).toBeNull();
                const forged = structuredClone(receipt.content);
                forged.teardown!.resources.find(resource => resource.id === 'app_data')!.id = 'foreign_data';
                expect(await teardown.admit(environment, link.id, forged, prepared.input, {})).toMatchObject({ ok: false });
            }
            const result = await teardown.execute({ actionId: 'deployments.teardown', input: {
                serverId: 'home', environmentId: environment.environment.id, targetLinkId: link.id,
                expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
                requestKey: receipt.deployment.requestKey, reason: 'manual', contentArtifactId: receipt.deployment.contentArtifactId,
                contentHeaderVersion: 1, contentBodyVersion: 1,
                ...(scenario === 'remote-native' ? { volumes: [{ name: 'app_data', disposition: 'delete' as const, confirmation: 'app_data' },
                    { name: 'app_logs', disposition: 'keep' as const }] } : {}) }, receipt: { ok: true,
                environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state },
                context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } });
            if (scenario === 'local-native' || scenario === 'remote-already-absent' || scenario === 'never-deployed' || scenario === 'remote-native' || scenario === 'remote-retry' || scenario === 'remote-caddy') {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: 'succeeded' });
                if (scenario === 'remote-retry') expect(receipt.content.failure).toBeUndefined();
                expect(receipt.content.teardown?.proofs.find(proof => proof.step === 'removeTarget'))
                    .toMatchObject({ state: 'succeeded', resources: [{ resourceId: environment.environment.id, disposition: 'absent' },
                        ...(scenario === 'remote-native' ? [{ resourceId: 'app_data', disposition: 'absent' },
                            { resourceId: 'app_logs', disposition: 'retained' }] : [])] });
            } else {
                const reason = scenario === 'remote-caddy-other-endpoint' ? 'network_removal_unproved' : scenario === 'missing-tool' || scenario === 'other-link' ? 'plugin_exec_system_tool_unavailable'
                    : scenario === 'engine-unreachable' ? 'ECONNREFUSED' : scenario.endsWith('observation-denied') ? 'EACCES' : 'ENOSPC';
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
                    details: { step: 'removeTarget', reason },
                    ...(scenario === 'remote-caddy-other-endpoint' ? {} : { failureCause: { errorCode: reason } }) });
                expect(receipt.content.teardown?.proofs.find(proof => proof.step === 'removeTarget'))
                    .toMatchObject({ state: 'outcome_unknown', reason });
            }
            if (observesRetirement) {
                expect(mounted.registry.projectManagedServices.listProjectServices().map(handle =>
                    handle.kind === 'environment' ? `${handle.homeServerIdentityId}/${handle.environmentId}` : 'workspace')).toEqual(
                    [...(scenario === 'remote-observation-denied' || scenario === 'remote-caddy-other-endpoint'
                        ? [`srv_teardown_home/${environment.environment.id}`] : []),
                        'srv_teardown_home/unrelated-environment', `srv_other_teardown_home/${environment.environment.id}`]);
                expect(mounted.registry.projectManagedServices.listMachineServices().map(handle => handle.watch.watchId)).toEqual(['unrelated-watch']);
                expect(observerStops).toBe(0);
            }
            if (docker) {
                if (scenario === 'remote-native') expect(await docker.readVolumeNames()).toEqual(['app_logs', 'foreign_data']);
                expect(remoteJobs).toEqual(scenario === 'local-native' ? [] : scenario === 'remote-already-absent'
                    ? ['removeTarget:observe', 'verify:observe'] : scenario === 'remote-caddy-other-endpoint'
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
            await mounted?.dispose();
            Reflect.set(configuration, 'happyHomeDir', originalHome);
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    });
