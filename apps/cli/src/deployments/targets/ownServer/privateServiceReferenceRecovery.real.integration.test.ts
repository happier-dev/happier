import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { createDirectRouteGrantSigningInputV2, type DirectRouteGrantRequestV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineAccessLossReceiver } from '@/daemon/externalActions/registerMachineAccessLossReceiver';
import * as installationStore from '@/daemon/identity/store';
import { createDaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { createServiceExportMachineForward } from '@/daemon/peer/iroh/serviceExportMachineForward';
import { startPeerMediationLoopbackServer } from '@/daemon/peer/mediation/loopback/server';
import type { ServiceExportTunnelOwner } from '@/daemon/peer/mediation/tunnel/registerRoutes';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { withOwnServerRemoteReferenceFixture } from './buildReceipt.testkit';
import { resolvePrivateServiceExportAdmissionForHost } from './privateServiceReference';
import { restorePrivateServiceReferencesForHost } from './privateServiceReferenceRecovery';

it.each(['cold replay', 'publisher restart', 'requester access loss'] as const)('composes a native private service forward for %s', async scenario => {
    const marker = 'retained private service';
    let upstreamConnections = 0;
    const upstream = createServer(socket => {
        upstreamConnections += 1;
        socket.end(marker);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('TCP fixture missing');
    const readMarker = async (port: number) => {
        const socket = connect(port, '127.0.0.1');
        const chunks: Buffer[] = [];
        socket.on('data', chunk => chunks.push(chunk));
        try { await once(socket, 'end'); }
        finally { socket.destroy(); }
        return Buffer.concat(chunks).toString();
    };
    try {
        await withOwnServerRemoteReferenceFixture(async fixture => {
            const { host, environment, referenceEnvironment, restartReferenceObservation, custody, root } = fixture;
            if (!restartReferenceObservation) throw new Error('Applied reference fixture missing');
            const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!lease) throw new Error('Real service owner missing');
            const publisher = referenceEnvironment.targetLinks[0]!.targetLink.members[0]!;
            const installedKeys = nacl.sign.keyPair.fromSeed(custody.installations.find(value => value.machineId === publisher.machineId)!.seed);
            const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                installationId: publisher.installationId, createdAt: 1, publicKey: Buffer.from(installedKeys.publicKey).toString('base64url'),
                privateKey: Buffer.from(installedKeys.secretKey).toString('base64url') });
            const dependencies = createDaemonDeploymentActionDeps({ ...host, machineId: publisher.machineId,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                async acquirePluginRuntimeRegistryLease() {
                    const current = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                    if (!current) throw new Error('Real service owner missing');
                    return current;
                } });
            const publisherAccountId = 'owner';
            const accountId = scenario === 'requester access loss' ? 'team-requester' : publisherAccountId;
            const signingKey = nacl.sign.keyPair();
            const trustRoots = [{ keyId: 'test-home', publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }];
            const commitments: string[] = [];
            const mintGrant = async (request: DirectRouteGrantRequestV2) => {
                if (request.scope.kind !== 'tcp_tunnel' || !request.scope.serviceExport) throw new Error('Expected a private export grant');
                commitments.push(request.scope.serviceExport.commitment);
                const { kind, ttlMs, ...binding } = request;
                const iat = Date.now();
                const payload = { ...binding, grantId: randomUUID(), accountId, iat, exp: iat + ttlMs,
                    aud: 'happier-daemon-route-grant' as const, proofKind: kind };
                return { payload, signature: { keyId: 'test-home', alg: 'Ed25519', valueBase64Url: Buffer.from(nacl.sign.detached(
                    Buffer.from(createDirectRouteGrantSigningInputV2(payload)), signingKey.secretKey)).toString('base64url') } };
            };
            const startEndpoint = async (name: string) => {
                const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir: join(root, name),
                    relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
                if (!runtime.available) throw new Error('The composed cold replay requires the installed native Iroh addon');
                return runtime;
            };
            const startPublisher = async () => {
                const runtime = await startEndpoint('publisher');
                let server: Awaited<ReturnType<typeof startPeerMediationLoopbackServer>> | undefined;
                try {
                    const endpointId = runtime.endpoint.endpointId;
                    let admissionPort = 0;
                    let tunnels: ServiceExportTunnelOwner | undefined;
                    server = await startPeerMediationLoopbackServer({ nowMs: Date.now, endpointExpiresAt: Date.now() + 300_000,
                        expected: { accountId: publisherAccountId, machineId: publisher.machineId, flowKind: 'tcp_tunnel', routeKind: 'loopback_direct', endpointFingerprint: endpointId },
                        trustRoots, tunnel: {
                            resolveServiceExport: ({ binding, signal }) => dependencies.resolveServiceExportBinding(binding, signal ?? new AbortController().signal),
                            onServiceExportTunnelsReady: owner => { tunnels = owner; },
                        },
                        irohMachineAdmission: { localEndpointId: endpointId, role: 'acceptor', allowedFlows: ['tcp_tunnel'],
                            resolveApplicationTarget: () => ({ port: admissionPort }) } });
                    admissionPort = Number(new URL(server.url).port);
                    await runtime.startAttemptAcceptor({ admissionPort });
                    if (!tunnels) throw new Error('Service export tunnel owner missing');
                    return { runtime, tunnels, async close() { try { await runtime.shutdown(); } finally { await server!.stop(); } } };
                } catch (error) { try { await runtime.shutdown(); } finally { await server?.stop(); } throw error; }
            };
            const sourceReference = { kind: 'reference', environmentId: referenceEnvironment.environment.id, export: 'database', via: 'auto' } as const;
            const readEnvironment = async ({ environmentId }: { environmentId: string }) =>
                environmentId === environment.environment.id ? environment : referenceEnvironment;
            const readInputs = { host, context: {}, readEnvironment, owner: lease.registry.projectManagedServices,
                homeServerIdentityId: host.serverId, installationId: 'installation-d', privateKey: installedKeys.secretKey };
            const selectExport = async () => {
                const selected = await resolvePrivateServiceExportAdmissionForHost({ ...readInputs, source: sourceReference, environment,
                    actionId: 'machines.services.list', signal: new AbortController().signal });
                if (selected.kind !== 'iroh') throw new Error('Expected Iroh-only export');
                return selected.serviceExport;
            };
            let source: Awaited<ReturnType<typeof startPublisher>> | undefined;
            const startConsumer = async () => {
                const runtime = await startEndpoint('consumer');
                const acquire = createServiceExportMachineForward({ accountId, localMachineId: host.machineId,
                    runtime, resolveTrustRoots: () => trustRoots, mintGrant,
                    async readTargetMachine(machineId) { return source ? { id: machineId, operationProtocolCapabilitiesRevision: 1,
                        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], ...source.runtime.endpoint } } } : null; } });
                return { runtime, acquire };
            };
            let consumer: Awaited<ReturnType<typeof startConsumer>> | undefined;
            let forward: Awaited<ReturnType<Awaited<ReturnType<typeof startConsumer>>['acquire']>> | undefined;
            let recovery: Awaited<ReturnType<typeof restorePrivateServiceReferencesForHost>> | undefined;
            try {
                source = await startPublisher();
                consumer = await startConsumer();
                const sourceEndpoint = source.runtime.endpoint.endpointId;
                const consumerEndpoint = consumer.runtime.endpoint.endpointId;
                const before = await selectExport();
                const lostCarrier = Promise.withResolvers<void>();
                const lostExport = Promise.withResolvers<void>();
                const waitBeforeFirstConnection = scenario === 'cold replay';
                if (waitBeforeFirstConnection) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                try {
                    forward = await consumer.acquire({ targetMachineId: publisher.machineId, serviceExport: before,
                        onFailure: error => {
                            if (error.code === 'machine_carrier_unavailable') lostCarrier.resolve();
                            if (error.code === 'service_export_unavailable') lostExport.resolve();
                        } });
                    if (waitBeforeFirstConnection) await vi.advanceTimersByTimeAsync(30_001);
                } finally {
                    if (waitBeforeFirstConnection) vi.useRealTimers();
                }
                const retainedPort = forward.port;
                expect(await readMarker(retainedPort)).toBe(marker);
                if (scenario === 'publisher restart') {
                    await source.close();
                    source = undefined;
                    await lostCarrier.promise;
                    await restartReferenceObservation();
                    source = await startPublisher();
                    expect(await selectExport()).toEqual(before);
                    expect(await Promise.all([readMarker(retainedPort), readMarker(retainedPort)])).toEqual([marker, marker]);
                    expect(commitments).toHaveLength(2);
                    expect(commitments[0]).not.toBe(commitments[1]);
                    await restartReferenceObservation('replacement-source-container');
                    await lostExport.promise;
                    const refused = connect(retainedPort, '127.0.0.1');
                    await expect(once(refused, 'connect')).rejects.toMatchObject({ code: expect.stringMatching(/^ECONN(?:REFUSED|RESET)$/u) });
                    expect(commitments).toHaveLength(2);
                    await expect(consumer.acquire({ targetMachineId: publisher.machineId, serviceExport: before }))
                        .rejects.toMatchObject({ code: 'service_export_unavailable' });
                    return;
                }
                if (scenario === 'requester access loss') {
                    const tunnels = source.tunnels;
                    const rpc = new RpcHandlerManager({ scopePrefix: publisher.machineId, encryptionMode: 'plain', logger() {},
                        authorizeRequest: input => authorizeMachineRpcRequest(input, {
                            machineId: publisher.machineId, resolveCustodianAccountId: async () => publisherAccountId,
                            resolveInstallationId: () => publisher.installationId,
                            // Start where Home's authenticated custody RPC leaves the network boundary.
                            verifyMachineAdmission: async () => true,
                        }) });
                    registerMachineAccessLossReceiver(rpc, { machineId: publisher.machineId, serverId: host.serverId,
                        resolveInstallationId: () => publisher.installationId,
                        async cleanupRequesterMachineResources({ requesterAccountId }) {
                            await tunnels.closeByRequester(requesterAccountId);
                            return { kind: 'settled' };
                        } });
                    const loss = { method: `${publisher.machineId}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
                        authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN, params: { v: 1, subjectAccountId: accountId },
                        machineAdmission: { actorAccountId: publisherAccountId, custodianAccountId: publisherAccountId,
                            machineId: publisher.machineId, installationId: publisher.installationId,
                            role: 'manage' as const, encryptionMode: 'plain' as const } };
                    expect(await rpc.handleRequest({ ...loss, params: { ...loss.params, remainingRole: 'use' } })).toEqual({ kind: 'settled' });
                    expect(await readMarker(retainedPort)).toBe(marker);
                    const beforeLoss = upstreamConnections;
                    expect(await rpc.handleRequest(loss)).toEqual({ kind: 'settled' });
                    const afterLoss = await readMarker(retainedPort).catch((error: unknown) => {
                        const code = (error as NodeJS.ErrnoException).code;
                        if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return '';
                        throw error;
                    });
                    expect(afterLoss).toBe('');
                    expect(upstreamConnections).toBe(beforeLoss);
                    expect(await readMarker(address.port)).toBe(marker);
                    return;
                }
                await forward.close();
                forward = undefined;
                await consumer.runtime.shutdown();
                consumer = undefined;
                await source.close();
                source = undefined;
                await restartReferenceObservation();
                source = await startPublisher();
                consumer = await startConsumer();
                expect(source.runtime.endpoint.endpointId).toBe(sourceEndpoint);
                expect(consumer.runtime.endpoint.endpointId).toBe(consumerEndpoint);
                recovery = await restorePrivateServiceReferencesForHost({ ...readInputs, environmentId: environment.environment.id,
                    signal: new AbortController().signal, host: { ...host, acquireServiceExportForward: consumer.acquire },
                    referenceAddresses: [{ machineId: host.machineId, installationId: readInputs.installationId, phase: 'runtime',
                        name: 'DATABASE_URL', source: sourceReference, address: `postgres://127.0.0.1:${retainedPort}`,
                        route: { kind: 'iroh', observedPath: 'direct' } }] });
                expect(await readMarker(retainedPort)).toBe(marker);
                expect(commitments).toHaveLength(2);
                expect(commitments[0]).not.toBe(commitments[1]);
                expect(await selectExport()).toEqual(before);
                await restartReferenceObservation('replacement-source-container');
                const afterReplacement = await selectExport();
                expect(afterReplacement).toEqual({ ...before, generation: expect.any(String) });
                expect(afterReplacement.generation).not.toBe(before.generation);
                await expect(consumer.acquire({ targetMachineId: publisher.machineId, serviceExport: before }))
                    .rejects.toMatchObject({ code: 'service_export_unavailable' });
            } finally {
                await recovery?.close();
                await forward?.close();
                await consumer?.runtime.shutdown();
                await source?.close();
                installation.mockRestore();
                await lease.release();
            }
        }, { referenceIroh: true, referenceNetworkObserved: false, referencePublishedPort: address.port, referenceBindAddress: '127.0.0.1' });
    } finally {
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
});
