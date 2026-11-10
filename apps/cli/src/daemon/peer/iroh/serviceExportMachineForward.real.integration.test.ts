import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { createIrohNodeNativeModule, loadIrohNodeNativeAddon, MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { createIrohTestControllerFromNativeAddon } from '@happier-dev/iroh-native/test-controller';
import { createDirectRouteGrantSigningInputV2, type DirectRouteGrantRequestV2 } from '@happier-dev/protocol';
import type { TcpTunnelServiceExportBindingV1 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { SignedDirectRouteGrantV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import { PEER_TCP_TUNNEL_OPEN_PATH_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/openAuthorizationV2';
import { startPeerMediationLoopbackServer } from '../mediation/loopback/server';
import { createDaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import { createServiceExportMachineForward, type ServiceExportMachineForward } from './serviceExportMachineForward';

const runFile = promisify(execFile);

async function measurePostgres(input: Readonly<{
  bin: string; root: string; topology: 'direct' | 'relay'; binding: TcpTunnelServiceExportBindingV1;
  acquire: ReturnType<typeof createServiceExportMachineForward>;
  selectExport(binding: TcpTunnelServiceExportBindingV1): void;
}>): Promise<void> {
  const data = join(input.root, 'postgres');
  await runFile(join(input.bin, 'initdb'), ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '--username=forward_test']);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No PostgreSQL fixture port.');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const postgres = spawn(join(input.bin, 'postgres'), ['-D', data, '-h', '127.0.0.1', '-p', String(address.port), '-k', input.root], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ready = new Promise<void>((resolve, reject) => {
    let output = '';
    postgres.stderr.on('data', bytes => {
      output += bytes.toString();
      if (output.includes('database system is ready to accept connections')) resolve();
    });
    postgres.once('error', reject);
    postgres.once('exit', code => reject(new Error(`PostgreSQL fixture exited ${code}: ${output}`)));
  });
  let forward: ServiceExportMachineForward | undefined;
  try {
    await ready;
    const binding = { ...input.binding, exportKey: 'postgres', destination: { ...input.binding.destination, port: address.port } };
    input.selectExport(binding);
    const started = performance.now();
    forward = await input.acquire({ targetMachineId: binding.service.machineId, serviceExport: binding });
    const setupMs = performance.now() - started;
    expect(forward.observedPath).toBe(input.topology);
    const args = ['-X', '-qAt', '-h', forward.host, '-p', String(forward.port), '-U', 'forward_test', '-d', 'postgres'];
    const transferStarted = performance.now();
    const payloads = await Promise.all([0, 1].map(() => runFile(join(input.bin, 'psql'), [...args, '-c', "SELECT repeat('x',1048576)"], { maxBuffer: 2 * 1024 * 1024 })));
    const throughputMiBPerSecond = 2 / ((performance.now() - transferStarted) / 1000);
    for (const result of payloads) expect(result.stdout.length).toBe(1048577);
    const client = spawn(join(input.bin, 'psql'), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: client.stdout });
    const roundTripsMs: number[] = [];
    try {
      await once(client, 'spawn');
      for (let sample = 0; sample < 20; sample++) {
        const line = once(lines, 'line');
        const start = performance.now();
        client.stdin.write('SELECT 1;\n');
        expect((await line)[0]).toBe('1');
        roundTripsMs.push(performance.now() - start);
      }
    } finally {
      const exited = once(client, 'exit');
      client.stdin.end('\\q\n');
      await exited;
      lines.close();
    }
    roundTripsMs.sort((left, right) => left - right);
    const script = join(input.root, 'postgres-benchmark.sql');
    await writeFile(script, 'SELECT 1;\n');
    const benchmark = await runFile(join(input.bin, 'pgbench'), ['-h', forward.host, '-p', String(forward.port), '-U', 'forward_test', '-n', '-M', 'prepared', '-f', script, '-c', '2', '-j', '2', '-t', '50', 'postgres']);
    const transactionsPerSecond = Number(/tps = ([\d.]+)/u.exec(benchmark.stdout)?.[1]);
    expect(transactionsPerSecond).toBeGreaterThan(0);
    console.info(JSON.stringify({ fixture: 'postgresql-16-psql-pgbench', platform: process.platform, arch: process.arch,
      topology: input.topology, observedPath: forward.observedPath, setupMs, throughputMiBPerSecond, transactionsPerSecond,
      p50Ms: roundTripsMs[Math.ceil(roundTripsMs.length * .5) - 1], p95Ms: roundTripsMs[Math.ceil(roundTripsMs.length * .95) - 1] }));
  } finally {
    await forward?.close();
    const stopped = once(postgres, 'exit');
    postgres.kill('SIGTERM');
    await stopped;
  }
}

describe('real native Machine service export forwarding', () => {
  it.each(['direct', 'relay'] as const)('carries concurrent TCP/half-close, refuses a changed port, and reconnects over %s', async topology => {
    const addonPath = process.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH;
    if (!addonPath) throw new Error('An existing test-relay-fixture addon path is required.');
    const addon = loadIrohNodeNativeAddon(addonPath);
    const controller = createIrohTestControllerFromNativeAddon(addon);
    if (topology === 'direct') await controller.forceDirectOnly();
    else await controller.forceRelayOnly();
    const native = createIrohNodeNativeModule(addon);
    const root = await mkdtemp(join(tmpdir(), 'happier-service-forward-'));
    const source = await createDaemonMachineIrohRuntime({ happyHomeDir: join(root, 'a'), identity: 'ephemeral', relayConfig: { relayPolicy: 'disabled', relayUrls: [] }, native });
    const target = await createDaemonMachineIrohRuntime({ happyHomeDir: join(root, 'b'), identity: 'ephemeral', relayConfig: { relayPolicy: 'disabled', relayUrls: [] }, native });
    if (!source.available || !target.available) throw new Error('The native Machine endpoints are unavailable.');
    const sockets = new Set<Socket>();
    const destination = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      socket.on('data', chunk => socket.write(chunk));
      socket.on('end', () => socket.end());
    });
    destination.listen(0, '127.0.0.1');
    await once(destination, 'listening');
    const destinationAddress = destination.address();
    if (!destinationAddress || typeof destinationAddress === 'string') throw new Error('No TCP fixture listener.');
    const accountId = 'native-forward-owner';
    const sourceMachineId = 'native-a';
    const targetMachineId = 'native-b';
    const key = tweetnacl.sign.keyPair();
    const trustRoots = [{ keyId: 'native-home-key', publicKey: Buffer.from(key.publicKey).toString('base64url') }];
    const binding: TcpTunnelServiceExportBindingV1 = { exportKey: 'tcp',
      service: { kind: 'deployment', machineId: targetMachineId, environmentId: 'native-environment', environmentInstanceId: 'native-instance',
        composeService: 'tcp', serviceId: 'native-instance/tcp' }, installationId: 'native-installation', deploymentId: 'native-deployment', generation: 'native-generation',
      destination: { host: '127.0.0.1', port: destinationAddress.port } };
    let admittedBinding = binding;
    let applicationPort = 0;
    const admission = await startPeerMediationLoopbackServer({ nowMs: Date.now, endpointExpiresAt: Date.now() + 300000,
      expected: { accountId, machineId: targetMachineId, flowKind: 'tcp_tunnel', routeKind: 'loopback_direct', endpointFingerprint: target.endpoint.endpointId },
      trustRoots, tunnel: { resolveServiceExport: async () => admittedBinding },
      irohMachineAdmission: { localEndpointId: target.endpoint.endpointId, role: 'acceptor', allowedFlows: ['tcp_tunnel'],
        resolveApplicationTarget: () => ({ port: applicationPort }) } });
    applicationPort = Number(new URL(admission.url).port);
    let grantAccountId = accountId;
    let lastGrantRequest: DirectRouteGrantRequestV2 | undefined;
    let activeCarrier: Awaited<ReturnType<typeof source.openHttpTunnel>> | undefined;
    const mintGrant = async (request: DirectRouteGrantRequestV2) => {
        lastGrantRequest = request;
        const { kind, ttlMs, ...rest } = request;
        const payload = { ...rest, grantId: randomUUID(), accountId: grantAccountId, iat: Date.now(), exp: Date.now() + ttlMs,
          aud: 'happier-daemon-route-grant' as const, proofKind: kind };
        return { payload, signature: { keyId: 'native-home-key', alg: 'Ed25519',
          valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), key.secretKey)).toString('base64url') } };
    };
    const acquire = createServiceExportMachineForward({ accountId, localMachineId: sourceMachineId,
      runtime: { endpoint: source.endpoint, openHttpTunnel: async (request, endpoint) => {
        activeCarrier = await source.openHttpTunnel(request, endpoint);
        return activeCarrier;
      } },
      resolveTrustRoots: () => trustRoots,
      readTargetMachine: async () => ({ id: targetMachineId, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], ...target.endpoint } } }),
      mintGrant });
    let forward: ServiceExportMachineForward | undefined;
    async function echo(value: Buffer, selected = forward!): Promise<void> {
      const client = connect({ host: selected.host, port: selected.port, allowHalfOpen: true });
      sockets.add(client);
      const parts: Buffer[] = [];
      client.on('data', chunk => parts.push(chunk));
      const finished = once(client, 'end');
      client.end(value);
      await finished;
      expect(Buffer.concat(parts)).toEqual(value);
      client.destroy();
    }
    try {
      await target.startAttemptAcceptor({ admissionPort: applicationPort });
      let reportCarrierFailure!: (error: Error & Readonly<{ code: string }>) => void;
      const carrierFailure = new Promise<Error & Readonly<{ code: string }>>(resolve => { reportCarrierFailure = resolve; });
      const setupStart = performance.now();
      forward = await acquire({ targetMachineId, serviceExport: binding, onFailure: reportCarrierFailure });
      const setupMs = performance.now() - setupStart;
      expect(forward.observedPath).toBe(topology);
      const payload = Buffer.alloc(1024 * 1024, 0xa5);
      const transferStart = performance.now();
      await Promise.all([echo(payload), echo(Buffer.from(payload).fill(0x5a))]);
      const throughputMiBPerSecond = 4 / ((performance.now() - transferStart) / 1000);
      const roundTripsMs: number[] = [];
      const client = connect({ host: forward.host, port: forward.port });
      sockets.add(client);
      await once(client, 'connect');
      for (let sample = 0; sample < 20; sample++) {
        const response = once(client, 'data');
        const start = performance.now();
        client.write(Buffer.from([sample]));
        expect((await response)[0]).toEqual(Buffer.from([sample]));
        roundTripsMs.push(performance.now() - start);
      }
      client.destroy();
      roundTripsMs.sort((left, right) => left - right);
      console.info(JSON.stringify({ fixture: 'native-tcp-echo', platform: process.platform, arch: process.arch,
        topology, observedPath: forward.observedPath, setupMs, throughputMiBPerSecond,
        p50Ms: roundTripsMs[Math.ceil(roundTripsMs.length * .5) - 1], p95Ms: roundTripsMs[Math.ceil(roundTripsMs.length * .95) - 1] }));
      // A foreign Home cannot authorize an inner open through an existing native carrier.
      if (!activeCarrier || !lastGrantRequest) throw new Error('No admitted native carrier.');
      const foreignProof = createEphemeralPeerRouteProofHandleV2({ randomBytes: length => new Uint8Array(randomBytes(length)) });
      try {
        grantAccountId = 'foreign-account';
        const tunnelId = randomUUID();
        const foreignGrant = SignedDirectRouteGrantV2Schema.parse(await mintGrant({ ...lastGrantRequest,
          ephemeralPublicKeyBase64Url: foreignProof.publicKeyBase64Url,
          scope: { ...lastGrantRequest.scope, tunnelId } }));
        const foreignKey = tweetnacl.sign.keyPair();
        foreignGrant.signature = { keyId: 'foreign-home-key', alg: 'Ed25519',
          valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(foreignGrant.payload)), foreignKey.secretKey)).toString('base64url') };
        const refused = await fetch(`http://127.0.0.1:${activeCarrier.localPort}${PEER_TCP_TUNNEL_OPEN_PATH_V2}`, {
          method: 'POST', headers: { 'content-type': 'application/json', [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: activeCarrier.localCapability },
          body: JSON.stringify({ v: 2, kind: 'open', tunnelId, targetMachineId, routeKind: 'iroh_peer', destination: binding.destination,
            grant: foreignGrant, proof: foreignProof.sign(foreignGrant) }) });
        expect(refused.ok).toBe(false);
        expect(await refused.json()).toMatchObject({ reasonCode: 'grant_unknown_key' });
      } finally { foreignProof.dispose(); grantAccountId = accountId; }
      await new Promise<void>(resolve => destination.close(() => resolve()));
      let reportDestinationFailure!: (error: Error & Readonly<{ code: string }>) => void;
      const destinationFailure = new Promise<Error & Readonly<{ code: string }>>(resolve => { reportDestinationFailure = resolve; });
      let reportDestinationRecovery!: () => void;
      const destinationRecovery = new Promise<void>(resolve => { reportDestinationRecovery = resolve; });
      const unavailableDestination = await acquire({ targetMachineId, serviceExport: binding,
        onFailure: reportDestinationFailure, onRecovered: reportDestinationRecovery });
      try {
        const failedClient = connect({ host: unavailableDestination.host, port: unavailableDestination.port });
        sockets.add(failedClient);
        const closed = once(failedClient, 'close');
        failedClient.end(Buffer.from('first real destination dial'));
        await closed;
        await expect(destinationFailure).resolves.toMatchObject({ code: 'tcp_connect_failed' });
        destination.listen(binding.destination.port, '127.0.0.1');
        await once(destination, 'listening');
        await echo(Buffer.from('actual recovered destination'), unavailableDestination);
        await destinationRecovery;
      } finally {
        await unavailableDestination.close();
        if (!destination.listening) {
          destination.listen(binding.destination.port, '127.0.0.1');
          await once(destination, 'listening');
        }
      }
      await expect(acquire({ targetMachineId, serviceExport: { ...binding, destination: { ...binding.destination, port: binding.destination.port === 65535 ? 65534 : binding.destination.port + 1 } } }))
        .rejects.toMatchObject({ code: 'service_export_unavailable' });
      grantAccountId = 'foreign-account';
      await expect(acquire({ targetMachineId, serviceExport: binding })).rejects.toMatchObject({ code: 'handshake_account_mismatch' });
      grantAccountId = accountId;
      await source.stopActiveTunnels();
      await expect(carrierFailure).resolves.toMatchObject({ code: 'machine_carrier_unavailable' });
      await forward.close();
      await target.stopAttemptAcceptor();
      await target.startAttemptAcceptor({ admissionPort: applicationPort });
      forward = await acquire({ targetMachineId, serviceExport: binding });
      await echo(Buffer.from([0, 255, 128]));
      const cancellation = new AbortController();
      const cancelled = await acquire({ targetMachineId, serviceExport: binding, signal: cancellation.signal });
      cancellation.abort();
      await cancelled.close();
      const refused = connect({ host: cancelled.host, port: cancelled.port });
      await expect(once(refused, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      refused.destroy();
      if (process.env.HAPPIER_TEST_POSTGRES_BIN_DIR) {
        await measurePostgres({ bin: process.env.HAPPIER_TEST_POSTGRES_BIN_DIR, root, topology, binding, acquire,
          selectExport: selected => { admittedBinding = selected; } });
      }
    } finally {
      await forward?.close();
      for (const socket of sockets) socket.destroy();
      await source.shutdown();
      await target.shutdown();
      await admission.stop();
      await new Promise<void>(resolve => destination.close(() => resolve()));
      await controller.restoreAutomatic();
      await rm(root, { recursive: true, force: true });
    }
  });
});
