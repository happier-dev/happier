import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { HealthCheckDefinitionV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { finiteHealthCheckResult } from './finiteHealthCheckResult';
import { createCurrentDomainEdgeObservation } from './currentDomainEdgeObservation';
import { observeNativeWorkload } from './readNativeWorkload';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createScmBackendRegistry } from '@/scm/registry';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createNativeComposeLifecycle } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { controlNativeServiceForHost } from '@/daemon/local/services/launch/nativeServiceControl';
import { createDeploymentSourceMaterializationPort } from '../targets/ownServer/exactCommitRelease';

describe('current workload aggregate', () => {
    it('publishes Production recovery without verification after service Start, Restart or a Docker restart policy', async () => {
        const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [] } });
        const lifetime = new AbortController();
        const environment = createDeploymentEnvironmentHeaderV1({ protection: 'production' });
        const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id, machines: ['machine-a'],
            members: [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }] });
        const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
            id: 'release-1', environmentId: environment.id, targetLinkId: targetLink.id, state: 'running_unverified',
        }) });
        const member = { machineId: 'machine-a', installationId: 'installation-a' };
        receipt.content.machineResults = [{ ...member, steps: [], activation: 'succeeded', health: 'unverified', currentDeploymentId: receipt.deployment.id }];
        targetLink.activeDeploymentId = receipt.deployment.id;
        receipt.content.ownServer = { approvedInputBasis: { v: 1, environmentId: environment.id,
            environmentRevision: environment.revision, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
            sourceIntent: receipt.content.sourceIntent, manifestFingerprint: 'manifest', configInputDigests: [],
            physicalProjectName: 'production-compose', toolVersion: '2.40.1', services: ['web'], profiles: [],
            members: [member], bindings: [], images: [] } };
        try {
            const deploymentId = receipt.deployment.id;
            const document = JSON.stringify({ services: { web: { image: 'nginx:alpine', restart: 'always' } } });
            const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]),
                async admit() { return { environmentId: environment.id, environmentInstanceId: 'production-instance',
                    deploymentId, machineId: 'machine-a', installationId: 'installation-a',
                    deploymentRoot: join(runtime.happyHomeDir, 'runtime'), artifactDirectory: join(runtime.happyHomeDir, 'artifacts'),
                    definition: { kind: 'stored' as const, contentRevision: 1, document,
                        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, services: ['web'], profiles: [] },
                    async assertCurrent() {} }; } });
            const release = await materializer.materialize({ environmentId: environment.id, deploymentId });
            await release.commit();
            const id = 'a'.repeat(64);
            const args = ['compose', '--project-name', 'production-compose', '--file', '/release/compose.yaml'];
            let state = 'running';
            let dockerEvent: ((event: unknown) => void) | undefined;
            // Substitute only Docker's process and event boundary.
            const capture = createNativeComposeLifecycle({ args, engineId: 'production-recovery-engine',
                environment: { composeService: 'web', containerIds: [id] }, io: {
                    async run(request) {
                        if (request.args[0] === 'info') return { stdout: JSON.stringify({
                            ID: 'production-recovery-engine', OperatingSystem: 'Linux',
                        }), stderr: '', exitCode: 0 };
                        if (request.args[0] === 'start' || request.args[0] === 'restart') state = 'running';
                        const stdout = request.args.includes('inspect') ? JSON.stringify([{ Id: id, State: { Status: state },
                            Config: { Labels: { 'com.docker.compose.project': 'production-compose', 'com.docker.compose.service': 'web' } },
                            NetworkSettings: { Ports: {} }, HostConfig: { RestartPolicy: { Name: 'always', MaximumRetryCount: 0 } } }]) : request.args.includes('ps') ? id : '';
                        return { stdout, stderr: '', exitCode: 0 };
                    },
                    async events(request) { dockerEvent = request.event; return { async dispose() {} }; },
                } });
            capture.bindLaunch({ command: '/docker', args, cwd: '/release', env: {},
                secretRedactionLease: createProviderRedactionLease({ values: [] }), release() {} });
            const services = runtime.registry.projectManagedServices;
            const handle = await services.superviseProject({ kind: 'environment', serverId: environment.serverId,
                machineId: 'machine-a', environmentId: environment.id, environmentInstanceId: release.environmentInstanceId,
                deploymentId, release, composeService: 'web', serviceId: `${release.environmentInstanceId}/web`, specIdentity: deploymentId,
                isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [
                    { kind: 'composeProject', dockerEndpoint: 'production-recovery-engine', projectName: 'production-compose' },
                ] }, processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: capture.lifecycle } } });
            const health = await observeNativeWorkload({ environment: createDeploymentEnvironmentDetailV1({ environment,
                    targetLinks: [{ targetLink, content: {} }] }), receipts: (async function* () { yield receipt; })(),
                signal: lifetime.signal, observedAtMs: 1000, local: { machineId: 'machine-a', installationId: 'installation-a',
                    rows: services.machineServiceRows, resolve: () => handle } });
            if (!health || !dockerEvent) throw new Error('Expected the retained workload and Docker event subscription');
            const published = vi.fn();
            health.observe(published);
            for (const operation of ['start', 'restart', 'policy'] as const) {
                state = 'exited';
                dockerEvent({ Type: 'container', Action: 'die', Actor: { ID: id } });
                await vi.waitFor(() => expect(published).toHaveBeenLastCalledWith(expect.objectContaining({
                    status: 'down', members: [expect.objectContaining({ evidence: [
                        expect.objectContaining({ status: 'down', reason: 'stopped' }),
                    ] })],
                })));
                if (operation === 'policy') {
                    state = 'running';
                    dockerEvent({ Type: 'container', Action: 'start', Actor: { ID: id } });
                } else {
                    expect(await controlNativeServiceForHost({ handle, operation, operationId: operation, context: {} }))
                        .toMatchObject({ kind: 'observed' });
                }
                await vi.waitFor(() => expect(services.machineServiceRows.read(handle).native).toMatchObject({
                    phase: 'running', readiness: 'not_reported',
                }));
                expect(published).toHaveBeenLastCalledWith(expect.objectContaining({
                    status: 'unknown', down: 0, unknown: 1, authoritativeRecovery: false,
                }));
            }
        } finally {
            lifetime.abort();
            await runtime.dispose();
        }
    });
    it('publishes the same observer’s current Domain edge fact beside unknown native members', async () => {
        const environment = createDeploymentEnvironmentHeaderV1({ controllerMachineId: 'controller',
            ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' } });
        const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id,
            machines: ['controller'], members: [{ machineId: 'controller', installationId: 'installation-controller', state: 'active' }] });
        const edge = createCurrentDomainEdgeObservation();
        const observer = { machineId: 'controller', installationId: 'installation-controller' };
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id,
            targetLinkId: targetLink.id, revision: 1, state: 'active', contentArtifactId: 'artifact-domain',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account',
            createdAtMs: 1000, updatedAtMs: 1000 });
        const check = HealthCheckDefinitionV1Schema.parse({ checkId: 'http',
            kind: { pluginId: 'happier.machine.services', localId: 'http' },
            binding: { kind: 'domain', domainId: domain.id, targetLinkId: targetLink.id, condition: 'domain_probe_failed' },
            config: {}, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 });
        edge.publish({ sourceInstanceId: 'saved', sourceRevision: '1', checkId: check.checkId, kind: 'http',
            caller: { pluginId: 'happier.machine.services', machineId: observer.machineId, materializationId: 'installed' },
            occurrenceId: 'occurrence', check, environment, targetLink, domain, observer,
            result: finiteHealthCheckResult({ observer, vantage: 'outside' }, 'http', 1000, 995, 'down', { reason: 'connection' }) });
        const input = { environment: createDeploymentEnvironmentDetailV1({ environment,
                targetLinks: [{ targetLink, content: {} }] }), receipts: (async function* () {})(),
            signal: new AbortController().signal, observedAtMs: 1000,
            local: { machineId: 'controller', installationId: 'installation-controller',
                rows: { read: () => { throw new Error('no retained native handle'); }, subscribe: () => ({ dispose() {} }) },
                resolve: () => null },
            edge };
        const lease = await observeNativeWorkload(input);
        expect(lease?.snapshot()).toMatchObject({ n: 2, edgeUnreachable: true,
            members: expect.arrayContaining([expect.objectContaining({ machineId: 'edge', status: 'down' })]) });
        // A Domain mutation retires the old check result at the controller's next action boundary.
        edge.withdrawDomain(environment.id, domain.id);
        expect(lease?.snapshot()).toMatchObject({ edgeUnreachable: false,
            members: expect.arrayContaining([expect.objectContaining({ machineId: 'edge', status: 'unknown' })]) });
        lease?.dispose();
    });
});
