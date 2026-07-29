import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';

const socketIoMocks = vi.hoisted(() => ({
  io: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: socketIoMocks.io,
}));

import {
  PeerTcpTunnelRelayEnvelopeSchema,
  verifyPeerTcpTunnelRelayAuthorizationV2,
} from '@happier-dev/protocol';

import {
  assertRelayClusterComposeConfig,
  connectRawRelayClient,
  createRelayClusterEnvelopeFactory,
  withRelayClientCleanup,
} from './runRelayClusterComposeScenario';
import type { StressConfig } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { runRelayClusterComposeScenario } from './runRelayClusterComposeScenario';

function createScenarioConfig(keepTopologyOnFailure: boolean): StressConfig {
  return {
    targetMode: 'full-compose',
    baseUrl: undefined,
    repeat: 1,
    seed: 42,
    flakeRetry: false,
    socketTransport: 'websocket',
    duration: {
      warmupMs: 1_000,
      durationMs: 10_000,
      cooldownMs: 1_000,
      soakMs: 0,
    },
    load: {
      users: 2,
      machinesPerUser: 1,
      sessionsPerUser: 1,
      rpcListenersPerUser: 1,
      rpcCallsPerSecond: 1,
      messagesPerSecond: 1,
      reconnectRate: 0,
      mixedSessionMode: 'representative',
    },
    orchestration: {
      rollingRestartEnabled: true,
      killTarget: 'api',
      expectedApiReplicas: 2,
      expectedWorkerReplicas: 1,
    },
    compose: {
      apiReplicas: 2,
      workerReplicas: 1,
      imageBuildStrategy: 'never',
      reuseRunningTopology: false,
      frontDoorMode: 'gateway',
      metricsEnabled: true,
      filesBackend: 's3',
    },
    artifacts: {
      saveArtifactsOnSuccess: false,
      metricsScrapeEnabled: true,
      keepTopologyOnFailure,
      summaryOutputPath: undefined,
    },
  };
}

function createScenarioTarget(input: Readonly<{
  resolvedApiReplicas: number;
  collectDiagnostics?: () => Promise<void>;
  preserveForInspection?: () => void;
}>): StartedStressTarget {
  return {
    mode: 'full-compose',
    baseUrl: 'http://127.0.0.1:43080',
    topology: {
      kind: 'full-compose',
      composeProjectName: 'relay-cluster-test',
      services: ['api', 'redis', 'gateway'],
      expectedApiReplicas: input.resolvedApiReplicas,
      expectedWorkerReplicas: 1,
      resolvedApiReplicas: input.resolvedApiReplicas,
      resolvedWorkerReplicas: 1,
      baseUrl: 'http://127.0.0.1:43080',
      ports: {},
    },
    admin: {
      listServiceContainers: vi.fn(async () => []),
      writeGatewayConfig: vi.fn(async () => ''),
      activateGatewayConfig: vi.fn(async () => {}),
      startService: vi.fn(async () => {}),
      stopService: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      startContainer: vi.fn(async () => {}),
      execInService: vi.fn(async () => ''),
    },
    preserveForInspection: input.preserveForInspection ?? vi.fn(),
    stop: vi.fn(async () => {}),
    collectDiagnostics: input.collectDiagnostics ?? vi.fn(async () => {}),
  };
}

function createTestRun() {
  const runDir = mkdtempSync(join(tmpdir(), 'happier-relay-cluster-scenario-'));
  return {
    runId: 'relay-cluster-unit',
    runDir,
    testDir: (testName: string) => {
      const testDir = join(runDir, testName);
      mkdirSync(testDir, { recursive: true });
      return testDir;
    },
  };
}

describe('runRelayClusterComposeScenario', () => {
  beforeEach(() => {
    socketIoMocks.io.mockReset();
  });

  it('rejects any configuration that cannot attest the exact full-compose topology', () => {
    expect(() => assertRelayClusterComposeConfig({
      ...createScenarioConfig(false),
      targetMode: 'external',
    })).toThrow('requires full-compose target mode');
    expect(() => assertRelayClusterComposeConfig({
      ...createScenarioConfig(false),
      compose: {
        ...createScenarioConfig(false).compose,
        apiReplicas: 3,
      },
    })).toThrow('requires exactly two configured API replicas');
    expect(() => assertRelayClusterComposeConfig({
      ...createScenarioConfig(false),
      compose: {
        ...createScenarioConfig(false).compose,
        metricsEnabled: false,
      },
    })).toThrow('requires per-replica metrics');
    expect(() => assertRelayClusterComposeConfig(createScenarioConfig(false))).not.toThrow();
  });

  it('builds a strict relay OPEN signed by the private key held only by test runtime authority', () => {
    const seed = new Uint8Array(nacl.sign.seedLength).fill(7);
    const keyPair = nacl.sign.keyPair.fromSeed(seed);
    const factory = createRelayClusterEnvelopeFactory({
      accountId: 'account-1',
      machineId: 'machine-1',
      signingKeyId: 'stress-route-grant',
      signingPrivateKeySeedBase64Url: Buffer.from(seed).toString('base64url'),
      now: () => 1_800_000_000_000,
    });

    const envelope = PeerTcpTunnelRelayEnvelopeSchema.parse(factory.open({
      tunnelId: 'tunnel-1',
      grantId: 'grant-1',
      relaySocketId: 'socket-1',
    }));
    expect(envelope.v).toBe(1);
    if (envelope.v !== 1 || envelope.frame.kind !== 'open') {
      throw new Error('Expected a JSON relay OPEN envelope');
    }
    const authorization = envelope.frame.open.relayAuthorization;
    if (!authorization || authorization.payload.v !== 2) {
      throw new Error('Expected a V2 relay authorization');
    }
    expect(verifyPeerTcpTunnelRelayAuthorizationV2({
      authorization,
      trustRoots: [{
        keyId: 'stress-route-grant',
        publicKeyBase64Url: Buffer.from(keyPair.publicKey).toString('base64url'),
      }],
      nowMs: 1_800_000_000_001,
    })).toMatchObject({ valid: true });
  });

  it('fails before placement unless the topology has exactly two API replicas', async () => {
    await expect(runRelayClusterComposeScenario({
      run: createTestRun(),
      target: createScenarioTarget({ resolvedApiReplicas: 3 }),
      config: createScenarioConfig(false),
      auth: {
        token: 'token',
        publicKeyBase64: 'public-key',
        accountSigningSeed: new Uint8Array(32),
      },
    })).rejects.toThrow('exactly two full-compose API replicas');
  });

  it('collects diagnostics and preserves a failed topology through the canonical finalizer', async () => {
    const collectDiagnostics = vi.fn(async () => {});
    const preserveForInspection = vi.fn();

    await expect(runRelayClusterComposeScenario({
      run: createTestRun(),
      target: createScenarioTarget({
        resolvedApiReplicas: 2,
        collectDiagnostics,
        preserveForInspection,
      }),
      config: createScenarioConfig(true),
      auth: {
        token: 'token',
        publicKeyBase64: 'public-key',
        accountSigningSeed: new Uint8Array(32),
      },
    })).rejects.toThrow('test-only signing metadata');

    expect(collectDiagnostics).toHaveBeenCalledTimes(1);
    expect(preserveForInspection).toHaveBeenCalledTimes(1);
  });

  it('disconnects a failed raw socket and closes earlier clients when later setup fails', async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const failedDisconnect = vi.fn();
    const failedSocket = {
      on: vi.fn(),
      once: vi.fn((event: string, listener: (value?: unknown) => void) => {
        listeners.set(event, listener);
      }),
      connect: vi.fn(() => {
        queueMicrotask(() => listeners.get('connect_error')?.(new Error('connect failed')));
      }),
      disconnect: failedDisconnect,
    };
    socketIoMocks.io.mockReturnValue(failedSocket);
    const earlierDisconnect = vi.fn();

    await expect(withRelayClientCleanup(async (retainClient) => {
      retainClient({
        socket: failedSocket,
        frames: [],
        close: earlierDisconnect,
      });
      await connectRawRelayClient({
        baseUrl: 'http://127.0.0.1:43080',
        token: 'token',
        stickyKey: 'sticky-b',
        clientType: 'user-scoped',
      });
    })).rejects.toThrow('connect failed');

    expect(failedDisconnect).toHaveBeenCalledTimes(1);
    expect(earlierDisconnect).toHaveBeenCalledTimes(1);
  });
});
