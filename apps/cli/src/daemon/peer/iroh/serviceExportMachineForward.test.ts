import { once } from 'node:events';
import { createServer, connect, type Socket } from 'node:net';
import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { createDirectRouteGrantSigningInputV2, type DirectRouteGrantRequestV2 } from '@happier-dev/protocol';
import type { TcpTunnelServiceExportBindingV1 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { startPeerMediationLoopbackServer } from '../mediation/loopback/server';
import { createServiceExportMachineForward } from './serviceExportMachineForward';

const accountId = 'forward-owner';
const sourceId = 'source-machine';
const targetId = 'target-machine';
const sourceEndpoint = 'a'.repeat(64);
const targetEndpoint = 'b'.repeat(64);

async function readAll(socket: Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on('data', chunk => chunks.push(chunk));
  await once(socket, 'end');
  return Buffer.concat(chunks);
}

describe('Machine service export forward', () => {
  it.each(['privacy', 'commitment mismatch', 'binary and recovery'] as const)('protects service export %s through the real inner HTTP owner', async mode => {
    const sockets = new Set<Socket>();
    const destination = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const chunks: Buffer[] = [];
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => socket.end(Buffer.concat(chunks).reverse()));
    });
    destination.listen(0, '127.0.0.1');
    await once(destination, 'listening');
    const address = destination.address();
    if (!address || typeof address === 'string') throw new Error('No destination listener');
    const binding: TcpTunnelServiceExportBindingV1 = {
      exportKey: 'database', installationId: 'target-installation', deploymentId: 'deployment-1', generation: 'generation-1',
      service: { kind: 'deployment', machineId: targetId, environmentId: 'environment-1', environmentInstanceId: 'instance-1',
        composeService: 'database', serviceId: 'instance-1/database' },
      destination: { host: '127.0.0.1', port: address.port },
    };
    const key = tweetnacl.sign.keyPair();
    const trustRoots = [{ keyId: 'home-key', publicKey: Buffer.from(key.publicKey).toString('base64url') }];
    const target = await startPeerMediationLoopbackServer({ nowMs: () => 2000, endpointExpiresAt: 300000,
      expected: { accountId, machineId: targetId, flowKind: 'tcp_tunnel', routeKind: 'loopback_direct', endpointFingerprint: 'listener' },
      trustRoots, tunnel: { resolveServiceExport: async () => binding }, irohMachineAdmission: { localEndpointId: targetEndpoint, role: 'acceptor',
        allowedFlows: ['tcp_tunnel'], resolveApplicationTarget: () => null } });
    let carrierClosed = 0;
    let carrierEndpoint = targetEndpoint;
    let grantAccountId = accountId;
    let grants = 0;
    let homeRequest = "";
    const acquire = createServiceExportMachineForward({ accountId, localMachineId: sourceId, nowMs: () => 2000, resolveTrustRoots: () => trustRoots,
      runtime: { endpoint: { endpointId: sourceEndpoint },
        // Native Iroh is the external boundary. The real inner HTTP/WebSocket server and frame owners remain live.
        openHttpTunnel: async () => ({ localPort: Number(new URL(target.url).port), localCapability: 'c'.repeat(64),
          remoteEndpointId: carrierEndpoint, observedPath: 'relay', close: async () => { carrierClosed++; } }) },
      readTargetMachine: async () => ({ id: targetId, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: targetEndpoint } } }),
      mintGrant: async (request: DirectRouteGrantRequestV2) => {
        grants++;
        homeRequest = JSON.stringify(request);
        const { kind, ttlMs: _ttl, ...rest } = request;
        if (mode === 'commitment mismatch' && rest.scope.kind === 'tcp_tunnel'
          && rest.scope.serviceExport && 'commitment' in rest.scope.serviceExport) {
          rest.scope = { ...rest.scope, serviceExport: { ...rest.scope.serviceExport, commitment: `sha256:${'0'.repeat(64)}` } };
        }
        const payload = { ...rest, grantId: `grant-${grants}`, accountId: grantAccountId, iat: 1000, exp: 300000,
          aud: 'happier-daemon-route-grant' as const, proofKind: kind };
        return { payload, signature: { keyId: 'home-key', alg: 'Ed25519',
          valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), key.secretKey)).toString('base64url') } };
      } });
    let forward: Awaited<ReturnType<typeof acquire>> | undefined;
    try {
      if (mode === 'commitment mismatch') {
        await expect(acquire({ targetMachineId: targetId, serviceExport: binding }).then(created => { forward = created; return created; }))
          .rejects.toMatchObject({ code: 'service_export_unavailable' });
        return;
      }
      forward = await acquire({ targetMachineId: targetId, serviceExport: binding });
      if (mode === 'privacy') {
        expect(homeRequest).not.toMatch(/exportKey|composeService|environmentInstanceId|deploymentId|installationId|generation/);
        expect(JSON.parse(homeRequest).scope).toEqual({ kind: 'tcp_tunnel', tunnelId: expect.any(String),
          allowedPorts: [binding.destination.port], serviceExport: { commitment: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) } });
        return;
      }
      expect(forward.host).toBe('127.0.0.1');
      expect(forward.observedPath).toBe('relay');
      const values = [Buffer.from([0, 255, 128, 1]), Buffer.alloc(256 * 1024, 17)];
      await Promise.all(values.map(async value => {
        const client = connect({ host: forward!.host, port: forward!.port, allowHalfOpen: true });
        sockets.add(client);
        const response = readAll(client);
        client.end(value);
        expect(await response).toEqual(Buffer.from(value).reverse());
        client.destroy();
      }));
      expect(grants).toBe(1);
      await forward.close();
      await forward.close();
      expect(carrierClosed).toBe(1);
      const client = connect({ host: forward.host, port: forward.port });
      await expect(once(client, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      client.destroy();
      carrierEndpoint = 'd'.repeat(64);
      await expect(acquire({ targetMachineId: targetId, serviceExport: binding })).rejects.toMatchObject({ code: 'transport_identity_mismatch' });
      expect(carrierClosed).toBe(2);
      carrierEndpoint = targetEndpoint;
      grantAccountId = 'foreign-account';
      await expect(acquire({ targetMachineId: targetId, serviceExport: binding })).rejects.toMatchObject({ code: 'handshake_account_mismatch' });
      expect(carrierClosed).toBe(2);
      grantAccountId = accountId;
      const recovered = await acquire({ targetMachineId: targetId, serviceExport: binding, preferredListenPort: forward.port });
      try {
        expect(recovered.port).toBe(forward.port);
        await expect(acquire({ targetMachineId: targetId, serviceExport: binding, preferredListenPort: forward.port }))
          .rejects.toMatchObject({ code: 'EADDRINUSE' });
      } finally { await recovered.close(); }
      // Inner admission deliberately does not dial: surface the first real destination failure.
      const failures: string[] = [];
      let recoveries = 0;
      const unavailableDestination = await acquire({ targetMachineId: targetId, serviceExport: binding,
        onFailure: error => { failures.push(error.code); }, onRecovered: () => { recoveries++; } });
      const oldDestinationAccepted = once(destination, 'connection');
      const oldClient = connect({ host: unavailableDestination.host, port: unavailableDestination.port, allowHalfOpen: true });
      sockets.add(oldClient);
      await oldDestinationAccepted;
      const destinationClosed = new Promise<void>(resolve => destination.close(() => resolve()));
      const unavailableCarrier = await acquire({ targetMachineId: targetId, serviceExport: binding,
        onFailure: error => { failures.push(error.code); } });
      try {
        const failedClient = connect({ host: unavailableDestination.host, port: unavailableDestination.port });
        const clientClosed = once(failedClient, 'close');
        failedClient.end(Buffer.from('first real dial'));
        await clientClosed;
        expect(recoveries).toBe(0);
        const oldResponse = readAll(oldClient);
        oldClient.end(Buffer.from('older connected client'));
        expect(await oldResponse).toEqual(Buffer.from('older connected client').reverse());
        oldClient.destroy();
        expect(recoveries).toBe(0);
        await destinationClosed;
        destination.listen(binding.destination.port, '127.0.0.1');
        await once(destination, 'listening');
        const recoveredClient = connect({ host: unavailableDestination.host, port: unavailableDestination.port, allowHalfOpen: true });
        sockets.add(recoveredClient);
        const recoveredResponse = readAll(recoveredClient);
        recoveredClient.end(Buffer.from('actual recovered client'));
        expect(await recoveredResponse).toEqual(Buffer.from('actual recovered client').reverse());
        recoveredClient.destroy();
        expect(recoveries).toBe(1);
        await unavailableDestination.close();
        await target.stop();
        // The listener is released by the actual WebSocket close, before its consumer disposes it.
        const refused = connect({ host: unavailableCarrier.host, port: unavailableCarrier.port });
        const listenerRefused = once(refused, 'connect');
        await expect(listenerRefused).rejects.toMatchObject({ code: expect.stringMatching(/^ECONN(?:REFUSED|RESET)$/u) });
        refused.destroy();
        expect(failures).toEqual(['tcp_connect_failed', 'machine_carrier_unavailable']);
      } finally {
        await unavailableDestination.close();
        await unavailableCarrier.close();
      }
    } finally {
      await forward?.close();
      for (const socket of sockets) socket.destroy();
      await target.stop();
      await new Promise<void>(resolve => destination.close(() => resolve()));
    }
  });
});
