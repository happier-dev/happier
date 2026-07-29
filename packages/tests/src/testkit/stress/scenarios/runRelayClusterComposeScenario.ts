import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  createPeerTcpTunnelRelayAuthorizationSigningInputV2,
  PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
  type PeerTcpTunnelRelayAuthorizationPayloadV2,
  type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';
import { io, type Socket } from 'socket.io-client';
import nacl from 'tweetnacl';

import type { TestAuth } from '../../auth';
import { fetchJson } from '../../http';
import type { RunDirs } from '../../runDir';
import { fetchAccountId } from '../../socialFriends';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { renderStressGatewayNginxConf } from '../docker/renderStressGatewayNginxConf';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type {
  StartedStressTarget,
  StressTargetServiceContainer,
} from '../targets/stressTargetTypes';
import {
  activateGatewayConfig,
  readClusterServiceMetricsByReplicaViaNodeFetch,
  readLabeledMetricValue,
  requireFullComposeAdmin,
  resolveServiceUpstreamTargets,
  waitForRedisServiceHealthy,
  writeScenarioGatewayConfig,
} from './fullComposeScenarioSupport';

const stickyHeaderName = 'X-Happier-Relay-Sticky-Key';
const relayPort = 3000;
const socketPath = '/v1/updates/';
const socketTimeoutMs = 30_000;

export function assertRelayClusterComposeConfig(config: StressConfig): void {
  if (config.targetMode !== 'full-compose') {
    throw new Error('Relay cluster compose scenario requires full-compose target mode');
  }
  if (config.compose.apiReplicas !== 2) {
    throw new Error('Relay cluster compose scenario requires exactly two configured API replicas');
  }
  if (!config.compose.metricsEnabled) {
    throw new Error('Relay cluster compose scenario requires per-replica metrics');
  }
}

type RelayEnvelopeFactory = Readonly<{
  open: (input: Readonly<{
    tunnelId: string;
    grantId: string;
    relaySocketId: string;
    expiresAt?: number;
  }>) => PeerTcpTunnelRelayEnvelope;
  userData: (input: Readonly<{
    tunnelId: string;
    sequence: number;
    payload: string;
  }>) => PeerTcpTunnelRelayEnvelope;
  machineData: (input: Readonly<{
    tunnelId: string;
    userSocketId: string;
    sequence: number;
    payload: string;
  }>) => PeerTcpTunnelRelayEnvelope;
}>;

export function createRelayClusterEnvelopeFactory(input: Readonly<{
  accountId: string;
  machineId: string;
  signingKeyId: string;
  signingPrivateKeySeedBase64Url: string;
  now?: () => number;
}>): RelayEnvelopeFactory {
  const signingSeed = Buffer.from(input.signingPrivateKeySeedBase64Url, 'base64url');
  if (signingSeed.byteLength !== nacl.sign.seedLength) {
    throw new Error(`Expected a ${nacl.sign.seedLength}-byte relay signing seed`);
  }
  const signingKeyPair = nacl.sign.keyPair.fromSeed(signingSeed);
  const now = input.now ?? Date.now;

  return {
    open: ({ tunnelId, grantId, relaySocketId, expiresAt }) => {
      const issuedAt = now();
      const destination = { host: '127.0.0.1', port: relayPort } as const;
      const payload = {
        v: 2,
        grantId,
        accountId: input.accountId,
        targetMachineId: input.machineId,
        flowKind: 'voice_media',
        applicationKind: 'speech_transcription',
        applicationAttemptId: `attempt_${tunnelId}`,
        applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
        routeKind: 'server_relay',
        tunnelId,
        relaySocketId,
        destination,
        capProfileId: 'interactive',
        maxFrameBytes: 64 * 1024,
        maxIdleMs: 30_000,
        maxDurationMs: 300_000,
        maxTotalBytes: 64 * 1024 * 1024,
        iat: issuedAt,
        exp: expiresAt ?? issuedAt + 300_000,
        aud: 'happier-tcp-tunnel-relay-authorization',
      } satisfies PeerTcpTunnelRelayAuthorizationPayloadV2;

      return {
        v: 1,
        scopeUserId: input.accountId,
        sender: { kind: 'user', socketId: relaySocketId },
        recipient: { kind: 'machine', machineId: input.machineId },
        frame: {
          v: 1,
          kind: 'open',
          open: {
            v: 1,
            kind: 'open',
            tunnelId,
            targetMachineId: input.machineId,
            routeKind: 'server_relay',
            destination,
            relayAuthorization: {
              payload,
              signature: {
                keyId: input.signingKeyId,
                alg: 'Ed25519',
                valueBase64Url: Buffer.from(nacl.sign.detached(
                  new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload)),
                  signingKeyPair.secretKey,
                )).toString('base64url'),
              },
            },
          },
        },
      };
    },
    userData: ({ tunnelId, sequence, payload }) => ({
      v: 1,
      scopeUserId: input.accountId,
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: input.machineId },
      frame: {
        v: 1,
        kind: 'data',
        tunnelId,
        direction: 'client_to_daemon',
        sequence,
        payloadBase64: Buffer.from(payload).toString('base64'),
      },
    }),
    machineData: ({ tunnelId, userSocketId, sequence, payload }) => ({
      v: 1,
      scopeUserId: input.accountId,
      sender: { kind: 'machine', machineId: input.machineId },
      recipient: { kind: 'user', socketId: userSocketId },
      frame: {
        v: 1,
        kind: 'data',
        tunnelId,
        direction: 'daemon_to_client',
        sequence,
        payloadBase64: Buffer.from(payload).toString('base64'),
      },
    }),
  };
}

type RawRelayClient = Readonly<{
  socket: Socket;
  frames: PeerTcpTunnelRelayEnvelope[];
  errors: unknown[];
  close: () => void;
}>;

export async function connectRawRelayClient(input: Readonly<{
  baseUrl: string;
  token: string;
  stickyKey: string;
  clientType: 'user-scoped' | 'machine-scoped';
  machineId?: string;
}>): Promise<RawRelayClient> {
  const frames: PeerTcpTunnelRelayEnvelope[] = [];
  const errors: unknown[] = [];
  const socket = io(input.baseUrl, {
    path: socketPath,
    transports: ['websocket'],
    timeout: socketTimeoutMs,
    reconnection: false,
    autoConnect: false,
    forceNew: true,
    extraHeaders: {
      [stickyHeaderName]: input.stickyKey,
    },
    auth: {
      token: input.token,
      clientType: input.clientType,
      ...(input.clientType === 'machine-scoped' ? { machineId: input.machineId } : {}),
    },
  });
  socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value: PeerTcpTunnelRelayEnvelope) => {
    frames.push(value);
  });
  socket.on('error', (value: unknown) => {
    errors.push(value);
  });
  socket.connect();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting ${input.clientType} relay socket`));
      }, socketTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timeout);
        resolvePromise();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } catch (error) {
    socket.disconnect();
    throw error;
  }
  return {
    socket,
    frames,
    errors,
    close: () => socket.disconnect(),
  };
}

export async function withRelayClientCleanup<TResult>(
  run: (
    retainClient: <TClient extends Readonly<{ close: () => void }>>(client: TClient) => TClient,
  ) => Promise<TResult>,
): Promise<TResult> {
  const retainedClients: Array<Readonly<{ close: () => void }>> = [];
  const retainClient = <TClient extends Readonly<{ close: () => void }>>(client: TClient): TClient => {
    retainedClients.push(client);
    return client;
  };

  try {
    return await run(retainClient);
  } finally {
    for (const client of retainedClients) {
      client.close();
    }
  }
}

function envelopeTunnelId(envelope: PeerTcpTunnelRelayEnvelope): string | undefined {
  if (envelope.v !== 1) return undefined;
  return envelope.frame.kind === 'open' ? envelope.frame.open.tunnelId : envelope.frame.tunnelId;
}

function framesForTunnel(
  frames: readonly PeerTcpTunnelRelayEnvelope[],
  tunnelId: string,
): PeerTcpTunnelRelayEnvelope[] {
  return frames.filter((frame) => envelopeTunnelId(frame) === tunnelId);
}

function dataPayloads(frames: readonly PeerTcpTunnelRelayEnvelope[], tunnelId: string): string[] {
  return framesForTunnel(frames, tunnelId).flatMap((envelope) => {
    if (envelope.v !== 1 || envelope.frame.kind !== 'data') return [];
    return [Buffer.from(envelope.frame.payloadBase64, 'base64').toString('utf8')];
  });
}

function terminalCount(
  frames: readonly PeerTcpTunnelRelayEnvelope[],
  tunnelId: string,
  reasonCode: string,
): number {
  return framesForTunnel(frames, tunnelId).filter((envelope) =>
    envelope.v === 1
    && (envelope.frame.kind === 'abort' || envelope.frame.kind === 'close')
    && envelope.frame.reasonCode === reasonCode,
  ).length;
}

async function readReplicaConnectionCounts(
  target: StartedStressTarget,
  clientType: 'user-scoped' | 'machine-scoped',
): Promise<Map<string, number>> {
  const replicas = await readClusterServiceMetricsByReplicaViaNodeFetch(target, 'api');
  return new Map(replicas.map((replica) => [
    replica.containerId,
    readLabeledMetricValue({
      metricsText: replica.metricsText,
      metricName: 'websocket_connections_active',
      labels: { role: 'api', type: clientType },
    }),
  ]));
}

async function resolveConnectedReplica(input: Readonly<{
  target: StartedStressTarget;
  baseline: ReadonlyMap<string, number>;
  clientType: 'user-scoped' | 'machine-scoped';
}>): Promise<string | null> {
  const current = await readReplicaConnectionCounts(input.target, input.clientType);
  const increased = [...current.entries()].filter(([containerId, value]) =>
    value === (input.baseline.get(containerId) ?? 0) + 1,
  );
  return increased.length === 1 ? increased[0]?.[0] ?? null : null;
}

async function discoverDistinctStickyKeys(input: Readonly<{
  target: StartedStressTarget;
  token: string;
}>): Promise<Readonly<{
  first: { stickyKey: string; containerId: string };
  second: { stickyKey: string; containerId: string };
}>> {
  const baseline = await readReplicaConnectionCounts(input.target, 'user-scoped');
  const discovered = new Map<string, string>();
  for (let index = 0; index < 64 && discovered.size < 2; index += 1) {
    const stickyKey = `relay-cluster-placement-${index}`;
    const probe = await connectRawRelayClient({
      baseUrl: input.target.baseUrl,
      token: input.token,
      stickyKey,
      clientType: 'user-scoped',
    });
    try {
      let containerId: string | null = null;
      await waitFor(async () => {
        containerId = await resolveConnectedReplica({
          target: input.target,
          baseline,
          clientType: 'user-scoped',
        });
        return containerId !== null;
      }, {
        timeoutMs: socketTimeoutMs,
        intervalMs: 250,
        context: `sticky placement for ${stickyKey}`,
      });
      discovered.set(containerId!, stickyKey);
    } finally {
      probe.close();
      await waitFor(async () => {
        const current = await readReplicaConnectionCounts(input.target, 'user-scoped');
        return [...baseline.entries()].every(([id, value]) => current.get(id) === value);
      }, {
        timeoutMs: socketTimeoutMs,
        intervalMs: 250,
        context: `sticky probe cleanup for ${stickyKey}`,
      });
    }
  }
  const entries = [...discovered.entries()];
  if (entries.length !== 2 || !entries[0] || !entries[1]) {
    throw new Error(`Could not discover sticky keys for two distinct API replicas (found=${entries.length})`);
  }
  return {
    first: { containerId: entries[0][0], stickyKey: entries[0][1] },
    second: { containerId: entries[1][0], stickyKey: entries[1][1] },
  };
}

async function provisionMachine(baseUrl: string, token: string, machineId: string): Promise<void> {
  const response = await fetchJson(`${baseUrl}/v1/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: machineId,
      metadata: 'relay-cluster-compose-test-machine',
    }),
    timeoutMs: socketTimeoutMs,
  });
  if (response.status !== 200) {
    throw new Error(`Failed to provision relay cluster machine (status=${response.status})`);
  }
}

async function waitForExactContainerHealthy(
  target: StartedStressTarget,
  containerId: string,
): Promise<StressTargetServiceContainer> {
  let matched: StressTargetServiceContainer | undefined;
  await waitFor(async () => {
    matched = (await target.admin?.listServiceContainers('api'))?.find((entry) =>
      entry.id === containerId && entry.state === 'running' && entry.health === 'healthy',
    );
    return matched !== undefined;
  }, {
    timeoutMs: 60_000,
    intervalMs: 500,
    context: `API container ${containerId} healthy`,
  });
  return matched!;
}

async function assertClientPlacement(input: Readonly<{
  target: StartedStressTarget;
  clientType: 'user-scoped' | 'machine-scoped';
  expectedContainerId: string;
  baseline: ReadonlyMap<string, number>;
}>): Promise<void> {
  await waitFor(async () =>
    await resolveConnectedReplica({
      target: input.target,
      baseline: input.baseline,
      clientType: input.clientType,
    }) === input.expectedContainerId,
  {
    timeoutMs: socketTimeoutMs,
    intervalMs: 250,
    context: `${input.clientType} placed on ${input.expectedContainerId}`,
  });
}

function emit(socket: Socket, envelope: PeerTcpTunnelRelayEnvelope): void {
  socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);
}

async function waitForTunnelOpen(frames: readonly PeerTcpTunnelRelayEnvelope[], tunnelId: string): Promise<void> {
  await waitFor(() => framesForTunnel(frames, tunnelId).some((envelope) =>
    envelope.v === 1 && envelope.frame.kind === 'open',
  ), {
    timeoutMs: socketTimeoutMs,
    context: `relay OPEN ${tunnelId}`,
  });
}

async function executeRelayClusterComposeScenario(params: Readonly<{
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  auth: TestAuth;
}>): Promise<void> {
  void params.run;
  assertRelayClusterComposeConfig(params.config);
  const admin = requireFullComposeAdmin(params.target);
  if (!admin || params.target.topology.resolvedApiReplicas !== 2) {
    throw new Error('Relay cluster compose scenario requires exactly two full-compose API replicas');
  }
  const startContainer = admin.startContainer;
  if (!startContainer) {
    throw new Error('Relay cluster compose scenario requires exact-container restart support');
  }
  const peerMediation = params.target.testRuntime?.peerMediation;
  if (!peerMediation || !peerMediation.allowedPorts.includes(relayPort)) {
    throw new Error(`Relay cluster compose topology must expose test-only signing metadata and port ${relayPort}`);
  }

  const upstreamTargets = await resolveServiceUpstreamTargets(params.target, 'api', 53288);
  const gatewayConfig = await writeScenarioGatewayConfig({
    target: params.target,
    fileName: 'nginx.relay-cluster.conf',
    contents: renderStressGatewayNginxConf({
      upstreamApiTargets: upstreamTargets,
      affinity: 'header-hash',
      stickyHeaderName,
      workerConnections: params.config.compose.gatewayWorkerConnections,
      workerRlimitNoFile: params.config.compose.gatewayWorkerRlimitNoFile,
    }),
  });
  await activateGatewayConfig(params.target, gatewayConfig);

  const accountId = await fetchAccountId(params.target.baseUrl, params.auth.token);
  const machineId = `relay-cluster-machine-${randomUUID()}`;
  await provisionMachine(params.target.baseUrl, params.auth.token, machineId);
  const placement = await discoverDistinctStickyKeys({
    target: params.target,
    token: params.auth.token,
  });
  const envelopeFactory = createRelayClusterEnvelopeFactory({
    accountId,
    machineId,
    signingKeyId: peerMediation.routeGrantSigning.keyId,
    signingPrivateKeySeedBase64Url: peerMediation.routeGrantSigning.privateKeySeedBase64Url,
  });

  await withRelayClientCleanup(async (retainClient) => {
    const connect = async (
      clientType: 'user-scoped' | 'machine-scoped',
      stickyKey: string,
    ): Promise<RawRelayClient> => {
      return retainClient(await connectRawRelayClient({
        baseUrl: params.target.baseUrl,
        token: params.auth.token,
        stickyKey,
        clientType,
        machineId,
      }));
    };
    const reconnectMachineAfterCrash = async (stickyKey: string): Promise<RawRelayClient> => {
      const deadline = Date.now() + socketTimeoutMs;
      let lastConflict: unknown;
      while (Date.now() < deadline) {
        try {
          return await connect('machine-scoped', stickyKey);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'machine-owner-conflict') {
            throw error;
          }
          lastConflict = error;
          await sleep(500);
        }
      }
      throw lastConflict ?? new Error('Timed out waiting for crashed machine ownership lease recovery');
    };

    const initialUserCounts = await readReplicaConnectionCounts(params.target, 'user-scoped');
    const initialMachineCounts = await readReplicaConnectionCounts(params.target, 'machine-scoped');
    let userA = await connect('user-scoped', placement.first.stickyKey);
    let userB = await connect('user-scoped', placement.second.stickyKey);
    let machineB = await connect('machine-scoped', placement.second.stickyKey);

    const userBaseline = new Map(initialUserCounts);
    userBaseline.set(
      placement.second.containerId,
      (userBaseline.get(placement.second.containerId) ?? 0) + 1,
    );
    await assertClientPlacement({
      target: params.target,
      clientType: 'user-scoped',
      expectedContainerId: placement.first.containerId,
      baseline: userBaseline,
    });
    await assertClientPlacement({
      target: params.target,
      clientType: 'machine-scoped',
      expectedContainerId: placement.second.containerId,
      baseline: initialMachineCounts,
    });
    assert.ok(userA.socket.id);
    assert.ok(userB.socket.id);
    assert.ok(machineB.socket.id);

    const duplicateGrantId = `duplicate-${randomUUID()}`;
    const duplicateA = `duplicate-a-${randomUUID()}`;
    const duplicateB = `duplicate-b-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: duplicateA,
      grantId: duplicateGrantId,
      relaySocketId: userA.socket.id,
    }));
    emit(userB.socket, envelopeFactory.open({
      tunnelId: duplicateB,
      grantId: duplicateGrantId,
      relaySocketId: userB.socket.id,
    }));
    await waitFor(() => {
      const opens = [duplicateA, duplicateB].filter((id) =>
        framesForTunnel(machineB.frames, id).some((frame) => frame.v === 1 && frame.frame.kind === 'open'),
      ).length;
      const rejected = [duplicateA, duplicateB].filter((id) =>
        terminalCount([...userA.frames, ...userB.frames], id, 'relay_authorization_invalid') === 1,
      ).length;
      return opens === 1 && rejected === 1;
    }, {
      timeoutMs: socketTimeoutMs,
      context: 'one global relay grant winner',
    });

    const orderedTunnelId = `ordered-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: orderedTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: orderedTunnelId,
      sequence: 0,
      payload: 'forward-0',
    }));
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: orderedTunnelId,
      sequence: 1,
      payload: 'forward-1',
    }));
    await waitFor(() => dataPayloads(machineB.frames, orderedTunnelId).length === 2, {
      timeoutMs: socketTimeoutMs,
      context: 'ordered forward relay DATA',
    });
    assert.deepEqual(dataPayloads(machineB.frames, orderedTunnelId), ['forward-0', 'forward-1']);
    const orderedKinds = framesForTunnel(machineB.frames, orderedTunnelId).flatMap((envelope) =>
      envelope.v === 1 ? [envelope.frame.kind] : [],
    );
    assert.deepEqual(orderedKinds.slice(0, 3), ['open', 'data', 'data']);

    emit(machineB.socket, envelopeFactory.machineData({
      tunnelId: orderedTunnelId,
      userSocketId: userA.socket.id,
      sequence: 0,
      payload: 'reverse-0',
    }));
    emit(machineB.socket, envelopeFactory.machineData({
      tunnelId: orderedTunnelId,
      userSocketId: userA.socket.id,
      sequence: 1,
      payload: 'reverse-1',
    }));
    await waitFor(() => dataPayloads(userA.frames, orderedTunnelId).length === 2, {
      timeoutMs: socketTimeoutMs,
      context: 'ordered reverse relay DATA',
    });
    assert.deepEqual(dataPayloads(userA.frames, orderedTunnelId), ['reverse-0', 'reverse-1']);

    const preFrameDisconnectTunnelId = `pre-frame-disconnect-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: preFrameDisconnectTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    await waitForTunnelOpen(machineB.frames, preFrameDisconnectTunnelId);
    machineB.close();
    await waitFor(() =>
      terminalCount(userA.frames, preFrameDisconnectTunnelId, 'relay_socket_disconnected') === 1,
    {
      timeoutMs: socketTimeoutMs,
      context: 'recipient disconnect terminal',
    });
    await sleep(250);
    assert.equal(
      terminalCount(userA.frames, preFrameDisconnectTunnelId, 'relay_socket_disconnected'),
      1,
    );
    machineB = await connect('machine-scoped', placement.second.stickyKey);

    const expiredTunnelId = `expired-after-redis-${randomUUID()}`;
    const expiresAt = Date.now() + 500;
    const expiredEnvelope = envelopeFactory.open({
      tunnelId: expiredTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
      expiresAt,
    });
    await admin.stopService('redis');
    await sleep(1_000);
    await admin.startService('redis');
    await waitForRedisServiceHealthy(params.target, 45_000);
    await waitFor(() => userA.socket.connected && machineB.socket.connected, {
      timeoutMs: 45_000,
      intervalMs: 500,
      context: 'relay sockets after Redis recovery',
    });
    emit(userA.socket, expiredEnvelope);
    await waitFor(() => terminalCount(userA.frames, expiredTunnelId, 'relay_authorization_invalid') === 1, {
      timeoutMs: socketTimeoutMs,
      context: 'expired grant rejected after Redis recovery',
    });
    const postRedisTunnelId = `post-redis-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: postRedisTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    await waitForTunnelOpen(machineB.frames, postRedisTunnelId);

    const beforeBKillTunnelId = `before-b-kill-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: beforeBKillTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    await waitForTunnelOpen(machineB.frames, beforeBKillTunnelId);
    await admin.killContainer(placement.second.containerId);
    await waitFor(() => !machineB.socket.connected, {
      timeoutMs: socketTimeoutMs,
      context: 'replica B crash disconnect',
    });
    await startContainer(placement.second.containerId);
    await waitForExactContainerHealthy(params.target, placement.second.containerId);
    userB = await connect('user-scoped', placement.second.stickyKey);
    machineB = await reconnectMachineAfterCrash(placement.second.stickyKey);
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: beforeBKillTunnelId,
      sequence: 0,
      payload: 'must-not-fail-over-after-b-kill',
    }));
    await sleep(500);
    assert.deepEqual(dataPayloads(machineB.frames, beforeBKillTunnelId), []);

    const afterBRestartTunnelId = `after-b-restart-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: afterBRestartTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: afterBRestartTunnelId,
      sequence: 0,
      payload: 'fresh-after-b-restart',
    }));
    await waitFor(() =>
      dataPayloads(machineB.frames, afterBRestartTunnelId).includes('fresh-after-b-restart'),
    {
      timeoutMs: socketTimeoutMs,
      context: 'fresh tunnel after B restart',
    });

    const beforeAKillTunnelId = `before-a-kill-${randomUUID()}`;
    const oldUserASocketId = userA.socket.id;
    assert.ok(oldUserASocketId);
    emit(userA.socket, envelopeFactory.open({
      tunnelId: beforeAKillTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: oldUserASocketId,
    }));
    await waitForTunnelOpen(machineB.frames, beforeAKillTunnelId);
    await admin.killContainer(placement.first.containerId);
    await waitFor(() => !userA.socket.connected, {
      timeoutMs: socketTimeoutMs,
      context: 'replica A crash disconnect',
    });

    const survivingReplicaTunnelId = `surviving-b-${randomUUID()}`;
    emit(userB.socket, envelopeFactory.open({
      tunnelId: survivingReplicaTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userB.socket.id!,
    }));
    emit(userB.socket, envelopeFactory.userData({
      tunnelId: survivingReplicaTunnelId,
      sequence: 0,
      payload: 'fresh-while-a-down',
    }));
    try {
      await waitFor(() =>
        dataPayloads(machineB.frames, survivingReplicaTunnelId).includes('fresh-while-a-down'),
      {
        timeoutMs: socketTimeoutMs,
        context: 'fresh tunnel while replica A is down',
      });
    } catch (error) {
      const diagnostics = {
        userConnected: userB.socket.connected,
        machineConnected: machineB.socket.connected,
        userFrames: framesForTunnel(userB.frames, survivingReplicaTunnelId),
        machineFrames: framesForTunnel(machineB.frames, survivingReplicaTunnelId),
        userErrors: userB.errors,
        machineErrors: machineB.errors,
      };
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }

    await startContainer(placement.first.containerId);
    await waitForExactContainerHealthy(params.target, placement.first.containerId);
    userA = await connect('user-scoped', placement.first.stickyKey);
    assert.ok(userA.socket.id);
    emit(machineB.socket, envelopeFactory.machineData({
      tunnelId: beforeAKillTunnelId,
      userSocketId: oldUserASocketId,
      sequence: 0,
      payload: 'must-not-fail-over-after-a-kill',
    }));
    await sleep(500);
    assert.deepEqual(dataPayloads(userA.frames, beforeAKillTunnelId), []);

    const afterARestartTunnelId = `after-a-restart-${randomUUID()}`;
    emit(userA.socket, envelopeFactory.open({
      tunnelId: afterARestartTunnelId,
      grantId: `grant-${randomUUID()}`,
      relaySocketId: userA.socket.id,
    }));
    emit(userA.socket, envelopeFactory.userData({
      tunnelId: afterARestartTunnelId,
      sequence: 0,
      payload: 'fresh-after-a-restart',
    }));
    await waitFor(() =>
      dataPayloads(machineB.frames, afterARestartTunnelId).includes('fresh-after-a-restart'),
    {
      timeoutMs: socketTimeoutMs,
      context: 'fresh cross-replica tunnel after rolling restart',
    });
  });
}

export async function runRelayClusterComposeScenario(params: Readonly<{
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  auth: TestAuth;
}>): Promise<void> {
  const testDir = params.run.testDir('relay-cluster-compose');
  const startedAt = new Date().toISOString();
  let failure: unknown;

  try {
    await executeRelayClusterComposeScenario(params);
  } catch (error) {
    failure = error;
  } finally {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'relay.clusterCompose',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        apiReplicas: params.target.topology.resolvedApiReplicas,
        scenarioRuns: 1,
      },
    });
  }

  if (failure) {
    throw failure;
  }
}
