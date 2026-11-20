import axios from 'axios';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { createDeploymentMemberVersionProjectionV1 } from '@happier-dev/deployments';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import * as installationStore from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { buildOwnServerDeploymentReceipt } from './buildReceipt';
import { createOwnServerTeardownForHost } from './teardown';
import { createOwnServerDeploymentTargetForHost, type OwnServerDeploymentTargetHostInput,
    type OwnServerDeploymentRequest, type OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';

it('deploys after native teardown and preserves a later activation failure without restoring removed code', { timeout: 300_000 }, async context => {
    const root = await mkdtemp(join(tmpdir(), 'happier-teardown-redeploy-'));
    const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    const originalHome = configuration.happyHomeDir;
    const keys = nacl.sign.keyPair();
    const identity = { version: 1 as const, installationId: 'installation-a', createdAt: 1,
        publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
    const environment = createDeploymentEnvironmentDetailV1();
    environment.content.retainPreviousDeployments = 0;
    const link = environment.targetLinks[0].targetLink;
    link.machines = ['machine-a'];
    link.members = [{ machineId: 'machine-a', installationId: identity.installationId, state: 'active' }];
    delete link.activeDeploymentId;
    const receipts = new Map<string, OwnServerDeploymentReceipt>();
    const phases: string[] = [];
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`, encryption: null };
    // Substitute Home HTTP/storage, installed identity and Docker OS only.
    // Projection, rollout, native teardown, build and activation remain real.
    const settings = await persistence.readSettings();
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: {
        id: 'home', name: 'Home', serverUrl: 'https://redeploy-home.test', webappUrl: 'https://redeploy-home.test',
        createdAt: 1, updatedAt: 1, homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_redeploy_home',
            canonicalServerUrl: 'https://redeploy-home.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://redeploy-home.test' }] }),
    } } });
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(identity);
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Notice Home is offline at the HTTP boundary'));
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.url?.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [] } };
        throw new Error('Unexpected Home request');
    });
    try {
        Reflect.set(configuration, 'happyHomeDir', root);
        const docker = await createOwnServerDockerBoundary(join(root, 'tools'));
        vi.stubEnv('PATH', `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
        const host: OwnServerDeploymentTargetHostInput = {
            credentials, serverId: 'home', serverHttpBaseUrl: 'https://redeploy-home.test', machineId: 'machine-a',
            async readEnvironment() { return structuredClone(environment); },
            async readReceipt({ deploymentId }) {
                const receipt = receipts.get(deploymentId);
                if (!receipt) throw new Error('Missing persisted receipt');
                return structuredClone(receipt);
            },
            async readRetentionHeaders({ deploymentId }) {
                return structuredClone({ environment: environment.environment, deployment: receipts.get(deploymentId)!.deployment, link });
            },
            async writeTransition(input) {
                const current = receipts.get(input.deploymentId)!;
                expect(input.expectedRevision).toBe(current.deployment.revision);
                const receipt = { ...current, content: DeploymentOwnServerContentV1Schema.parse(input.content),
                    deployment: { ...current.deployment, state: input.state, revision: current.deployment.revision + 1 } };
                receipts.set(input.deploymentId, receipt);
                // Mirror the server's successful signed transition at the
                // persistence boundary, including teardown pointer removal.
                if (input.teardownProof || input.state === 'succeeded' || input.state === 'running_unverified') {
                    if (input.teardownProof) delete link.activeDeploymentId;
                    else link.activeDeploymentId = receipt.deployment.id;
                    link.revision++;
                }
                return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: input.state };
            },
            async *readBuildHistory() { for (const receipt of [...receipts.values()].reverse()) yield structuredClone(receipt); },
            async readMemberVersions() {
                const projection = createDeploymentMemberVersionProjectionV1(link);
                for (const receipt of [...receipts.values()].reverse()) if (projection.addReceipt(receipt)) break;
                const version = projection.getVersions()['machine-a']!;
                return [{ machineId: 'machine-a', installationId: identity.installationId, steps: [], activation: 'pending', health: 'unknown',
                    ...(version.deploymentId ? { currentDeploymentId: version.deploymentId } : {}) }];
            },
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://redeploy-home.test', machineId: 'machine-a',
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                async acquirePluginRuntimeRegistryLease() { return mounted.controller.tryAcquireRuntimeRegistry()!; } }),
            async dispatchBuild(request) { return buildOwnServerDeploymentReceipt(host, request); },
            async reviewMember(input) { return target.reviewMember(input); },
            async dispatchMember(input) { phases.push(input.phase); return target.executeMember(input); },
            async dispatchRetention(input) { return target.retain(input); },
        };
        const target = createOwnServerDeploymentTargetForHost(host);
        const teardown = createOwnServerTeardownForHost({ ...host, async findReceipt() { return null; },
            async *readHistoryHeaders() { for (const receipt of [...receipts.values()].reverse()) yield structuredClone(receipt.deployment); },
            async createCandidate() { throw new Error('Receipt is supplied at the storage boundary'); } });
        let revision = 0;
        const candidate = async (id: string) => {
            const image = await docker.registerImage('app', id);
            const document = JSON.stringify({ services: { app: { image: image.registryReference,
                healthcheck: { test: ['CMD', 'true'] } } } });
            const sourceIntent = { kind: 'stored' as const, document, contentRevision: ++revision,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, services: ['app'], profiles: [] };
            environment.content.definition = sourceIntent;
            const receipt = createDeploymentReceiptDetailV1();
            receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, id, requestKey: id, state: 'queued', actionOperationId: `operation-${id}`,
                acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: identity.installationId },
                    builder: { machineId: 'machine-a', installationId: identity.installationId } } });
            receipt.content = { sourceIntent, machines: link.machines, buildMachineId: 'machine-a', onFailure: 'rollbackAll',
                images: [image], machineResults: [], steps: [] };
            receipts.set(id, receipt);
            const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
                input: { serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                    targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: id,
                    contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: id, deploymentRevision: 1, state: 'queued' },
                context: { signal: context.signal, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
            const review = await target.review({ ...request, content: receipt.content });
            receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
            return { receipt, request, image };
        };
        const stop = async (id: string) => {
            const receipt = createDeploymentReceiptDetailV1();
            receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, id, operation: 'teardown', state: 'queued', actionOperationId: `operation-${id}` });
            receipt.content = { sourceIntent: [...receipts.values()].at(-1)!.content.sourceIntent, machines: link.machines,
                buildMachineId: 'machine-a', onFailure: 'keepPartial', images: [], machineResults: [], steps: [],
                teardown: { reason: 'manual', targetLinkRevision: link.revision,
                    machines: [{ machineId: 'machine-a', installationId: identity.installationId }],
                    resources: [{ id: environment.environment.id, kind: 'workload', machineId: 'machine-a', ownership: 'owned', disposition: 'remove' }], proofs: [] } };
            receipts.set(id, receipt);
            expect(await teardown.execute({ actionId: 'deployments.teardown',
                input: { serverId: 'home', environmentId: environment.environment.id, targetLinkId: link.id,
                    expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
                    requestKey: id, reason: 'manual', contentArtifactId: receipt.deployment.contentArtifactId,
                    contentHeaderVersion: 1, contentBodyVersion: 1 },
                receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: id, deploymentRevision: 1, state: 'queued' },
                context: { signal: context.signal, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } }))
                .toMatchObject({ ok: true, state: 'succeeded' });
            expect(link.activeDeploymentId).toBeUndefined();
            expect(await docker.readRunningImageConfig('app')).toBeNull();
            expect(await docker.readContainerIds()).toEqual([]);
            expect(await docker.readNetworkIds()).toEqual([]);
        };
        const first = await candidate('v1');
        expect(await target.execute(first.request)).toMatchObject({ ok: true, state: 'succeeded' });
        await docker.stopCurrentContainers();
        expect((await docker.readContainerIds()).length).toBeGreaterThan(0);
        await stop('stop-v1');
        for (const unhealthy of [false, true]) {
            if (unhealthy) await stop('stop-v2');
            const fresh = await candidate(unhealthy ? 'unhealthy' : 'v2');
            if (unhealthy) await docker.failImageHealth(fresh.image.configDigest);
            const before = phases.length;
            const result = await target.execute(fresh.request);
            // writeTransition persists a new receipt object; read the stored one.
            const persisted = receipts.get(fresh.receipt.deployment.id)!;
            expect(result, JSON.stringify({ result, failure: persisted.content.failure }))
                .toMatchObject(unhealthy
                    ? { ok: false, errorCode: 'native_failed', details: { failure: { code: 'native_failed', phase: 'activate' } } }
                    : { ok: true, state: 'succeeded' });
            expect(phases.slice(before)).toContain('activate');
            expect(phases.slice(before)).not.toContain('restore');
            if (unhealthy) {
                expect(persisted.deployment.state).toBe('failed');
                expect(persisted.content.failure).toEqual({ code: 'native_failed', phase: 'activate',
                    requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/),
                    // The native owner's closed reason is the typed cause.
                    failureCause: { phase: 'deployment.failure', errorClass: 'Error', errorCode: 'deployment_activation_failed', httpStatus: null } });
                expect(await docker.readRunningImageConfig('app')).toBeNull();
            } else {
                expect(persisted.content.failure).toBeUndefined();
                expect(link.activeDeploymentId).toBe('v2');
                expect(await docker.readRunningImageConfig('app')).toBe(fresh.image.configDigest);
            }
        }
    } finally {
        Reflect.set(configuration, 'happyHomeDir', originalHome);
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await mounted.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
