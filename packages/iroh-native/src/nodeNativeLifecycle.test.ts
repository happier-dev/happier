import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { loadIrohNodeNative, resolveIrohNodeAddonPath } from './nodeNative';
import { IROH_NODE_NATIVE_EXPORTS, type NodeIrohNativeModule, type IrohNodeMachineHttpObservation } from './nodeNative.types';
import { createNodeIrohHomeTunnelSession } from './nodeHomeTunnelSession';

/**
 * Shared-owner behavior through the real binding: when the addon artifact is
 * built for this host, exercise create endpoint → start acceptor → status →
 * tunnel leases → release → shutdown against the one native runtime. When no
 * artifact exists the suite reports skipped (not-run), never a fake runtime.
 */
// Remote source synchronization intentionally removes ignored native outputs
// from the mirrored package directory. An explicit test-only package root lets
// the deciding run load the freshly built addon from a non-mirrored temp path
// while every TypeScript test byte still comes from the current checkout.
const packageRoot = process.env.HAPPIER_IROH_TEST_PACKAGE_ROOT ?? join(import.meta.dirname, '..');
const addonPath = resolveIrohNodeAddonPath(packageRoot);
const hasBuiltAddon = existsSync(addonPath);
const loaded = loadIrohNodeNative(packageRoot);
if (process.env.HAPPIER_IROH_REQUIRE_NODE_ADDON === '1' && !hasBuiltAddon) {
  throw new Error(`required Iroh lifecycle addon is missing: ${addonPath}`);
}
if (hasBuiltAddon && !loaded.available) {
  throw new Error(`built Iroh lifecycle addon failed to load: ${loaded.message}`);
}
const describeWhenNative = hasBuiltAddon ? describe : describe.skip;

function startEchoServer(): Promise<{ server: Server; port: number; connections: { count: number } }> {
  return new Promise((resolve, reject) => {
    const connections = { count: 0 };
    const server = createServer((socket) => {
      connections.count += 1;
      socket.on('data', (chunk) => {
        socket.write(chunk);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('echo server address missing'));
        return;
      }
      resolve({ server, port: address.port, connections });
    });
  });
}

function startAdmissionServer(
  expectedRemoteEndpointId: string,
  applicationPort: number | null,
): Promise<{ server: Server; port: number; requests: string[] }> {
  return new Promise((resolve, reject) => {
    const requests: string[] = [];
    const server = createServer((socket) => {
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString('utf8');
        const split = request.indexOf('\r\n\r\n');
        if (split < 0) return;
        const length = Number(/\r\nContent-Length: (\d+)\r\n/i.exec(request.slice(0, split + 4))?.[1] ?? -1);
        if (request.length < split + 4 + length) return;
        requests.push(request);
        const applicationPortHeader =
          applicationPort === null ? '' : `X-Happier-Iroh-Application-Port: ${applicationPort}\r\n`;
        socket.end(
          `HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: ${expectedRemoteEndpointId}\r\n${applicationPortHeader}Content-Length: 0\r\nConnection: close\r\n\r\n`,
        );
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('admission server address missing'));
      resolve({ server, port: address.port, requests });
    });
  });
}

function echoOverPort(port: number, payload: string, localCapability?: string): Promise<void> {
  return echoOverRuntimeOrigin(`http://127.0.0.1:${port}`, payload, localCapability);
}

function loopbackPortOf(origin: string): number {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error(`runtime origin must be a loopback http origin: ${origin}`);
  }
  return Number(url.port);
}

function echoOverRuntimeOrigin(origin: string, payload: string, localCapability?: string): Promise<void> {
  const port = loopbackPortOf(origin);
  const wirePayload = localCapability
    ? `POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Happier-Machine-Local-Capability: ${localCapability}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
    : payload;
  const expectedEcho = localCapability
    ? `POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
    : payload;
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    socket.setTimeout(20_000);
    socket.on('connect', () => socket.write(wirePayload));
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.length >= expectedEcho.length) {
        socket.destroy();
        if (received === expectedEcho && (!localCapability || !received.includes(localCapability))) resolve();
        else reject(new Error(`echo response did not preserve only the authorized application bytes on ${origin}`));
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`echo timeout on ${origin}`));
    });
    socket.on('error', reject);
  });
}

function echoBinaryUpgradeOverPort(port: number, localCapability: string): Promise<void> {
  const applicationHead = 'GET /peer-mediation/v1/tunnel/stream HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n';
  const binary = Buffer.from([0x82, 3, 0xff, 0, 0x7f]);
  const wire = Buffer.concat([
    Buffer.from(`${applicationHead}Sec-WebSocket-Protocol: happier.iroh.cap.${localCapability}\r\n\r\n`),
    binary,
  ]);
  const expected = Buffer.concat([Buffer.from(`${applicationHead}\r\n`), binary]);
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    let bytes = 0;
    socket.on('connect', () => socket.write(wire));
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
      bytes += chunk.length;
      if (bytes >= expected.length) {
        socket.destroy();
        if (Buffer.concat(received).equals(expected)) resolve();
        else reject(new Error('NAPI TCP carrier changed binary upgrade bytes or disclosed its local capability'));
      }
    });
    socket.on('close', () => {
      if (bytes < expected.length) reject(new Error('NAPI TCP carrier closed before the binary upgrade echo'));
    });
  });
}

/** Resolves true once `origin` refuses connections (bounded polling). */
async function expectOriginDown(origin: string): Promise<boolean> {
  const port = loopbackPortOf(origin);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.setTimeout(2_000);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (!up) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

describeWhenNative('Iroh Node lifecycle binding over the shared native runtime', () => {
  let echo: { server: Server; port: number; connections: { count: number } } | null = null;
  let admission: { server: Server; port: number; requests: string[] } | null = null;
  let keyDir: string | null = null;

  const native: NodeIrohNativeModule | null = loaded.available ? loaded.native : null;

  function requireNative(): NodeIrohNativeModule {
    if (!native) throw new Error('native addon unexpectedly unavailable');
    return native;
  }

  afterEach(async () => {
    if (echo) {
      const server = echo.server;
      echo = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (admission) {
      const server = admission.server;
      admission = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (keyDir) {
      const dir = keyDir;
      keyDir = null;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports availability and typed null for unknown handles', async () => {
    const addon = requireNative();
    const availability = addon.getAvailability();
    expect(availability.available).toBe(true);
    expect(availability.surface).toEqual([...IROH_NODE_NATIVE_EXPORTS]);
    await expect(addon.getEndpointStatus('missing-handle')).resolves.toBeNull();
    await expect(addon.getTunnelStatus('missing-tunnel')).resolves.toBeNull();
  });

  it('keeps filesystem and lifecycle reads responsive while retired-peer dials are pending', { timeout: 90_000 }, async () => {
    const addon = requireNative();
    const client = await addon.createEndpoint({ relayPolicy: 'disabled', capProfile: 'machineBulk' });
    const peer = await addon.createEndpoint({ relayPolicy: 'disabled', capProfile: 'machineBulk' });
    const peerStatus = await addon.getEndpointStatus(peer.endpointHandle);
    await addon.shutdownEndpoint({ endpointHandle: peer.endpointHandle });
    if (!peerStatus?.directAddresses.length) throw new Error('retired peer direct address missing');

    // Fill the actual configured libuv pool, as concurrent daemon requests can.
    // Native lifecycle waits must not take the pool needed by file logging,
    // heartbeat persistence, DNS and requester admission.
    const poolSize = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
    const pendingDials = Array.from({ length: poolSize }, () => addon.startMachineTunnel({
      endpointHandle: client.endpointHandle,
      endpointId: peer.endpointId,
      directAddresses: peerStatus.directAddresses,
      handshakeJson: JSON.stringify({ v: 1, flow: 'tcp_tunnel' }),
    }).then(() => 'started', (error: unknown) => error));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const observation = await Promise.race([
        Promise.all([
          stat(import.meta.filename),
          addon.getEndpointStatus(client.endpointHandle),
        ]).then(([, status]) => ({ kind: 'responsive' as const, active: status?.active })),
        new Promise<{ kind: 'blocked' }>((resolve) => {
          watchdog = setTimeout(() => resolve({ kind: 'blocked' }), 1_000);
        }),
      ]);
      expect(observation).toEqual({ kind: 'responsive', active: true });
    } finally {
      clearTimeout(watchdog);
      // The public shutdown boundary cancels dials before joining them; cleanup
      // still works on the defective binding whose worker pool is saturated.
      await addon.shutdownEndpoint({ endpointHandle: client.endpointHandle });
      const settled = await Promise.all(pendingDials);
      expect(settled.every((result) => result instanceof Error)).toBe(true);
    }
  });

  it('isolates Account-client identities and preserves Machine continuity after helper shutdown', { timeout: 90_000 }, async () => {
    const addon = requireNative();
    echo = await startEchoServer();
    keyDir = await mkdtemp(join(tmpdir(), 'happier-iroh-helper-custody-'));
    const home = await addon.createEndpoint({ keyPath: join(keyDir, 'home.key'), relayPolicy: 'disabled' });
    const machine = await addon.createEndpoint({
      keyPath: join(keyDir, 'machine.key'), relayPolicy: 'disabled', capProfile: 'machineBulk',
    });
    const helperEndpoints: Awaited<ReturnType<NodeIrohNativeModule['createEndpoint']>>[] = [];
    const observedNative = {
      ...addon,
      createEndpoint: async (input) => {
        const endpoint = await addon.createEndpoint(input);
        helperEndpoints.push(endpoint);
        return endpoint;
      },
    } satisfies NodeIrohNativeModule;
    const first = await createNodeIrohHomeTunnelSession({ native: observedNative, keylessEndpoint: 'account_client', relayPolicy: 'disabled' });
    const second = await createNodeIrohHomeTunnelSession({ native: observedNative, keylessEndpoint: 'account_client', relayPolicy: 'disabled' });
    let machineStream: ReturnType<typeof connect> | null = null;
    try {
      await addon.startHomeAcceptor({ endpointHandle: home.endpointHandle, targetPort: echo.port });
      admission = await startAdmissionServer(machine.endpointId, echo.port);
      await addon.startMachineAcceptor({ endpointHandle: machine.endpointHandle, admissionPort: admission.port });
      const directAddresses = (await addon.getEndpointStatus(home.endpointHandle))?.directAddresses;
      if (!directAddresses?.length) throw new Error('Home endpoint direct address missing');
      const descriptor = {
        v: 1 as const, homeServerIdentityId: 'srv_home_helper_custody',
        canonicalServerUrl: 'https://home.example', revision: 1,
        endpoints: [{ kind: 'iroh' as const, endpointId: home.endpointId, directAddresses }],
      };
      const machineLease = await addon.ensureHomeTunnel({
        endpointHandle: machine.endpointHandle, homeServerIdentityId: descriptor.homeServerIdentityId,
        endpointId: home.endpointId, directAddresses,
      });
      await first.ensureHomeTunnel({ descriptor });
      const sibling = await second.ensureHomeTunnel({ descriptor });
      expect(new Set([machine.endpointId, ...helperEndpoints.map((endpoint) => endpoint.endpointId)]).size).toBe(3);
      const socket = connect(loopbackPortOf(machineLease.runtimeOrigin), '127.0.0.1');
      machineStream = socket;
      const echoOnMachineStream = (payload: string) => new Promise<void>((resolve, reject) => {
        let received = '';
        const cleanup = () => {
          socket.off('data', onData);
          socket.off('error', onError);
          socket.off('close', onClose);
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onClose = () => onError(new Error('Machine stream closed before echo completed'));
        const onData = (chunk: Buffer) => {
          received += chunk.toString('utf8');
          if (received.length < payload.length) return;
          cleanup();
          if (received === payload) resolve();
          else reject(new Error('Machine stream did not preserve application bytes'));
        };
        socket.on('data', onData);
        socket.once('error', onError);
        socket.once('close', onClose);
        socket.write(payload);
      });
      await echoOnMachineStream('machine-before-helper-close');
      await first.shutdown();
      await expect(addon.getEndpointStatus(helperEndpoints[0]!.endpointHandle)).resolves.toBeNull();
      expect((await addon.getEndpointStatus(machine.endpointHandle))?.active).toBe(true);
      expect((await addon.getMachineAcceptorStatus(machine.endpointHandle))?.running).toBe(true);
      await echoOnMachineStream('same-machine-stream-after-helper-close');
      await echoOverRuntimeOrigin(sibling.runtimeOrigin, 'sibling-after-helper-close');
      await addon.releaseHomeTunnel(machineLease.tunnelId);
    } finally {
      machineStream?.destroy();
      await first.shutdown();
      await second.shutdown();
      await addon.shutdownEndpoint({ endpointHandle: machine.endpointHandle });
      await addon.shutdownEndpoint({ endpointHandle: home.endpointHandle });
    }
  });

  it('serves two tunnel leases on one shared endpoint, releases one, and shuts down', { timeout: 90_000 }, async () => {
    const addon = requireNative();
    echo = await startEchoServer();
    keyDir = await mkdtemp(join(tmpdir(), 'happier-iroh-node-binding-'));
    const serverKey = join(keyDir, 'server.key');
    const clientKey = join(keyDir, 'client.key');

    const serverEndpoint = await addon.createEndpoint({ keyPath: serverKey, relayPolicy: 'disabled' });
    const serverStatus = await addon.getEndpointStatus(serverEndpoint.endpointHandle);
    expect(serverStatus?.active).toBe(true);
    const directAddress = serverStatus?.directAddresses[0];
    if (typeof directAddress !== 'string') throw new Error('endpoint status missing a direct address');

    const acceptor = await addon.startHomeAcceptor({
      endpointHandle: serverEndpoint.endpointHandle,
      targetPort: echo.port,
    });
    expect(acceptor.reused).toBe(false);
    expect(acceptor.status.running).toBe(true);

    const clientEndpoint = await addon.createEndpoint({ keyPath: clientKey, relayPolicy: 'disabled' });
    const leaseRequest = {
      endpointHandle: clientEndpoint.endpointHandle,
      homeServerIdentityId: 'srv_home_a',
      endpointId: serverEndpoint.endpointId,
      directAddresses: [directAddress],
    };
    const first = await addon.ensureHomeTunnel(leaseRequest);
    const second = await addon.ensureHomeTunnel({ ...leaseRequest, homeServerIdentityId: 'srv_home_b' });
    // Compatible leases share the one endpoint handle — no second runtime.
    expect(first.endpointHandle).toBe(clientEndpoint.endpointHandle);
    expect(second.endpointHandle).toBe(clientEndpoint.endpointHandle);
    expect(first.runtimeOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(second.runtimeOrigin).not.toBe(first.runtimeOrigin);

    await echoOverRuntimeOrigin(first.runtimeOrigin, 'iroh-node-binding-bytes-a');
    await echoOverRuntimeOrigin(second.runtimeOrigin, 'iroh-node-binding-bytes-b');

    const status = await addon.getTunnelStatus(first.tunnelId);
    expect(status?.connectionActive).toBe(true);
    expect(status?.observedPath).toBe('direct');

    // Beyond the pinned transport's 30-second dead-peer window, healthy
    // application-idle connections must survive on Iroh's own keepalives.
    await new Promise((resolveIdle) => setTimeout(resolveIdle, 35_000));
    expect((await addon.getTunnelStatus(second.tunnelId))?.connectionActive).toBe(true);
    await echoOverRuntimeOrigin(second.runtimeOrigin, 'same-idle-tunnel-still-serves-bytes');

    await addon.releaseHomeTunnel(first.tunnelId);
    expect(await expectOriginDown(first.runtimeOrigin)).toBe(true);
    const sibling = await addon.getTunnelStatus(second.tunnelId);
    expect(sibling?.connectionActive).toBe(true);

    await addon.stopHomeAcceptor({ endpointHandle: serverEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: clientEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: serverEndpoint.endpointHandle });
    await expect(addon.getEndpointStatus(clientEndpoint.endpointHandle)).resolves.toBeNull();
  });

  it('moves finite-transfer HTTP bytes through one capability-free native listener', { timeout: 90_000 }, async () => {
    const addon = requireNative();
    echo = await startEchoServer();
    keyDir = await mkdtemp(join(tmpdir(), 'happier-iroh-machine-binding-'));
    const serverEndpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'server.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    const clientEndpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'client.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    admission = await startAdmissionServer(clientEndpoint.endpointId, echo.port);
    await addon.startMachineAcceptor({
      endpointHandle: serverEndpoint.endpointHandle,
      admissionPort: admission.port,
    });
    const serverStatus = await addon.getEndpointStatus(serverEndpoint.endpointHandle);
    const directAddress = serverStatus?.directAddresses[0];
    if (!directAddress) throw new Error('machine endpoint direct address missing');
    const handshakeJson = JSON.stringify({ v: 1, flow: 'finite_transfer' });
    const tunnel = await addon.startMachineTunnel({
      endpointHandle: clientEndpoint.endpointHandle,
      endpointId: serverEndpoint.endpointId,
      directAddresses: [directAddress],
      handshakeJson,
    });
    expect(tunnel.localPort).toBeGreaterThan(0);
    expect(tunnel).not.toHaveProperty('localCapability');
    expect(tunnel.remoteEndpointId).toBe(serverEndpoint.endpointId);
    const request = 'POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 21\r\nConnection: close\r\n\r\nfinite-transfer-bytes';
    await echoOverPort(tunnel.localPort, request);
    expect(admission.requests).toHaveLength(1);
    expect(admission.requests[0]).toContain(`X-Happier-Iroh-Remote-Endpoint-Id: ${clientEndpoint.endpointId}\r\n`);
    expect(admission.requests[0]?.endsWith(handshakeJson)).toBe(true);
    const status = await addon.getMachineTunnelStatus(tunnel.machineTunnelId);
    expect(status?.streamsOpened).toBe(1);
    await addon.stopMachineTunnel(tunnel.machineTunnelId);
    expect(await expectOriginDown(`http://127.0.0.1:${tunnel.localPort}`)).toBe(true);
    await addon.stopMachineAcceptor({ endpointHandle: serverEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: clientEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: serverEndpoint.endpointHandle });
  });

  it.each(['provider_broker', 'tcp_tunnel'] as const)('keeps the %s HTTP adapter capability-protected through the NAPI lifecycle', { timeout: 90_000 }, async (purpose) => {
    const addon = requireNative();
    echo = await startEchoServer();
    keyDir = await mkdtemp(join(tmpdir(), 'happier-iroh-machine-binding-'));
    const serverEndpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'server.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    const clientEndpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'client.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    // The trusted local admission response — not an acceptor input — selects
    // the application loopback port for the authenticated stream.
    admission = await startAdmissionServer(clientEndpoint.endpointId, echo.port);
    await addon.startMachineAcceptor({
      endpointHandle: serverEndpoint.endpointHandle,
      admissionPort: admission.port,
    });
    const serverStatus = await addon.getEndpointStatus(serverEndpoint.endpointHandle);
    const directAddress = serverStatus?.directAddresses[0];
    if (!directAddress) throw new Error('machine endpoint direct address missing');
    const handshakeJson = JSON.stringify(purpose === 'tcp_tunnel'
      ? { v: 1, flow: purpose }
      : { v: 1, kind: purpose });
    const tunnel = await addon.startMachineHttpTunnel({
      endpointHandle: clientEndpoint.endpointHandle,
      endpointId: serverEndpoint.endpointId,
      directAddresses: [directAddress],
      handshakeJson,
    });
    expect(tunnel.localPort).toBeGreaterThan(0);
    expect(tunnel.localCapability).toMatch(/^[0-9a-f]{64}$/);
    // The tunnel surfaces the normalized authenticated remote identity.
    expect(tunnel.remoteEndpointId).toBe(serverEndpoint.endpointId);
    await echoOverPort(tunnel.localPort, 'node-machine-http-nonzero-bytes', tunnel.localCapability);
    if (purpose === 'tcp_tunnel') {
      // A TCP mux requires more than the finite carrier's single local socket.
      await echoOverPort(tunnel.localPort, 'node-machine-tcp-second-stream', tunnel.localCapability);
      await echoBinaryUpgradeOverPort(tunnel.localPort, tunnel.localCapability);
    }
    const streamCount = purpose === 'tcp_tunnel' ? 3 : 1;
    expect(admission.requests).toHaveLength(streamCount);
    expect(admission.requests[0]).toContain(`X-Happier-Iroh-Remote-Endpoint-Id: ${clientEndpoint.endpointId}\r\n`);
    expect(admission.requests[0]?.endsWith(handshakeJson)).toBe(true);
    const status = await addon.getMachineTunnelStatus(tunnel.machineTunnelId);
    expect(status?.streamsOpened).toBe(streamCount);
    expect(status?.remoteEndpointId).toBe(serverEndpoint.endpointId);
    const acceptorStatus = await addon.getMachineAcceptorStatus(serverEndpoint.endpointHandle);
    expect(acceptorStatus?.streamsAccepted).toBe(streamCount);
    await addon.stopMachineTunnel(tunnel.machineTunnelId);
    await expect(addon.getMachineTunnelStatus(tunnel.machineTunnelId)).resolves.toBeNull();
    expect(await expectOriginDown(`http://127.0.0.1:${tunnel.localPort}`)).toBe(true);
    await addon.stopMachineAcceptor({ endpointHandle: serverEndpoint.endpointHandle });
    await expect(addon.getMachineAcceptorStatus(serverEndpoint.endpointHandle)).resolves.toBeNull();
    await addon.shutdownEndpoint({ endpointHandle: clientEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: serverEndpoint.endpointHandle });
  });

  it('observes paired HTTP metadata through the real binding while keepalive bodies stay native', { timeout: 90_000 }, async () => {
    const addon = requireNative();
    const body = 'HTTP/1.1 403 Forbidden\r\nx-broker-code: body-only\r\n\r\n';
    let received = 0;
    const server = createServer(socket => {
      let buffer = '';
      socket.on('data', bytes => {
        buffer += bytes.toString('utf8');
        let end: number;
        while ((end = buffer.indexOf('\r\n\r\n')) >= 0) {
          buffer = buffer.slice(end + 4);
          received++;
          if (received === 1) socket.write(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nSet-Cookie: private\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`);
          else socket.end('HTTP/1.1 403 Forbidden\r\nx-broker-code: team_credential_usage_limit\r\nContent-Length: 3\r\n\r\nno!');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('application listener missing');
    echo = { server, port: address.port, connections: { count: 0 } };
    keyDir = await mkdtemp(join(tmpdir(), 'happier-iroh-http-observation-'));
    const endpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'server.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    const client = await addon.createEndpoint({ keyPath: join(keyDir, 'client.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    admission = await startAdmissionServer(client.endpointId, address.port);
    await addon.startMachineAcceptor({ endpointHandle: endpoint.endpointHandle, admissionPort: admission.port });
    const endpointStatus = await addon.getEndpointStatus(endpoint.endpointHandle);
    const events: IrohNodeMachineHttpObservation[] = [];
    let refuseLocally = false;
    const tunnel = await addon.startMachineHttpTunnel({
      endpointHandle: client.endpointHandle, endpointId: endpoint.endpointId,
      directAddresses: endpointStatus?.directAddresses,
      handshakeJson: JSON.stringify({ v: 1, kind: 'provider_broker' }),
      handshakeProvider: async () => JSON.stringify(refuseLocally
        ? { kind: 'http_refusal', responseBody: '{}', responseHeaders: { 'x-broker-code': 'application_refused' } }
        : { v: 1, kind: 'provider_broker' }),
      observedResponseHeaders: ['x-broker-code'], httpObserver: async event => { events.push(event); },
    });
    const request = (paths: readonly string[]) => new Promise<string>((resolve, reject) => {
      const socket = connect(tunnel.localPort, '127.0.0.1');
      const chunks: Buffer[] = [];
      socket.on('data', bytes => chunks.push(bytes));
      socket.on('error', reject);
      socket.on('end', () => { socket.end(); resolve(Buffer.concat(chunks).toString('utf8')); });
      socket.on('connect', () => socket.write(paths.map(path => `GET /${path} HTTP/1.1\r\nHost: local\r\nX-Happier-Machine-Local-Capability: ${tunnel.localCapability}\r\n\r\n`).join('')));
    });
    const response = await request(['1', '2']);
    expect(received).toBe(2);
    expect(response).toContain(body);
    expect(response.endsWith('\r\n\r\nno!')).toBe(true);
    expect(events.filter(event => event.kind === 'response')).toEqual([
      { kind: 'response', connectionId: '1', requestId: '1', status: 200, headers: {} },
      { kind: 'response', connectionId: '1', requestId: '2', status: 403, headers: { 'x-broker-code': 'team_credential_usage_limit' } },
    ]);
    expect(events.filter(event => event.kind === 'request')).toHaveLength(2);
    refuseLocally = true;
    const refused = await request(['refused']);
    expect(refused).toContain('x-broker-code: application_refused\r\n');
    expect(events.filter(event => event.kind === 'response').at(-1)).toEqual({
      kind: 'response', connectionId: '2', requestId: '1', status: 403,
      headers: { 'x-broker-code': 'application_refused' },
    });
    expect(received).toBe(2); // Local refusal opens no application stream.
    await addon.stopMachineTunnel(tunnel.machineTunnelId);
    await addon.stopMachineAcceptor({ endpointHandle: endpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: client.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: endpoint.endpointHandle });
  });

  it('requests distinct fresh handshakes for later provider HTTP connections', { timeout: 90_000 }, async () => {
    const addon = requireNative();
    echo = await startEchoServer();
    keyDir = await mkdtemp(join(tmpdir(), 'happier-iroh-machine-binding-'));
    const serverEndpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'server.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    const clientEndpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'client.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    admission = await startAdmissionServer(clientEndpoint.endpointId, echo.port);
    await addon.startMachineAcceptor({ endpointHandle: serverEndpoint.endpointHandle, admissionPort: admission.port });
    const serverStatus = await addon.getEndpointStatus(serverEndpoint.endpointHandle);
    const directAddress = serverStatus?.directAddresses[0];
    if (!directAddress) throw new Error('machine endpoint direct address missing');
    let witness = 0;
    const tunnel = await addon.startMachineHttpTunnel({
      endpointHandle: clientEndpoint.endpointHandle,
      endpointId: serverEndpoint.endpointId,
      directAddresses: [directAddress],
      handshakeJson: JSON.stringify({ v: 1, kind: 'provider_broker', witness: 0 }),
      handshakeProvider: async () => JSON.stringify({ v: 1, kind: 'provider_broker', witness: ++witness }),
    });
    await echoOverPort(tunnel.localPort, 'first-connection', tunnel.localCapability);
    await echoOverPort(tunnel.localPort, 'second-connection', tunnel.localCapability);
    expect(admission.requests.map((request) => JSON.parse(request.split('\r\n\r\n')[1] ?? '{}').witness))
      .toEqual([1, 2]);
    await addon.stopMachineTunnel(tunnel.machineTunnelId);
    await addon.stopMachineAcceptor({ endpointHandle: serverEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: clientEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: serverEndpoint.endpointHandle });
  });

  it('rejects the stream without any application contact when admission omits the application port', { timeout: 90_000 }, async () => {
    const addon = requireNative();
    echo = await startEchoServer();
    keyDir = await mkdtemp(join(tmpdir(), 'happier-iroh-machine-binding-'));
    const serverEndpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'server.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    const clientEndpoint = await addon.createEndpoint({ keyPath: join(keyDir, 'client.key'), relayPolicy: 'disabled', capProfile: 'machineBulk' });
    // Approved 2xx admission with an exact echo but no application-port
    // selection must reject before any application connection.
    admission = await startAdmissionServer(clientEndpoint.endpointId, null);
    await addon.startMachineAcceptor({
      endpointHandle: serverEndpoint.endpointHandle,
      admissionPort: admission.port,
    });
    const serverStatus = await addon.getEndpointStatus(serverEndpoint.endpointHandle);
    const directAddress = serverStatus?.directAddresses[0];
    if (!directAddress) throw new Error('machine endpoint direct address missing');
    const tunnel = await addon.startMachineTunnel({
      endpointHandle: clientEndpoint.endpointHandle,
      endpointId: serverEndpoint.endpointId,
      directAddresses: [directAddress],
      handshakeJson: JSON.stringify({ v: 1, flow: 'finite_transfer' }),
    });
    const connectionsBefore = echo.connections.count;
    await new Promise<void>((resolve, reject) => {
      const socket = connect(tunnel.localPort, '127.0.0.1');
      socket.setTimeout(20_000);
      socket.on('connect', () => {
        socket.write('must-not-reach-app');
      });
      socket.on('data', () => reject(new Error('stream admitted without an application-port selection')));
      socket.on('close', resolve);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('missing-port rejection timed out'));
      });
      // A rejected native stream may surface as either an orderly close or a
      // TCP reset depending on the host network stack. Both are the expected
      // fail-closed outcome; receiving application data is the actual defect.
      socket.on('error', () => resolve());
    });
    expect(echo.connections.count).toBe(connectionsBefore);
    const acceptorStatus = await addon.getMachineAcceptorStatus(serverEndpoint.endpointHandle);
    expect(acceptorStatus?.streamsAccepted).toBe(0);
    expect(acceptorStatus?.streamsRejected).toBe(1);
    await addon.stopMachineTunnel(tunnel.machineTunnelId);
    await addon.stopMachineAcceptor({ endpointHandle: serverEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: clientEndpoint.endpointHandle });
    await addon.shutdownEndpoint({ endpointHandle: serverEndpoint.endpointHandle });
  });
});
