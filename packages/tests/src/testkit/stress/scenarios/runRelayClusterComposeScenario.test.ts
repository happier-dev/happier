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
  deriveAccountMachineKeyFromRecoverySecret,
  PeerTcpTunnelRelayEnvelopeSchema,
  type PeerTcpTunnelRelayEnvelope,
  verifyPeerTcpTunnelRelayAuthorizationV2,
} from '@happier-dev/protocol';

import {
  assertExternalPartitionPayloadsRemainAbsent,
  assertExternalPartitionTerminalWindow,
  assertRelayClusterComposeConfig,
  buildFreshTunnelRelayDiagnostics,
  buildOrderedForwardRelayDiagnostics,
  connectRawRelayClient,
  createRelayClusterEnvelopeFactory,
  waitForFreshTunnelRelayData,
  waitForOrderedForwardRelayData,
  waitForRelayAdapterReadiness,
  withRelayClientCleanup,
} from './runRelayClusterComposeScenario';
import type { StressConfig } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { runRelayClusterComposeScenario } from './runRelayClusterComposeScenario';

function createTestAuthFixture() {
  const accountSigningSeed = new Uint8Array(32);
  return {
    token: 'token',
    publicKeyBase64: 'public-key',
    accountSigningSeed,
    accountMachineKey: deriveAccountMachineKeyFromRecoverySecret(accountSigningSeed),
  };
}

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
      auth: createTestAuthFixture(),
    })).rejects.toThrow('exactly two full-compose API replicas');
  });

  it('requires canonical owned-network controls for the external Redis partition mode', async () => {
    await expect(runRelayClusterComposeScenario({
      run: createTestRun(),
      target: createScenarioTarget({ resolvedApiReplicas: 2 }),
      config: createScenarioConfig(false),
      auth: createTestAuthFixture(),
      disruption: 'external-redis-partition',
    })).rejects.toThrow('external Redis network partition support');
  });

  it.each(['forward', 'reverse'] as const)(
    'rejects a %s partition-time payload that arrives only after adapter readiness',
    (direction) => {
      const tunnelId = 'partition-payload-late-arrival';
      const factory = createRelayClusterEnvelopeFactory({
        accountId: 'account-1',
        machineId: 'machine-1',
        signingKeyId: 'stress-route-grant',
        signingPrivateKeySeedBase64Url: Buffer.from(new Uint8Array(nacl.sign.seedLength).fill(6)).toString('base64url'),
        now: () => 1_800_000_000_000,
      });
      const userFrames: PeerTcpTunnelRelayEnvelope[] = [];
      const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];

      expect(() => assertExternalPartitionPayloadsRemainAbsent({
        milestone: 'during partition',
        tunnelId,
        userFrames,
        machineFrames,
      })).not.toThrow();

      if (direction === 'forward') {
        machineFrames.push(factory.userData({
          tunnelId,
          sequence: 1,
          payload: 'must-not-cross-external-partition',
        }));
      } else {
        userFrames.push(factory.machineData({
          tunnelId,
          userSocketId: 'user-a-socket',
          sequence: 1,
          payload: 'must-not-reverse-cross-external-partition',
        }));
      }

      expect(() => assertExternalPartitionPayloadsRemainAbsent({
        milestone: 'after adapter readiness',
        tunnelId,
        userFrames,
        machineFrames,
      })).toThrow('after adapter readiness');
    },
  );

  it('counts every public terminal envelope in the bounded partition terminal window', () => {
    const tunnelId = 'partition-terminal-window';
    const terminal = {
      v: 1 as const,
      scopeUserId: 'account-1',
      sender: { kind: 'machine' as const, machineId: 'machine-1' },
      recipient: { kind: 'user' as const, socketId: 'user-a-socket' },
      frame: {
        v: 1 as const,
        kind: 'abort' as const,
        tunnelId,
        reasonCode: 'relay_cap_exceeded' as const,
      },
    };

    expect(assertExternalPartitionTerminalWindow({
      tunnelId,
      userFrames: [terminal],
      machineFrames: [],
    })).toEqual({ terminalEnvelopeCount: 1, reasonCodes: ['relay_cap_exceeded'] });

    expect(() => assertExternalPartitionTerminalWindow({
      tunnelId,
      userFrames: [terminal],
      machineFrames: [terminal],
    })).toThrow('exactly one public terminal envelope');
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
      auth: createTestAuthFixture(),
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

  it.each([
    {
      expected: 'open_absent',
      machineFrames: [],
      userFrames: [],
      errors: [],
    },
    {
      expected: 'open_only',
      machineFrames: ['open'],
      userFrames: [],
      errors: [],
    },
    {
      expected: 'one_data',
      machineFrames: ['open', 'data-0'],
      userFrames: [],
      errors: [],
    },
    {
      expected: 'two_plus_or_duplicate_data',
      machineFrames: ['open', 'data-0', 'data-0', 'data-1'],
      userFrames: [],
      errors: [],
    },
    {
      expected: 'terminal',
      machineFrames: ['open'],
      userFrames: ['terminal'],
      errors: [],
    },
    {
      expected: 'socket_error',
      machineFrames: [],
      userFrames: [],
      errors: [{ type: 'peer-tunnel', error: 'bounded failure' }],
    },
  ])('adds classifiable bounded diagnostics when ordered forwarding times out: $expected', async ({
    expected,
    machineFrames,
    userFrames,
    errors,
  }) => {
    const tunnelId = 'ordered-timeout';
    const factory = createRelayClusterEnvelopeFactory({
      accountId: 'account-1',
      machineId: 'machine-1',
      signingKeyId: 'stress-route-grant',
      signingPrivateKeySeedBase64Url: Buffer.from(new Uint8Array(nacl.sign.seedLength).fill(3)).toString('base64url'),
      now: () => 1_800_000_000_000,
    });
    const frames = machineFrames.map((kind) => {
      if (kind === 'open') {
        return factory.open({
          tunnelId,
          grantId: 'grant-ordered',
          relaySocketId: 'user-a-socket',
        });
      }
      const sequence = kind === 'data-1' ? 1 : 0;
      return factory.userData({
        tunnelId,
        sequence,
        payload: `payload-${sequence}`,
      });
    });
    const terminals = userFrames.map(() => ({
      v: 1 as const,
      scopeUserId: 'account-1',
      sender: { kind: 'machine' as const, machineId: 'machine-1' },
      recipient: { kind: 'user' as const, socketId: 'user-a-socket' },
      frame: {
        v: 1 as const,
        kind: 'abort' as const,
        tunnelId,
        reasonCode: 'route_unavailable',
      },
    }));
    const input = {
      orderedTunnelId: tunnelId,
      duplicateTunnelIds: {
        a: 'duplicate-a',
        b: 'duplicate-b',
      },
      clients: {
        userA: {
          socket: { id: 'user-a-socket', connected: true },
          frames: terminals,
          errors,
        },
        userB: {
          socket: { id: 'user-b-socket', connected: true },
          frames: [],
          errors: [],
        },
        machineB: {
          socket: { id: 'machine-b-socket', connected: true },
          frames,
          errors: [],
        },
      },
      placement: {
        userAContainerId: 'api-a',
        userBContainerId: 'api-b',
        machineBContainerId: 'api-b',
      },
    } as const;

    await expect(waitForOrderedForwardRelayData({
      ...input,
      timeoutMs: 5,
      intervalMs: 1,
    })).rejects.toThrow(`"classification":"${expected}"`);

    const diagnostics = buildOrderedForwardRelayDiagnostics(input);
    expect(diagnostics.ordered.classification).toBe(expected);
    expect(JSON.stringify(diagnostics).length).toBeLessThan(8_192);
  });

  it('records the ordered-forward diagnostic contract without exposing socket credentials', () => {
    const tunnelId = 'ordered-contract';
    const factory = createRelayClusterEnvelopeFactory({
      accountId: 'account-1',
      machineId: 'machine-1',
      signingKeyId: 'stress-route-grant',
      signingPrivateKeySeedBase64Url: Buffer.from(new Uint8Array(nacl.sign.seedLength).fill(7)).toString('base64url'),
      now: () => 1_800_000_000_000,
    });
    const rejectedDuplicate = {
      v: 1 as const,
      scopeUserId: 'account-1',
      sender: { kind: 'machine' as const, machineId: 'machine-1' },
      recipient: { kind: 'user' as const, socketId: 'user-a-socket' },
      frame: {
        v: 1 as const,
        kind: 'abort' as const,
        tunnelId: 'duplicate-b',
        reasonCode: 'relay_authorization_invalid',
      },
    };
    const terminal = {
      ...rejectedDuplicate,
      frame: {
        ...rejectedDuplicate.frame,
        tunnelId,
        reasonCode: 'route_unavailable',
      },
    };
    const secret = 'socket-secret-token-value';
    const diagnostics = buildOrderedForwardRelayDiagnostics({
      orderedTunnelId: tunnelId,
      duplicateTunnelIds: {
        a: 'duplicate-a',
        b: 'duplicate-b',
      },
      clients: {
        userA: {
          socket: { id: 'user-a-socket', connected: false },
          frames: [terminal, rejectedDuplicate],
          errors: [new Error(`Bearer ${secret}`)],
        },
        userB: {
          socket: { id: 'user-b-socket', connected: true },
          frames: [],
          errors: [],
        },
        machineB: {
          socket: { id: 'machine-b-socket', connected: true },
          frames: [
            factory.open({
              tunnelId,
              grantId: 'grant-ordered',
              relaySocketId: 'user-a-socket',
            }),
            factory.userData({ tunnelId, sequence: 0, payload: 'payload-0' }),
            factory.open({
              tunnelId: 'duplicate-a',
              grantId: 'grant-duplicate',
              relaySocketId: 'user-a-socket',
            }),
          ],
          errors: [],
        },
      },
      placement: {
        userAContainerId: 'api-a',
        userBContainerId: 'api-b',
        machineBContainerId: 'api-b',
      },
    });

    expect(diagnostics).toMatchObject({
      milestone: 'ordered_forward_relay_data',
      orderedTunnelId: tunnelId,
      ordered: {
        classification: 'terminal',
        openCount: 1,
        dataCount: 1,
        dataSequences: [0],
        omittedDataSequenceCount: 0,
        duplicateSequences: [],
        omittedDuplicateSequenceCount: 0,
        terminalReasons: ['route_unavailable'],
        omittedTerminalReasonCount: 0,
        socketErrorCount: 1,
      },
      duplicateGrant: {
        tunnelIds: { a: 'duplicate-a', b: 'duplicate-b' },
        winnerTunnelIds: ['duplicate-a'],
        rejectedTunnelIds: ['duplicate-b'],
      },
      placement: {
        userAContainerId: 'api-a',
        userBContainerId: 'api-b',
        machineBContainerId: 'api-b',
      },
      clients: {
        userA: {
          socketId: 'user-a-socket',
          connected: false,
          errors: [{ name: 'Error', message: 'Bearer [REDACTED]', truncated: false }],
        },
        machineB: {
          socketId: 'machine-b-socket',
          connected: true,
          frames: [
            { v: 1, tunnelId, kind: 'open' },
            {
              v: 1,
              tunnelId,
              kind: 'data',
              sequence: 0,
              payloadIdentity: {
                decodedBytes: 9,
                sha256: 'd449acb92215ed502901c9e6f6a4dc6d28e6856fb6754892becd148dee1b3e85',
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it('bounds fresh-tunnel timeout diagnostics without exposing socket credentials', async () => {
    const tunnelId = 'fresh-after-restart';
    const factory = createRelayClusterEnvelopeFactory({
      accountId: 'account-1',
      machineId: 'machine-1',
      signingKeyId: 'stress-route-grant',
      signingPrivateKeySeedBase64Url: Buffer.from(new Uint8Array(nacl.sign.seedLength).fill(5)).toString('base64url'),
      now: () => 1_800_000_000_000,
    });
    const secret = 'fresh-tunnel-secret';
    const diagnostics = buildFreshTunnelRelayDiagnostics({
      milestone: 'fresh_after_api_restart',
      tunnelId,
      user: {
        socket: { id: 'user-a-socket', connected: true },
        frames: [],
        errors: [new Error(`Bearer ${secret}`)],
      },
      machine: {
        socket: { id: 'machine-b-socket', connected: true },
        frames: [factory.open({
          tunnelId,
          grantId: 'grant-fresh',
          relaySocketId: 'user-a-socket',
        })],
        errors: [],
      },
    });

    expect(diagnostics).toMatchObject({
      milestone: 'fresh_after_api_restart',
      tunnelId,
      user: {
        socketId: 'user-a-socket',
        connected: true,
        errors: [{ name: 'Error', message: 'Bearer [REDACTED]' }],
      },
      machine: {
        socketId: 'machine-b-socket',
        connected: true,
        frames: [{ v: 1, tunnelId, kind: 'open' }],
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics).length).toBeLessThan(8_192);

    let waitError: unknown;
    try {
      await waitForFreshTunnelRelayData({
        milestone: 'fresh_after_api_restart',
        tunnelId,
        payload: 'fresh-after-restart',
        user: {
          socket: { id: 'user-a-socket', connected: true },
          frames: [],
          errors: [new Error(`Bearer ${secret}`)],
        },
        machine: {
          socket: { id: 'machine-b-socket', connected: true },
          frames: [],
          errors: [],
        },
        timeoutMs: 5,
        intervalMs: 1,
      });
    } catch (error) {
      waitError = error;
    }
    const waitMessage = waitError instanceof Error ? waitError.message : String(waitError);
    expect(waitMessage).toContain('"milestone":"fresh_after_api_restart"');
    expect(waitMessage).toContain('Bearer [REDACTED]');
    expect(waitMessage).not.toContain(secret);
  });

  it('uses unique probe grants until cross-replica relay membership becomes ready', async () => {
    const factory = createRelayClusterEnvelopeFactory({
      accountId: 'account-1',
      machineId: 'machine-1',
      signingKeyId: 'stress-route-grant',
      signingPrivateKeySeedBase64Url: Buffer.from(new Uint8Array(nacl.sign.seedLength).fill(5)).toString('base64url'),
      now: () => 1_800_000_000_000,
    });
    const user = {
      socket: { id: 'user-a-socket', connected: true },
      frames: [] as Array<ReturnType<typeof factory.open>>,
      errors: [] as unknown[],
    };
    const machine = {
      socket: { id: 'machine-b-socket', connected: true },
      frames: [] as Array<ReturnType<typeof factory.open>>,
      errors: [] as unknown[],
    };
    const probes: Array<Readonly<{ tunnelId: string; grantId: string; payload: string }>> = [];

    await expect(waitForRelayAdapterReadiness({
      milestone: 'api_a_adapter_readiness',
      user,
      machine,
      maxAttempts: 3,
      probeTimeoutMs: 5,
      intervalMs: 1,
      retryIntervalMs: 0,
      sendProbe: (probe) => {
        probes.push(probe);
        if (probes.length < 3) {
          user.errors.push(new Error('Server-routed peer tunnel cluster admission failed'));
          user.frames.push({
            v: 1,
            scopeUserId: 'account-1',
            sender: { kind: 'machine', machineId: 'machine-1' },
            recipient: { kind: 'user', socketId: 'user-a-socket' },
            frame: {
              v: 1,
              kind: 'abort',
              tunnelId: probe.tunnelId,
              reasonCode: 'route_unavailable',
            },
          });
          user.frames.push({
            v: 1,
            scopeUserId: 'account-1',
            sender: { kind: 'machine', machineId: 'machine-1' },
            recipient: { kind: 'user', socketId: 'user-a-socket' },
            frame: {
              v: 1,
              kind: 'abort',
              tunnelId: probe.tunnelId,
              reasonCode: 'tunnel_not_open',
            },
          });
          return;
        }
        machine.frames.push(factory.userData({
          tunnelId: probe.tunnelId,
          sequence: 0,
          payload: probe.payload,
        }));
      },
    })).resolves.toMatchObject({ attempts: 3 });

    expect(new Set(probes.map((probe) => probe.tunnelId)).size).toBe(3);
    expect(new Set(probes.map((probe) => probe.grantId)).size).toBe(3);
  });

  it('fails after bounded persistent route unavailability without reusing a grant', async () => {
    const user = {
      socket: { id: 'user-a-socket', connected: true },
      frames: [] as PeerTcpTunnelRelayEnvelope[],
      errors: [] as unknown[],
    };
    const machine = {
      socket: { id: 'machine-b-socket', connected: true },
      frames: [] as PeerTcpTunnelRelayEnvelope[],
      errors: [] as unknown[],
    };
    const probes: Array<Readonly<{ tunnelId: string; grantId: string; payload: string }>> = [];

    await expect(waitForRelayAdapterReadiness({
      milestone: 'api_a_adapter_readiness',
      user,
      machine,
      maxAttempts: 2,
      probeTimeoutMs: 5,
      intervalMs: 1,
      retryIntervalMs: 0,
      sendProbe: (probe) => {
        probes.push(probe);
        user.errors.push(new Error('Server-routed peer tunnel cluster admission failed'));
        user.frames.push({
          v: 1,
          scopeUserId: 'account-1',
          sender: { kind: 'machine', machineId: 'machine-1' },
          recipient: { kind: 'user', socketId: 'user-a-socket' },
          frame: {
            v: 1,
            kind: 'abort',
            tunnelId: probe.tunnelId,
            reasonCode: 'route_unavailable',
          },
        });
      },
    })).rejects.toThrow('after 2 unique probes');

    expect(new Set(probes.map((probe) => probe.tunnelId)).size).toBe(2);
    expect(new Set(probes.map((probe) => probe.grantId)).size).toBe(2);
  });

  it('does not retry a terminal relay readiness rejection', async () => {
    const user = {
      socket: { id: 'user-a-socket', connected: true },
      frames: [] as PeerTcpTunnelRelayEnvelope[],
      errors: [] as unknown[],
    };
    const machine = {
      socket: { id: 'machine-b-socket', connected: true },
      frames: [] as PeerTcpTunnelRelayEnvelope[],
      errors: [] as unknown[],
    };
    const probes: Array<Readonly<{ tunnelId: string; grantId: string; payload: string }>> = [];

    const readiness = waitForRelayAdapterReadiness({
      milestone: 'api_a_adapter_readiness',
      user,
      machine,
      maxAttempts: 4,
      probeTimeoutMs: 5,
      intervalMs: 1,
      retryIntervalMs: 0,
      sendProbe: (probe) => {
        probes.push(probe);
        user.frames.push({
          v: 1,
          scopeUserId: 'account-1',
          sender: { kind: 'machine', machineId: 'machine-1' },
          recipient: { kind: 'user', socketId: 'user-a-socket' },
          frame: {
            v: 1,
            kind: 'abort',
            tunnelId: probe.tunnelId,
            reasonCode: 'relay_authorization_invalid',
          },
        });
      },
    });

    await expect(readiness).rejects.toThrow('relay_authorization_invalid');
    expect(probes).toHaveLength(1);
  });

  it('bounds aggregate ordered-forward diagnostics for large frame sets and terminal reasons', () => {
    const tunnelId = 'ordered-large';
    const factory = createRelayClusterEnvelopeFactory({
      accountId: 'account-1',
      machineId: 'machine-1',
      signingKeyId: 'stress-route-grant',
      signingPrivateKeySeedBase64Url: Buffer.from(new Uint8Array(nacl.sign.seedLength).fill(9)).toString('base64url'),
      now: () => 1_800_000_000_000,
    });
    const frames = Array.from({ length: 10_000 }, (_, sequence) =>
      factory.userData({ tunnelId, sequence, payload: 'x' }),
    );
    const terminal = {
      v: 1 as const,
      scopeUserId: 'account-1',
      sender: { kind: 'machine' as const, machineId: 'machine-1' },
      recipient: { kind: 'user' as const, socketId: 'user-a-socket' },
      frame: {
        v: 1 as const,
        kind: 'abort' as const,
        tunnelId,
        reasonCode: 'x'.repeat(10_000),
      },
    };
    const diagnostics = buildOrderedForwardRelayDiagnostics({
      orderedTunnelId: tunnelId,
      duplicateTunnelIds: { a: 'duplicate-a', b: 'duplicate-b' },
      clients: {
        userA: {
          socket: { id: 'user-a-socket', connected: true },
          frames: [terminal],
          errors: [],
        },
        userB: {
          socket: { id: 'user-b-socket', connected: true },
          frames: [],
          errors: [],
        },
        machineB: {
          socket: { id: 'machine-b-socket', connected: true },
          frames,
          errors: [],
        },
      },
      placement: {
        userAContainerId: 'api-a',
        userBContainerId: 'api-b',
        machineBContainerId: 'api-b',
      },
    });
    const parsed = JSON.parse(JSON.stringify(diagnostics)) as {
      ordered: {
        dataSequences: number[];
        omittedDataSequenceCount: number;
        terminalReasons: string[];
        omittedTerminalReasonCount: number;
      };
    };

    expect(parsed.ordered.dataSequences).toHaveLength(12);
    expect(parsed.ordered.omittedDataSequenceCount).toBe(9_988);
    expect(parsed.ordered.terminalReasons).toHaveLength(1);
    expect(parsed.ordered.terminalReasons[0]?.length).toBeLessThanOrEqual(257);
    expect(parsed.ordered.omittedTerminalReasonCount).toBe(0);
    expect(JSON.stringify(diagnostics).length).toBeLessThan(8_192);
  });

  it('keeps the ordered-forward success predicate at exactly two DATA frames', async () => {
    const tunnelId = 'ordered-complete';
    const factory = createRelayClusterEnvelopeFactory({
      accountId: 'account-1',
      machineId: 'machine-1',
      signingKeyId: 'stress-route-grant',
      signingPrivateKeySeedBase64Url: Buffer.from(new Uint8Array(nacl.sign.seedLength).fill(5)).toString('base64url'),
      now: () => 1_800_000_000_000,
    });
    const input = {
      orderedTunnelId: tunnelId,
      duplicateTunnelIds: {
        a: 'duplicate-a',
        b: 'duplicate-b',
      },
      clients: {
        userA: {
          socket: { id: 'user-a-socket', connected: true },
          frames: [],
          errors: [],
        },
        userB: {
          socket: { id: 'user-b-socket', connected: true },
          frames: [],
          errors: [],
        },
        machineB: {
          socket: { id: 'machine-b-socket', connected: true },
          frames: [
            factory.open({
              tunnelId,
              grantId: 'grant-ordered',
              relaySocketId: 'user-a-socket',
            }),
            factory.userData({ tunnelId, sequence: 0, payload: 'forward-0' }),
            factory.userData({ tunnelId, sequence: 1, payload: 'forward-1' }),
          ],
          errors: [],
        },
      },
      placement: {
        userAContainerId: 'api-a',
        userBContainerId: 'api-b',
        machineBContainerId: 'api-b',
      },
      timeoutMs: 5,
      intervalMs: 1,
    } as const;

    await expect(waitForOrderedForwardRelayData(input)).resolves.toBeUndefined();
    expect(buildOrderedForwardRelayDiagnostics(input).ordered.classification).toBe('complete');
  });
});
