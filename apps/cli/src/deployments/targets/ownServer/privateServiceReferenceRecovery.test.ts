import { createServer } from 'node:net';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { withOwnServerBuildFixture, withOwnServerRemoteReferenceFixture } from './buildReceipt.testkit';
import { restorePrivateServiceReferencesForHost } from './privateServiceReferenceRecovery';
import { createRelayDockerFixture } from './privateServiceContainerBridge.testkit';

it('rebinds the recorded native reference address on restart and closes it with retained observation custody', async () => {
    await withOwnServerRemoteReferenceFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        referenceEnvironment.content.ownServer!.serviceExports = [{ key: 'database', service: 'db', containerPort: 5432,
            scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }];
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        const server = createServer();
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TCP address required');
        await new Promise<void>(resolve => server.close(() => resolve()));
        try {
            const recovery = await restorePrivateServiceReferencesForHost({ environmentId: environment.environment.id,
                referenceAddresses: [{ machineId: host.machineId, installationId: 'installation-c', phase: 'runtime', name: 'DATABASE_URL',
                    source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork' },
                    address: `postgres://127.0.0.1:${address.port}`, route: { kind: 'iroh', observedPath: 'direct' } }],
                host: { ...host, async acquirePluginRuntimeRegistryLease() { return lease; }, async acquireServiceExportForward(input) {
                    expect(input.preferredListenPort).toBe(address.port);
                    expect(input.serviceExport.destination).toEqual({ host: '127.0.0.1', port: 25432 });
                    server.listen(input.preferredListenPort, '127.0.0.1'); await once(server, 'listening');
                    return { host: '127.0.0.1', port: address.port, observedPath: 'direct',
                        close: () => new Promise<void>(resolve => server.close(() => resolve())) };
                } }, context: request.context, signal: new AbortController().signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
                readEnvironment: async ({ environmentId }) => environmentId === environment.environment.id ? environment : referenceEnvironment,
            });
            expect(server.listening).toBe(true);
            await recovery.close();
            expect(server.listening).toBe(false);
        } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await lease.release(); }
    }, { buildReference: true, referenceBindAddress: '127.0.0.1' });
});

it.skipIf(process.platform !== 'linux')('restores a recorded Iroh container alias without re-pinning its host forward', async () => {
    await withOwnServerRemoteReferenceFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        referenceEnvironment.content.ownServer!.serviceExports = [{ key: 'database', service: 'db', containerPort: 5432,
            scheme: 'postgres', exposure: 'privateNetwork', privateNetwork: 'network', transport: { kind: 'iroh' } }];
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('The real source service owner must be mounted');
        const fixture = createRelayDockerFixture('consumer-network');
        const alias = 'happier-relay-00000000000000000000000000000001';
        const server = createServer();
        try {
            const recovery = await restorePrivateServiceReferencesForHost({ environmentId: environment.environment.id,
                referenceAddresses: [{ machineId: host.machineId, installationId: 'installation-c', phase: 'runtime', name: 'DATABASE_URL',
                    source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'auto' },
                    address: `postgres://${alias}:8080`, route: { kind: 'iroh', observedPath: 'direct', containerNetworkId: 'consumer-network' } }],
                host: { ...host, async acquirePluginRuntimeRegistryLease() { return lease; }, async acquireServiceExportForward(input) {
                    expect(input.preferredListenPort).toBeUndefined();
                    expect(input.serviceExport.destination).toEqual({ host: '127.0.0.1', port: 25433 });
                    server.listen(0, '127.0.0.1'); await once(server, 'listening');
                    const address = server.address();
                    if (!address || typeof address === 'string') throw new Error('TCP address required');
                    return { host: '127.0.0.1', port: address.port, observedPath: 'direct',
                        close: () => new Promise<void>(resolve => server.close(() => resolve())) };
                } }, context: request.context, signal: new AbortController().signal,
                docker: fixture.docker, engine: { id: 'local', kind: 'native' },
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
                readEnvironment: async ({ environmentId }) => environmentId === environment.environment.id ? environment : referenceEnvironment,
            });
            try { expect((await stat(fixture.socketPath(alias))).isSocket()).toBe(true); }
            finally { await recovery.close(); }
            expect(server.listening).toBe(false);
            expect(fixture.hasRelay(alias)).toBe(false);
        } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await lease.release(); }
    }, { buildReference: true, referenceDualPublication: true });
});

it('recovers a native local reference without acquiring an Iroh self-route', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('Source owner required');
        try {
            const restored = await restorePrivateServiceReferencesForHost({ environmentId: environment.environment.id,
                referenceAddresses: [{ machineId: host.machineId, installationId: 'installation-c', phase: 'runtime', name: 'DATABASE_URL',
                    source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'auto' },
                    address: 'postgres://127.0.0.1:25432', route: { kind: 'local' } }],
                host: { ...host, async acquireServiceExportForward() { throw new Error('Iroh self-route attempted'); } },
                context: request.context, signal: new AbortController().signal, owner: lease.registry.projectManagedServices,
                homeServerIdentityId: host.serverId, installationId: 'installation-c',
                privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
                readEnvironment: async ({ environmentId }) => environmentId === referenceEnvironment.environment.id ? referenceEnvironment : environment,
            });
            await restored.close();
        } finally { await lease.release(); }
    }, { buildReference: true, referenceIroh: true, referenceBindAddress: '127.0.0.1' });
});

it('leaves retained local container DNS and split host/port references with Docker after daemon recovery', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, custody }) => {
        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) throw new Error('Source owner required');
        try {
            const source = { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'auto' } as const;
            const restored = await restorePrivateServiceReferencesForHost({ environmentId: environment.environment.id,
                referenceAddresses: [
                    { name: 'DATABASE_URL', address: 'postgres://source-project-db-1:5432', source },
                    { name: 'DB_MOVE_HOST', address: 'source-project-db-1', source: { ...source, component: 'host' as const } },
                    { name: 'DB_MOVE_PORT', address: '5432', source: { ...source, component: 'port' as const } },
                ].map(address => ({ ...address, machineId: host.machineId, installationId: 'installation-c', phase: 'runtime' as const,
                    route: { kind: 'local' as const, containerNetworkId: 'source-network' } })),
                host: { ...host, async acquireServiceExportForward() { throw new Error('A direct Docker route needs no forward'); } },
                context: request.context, signal: new AbortController().signal, owner: lease.registry.projectManagedServices,
                homeServerIdentityId: host.serverId, installationId: 'installation-c',
                privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
                async readEnvironment() { throw new Error('Native container networking does not need listener recovery'); },
            });
            await restored.close();
        } finally { await lease.release(); }
    }, { buildReference: true, referenceIroh: true, referenceBindAddress: '127.0.0.1' });
});
