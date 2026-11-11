import { createServer } from 'node:net';
import { once } from 'node:events';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { withOwnServerBuildFixture } from './buildReceipt.testkit';
import { restorePrivateServiceReferencesForHost } from './privateServiceReferenceRecovery';

it('rebinds the recorded native reference address on restart and closes it with retained observation custody', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
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

it('restores a recorded Iroh auto route even when the export now has a shared network', async () => {
    await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
        referenceEnvironment.content.ownServer!.serviceExports = [{ key: 'database', service: 'db', containerPort: 5432,
            scheme: 'postgres', exposure: 'privateNetwork', privateNetwork: 'network', transport: { kind: 'iroh' } }];
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
                    source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'auto' },
                    address: `postgres://127.0.0.1:${address.port}`, route: { kind: 'iroh', observedPath: 'direct' } }],
                host: { ...host, async acquirePluginRuntimeRegistryLease() { return lease; }, async acquireServiceExportForward(input) {
                    expect(input.preferredListenPort).toBe(address.port);
                    expect(input.serviceExport.destination).toEqual({ host: '127.0.0.1', port: 25433 });
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
    }, { buildReference: true, referenceDualPublication: true });
});
