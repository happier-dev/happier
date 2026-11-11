import { expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { withOwnServerBuildFixture } from './buildReceipt.testkit';
import { resolvePrivateServiceReferenceForHost, resolvePrivateServiceExportAdmissionForHost, resolvePrivateServiceReferenceMaterialForHost } from './privateServiceReference';
import { DeploymentReferenceSourceV1Schema, DeploymentServiceExportV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';

it('verifies B against its applied declarations without reading a later saved Environment', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        try {
            const admission = await resolvePrivateServiceExportAdmissionForHost({
                source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork' },
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
            });
            if (admission.kind !== 'iroh') throw new Error('Expected admitted Iroh source');
            const handle = lease.registry.projectManagedServices.resolveEnvironmentService(host.serverId, admission.serviceExport.service);
            if (!handle) throw new Error('Expected the serving source handle');
            // A save is not an applied deployment. B keeps the declaration it admitted.
            referenceEnvironment.content.ownServer!.serviceExports![0]!.key = 'saved-but-not-deployed';
            const applied = { kind: 'applied' as const, exportKey: 'database', machineId: host.machineId,
                installationId: 'installation-c', exports: handle.appliedServiceExports ?? [],
                row: lease.registry.projectManagedServices.machineServiceRows.read(handle), signal: new AbortController().signal };
            expect(await resolvePrivateServiceExportAdmissionForHost(applied)).toEqual(admission);
            await expect(resolvePrivateServiceExportAdmissionForHost({ ...applied, exports: [] }))
                .rejects.toMatchObject({ code: 'reference_unavailable' });
            await expect(resolvePrivateServiceExportAdmissionForHost({ ...applied, installationId: 'replacement' }))
                .rejects.toMatchObject({ code: 'reference_unavailable' });
        } finally { await lease.release(); }
    }, { buildReference: true, referenceBindAddress: '127.0.0.1', referenceIroh: true });
});

it.each([undefined, 'host', 'port'] as const)('uses the current source member native service when a partial rollout leaves an older or absent uniform pointer (%s)', async component => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        try {
            const resolve = () => resolvePrivateServiceReferenceForHost({
                source: DeploymentReferenceSourceV1Schema.parse({ kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork',
                    ...(component ? { component } : {}) }),
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
            });
            referenceEnvironment.targetLinks[0]!.targetLink.activeDeploymentId = 'previous-uniform-generation';
            await expect(resolve()).resolves.toBe(component === 'host' ? '100.64.0.7' : component === 'port' ? '25432' : 'postgres://100.64.0.7:25432');
            referenceEnvironment.targetLinks[0]!.targetLink.activeDeploymentId = null;
            await expect(resolve()).resolves.toBe(component === 'host' ? '100.64.0.7' : component === 'port' ? '25432' : 'postgres://100.64.0.7:25432');
        } finally { await lease.release(); }
    }, { buildReference: true });
});

it('admits the actual loopback publication and exact managed occurrence for an Iroh export', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        referenceEnvironment.content.ownServer!.serviceExports = [{ key: 'database', service: 'db', containerPort: 5432,
            scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }];
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        try {
            const input = {
                source: { kind: 'reference' as const, environmentId: 'source-database', export: 'database', via: 'privateNetwork' as const },
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
            };
            const admission = await resolvePrivateServiceExportAdmissionForHost(input);
            expect(admission).toMatchObject({ kind: 'iroh', machineId: host.machineId, scheme: 'postgres',
                serviceExport: { exportKey: 'database', installationId: 'installation-c', deploymentId: 'source-release',
                    service: { environmentId: 'source-database', composeService: 'db' },
                    destination: { host: '127.0.0.1', port: 25432 } } });
            if (admission.kind !== 'iroh') throw new Error('Iroh admission required');
            expect(admission.serviceExport.generation).toBeTruthy();
            await expect(resolvePrivateServiceExportAdmissionForHost({ ...input, targetMachineId: 'another-machine' }))
                .rejects.toMatchObject({ code: 'reference_unavailable' });
            referenceEnvironment.targetLinks[0]!.targetLink.members[0]!.installationId = 'replacement-installation';
            await expect(resolvePrivateServiceExportAdmissionForHost(input)).rejects.toMatchObject({ code: 'reference_unavailable' });
        } finally { await lease.release(); }
    }, { buildReference: true, referenceBindAddress: '127.0.0.1' });
});

it('refuses an Iroh export when its actual TCP publication is on a private interface', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        referenceEnvironment.content.ownServer!.serviceExports = [{ key: 'database', service: 'db', containerPort: 5432,
            scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }];
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        try {
            await expect(resolvePrivateServiceExportAdmissionForHost({
                source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork' },
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
            })).rejects.toMatchObject({ code: 'reference_unavailable' });
        } finally { await lease.release(); }
    }, { buildReference: true });
});

it.each([undefined, 'host', 'port'] as const)('materializes an admitted Iroh export through the consumer-owned forward and records the actual route (%s)', async component => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        referenceEnvironment.content.ownServer!.serviceExports = [{ key: 'database', service: 'db', containerPort: 5432,
            scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }];
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        try {
            const material = await resolvePrivateServiceReferenceMaterialForHost({
                source: DeploymentReferenceSourceV1Schema.parse({ kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork',
                    ...(component ? { component } : {}) }),
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
                async acquireForward(admission) {
                    expect(admission.serviceExport.destination).toEqual({ host: '127.0.0.1', port: 25432 });
                    return { host: '127.0.0.1', port: 32567, observedPath: 'relay', async close() {} };
                },
            });
            expect(material).toEqual({ value: component === 'host' ? '127.0.0.1' : component === 'port' ? '32567' : 'postgres://127.0.0.1:32567',
                route: { kind: 'iroh', observedPath: 'relay' } });
        } finally { await lease.release(); }
    }, { buildReference: true, referenceBindAddress: '127.0.0.1' });
});

// Owner ruling 2026-11-10: auto prefers the shared observed publication, then Iroh.
it.each([
    { via: 'auto', shared: true, iroh: true, expected: 'privateNetwork' },
    { via: 'auto', shared: false, iroh: true, expected: 'iroh' },
    { via: 'auto', shared: false, iroh: false, expected: 'refusal' },
    { via: 'privateNetwork', shared: true, iroh: true, expected: 'privateNetwork' },
] as const)('selects $expected with via=$via shared=$shared iroh=$iroh', async ({ via, shared, iroh, expected }) => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        try {
            const input = { source: { kind: 'reference' as const, environmentId: 'source-database', export: 'database', via },
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey };
            if (expected === 'refusal') {
                await expect(resolvePrivateServiceExportAdmissionForHost(input)).rejects.toMatchObject({ code: 'reference_unavailable' });
                return;
            }
            const admission = await resolvePrivateServiceExportAdmissionForHost(input);
            // The authored declaration must also cross the real schema.
            expect(DeploymentServiceExportV1Schema.safeParse(referenceEnvironment.content.ownServer!.serviceExports![0]).success).toBe(true);
            if (expected === 'privateNetwork') {
                expect(admission).toEqual({ kind: 'privateNetwork', url: 'postgres://100.64.0.7:25432', networkIdentity: 'network' });
                expect(await resolvePrivateServiceReferenceMaterialForHost(input)).toEqual({ value: 'postgres://100.64.0.7:25432',
                    route: { kind: 'privateNetwork', networkIdentity: 'network' } });
            } else {
                expect(admission).toMatchObject({ kind: 'iroh', serviceExport: { destination: { host: '127.0.0.1', port: 25433 } } });
            }
        } finally { await lease.release(); }
    }, { buildReference: true, referenceDualPublication: iroh, referenceNetworkObserved: shared });
});
