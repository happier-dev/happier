import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import type { WebSocket } from 'ws';
import { createDirectRouteGrantSigningInputV2, createEphemeralPeerRouteProofHandleV2,
    encodePeerTcpTunnelBinaryFrameV2, type DirectRouteGrantPayloadV2,
    type TcpTunnelServiceExportBindingV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { registerMachineAccessLossReceiver } from '@/daemon/externalActions/registerMachineAccessLossReceiver';
import { createPeerMediationLoopbackApp } from '@/daemon/peer/mediation/loopback/server';
import { registerPeerTcpTunnelLoopbackRoutes, type ServiceExportTunnelOwner } from '@/daemon/peer/mediation/tunnel/registerRoutes';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { withOwnServerBuildFixture } from './buildReceipt.testkit';
import { resolvePrivateServiceExportAdmissionForHost } from './privateServiceReference';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import * as installationStore from '@/daemon/identity/store';

it('admits the requester against B current export and closes only its open stream on authenticated access loss', async () => {
    const sockets: Socket[] = [];
    const upstream = createServer(socket => { sockets.push(socket); socket.resume(); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('TCP fixture missing');
    try {
        await withOwnServerBuildFixture(async ({ host, request, environment, referenceEnvironment, custody }) => {
            referenceEnvironment.content.ownServer!.serviceExports = [{ key: 'database', service: 'db', containerPort: 5432,
                scheme: 'postgres', exposure: 'loopback', transport: { kind: 'iroh' } }];
            const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
            if (!lease) throw new Error('Real managed service owner missing');
            const installedKeys = nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed);
            // Installed identity is the OS boundary. B's export reader and managed owner stay real.
            const installedIdentity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                installationId: 'installation-c', createdAt: 1, publicKey: Buffer.from(installedKeys.publicKey).toString('base64url'),
                privateKey: Buffer.from(installedKeys.secretKey).toString('base64url') });
            const dependencies = createDaemonDeploymentActionDeps({ ...host,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                async acquirePluginRuntimeRegistryLease() {
                    const current = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                    if (!current) throw new Error('Real managed service owner missing');
                    return current;
                } });
            const signal = new AbortController().signal;
            const resolve = () => resolvePrivateServiceExportAdmissionForHost({
                source: { kind: 'reference', environmentId: 'source-database', export: 'database', via: 'privateNetwork' },
                environment, readEnvironment: async () => referenceEnvironment, host,
                context: request.context, actionId: request.actionId, signal,
                owner: lease.registry.projectManagedServices, homeServerIdentityId: host.serverId,
                installationId: 'installation-c', privateKey: nacl.sign.keyPair.fromSeed(custody.installations[0]!.seed).secretKey,
                targetMachineId: host.machineId,
            });
            const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
            const endpointId = 'b'.repeat(64);
            const app = createPeerMediationLoopbackApp({ nowMs: () => 2_000, expected: {
                accountId: 'custodian', machineId: host.machineId, flowKind: 'tcp_tunnel', routeKind: 'iroh_peer', endpointFingerprint: endpointId,
            }, trustRoots: [] });
            let tunnelOwner: ServiceExportTunnelOwner | undefined;
            registerPeerTcpTunnelLoopbackRoutes(app, { nowMs: () => 2_000,
                expected: { accountId: 'custodian', machineId: host.machineId, endpointFingerprint: endpointId, irohEndpointId: endpointId },
                trustRoots: [{ keyId: 'key', publicKey: Buffer.from(key.publicKey).toString('base64url') }],
                resolveServiceExport: ({ binding, signal }) => dependencies.resolveServiceExportBinding(binding, signal ?? new AbortController().signal),
                onServiceExportTunnelsReady(owner) { tunnelOwner = owner; },
            });
            const open = (binding: TcpTunnelServiceExportBindingV1, id: string, accountId = 'requester') => {
                const proof = createEphemeralPeerRouteProofHandleV2({ randomBytes: length => new Uint8Array(length).fill(9) });
                const payload: DirectRouteGrantPayloadV2 = { v: 2, grantId: id, accountId, machineId: host.machineId,
                    flowKind: 'tcp_tunnel', routeKind: 'iroh_peer', scope: { kind: 'tcp_tunnel', tunnelId: id,
                        allowedPorts: [binding.destination.port], serviceExport: binding }, iat: 1_000, exp: 61_000,
                    aud: 'happier-daemon-route-grant', endpointFingerprint: endpointId, proofKind: 'ephemeral_ed25519',
                    ephemeralPublicKeyBase64Url: proof.publicKeyBase64Url, iroh: { operationKind: 'tcp_tunnel',
                        initiator: { kind: 'machine', machineId: 'consumer', endpointId: 'a'.repeat(64) },
                        target: { machineId: host.machineId, endpointId } } };
                const grant = { payload, signature: { keyId: 'key', alg: 'Ed25519' as const,
                    valueBase64Url: Buffer.from(nacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), key.secretKey)).toString('base64url') } };
                try { return { v: 2, kind: 'open', tunnelId: id, targetMachineId: host.machineId, routeKind: 'iroh_peer',
                    destination: binding.destination, grant, proof: proof.sign(grant) }; }
                finally { proof.dispose(); }
            };
            try {
                const admitted = await resolve();
                if (admitted.kind !== 'iroh') throw new Error('Expected Iroh export');
                referenceEnvironment.content.ownServer!.serviceExports = [];
                for (const [field, binding] of [
                    ['generation', { ...admitted.serviceExport, generation: 'replaced' }],
                    ['installation', { ...admitted.serviceExport, installationId: 'replaced' }],
                    ['export', { ...admitted.serviceExport, exportKey: 'undeclared' }],
                    ['port', { ...admitted.serviceExport, destination: { ...admitted.serviceExport.destination, port: address.port === 65535 ? 65534 : address.port + 1 } }],
                ] as const) {
                    const denied = await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload: open(binding, field) });
                    expect(denied.json()).toMatchObject({ ok: false, reasonCode: 'service_export_unavailable' });
                }
                expect(sockets).toHaveLength(0);
                expect((await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open',
                    payload: open(admitted.serviceExport, 'live') })).statusCode).toBe(200);
                await app.ready();
                const ws = await (app as typeof app & { injectWS(path: string): Promise<WebSocket> }).injectWS('/peer-mediation/v1/tunnel/stream');
                ws.send(encodePeerTcpTunnelBinaryFrameV2({ header: {
                    version: 2, kind: 'open', tunnelId: 'live', substreamId: 'child', payloadLength: 0,
                } }));
                await vi.waitFor(() => expect(sockets).toHaveLength(1));
                const rpc = new RpcHandlerManager({ scopePrefix: host.machineId, encryptionMode: 'plain', logger() {},
                    authorizeRequest: input => authorizeMachineRpcRequest(input, {
                        machineId: host.machineId, resolveCustodianAccountId: async () => 'custodian',
                        resolveInstallationId: () => 'installation-c',
                        // Home admission verification is the genuine network authority boundary.
                        verifyMachineAdmission: async () => true,
                    }) });
                registerMachineAccessLossReceiver(rpc, { machineId: host.machineId, serverId: host.serverId,
                    resolveInstallationId: () => 'installation-c',
                    readLiveWorkInventory: async () => ({ coverage: 'complete', items: [] }),
                    readRequesterMachineResourceAccountIds: () => tunnelOwner?.readRequesterAccountIds() ?? [],
                    cleanupRequesterMachineResources: async ({ requesterAccountId }) => {
                        await tunnelOwner?.closeByRequester(requesterAccountId);
                        return { kind: 'settled' };
                    } });
                const loss = { method: `${host.machineId}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
                    authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN, params: { v: 1, subjectAccountId: 'requester' },
                    machineAdmission: { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId: host.machineId,
                        installationId: 'installation-c', role: 'manage' as const, encryptionMode: 'plain' as const } };
                expect(await rpc.handleRequest({ ...loss, params: { ...loss.params, remainingRole: 'use' } })).toEqual({ kind: 'settled' });
                expect(await rpc.handleRequest({ ...loss, params: { ...loss.params, subjectAccountId: 'other' } })).toEqual({ kind: 'settled' });
                expect(sockets[0]!.destroyed).toBe(false);
                const census = { ...loss, params: { v: 1, kind: 'requesters' } };
                expect(await rpc.handleRequest(census)).toEqual({ kind: 'requesters', accountIds: ['requester'], coverage: 'complete' });
                const closed = once(ws, 'close');
                expect(await rpc.handleRequest(loss)).toEqual({ kind: 'settled' });
                await vi.waitFor(() => expect(sockets[0]!.destroyed).toBe(true));
                await closed;
                expect(await rpc.handleRequest(census)).toEqual({ kind: 'requesters', accountIds: [], coverage: 'complete' });
            } finally { installedIdentity.mockRestore(); for (const socket of sockets) socket.destroy(); await app.close(); await lease.release(); }
        }, { buildReference: true, referenceBindAddress: '127.0.0.1', referencePublishedPort: address.port, referenceIroh: true });
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
