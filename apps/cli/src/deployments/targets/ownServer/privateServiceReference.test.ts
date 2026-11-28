import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { ApiClient } from '@/api/api';
import nacl from 'tweetnacl';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { withOwnServerBuildFixture, withOwnServerRemoteReferenceFixture } from './buildReceipt.testkit';
import { resolvePrivateServiceReferenceForHost, resolvePrivateServiceExportAdmissionForHost, resolvePrivateServiceReferenceMaterialForHost } from './privateServiceReference';
import { DeploymentReferenceAddressV1Schema } from '@happier-dev/protocol/deployments/deploymentReadsV1';
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
            if (admission.kind !== 'local') throw new Error('Expected admitted Iroh source');
            const handle = lease.registry.projectManagedServices.resolveEnvironmentService(host.serverId, admission.serviceExport.service);
            if (!handle) throw new Error('Expected the serving source handle');
            // A save is not an applied deployment. B keeps the declaration it admitted.
            referenceEnvironment.content.ownServer!.serviceExports![0]!.key = 'saved-but-not-deployed';
            const applied = { kind: 'applied' as const, exportKey: 'database', machineId: host.machineId,
                installationId: 'installation-c', exports: handle.appliedServiceExports ?? [],
                row: lease.registry.projectManagedServices.machineServiceRows.read(handle), signal: new AbortController().signal };
            expect(await resolvePrivateServiceExportAdmissionForHost(applied)).toEqual({ kind: 'iroh',
                machineId: admission.machineId, scheme: admission.scheme, serviceExport: admission.serviceExport });
            // An exposed target is observable but cannot supply a host forward destination.
            await expect(resolvePrivateServiceExportAdmissionForHost({ ...applied, row: { ...applied.row,
                configuration: { ports: [{ target: 5432, published: null, bindAddress: null, protocol: 'tcp' }] },
            } })).rejects.toMatchObject({ code: 'reference_unavailable', failureCause: { phase: 'deployment.reference.resolve', errorCode: 'service_export_unavailable' } });
            await expect(resolvePrivateServiceExportAdmissionForHost({ ...applied, exports: [] }))
                .rejects.toMatchObject({ code: 'reference_unavailable', failureCause: { phase: 'deployment.reference.resolve', errorCode: 'service_export_unavailable' } });
            await expect(resolvePrivateServiceExportAdmissionForHost({ ...applied, installationId: 'replacement' }))
                .rejects.toMatchObject({ code: 'reference_unavailable', failureCause: { phase: 'deployment.reference.resolve', errorCode: 'service_export_unavailable' } });
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
            delete referenceEnvironment.targetLinks[0]!.targetLink.activeDeploymentId;
            await expect(resolve()).resolves.toBe(component === 'host' ? '100.64.0.7' : component === 'port' ? '25432' : 'postgres://100.64.0.7:25432');
        } finally { await lease.release(); }
    }, { buildReference: true, referenceDualPublication: true });
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
            expect(admission).toMatchObject({ kind: 'local', machineId: host.machineId, scheme: 'postgres',
                serviceExport: { exportKey: 'database', installationId: 'installation-c', deploymentId: 'source-release',
                    service: { environmentId: 'source-database', composeService: 'db' },
                    destination: { host: '127.0.0.1', port: 25432 } } });
            if (admission.kind !== 'local') throw new Error('Iroh admission required');
            expect(admission.serviceExport.generation).toBeTruthy();
            await expect(resolvePrivateServiceExportAdmissionForHost({ ...input, targetMachineId: 'another-machine' }))
                .rejects.toMatchObject({ code: 'reference_unavailable', failureCause: { phase: 'deployment.reference.resolve', errorCode: 'service_export_unavailable' } });
            referenceEnvironment.targetLinks[0]!.targetLink.members[0]!.installationId = 'replacement-installation';
            await expect(resolvePrivateServiceExportAdmissionForHost(input)).rejects.toMatchObject({ code: 'reference_unavailable', failureCause: { phase: 'deployment.reference.resolve', errorCode: 'service_export_unavailable' } });
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
            })).rejects.toMatchObject({ code: 'reference_unavailable', failureCause: { phase: 'deployment.reference.resolve', errorCode: 'service_export_unavailable' } });
        } finally { await lease.release(); }
    }, { buildReference: true });
});

it.each([undefined, 'host', 'port'] as const)('materializes a same-Machine loopback export locally and records the native route (%s)', async component => {
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
            });
            expect(material).toEqual({ value: component === 'host' ? '127.0.0.1' : component === 'port' ? '25432' : 'postgres://127.0.0.1:25432',
                route: { kind: 'local' } });
        } finally { await lease.release(); }
    }, { buildReference: true, referenceBindAddress: '127.0.0.1' });
});

// Owner ruling 2026-11-18: a same-Machine observed publication is local;
// native Compose can attach its consumer to the source network.
it.each([
    { via: 'auto', shared: true, iroh: true, expected: 'localNetwork' },
    { via: 'auto', shared: true, iroh: false, expected: 'localNetwork' },
    { via: 'auto', shared: false, iroh: true, expected: 'local' },
    { via: 'auto', shared: false, iroh: false, expected: 'refusal' },
    { via: 'privateNetwork', shared: true, iroh: true, expected: 'localNetwork' },
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
                await expect(resolvePrivateServiceExportAdmissionForHost(input)).rejects.toMatchObject({ code: 'reference_unavailable', failureCause: { phase: 'deployment.reference.resolve', errorCode: 'service_export_unavailable' } });
                return;
            }
            const admission = await resolvePrivateServiceExportAdmissionForHost(input);
            // The authored declaration must also cross the real schema.
            expect(DeploymentServiceExportV1Schema.safeParse(referenceEnvironment.content.ownServer!.serviceExports![0]).success).toBe(true);
            if (expected === 'localNetwork') {
                expect(admission).toMatchObject({ kind: 'local', serviceExport: { destination: { host: '100.64.0.7', port: 25432 } } });
                expect(await resolvePrivateServiceReferenceMaterialForHost(input)).toEqual({ value: 'postgres://100.64.0.7:25432',
                    route: { kind: 'local' } });
            } else {
                expect(admission).toMatchObject({ kind: 'local', serviceExport: { destination: { host: '127.0.0.1', port: 25433 } } });
            }
        } finally { await lease.release(); }
    }, { buildReference: true, referenceDualPublication: iroh, referenceNetworkObserved: shared });
});

it('reads a four-member fleet in one metadata wave and uses only the exact Iroh installation', async () => {
    await withOwnServerRemoteReferenceFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('Source service owner required');
        const link = referenceEnvironment.targetLinks[0]!.targetLink;
        const replaced = ['machine-e', 'machine-f', 'machine-g'];
        const valid = link.members[0]!;
        link.members.push(...replaced.map(machineId => ({ machineId, installationId: 'prior-installation', state: 'active' as const })));
        link.machines.push(...replaced);
        const previousGet = vi.mocked(axios.get).getMockImplementation()!;
        const create = vi.spyOn(ApiClient, 'create');
        let inFlight = 0;
        let peak = 0;
        vi.mocked(axios.get).mockImplementation(async (url, options) => {
            const machineId = new URL(String(url)).pathname.split('/').at(-1)!;
            if (!String(url).includes('/v1/machines/')) return previousGet(url, options);
            peak = Math.max(peak, ++inFlight);
            try {
                await new Promise<void>(resolve => setImmediate(resolve));
                if (!replaced.includes(machineId)) return previousGet(url, options);
                const original = await previousGet(String(url).replace(machineId, valid.machineId), options);
                return { ...original, data: { machine: { ...original.data.machine, id: machineId } } };
            } finally { inFlight--; }
        });
        try {
            const material = await resolvePrivateServiceReferenceMaterialForHost({
                source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'auto' },
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId, installationId: 'installation-c',
                privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
                async acquireForward(admission) {
                    expect(admission).toMatchObject({ kind: 'iroh', machineId: 'builder-c' });
                    return { host: '127.0.0.1', port: 32567, observedPath: 'relay', async close() {} };
                },
            });
            expect(material).toEqual({ value: 'postgres://127.0.0.1:32567', route: { kind: 'iroh', observedPath: 'relay' } });
            expect.soft(create).toHaveBeenCalledTimes(1);
            expect(peak).toBe(5);
        } finally {
            create.mockRestore();
            vi.mocked(axios.get).mockImplementation(previousGet);
            await lease.release();
        }
    }, { referenceIroh: true, referenceBindAddress: '127.0.0.1' });
});

it('preserves an IPv6 native loopback publication and its persisted local route', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('Source owner required');
        try {
            const source = { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'auto' } as const;
            const material = await resolvePrivateServiceReferenceMaterialForHost({ source,
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
            });
            expect(material).toEqual({ value: 'postgres://[::1]:25432', route: { kind: 'local' } });
            if (typeof material === 'string') throw new Error('Native route required');
            expect(DeploymentReferenceAddressV1Schema.parse({ machineId: host.machineId, installationId: 'installation-c',
                phase: 'runtime', name: 'DATABASE_URL', source, address: material.value, route: material.route }).route).toEqual({ kind: 'local' });
        } finally { await lease.release(); }
    }, { buildReference: true, referenceIroh: true, referenceBindAddress: '::1' });
});
