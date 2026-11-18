import { expect, it } from 'vitest';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost, type ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createNativeComposeLifecycle } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { projectNativeComposeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { resolvePrivateServiceExportAdmissionForHost } from './privateServiceReference';
import { resolvePrivateServiceLocalContainerAddress } from './privateServiceLocalNetwork';

async function withSource(consume: (input: Parameters<typeof resolvePrivateServiceLocalContainerAddress>[0]) => Promise<void>, networkName = 'source-default') {
    const owner = createManagedServicesOwner({
        processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
        dependencies: () => { throw new Error('Native observation does not acquire dependencies'); }, resolveScope: scope => scope,
    });
    const id = 'a'.repeat(64);
    const configuration = projectNativeComposeReview({ services: { db: { ports: [
        { target: 5432, published: '25432', host_ip: '127.0.0.1', protocol: 'tcp' },
    ] } } }, '/release', value => value).services[0]!;
    // Only the Docker OS boundary is substituted. The native capture,
    // supervision, projection and export admission remain real.
    const capture = createNativeComposeLifecycle({ args: ['compose', '--project-name', 'source', '--file', '/release/compose.yaml'],
        engineId: 'source-engine', environment: { composeService: 'db', containerIds: [id], facts: { configuration, containerImages: [] } }, io: {
            async events() { return { async dispose() {} }; },
            async run(request) {
                if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'source-engine' }) };
                return { exitCode: 0, stdout: JSON.stringify([{ Id: id, Name: '/source-db-1',
                    Config: { Labels: { 'com.docker.compose.project': 'source', 'com.docker.compose.service': 'db' } },
                    State: { Status: 'running' }, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '25432' }] },
                        Networks: { [networkName]: {} } } }]) };
            },
        } });
    capture.bindLaunch({ command: '/docker', args: ['compose', '--project-name', 'source', '--file', '/release/compose.yaml'],
        cwd: '/release', env: {}, release() {} });
    const handle = await owner.superviseProject({ kind: 'environment', serverId: 'home', machineId: 'machine',
        environmentId: 'source', environmentInstanceId: 'source-instance', deploymentId: 'source-release', composeService: 'db',
        serviceId: 'source-instance/db', specIdentity: 'source-release', isCurrent: () => true,
        appliedServiceExports: [{ key: 'database', service: 'db', containerPort: 5432, scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }],
        release: { environmentId: 'source', environmentInstanceId: 'source-instance', deploymentId: 'source-release', machineId: 'machine',
            installationId: 'installation', rootPath: '/release', manifestFingerprint: 'exact',
            async assertCurrent() {}, async commit() {}, async abort() {} },
        nativeEffects: { keys: [] }, async releaseObservation() {},
        processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: capture.lifecycle } },
    });
    try {
        const admitted = await resolvePrivateServiceExportAdmissionForHost({ kind: 'applied', exportKey: 'database', machineId: 'machine',
            installationId: 'installation', exports: handle.appliedServiceExports ?? [], row: owner.machineServiceRows.read(handle),
            signal: new AbortController().signal });
        if (admitted.kind !== 'iroh') throw new Error('Expected the applied loopback export');
        const docker: ProjectNativeDockerPort = { engineId: 'source-engine', async run() {
            return { exitCode: 0, stdout: JSON.stringify([{ Id: 'actual-source-network-id', Name: networkName, Driver: 'bridge', Scope: 'local' }]) };
        } };
        const admission = { ...admitted, kind: 'local' as const, containerPort: 5432 };
        await consume({ admission, owner, homeServerIdentityId: 'home', docker });
    } finally { await handle.dispose(); }
}

it('refuses a same-Machine consumer using another Docker engine before network inspection', async () => {
    await withSource(async input => {
        await expect(resolvePrivateServiceLocalContainerAddress(input)).resolves.toEqual({ host: 'source-db-1', port: 5432, networkId: 'actual-source-network-id' });
        const docker: ProjectNativeDockerPort = { engineId: 'other-engine', async run() {
            throw new Error('A different engine must not inspect the admitted source network');
        } };
        await expect(resolvePrivateServiceLocalContainerAddress({ ...input, docker })).rejects.toMatchObject({ code: 'reference_unavailable',
            data: { details: { reason: 'docker_engine_mismatch' }, failureCause: { phase: 'deployment.reference.local.source', errorCode: 'docker_engine_mismatch' } } });
    });
});

it('uses the port selected at admission when the applied export still carries its older port', async () => {
    await withSource(async input => {
        const admission = { ...input.admission, containerPort: 5433 };
        await expect(resolvePrivateServiceLocalContainerAddress({ ...input, admission })).resolves.toEqual({
            host: 'source-db-1', port: 5433, networkId: 'actual-source-network-id',
        });
    });
});

it('refuses the built-in bridge because it cannot resolve the captured container by Docker DNS', async () => {
    await withSource(async input => {
        await expect(resolvePrivateServiceLocalContainerAddress(input)).rejects.toMatchObject({ code: 'reference_unavailable',
            data: { details: { reason: 'service_bridge_network_unavailable' }, failureCause: {
                phase: 'deployment.reference.local.network_inspect', errorCode: 'service_bridge_network_unavailable',
            } } });
    }, 'bridge');
});

it.each([
    { stdout: '{bad json', exitCode: 0, reason: 'docker_network_inspection_invalid' },
    { stdout: '[]', exitCode: 1, reason: 'docker_network_inspect_failed' },
    { stdout: JSON.stringify([{ Id: 'host-network', Name: 'source-default', Driver: 'host', Scope: 'local' }]), exitCode: 0, reason: 'service_bridge_network_unavailable' },
])('preserves the native network failure $reason', async ({ stdout, exitCode, reason }) => {
    await withSource(async input => {
        const docker: ProjectNativeDockerPort = { engineId: 'source-engine', async run() { return { exitCode, stdout }; } };
        await expect(resolvePrivateServiceLocalContainerAddress({ ...input, docker })).rejects.toMatchObject({ code: 'reference_unavailable',
            data: { details: { reason }, failureCause: { phase: 'deployment.reference.local.network_inspect', errorCode: reason } } });
    });
});
