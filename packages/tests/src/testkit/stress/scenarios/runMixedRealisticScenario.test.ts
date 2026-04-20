import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as mixedRealisticScenario from './runMixedRealisticScenario';

const emitPresencePulse =
  mixedRealisticScenario.emitPresencePulse as
    | ((collector: {
        sessionId: string;
        machineId: string;
        socket: {
          emit: (event: string, payload: unknown) => void;
          emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
        };
      }) => Promise<void>)
    | undefined;

const sendMixedMessageBatch =
  mixedRealisticScenario.sendMixedMessageBatch as
    | ((params: {
        startIndex: number;
        endIndexExclusive: number;
        sessions: readonly {
          sessionId: string;
          authIndex: number;
        }[];
        concurrency: number;
        userDevices: readonly {
          authIndex: number;
          token: string;
          devices: ReadonlyArray<{
            emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
          }>;
        }[];
        ackLatencies: number[];
        expectedLocalIdsBySession: Map<string, string[]>;
      }) => Promise<void>)
    | undefined;

const sendMixedRpcBatch =
  mixedRealisticScenario.sendMixedRpcBatch as
    | ((params: {
        listeners: readonly {
          method: string;
          machineId: string;
          authIndex: number;
        }[];
        rpcPlans: readonly {
          listenerIndex: number;
          triggerMessageIndex: number;
        }[];
        concurrency: number;
        userDevices: readonly {
          authIndex: number;
          token: string;
          devices: ReadonlyArray<{
            rpcCall: (method: string, params: string) => Promise<{ ok?: boolean; result?: string; errorCode?: string }>;
          }>;
        }[];
        rpcLatencies: number[];
      }) => Promise<void>)
    | undefined;

const recordProvisionedCollector =
  mixedRealisticScenario.recordProvisionedCollector as
    | ((params: {
        collector: {
          sessionId: string;
          machineId: string;
          authIndex: number;
          socket: {
            emit: (event: string, payload: unknown) => void;
            emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
          };
        };
        sessionIds: string[];
        sessions: Array<{
          sessionId: string;
          authIndex: number;
        }>;
        machineCollectors: Array<{
          sessionId: string;
          machineId: string;
          authIndex: number;
          socket: {
            emit: (event: string, payload: unknown) => void;
            emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
          };
        }>;
        verificationSessionIds: string[];
        expectedLocalIdsBySession: Map<string, string[]>;
        verificationSessionCount: number;
      }) => void)
    | undefined;

const runMixedSocketConnectTasks =
  mixedRealisticScenario.runMixedSocketConnectTasks as
    | ((params: {
        tasks: ReadonlyArray<() => Promise<void>>;
        concurrency: number;
        connectPattern?: 'burst' | 'ramped';
        rampStepMs?: number;
        sleepImpl?: (ms: number) => Promise<void>;
      }) => Promise<void>)
    | undefined;

describe('emitPresencePulse', () => {
  it('fires presence events without waiting for acknowledgements that the server does not provide', async () => {
    const emit = vi.fn();
    const emitWithAck = vi.fn(async () => {
      throw new Error('emitWithAck should not be used for fire-and-forget presence pulses');
    });

    expect(emitPresencePulse).toBeTypeOf('function');

    await expect(
      emitPresencePulse?.({
        sessionId: 'session-1',
        machineId: 'machine-1',
        socket: {
          emit,
          emitWithAck,
        },
      }),
    ).resolves.toBeUndefined();

    expect(emitWithAck).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(2);

    const [sessionEvent, machineEvent] = emit.mock.calls;
    expect(sessionEvent?.[0]).toBe('session-alive');
    expect(sessionEvent?.[1]).toEqual({
      sid: 'session-1',
      time: expect.any(Number),
      thinking: false,
    });
    expect(machineEvent?.[0]).toBe('machine-alive');
    expect(machineEvent?.[1]).toEqual({
      machineId: 'machine-1',
      time: expect.any(Number),
    });
    expect((sessionEvent?.[1] as { time?: number }).time).toBe((machineEvent?.[1] as { time?: number }).time);
  });
});

describe('sendMixedMessageBatch', () => {
  it('sends mixed messages with bounded concurrency and shards them across the available emitters', async () => {
    let active = 0;
    let maxActive = 0;

    const createEmitter = () => ({
      emitWithAck: vi.fn(async (_event: string, payload: unknown) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;

        const localId = (payload as { localId?: unknown }).localId;
        if (typeof localId !== 'string' || localId.length === 0) {
          throw new Error('expected localId to be populated');
        }

        return { ok: true, id: `message-${localId}`, seq: 1, localId };
      }),
    });
    const devices = [createEmitter(), createEmitter()];
    const ackLatencies: number[] = [];
    const expectedLocalIdsBySession = new Map<string, string[]>([
      ['session-1', []],
      ['session-2', []],
    ]);

    expect(sendMixedMessageBatch).toBeTypeOf('function');

    await expect(
      sendMixedMessageBatch?.({
        startIndex: 0,
        endIndexExclusive: 6,
        sessions: [
          { sessionId: 'session-1', authIndex: 0 },
          { sessionId: 'session-2', authIndex: 1 },
        ],
        concurrency: 3,
        userDevices: [
          { authIndex: 0, token: 'token-1', devices: [devices[0]] },
          { authIndex: 1, token: 'token-2', devices: [devices[1]] },
        ],
        ackLatencies,
        expectedLocalIdsBySession,
      }),
    ).resolves.toBeUndefined();

    expect(devices[0].emitWithAck).toHaveBeenCalledTimes(3);
    expect(devices[1].emitWithAck).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(3);
    expect(ackLatencies).toHaveLength(6);
    expect(expectedLocalIdsBySession.get('session-1')).toHaveLength(3);
    expect(expectedLocalIdsBySession.get('session-2')).toHaveLength(3);
  });

  it('surfaces the full non-ok ack payload when a mixed message write fails', async () => {
    expect(sendMixedMessageBatch).toBeTypeOf('function');

    await expect(
      sendMixedMessageBatch?.({
        startIndex: 0,
        endIndexExclusive: 1,
        sessions: [{ sessionId: 'session-1', authIndex: 0 }],
        concurrency: 1,
        userDevices: [
          {
            authIndex: 0,
            token: 'token-1',
            devices: [
              {
                emitWithAck: vi.fn(async () => ({
                  ok: false,
                  error: 'internal',
                })),
              },
            ],
          },
        ],
        ackLatencies: [],
        expectedLocalIdsBySession: new Map([['session-1', []]]),
      }),
    ).rejects.toThrow(/session-1.*internal/);
  });
});

describe('sendMixedRpcBatch', () => {
  it('runs mixed RPC calls with bounded concurrency across the auth-scoped emitters', async () => {
    let active = 0;
    let maxActive = 0;

    const createDevice = () => ({
      rpcCall: vi.fn(async (method: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const listenerIndex = Number(method.split('.').at(-1));
        const machineId = Number.isFinite(listenerIndex) && listenerIndex % 2 === 0 ? 'machine-1' : 'machine-2';
        return {
          ok: true,
          result: JSON.stringify({ ok: true, method, machineId }),
        };
      }),
    });

    const deviceA = createDevice();
    const deviceB = createDevice();
    const rpcLatencies: number[] = [];

    expect(sendMixedRpcBatch).toBeTypeOf('function');

    await expect(
      sendMixedRpcBatch?.({
        listeners: [
          { method: 'session-1:stress.mixed.rpc.0', machineId: 'machine-1', authIndex: 0 },
          { method: 'session-2:stress.mixed.rpc.1', machineId: 'machine-2', authIndex: 1 },
        ],
        rpcPlans: [
          { listenerIndex: 0, triggerMessageIndex: 0 },
          { listenerIndex: 1, triggerMessageIndex: 1 },
          { listenerIndex: 0, triggerMessageIndex: 2 },
          { listenerIndex: 1, triggerMessageIndex: 3 },
          { listenerIndex: 0, triggerMessageIndex: 4 },
          { listenerIndex: 1, triggerMessageIndex: 5 },
        ],
        concurrency: 3,
        userDevices: [
          { authIndex: 0, token: 'token-1', devices: [deviceA] },
          { authIndex: 1, token: 'token-2', devices: [deviceB] },
        ],
        rpcLatencies,
      }),
    ).resolves.toBeUndefined();

    expect(deviceA.rpcCall).toHaveBeenCalledTimes(3);
    expect(deviceB.rpcCall).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(3);
    expect(rpcLatencies).toHaveLength(6);
  });
});

describe('recordProvisionedCollector', () => {
  it('tracks partial setup progress as collectors are provisioned', () => {
    expect(recordProvisionedCollector).toBeTypeOf('function');

    const sessionIds: string[] = [];
    const sessions: Array<{
      sessionId: string;
      authIndex: number;
    }> = [];
    const machineCollectors: Array<{
      sessionId: string;
      machineId: string;
      authIndex: number;
      socket: {
        emit: (event: string, payload: unknown) => void;
        emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
      };
    }> = [];
    const verificationSessionIds: string[] = [];
    const expectedLocalIdsBySession = new Map<string, string[]>();

    const socket = {
      emit: vi.fn(),
      emitWithAck: vi.fn(async () => undefined),
    };

    recordProvisionedCollector?.({
      collector: { sessionId: 'session-1', machineId: 'machine-1', authIndex: 0, socket },
      sessionIds,
      sessions,
      machineCollectors,
      verificationSessionIds,
      expectedLocalIdsBySession,
      verificationSessionCount: 2,
    });
    recordProvisionedCollector?.({
      collector: { sessionId: 'session-2', machineId: 'machine-2', authIndex: 1, socket },
      sessionIds,
      sessions,
      machineCollectors,
      verificationSessionIds,
      expectedLocalIdsBySession,
      verificationSessionCount: 2,
    });
    recordProvisionedCollector?.({
      collector: { sessionId: 'session-3', machineId: 'machine-3', authIndex: 0, socket },
      sessionIds,
      sessions,
      machineCollectors,
      verificationSessionIds,
      expectedLocalIdsBySession,
      verificationSessionCount: 2,
    });

    expect(sessionIds).toEqual(['session-1', 'session-2', 'session-3']);
    expect(sessions).toEqual([
      { sessionId: 'session-1', authIndex: 0 },
      { sessionId: 'session-2', authIndex: 1 },
      { sessionId: 'session-3', authIndex: 0 },
    ]);
    expect(machineCollectors).toHaveLength(3);
    expect(verificationSessionIds).toEqual(['session-1', 'session-2']);
    expect(expectedLocalIdsBySession.get('session-1')).toEqual([]);
    expect(expectedLocalIdsBySession.get('session-2')).toEqual([]);
    expect(expectedLocalIdsBySession.has('session-3')).toBe(false);
  });
});

describe('runMixedSocketConnectTasks', () => {
  it('bounds concurrent socket connect scheduling for the mixed scenario', async () => {
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];

    expect(runMixedSocketConnectTasks).toBeTypeOf('function');

    await expect(
      runMixedSocketConnectTasks?.({
        concurrency: 2,
        tasks: Array.from({ length: 6 }, (_, index) => async () => {
          started.push(index);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      }),
    ).resolves.toBeUndefined();

    expect(started).toHaveLength(6);
    expect(maxActive).toBe(2);
  });

  it('can ramp later mixed connect tasks instead of launching the whole batch as a burst', async () => {
    const sleepImpl = vi.fn(async () => undefined);
    const started: number[] = [];

    expect(runMixedSocketConnectTasks).toBeTypeOf('function');

    await expect(
      runMixedSocketConnectTasks?.({
        concurrency: 3,
        connectPattern: 'ramped',
        rampStepMs: 25,
        sleepImpl,
        tasks: Array.from({ length: 4 }, (_, index) => async () => {
          started.push(index);
        }),
      }),
    ).resolves.toBeUndefined();

    expect(started).toEqual([0, 1, 2, 3]);
    expect(sleepImpl.mock.calls).toEqual([[25]]);
  });
});

describe('runMixedRealisticScenario', () => {
  it('distributes mixed setup and traffic across the provided auth pool', async () => {
    vi.resetModules();

    const finalize = vi.fn(async () => undefined);
    const sessionTokens: string[] = [];
    const collectorTokensBySessionId = new Map<string, string>();
    const messageTokens: string[] = [];
    const localIdsBySessionId = new Map<string, string[]>();
    const transcriptTokensBySessionId = new Map<string, string>();
    const deviceTokenBySessionId = new Map<string, string>();
    const sessionIdsByToken = new Map<string, string[]>();
    let sessionCounter = 0;

    class MockFailureArtifacts {
      json(): void {}

      text(): void {}

      async dumpAll(): Promise<void> {}
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 4,
        sessionPlans: [
          { authIndex: 0, sessionSlot: 0 },
          { authIndex: 1, sessionSlot: 0 },
          { authIndex: 0, sessionSlot: 1 },
          { authIndex: 1, sessionSlot: 1 },
        ],
        rpcListenerCount: 0,
        rpcReadinessProbeCount: 0,
        messageCount: 4,
        reconnectCycles: 0,
        verificationSessionCount: 4,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async (_baseUrl: string, token: string) => {
        sessionTokens.push(token);
        const sessionId = `session-${++sessionCounter}`;
        const ownedSessionIds = sessionIdsByToken.get(token) ?? [];
        ownedSessionIds.push(sessionId);
        sessionIdsByToken.set(token, ownedSessionIds);
        return { sessionId, tag: sessionId };
      }),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async (_baseUrl: string, token: string, sessionId: string) => {
        transcriptTokensBySessionId.set(sessionId, token);
        return (localIdsBySessionId.get(sessionId) ?? []).map((localId, index) => ({
          id: `message-${sessionId}-${index}`,
          seq: index + 1,
          localId,
          content: { t: 'encrypted' as const, c: 'ciphertext' },
          createdAt: index + 1,
          updatedAt: index + 1,
        }));
      }),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn((_baseUrl: string, token: string) => ({
        getEvents: () => [],
        close: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => true),
        rpcRegister: vi.fn(async () => undefined),
        rpcCall: vi.fn(async () => ({ ok: true, result: JSON.stringify({ ok: true, machineId: 'unused' }) })),
        emitWithAck: vi.fn(async (_event: string, payload: unknown) => {
          const sessionId = (payload as { sid?: unknown }).sid;
          const localId = (payload as { localId?: unknown }).localId;
          if (typeof sessionId !== 'string') {
            throw new Error('expected sid on mixed message payload');
          }
          if (typeof localId !== 'string' || localId.length === 0) {
            throw new Error('expected localId on mixed message payload');
          }
          messageTokens.push(token);
          deviceTokenBySessionId.set(sessionId, token);
          const sessionLocalIds = localIdsBySessionId.get(sessionId) ?? [];
          sessionLocalIds.push(localId);
          localIdsBySessionId.set(sessionId, sessionLocalIds);
          return { ok: true, id: `message-${sessionId}`, seq: sessionLocalIds.length, localId };
        }),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(async (params: { token: string; sessionId: string }) => {
        collectorTokensBySessionId.set(params.sessionId, params.token);
        return {
          machineId: `machine-${params.sessionId}`,
          socket: {
            getEvents: () => [],
            connect: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            isConnected: vi.fn(() => true),
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => undefined),
            onRpcRequest: vi.fn(),
            rpcRegister: vi.fn(async () => undefined),
          },
        };
      }),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        const result = await predicate();
        if (!result) {
          throw new Error('predicate remained false');
        }
      }),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      })),
      resolveRpcCallCount: vi.fn(() => 0),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeServiceMetricCounters: vi.fn(async () => ({})),
      summarizeGatewayLogs: vi.fn(async () => undefined),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod: vi.fn(async () => undefined),
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: '/tmp/run-1',
          testDir: () => '/tmp/run-1/mixed-realistic',
        },
        target: {
          mode: 'light',
          baseUrl: 'http://127.0.0.1:43080',
          stop: async () => undefined,
          collectDiagnostics: async () => undefined,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'light',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 2,
            machinesPerUser: 1,
            sessionsPerUser: 2,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 1,
            messagesPerSecond: 4,
            reconnectRate: 0,
            mixedSessionMode: 'presence-fan-in',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 0,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 0,
            imageBuildStrategy: 'if-missing',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: false,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: false,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        auths: [{ token: 'token-1', publicKeyBase64: 'pk-1' }, { token: 'token-2', publicKeyBase64: 'pk-2' }],
      }),
    ).resolves.toBeUndefined();

    expect(sessionTokens).toEqual(['token-1', 'token-2', 'token-1', 'token-2']);
    expect(collectorTokensBySessionId).toEqual(
      new Map([
        ['session-1', 'token-1'],
        ['session-2', 'token-2'],
        ['session-3', 'token-1'],
        ['session-4', 'token-2'],
      ]),
    );
    expect(messageTokens).toEqual(['token-1', 'token-2', 'token-1', 'token-2']);
    expect(deviceTokenBySessionId).toEqual(
      new Map([
        ['session-1', 'token-1'],
        ['session-2', 'token-2'],
        ['session-3', 'token-1'],
        ['session-4', 'token-2'],
      ]),
    );
    expect(transcriptTokensBySessionId).toEqual(
      new Map([
        ['session-1', 'token-1'],
        ['session-2', 'token-2'],
        ['session-3', 'token-1'],
        ['session-4', 'token-2'],
      ]),
    );
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          stageDurationsMs: expect.objectContaining({
            provisionMs: expect.any(Number),
            trafficMs: expect.any(Number),
            verificationMs: expect.any(Number),
          }),
        }),
      }),
    );
  });

  it('writes failure artifacts before finalizing a failed run', async () => {
    vi.resetModules();

    const callOrder: string[] = [];
    const dumpAll = vi.fn(async () => {
      callOrder.push('dump');
    });
    const finalize = vi.fn(async () => {
      callOrder.push('finalize');
    });

    class MockFailureArtifacts {
      json(): void {}

      text(): void {}

      async dumpAll(): Promise<void> {
        await dumpAll();
      }
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 1,
        sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
        rpcListenerCount: 0,
        rpcReadinessProbeCount: 0,
        messageCount: 0,
        reconnectCycles: 0,
        verificationSessionCount: 0,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async () => {
        throw new Error('setup failed');
      }),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async () => []),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn(() => ({
        getEvents: () => [],
        close: vi.fn(() => {
          callOrder.push('user-close');
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => false),
        emitWithAck: vi.fn(),
        rpcCall: vi.fn(),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async () => undefined),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      })),
      resolveRpcCallCount: vi.fn(() => 0),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeServiceMetricCounters: vi.fn(async () => ({})),
      summarizeGatewayLogs: vi.fn(async () => undefined),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod: vi.fn(async () => undefined),
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: '/tmp/run-1',
          testDir: () => '/tmp/run-1/mixed-realistic',
        },
        target: {
          mode: 'light',
          baseUrl: 'http://127.0.0.1:43080',
          stop: async () => undefined,
          collectDiagnostics: async () => undefined,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'light',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 1,
            machinesPerUser: 1,
            sessionsPerUser: 1,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 1,
            messagesPerSecond: 1,
            reconnectRate: 0,
            mixedSessionMode: 'representative',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 0,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 0,
            imageBuildStrategy: 'if-missing',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: false,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: false,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        token: 'token-1',
      }),
    ).rejects.toThrow('setup failed');

    expect(callOrder).toEqual(['dump', 'user-close', 'finalize']);
    expect(dumpAll).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('captures a connectivity snapshot when the connect wait times out before traffic starts', async () => {
    vi.resetModules();

    let connectivitySnapshotLoader: (() => unknown) | undefined;
    const finalize = vi.fn(async () => undefined);

    class MockFailureArtifacts {
      json(name: string, loader: () => unknown): void {
        if (name === 'connectivity.snapshot.json') {
          connectivitySnapshotLoader = loader;
        }
      }

      text(): void {}

      async dumpAll(): Promise<void> {}
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 1,
        sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
        rpcListenerCount: 0,
        rpcReadinessProbeCount: 0,
        messageCount: 0,
        reconnectCycles: 0,
        verificationSessionCount: 0,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async () => ({
        sessionId: 'session-1',
        tag: 'session-1',
      })),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async () => []),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn(() => ({
        getEvents: () => [
          { at: 1, kind: 'connect' },
          { at: 2, kind: 'connect_error', message: 'upstream_error' },
          { at: 3, kind: 'disconnect', reason: 'transport close' },
        ],
        close: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => false),
        emitWithAck: vi.fn(),
        rpcCall: vi.fn(),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(async () => ({
        machineId: 'machine-1',
        socket: {
          getEvents: () => [
            { at: 4, kind: 'connect_error', message: 'upstream_error' },
            { at: 5, kind: 'disconnect', reason: 'transport close' },
          ],
          connect: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => false),
          emit: vi.fn(),
          emitWithAck: vi.fn(async () => undefined),
          onRpcRequest: vi.fn(),
          rpcRegister: vi.fn(async () => undefined),
        },
      })),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        const result = await predicate();
        if (!result) {
          throw new Error('Timed out waiting for condition');
        }
      }),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      })),
      resolveRpcCallCount: vi.fn(() => 0),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeServiceMetricCounters: vi.fn(async () => ({})),
      summarizeGatewayLogs: vi.fn(async () => undefined),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod: vi.fn(async () => undefined),
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: '/tmp/run-1',
          testDir: () => '/tmp/run-1/mixed-realistic',
        },
        target: {
          mode: 'light',
          baseUrl: 'http://127.0.0.1:43080',
          stop: async () => undefined,
          collectDiagnostics: async () => undefined,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'light',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 1,
            machinesPerUser: 1,
            sessionsPerUser: 1,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 1,
            messagesPerSecond: 1,
            reconnectRate: 0,
            mixedSessionMode: 'representative',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 0,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 0,
            imageBuildStrategy: 'if-missing',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: false,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: false,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        token: 'token-1',
      }),
    ).rejects.toThrow('Timed out waiting for condition');

    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          connectivitySnapshot: expect.objectContaining({
            userDevices: expect.objectContaining({
              total: 1,
              connected: 0,
              disconnectedAuthIndexes: [0],
              disconnectedSample: [
                expect.objectContaining({
                  authIndex: 0,
                  disconnectedDeviceCount: 1,
                  devices: [
                    expect.objectContaining({
                      deviceIndex: 0,
                      lastConnectError: expect.objectContaining({
                        at: 2,
                        message: 'upstream_error',
                      }),
                      lastDisconnect: expect.objectContaining({
                        at: 3,
                        reason: 'transport close',
                      }),
                    }),
                  ],
                }),
              ],
            }),
            machineCollectors: expect.objectContaining({
              total: 1,
              connected: 0,
              disconnectedCount: 1,
              disconnectedSample: [
                expect.objectContaining({
                  sessionId: 'session-1',
                  machineId: 'machine-1',
                  authIndex: 0,
                  lastConnectError: expect.objectContaining({
                    at: 4,
                    message: 'upstream_error',
                  }),
                  lastDisconnect: expect.objectContaining({
                    at: 5,
                    reason: 'transport close',
                  }),
                }),
              ],
            }),
          }),
        }),
      }),
    );
    expect(connectivitySnapshotLoader?.()).toEqual([
      expect.objectContaining({
        userDevices: expect.objectContaining({
          total: 1,
          connected: 0,
          disconnectedAuthIndexes: [0],
          disconnectedSample: [
            expect.objectContaining({
              authIndex: 0,
              disconnectedDeviceCount: 1,
              devices: [
                expect.objectContaining({
                  deviceIndex: 0,
                  lastConnectError: expect.objectContaining({
                    at: 2,
                    message: 'upstream_error',
                  }),
                  lastDisconnect: expect.objectContaining({
                    at: 3,
                    reason: 'transport close',
                  }),
                }),
              ],
            }),
          ],
        }),
        machineCollectors: expect.objectContaining({
          total: 1,
          connected: 0,
          disconnectedCount: 1,
          disconnectedSample: [
            expect.objectContaining({
              sessionId: 'session-1',
              machineId: 'machine-1',
              authIndex: 0,
              lastConnectError: expect.objectContaining({
                at: 4,
                message: 'upstream_error',
              }),
              lastDisconnect: expect.objectContaining({
                at: 5,
                reason: 'transport close',
              }),
            }),
          ],
        }),
      }),
    ]);
  });

  it('captures createSessionMessage stage metrics and transaction retries in full-compose summaries', async () => {
    vi.resetModules();

    const finalize = vi.fn(async () => undefined);
    const localIdsBySessionId = new Map<string, string[]>();
    const scrapeClusterServiceMetricCounters = vi.fn(async ({ service }: { service: string }) =>
      service === 'api'
        ? {
            rpc_calls_total: 12,
            socket_cluster_fetch_sockets_total: 12,
            websocket_auth_handshake_exceptions_total: 0,
            websocket_connections_active: 4,
          }
        : {
            session_alive_events_total: 0,
            machine_alive_events_total: 0,
            presence_stream_pending_entries: 0,
          });
    const scrapeClusterServiceMetricSelectors = vi.fn(async () => ({
        verify_token_sum: 1.2,
        verify_token_count: 10,
        login_eligibility_sum: 2.4,
        login_eligibility_count: 10,
        session_binding_sum: 3.6,
        session_binding_count: 8,
        connect_start_total: 20,
        connect_complete_total: 12,
        connect_disconnect_before_ready_total: 8,
        connect_ready_sum: 3.6,
        connect_ready_count: 12,
        connect_disconnect_before_ready_sum: 3.6,
        connect_disconnect_before_ready_count: 8,
        binding_owner_session_lookup_sum: 1.2,
        binding_owner_session_lookup_count: 3,
        binding_machine_access_key_lookup_sum: 4.2,
        binding_machine_access_key_lookup_count: 5,
      eligibility_total_sum: 2.8,
      eligibility_total_count: 10,
      eligibility_account_lookup_sum: 1.4,
      eligibility_account_lookup_count: 10,
      eligibility_disabled_check_sum: 0.6,
      eligibility_disabled_check_count: 10,
      eligibility_provider_checks_sum: 0.8,
      eligibility_provider_checks_count: 4,
      eligibility_positive_hit_total: 7,
      eligibility_positive_miss_total: 10,
      eligibility_account_snapshot_hit_total: 6,
      eligibility_account_snapshot_miss_total: 4,
      eligibility_inflight_hit_total: 2,
      eligibility_inflight_miss_total: 10,
      access_sum: 2.5,
      access_count: 10,
      persist_sum: 7.5,
      persist_count: 10,
      change_tracking_sum: 1.5,
      change_tracking_count: 10,
      total_sum: 12.5,
      total_count: 10,
      retry_total: 4,
    }));
    const fetchGatewayStubStatus = vi.fn(async () => [
      'Active connections: 12',
      'server accepts handled requests',
      ' 100 100 120',
      'Reading: 2 Writing: 3 Waiting: 7',
    ].join('\n'));
    const summarizeGatewayLogs = vi.fn(async () => ({
      access: {
        totalRequests: 120,
        updatesRequests: 12,
        status101: 8,
        status499: 2,
        status502: 1,
        status5xx: 1,
      },
      error: {
        connectFailed: 1,
        upstreamTimedOut: 2,
        upstreamPrematurelyClosed: 0,
        noLiveUpstreams: 0,
      },
    }));

    class MockFailureArtifacts {
      json(): void {}
      text(): void {}
      async dumpAll(): Promise<void> {}
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 1,
        sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
        rpcListenerCount: 0,
        rpcReadinessProbeCount: 0,
        messageCount: 1,
        reconnectCycles: 0,
        verificationSessionCount: 1,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async (baseUrl: string, token: string, sessionId: string) => {
        void baseUrl;
        void token;
        return (localIdsBySessionId.get(sessionId) ?? []).map((localId, index) => ({
          id: `message-${index}`,
          seq: index + 1,
          localId,
        }));
      }),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn(() => ({
        getEvents: () => [],
        close: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => true),
        emitWithAck: vi.fn(async (_event: string, payload: any) => {
          const sessionId = payload.sid;
          const localId = payload.localId;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('expected session id on mixed message payload');
          }
          if (typeof localId !== 'string' || localId.length === 0) {
            throw new Error('expected localId on mixed message payload');
          }
          const sessionLocalIds = localIdsBySessionId.get(sessionId) ?? [];
          sessionLocalIds.push(localId);
          localIdsBySessionId.set(sessionId, sessionLocalIds);
          return {
            ok: true,
            id: `message-${localId}`,
            seq: sessionLocalIds.length,
            localId,
          };
        }),
        rpcCall: vi.fn(),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(async () => ({
        machineId: 'machine-1',
        socket: {
          getEvents: () => [],
          connect: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
          emit: vi.fn(),
          emitWithAck: vi.fn(async () => undefined),
          onRpcRequest: vi.fn(),
          rpcRegister: vi.fn(async () => undefined),
        },
      })),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        const result = await predicate();
        if (!result) throw new Error('predicate remained false');
      }),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 10,
        p95Ms: 20,
        p99Ms: 30,
        maxMs: 40,
      })),
      resolveRpcCallCount: vi.fn(() => 0),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeClusterServiceMetricCounters,
      scrapeClusterServiceMetricSelectors,
      fetchGatewayStubStatus,
      summarizeGatewayLogs,
      scrapeServiceMetricCounters: vi.fn(async () => ({
        session_alive_events_total: 0,
        machine_alive_events_total: 0,
        presence_stream_pending_entries: 0,
      })),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod: vi.fn(async () => undefined),
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: '/tmp/run-1',
          testDir: () => '/tmp/run-1/mixed-realistic',
        },
        target: {
          mode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          stop: async () => undefined,
          collectDiagnostics: async () => undefined,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 1,
            machinesPerUser: 1,
            sessionsPerUser: 1,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 1,
            messagesPerSecond: 1,
            reconnectRate: 0,
            mixedSessionMode: 'representative',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 1,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 1,
            imageBuildStrategy: 'never',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: true,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: true,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        auths: [{ token: 'token-1', publicKeyBase64: 'pk-1' }],
      }),
    ).resolves.toBeUndefined();

    expect(scrapeClusterServiceMetricCounters).toHaveBeenCalledTimes(1);
    expect(scrapeClusterServiceMetricSelectors).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          api: expect.objectContaining({
            rpc_calls_total: 12,
            websocket_auth_handshake_exceptions_total: 0,
          }),
          createSessionMessageStages: {
            access: { count: 10, avgMs: 250, totalMs: 2500 },
            persist: { count: 10, avgMs: 750, totalMs: 7500 },
            changeTracking: { count: 10, avgMs: 150, totalMs: 1500 },
            total: { count: 10, avgMs: 1250, totalMs: 12500 },
          },
          authHandshakeStages: {
            verifyToken: { count: 10, avgMs: 120, totalMs: 1200 },
            loginEligibility: { count: 10, avgMs: 240, totalMs: 2400 },
            sessionBinding: { count: 8, avgMs: 450, totalMs: 3600 },
          },
          connectConvergence: {
            phases: {
              startTotal: 20,
              completeTotal: 12,
              disconnectBeforeReadyTotal: 8,
            },
            durations: {
              ready: { count: 12, avgMs: 300, totalMs: 3600 },
              disconnectBeforeReady: { count: 8, avgMs: 450, totalMs: 3600 },
            },
          },
          gatewayStatus: {
            active: 12,
            accepts: 100,
            handled: 100,
            requests: 120,
            reading: 2,
            writing: 3,
            waiting: 7,
          },
          gatewayLogSummary: {
            access: {
              totalRequests: 120,
              updatesRequests: 12,
              status101: 8,
              status499: 2,
              status502: 1,
              status5xx: 1,
            },
            error: {
              connectFailed: 1,
              upstreamTimedOut: 2,
              upstreamPrematurelyClosed: 0,
              noLiveUpstreams: 0,
            },
          },
          sessionBindingStages: {
            ownerSessionLookup: { count: 3, avgMs: 400, totalMs: 1200 },
            machineAccessKeyLookup: { count: 5, avgMs: 840, totalMs: 4200 },
          },
          loginEligibilityStages: {
            total: { count: 10, avgMs: 280, totalMs: 2800 },
            accountLookup: { count: 10, avgMs: 140, totalMs: 1400 },
            disabledCheck: { count: 10, avgMs: 60, totalMs: 600 },
            providerChecks: { count: 4, avgMs: 200, totalMs: 800 },
          },
          loginEligibilityCache: {
            positiveResultHits: 7,
            positiveResultMisses: 10,
            accountSnapshotHits: 6,
            accountSnapshotMisses: 4,
            inflightHits: 2,
            inflightMisses: 10,
          },
          databaseTransactionRetries: {
            postgres: 4,
          },
        }),
      }),
    );
  });

  it('records gateway status scrape failures in full-compose summaries without failing the scenario', async () => {
    vi.resetModules();

    const finalize = vi.fn(async () => undefined);
    const localIdsBySessionId = new Map<string, string[]>();
    const scrapeClusterServiceMetricCounters = vi.fn(async ({ service }: { service: string }) =>
      service === 'api'
        ? {
            rpc_calls_total: 1,
            socket_cluster_fetch_sockets_total: 1,
            socket_cluster_fetch_sockets_failures_total: 0,
            websocket_auth_handshake_exceptions_total: 0,
            websocket_connections_active: 1,
            websocket_disconnects_total: 0,
            websocket_reconnections_total: 0,
            rpc_registrations_total: 0,
            rpc_unregistrations_total: 0,
            rpc_method_not_available_total: 0,
            rpc_target_lookup_failures_total: 0,
            runtime_rss_bytes: 1024,
            runtime_heap_used_bytes: 512,
          }
        : {
            session_alive_events_total: 0,
            machine_alive_events_total: 0,
            presence_stream_pending_entries: 0,
          });
    const scrapeClusterServiceMetricSelectors = vi.fn(async () => ({
      verify_token_sum: 0.1,
      verify_token_count: 1,
      login_eligibility_sum: 0.2,
      login_eligibility_count: 1,
      session_binding_sum: 0.3,
      session_binding_count: 1,
      connect_start_total: 1,
      connect_complete_total: 1,
      connect_disconnect_before_ready_total: 0,
      connect_ready_sum: 0.4,
      connect_ready_count: 1,
      connect_disconnect_before_ready_sum: 0,
      connect_disconnect_before_ready_count: 0,
      binding_owner_session_lookup_sum: 0,
      binding_owner_session_lookup_count: 0,
      binding_machine_access_key_lookup_sum: 0.3,
      binding_machine_access_key_lookup_count: 1,
      eligibility_total_sum: 0.2,
      eligibility_total_count: 1,
      eligibility_account_lookup_sum: 0.1,
      eligibility_account_lookup_count: 1,
      eligibility_disabled_check_sum: 0.05,
      eligibility_disabled_check_count: 1,
      eligibility_provider_checks_sum: 0,
      eligibility_provider_checks_count: 0,
      eligibility_positive_hit_total: 0,
      eligibility_positive_miss_total: 1,
      eligibility_account_snapshot_hit_total: 0,
      eligibility_account_snapshot_miss_total: 1,
      eligibility_inflight_hit_total: 0,
      eligibility_inflight_miss_total: 1,
      access_sum: 0.2,
      access_count: 1,
      persist_sum: 0.3,
      persist_count: 1,
      change_tracking_sum: 0.1,
      change_tracking_count: 1,
      total_sum: 0.6,
      total_count: 1,
      retry_total: 0,
    }));
    const fetchGatewayStubStatus = vi.fn(async () => {
      throw new Error('gateway overloaded');
    });

    class MockFailureArtifacts {
      json(): void {}
      text(): void {}
      async dumpAll(): Promise<void> {}
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 1,
        sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
        rpcListenerCount: 0,
        rpcReadinessProbeCount: 0,
        messageCount: 1,
        reconnectCycles: 0,
        verificationSessionCount: 1,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async (baseUrl: string, token: string, sessionId: string) => {
        void baseUrl;
        void token;
        return (localIdsBySessionId.get(sessionId) ?? []).map((localId, index) => ({
          id: `message-${index}`,
          seq: index + 1,
          localId,
        }));
      }),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn(() => ({
        getEvents: () => [],
        close: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => true),
        emitWithAck: vi.fn(async (_event: string, payload: any) => {
          const sessionId = payload.sid;
          const localId = payload.localId;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('expected session id on mixed message payload');
          }
          if (typeof localId !== 'string' || localId.length === 0) {
            throw new Error('expected localId on mixed message payload');
          }
          const sessionLocalIds = localIdsBySessionId.get(sessionId) ?? [];
          sessionLocalIds.push(localId);
          localIdsBySessionId.set(sessionId, sessionLocalIds);
          return {
            ok: true,
            id: `message-${localId}`,
            seq: sessionLocalIds.length,
            localId,
          };
        }),
        rpcCall: vi.fn(),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(async () => ({
        machineId: 'machine-1',
        socket: {
          getEvents: () => [],
          connect: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
          emit: vi.fn(),
          emitWithAck: vi.fn(async () => undefined),
          onRpcRequest: vi.fn(),
          rpcRegister: vi.fn(async () => undefined),
        },
      })),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        const result = await predicate();
        if (!result) throw new Error('predicate remained false');
      }),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 10,
        p95Ms: 20,
        p99Ms: 30,
        maxMs: 40,
      })),
      resolveRpcCallCount: vi.fn(() => 0),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeClusterServiceMetricCounters,
      scrapeClusterServiceMetricSelectors,
      fetchGatewayStubStatus,
      summarizeGatewayLogs: vi.fn(async () => undefined),
      scrapeServiceMetricCounters: vi.fn(async () => ({
        session_alive_events_total: 0,
        machine_alive_events_total: 0,
        presence_stream_pending_entries: 0,
      })),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod: vi.fn(async () => undefined),
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: '/tmp/run-1',
          testDir: () => '/tmp/run-1/mixed-realistic',
        },
        target: {
          mode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          stop: async () => undefined,
          collectDiagnostics: async () => undefined,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 1,
            machinesPerUser: 1,
            sessionsPerUser: 1,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 1,
            messagesPerSecond: 1,
            reconnectRate: 0,
            mixedSessionMode: 'representative',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 1,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 1,
            imageBuildStrategy: 'never',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: true,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: true,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        auths: [{ token: 'token-1', publicKeyBase64: 'pk-1' }],
      }),
    ).resolves.toBeUndefined();

    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          gatewayStatusError: 'gateway overloaded',
        }),
      }),
    );
  });

  it('preserves gateway status when docker-backed service metric scraping fails', async () => {
    vi.resetModules();

    const finalize = vi.fn(async () => undefined);
    const localIdsBySessionId = new Map<string, string[]>();
    const scrapeClusterServiceMetricCounters = vi.fn(async () => {
      throw new Error('spawn EBADF');
    });
    const scrapeClusterServiceMetricSelectors = vi.fn(async () => {
      throw new Error('spawn EBADF');
    });
    const fetchGatewayStubStatus = vi.fn(async () => [
      'Active connections: 14',
      'server accepts handled requests',
      ' 101 100 140',
      'Reading: 1 Writing: 4 Waiting: 9',
    ].join('\n'));

    class MockFailureArtifacts {
      json(): void {}
      text(): void {}
      async dumpAll(): Promise<void> {}
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 1,
        sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
        rpcListenerCount: 0,
        rpcReadinessProbeCount: 0,
        messageCount: 1,
        reconnectCycles: 0,
        verificationSessionCount: 1,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async (baseUrl: string, token: string, sessionId: string) => {
        void baseUrl;
        void token;
        return (localIdsBySessionId.get(sessionId) ?? []).map((localId, index) => ({
          id: `message-${index}`,
          seq: index + 1,
          localId,
        }));
      }),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn(() => ({
        getEvents: () => [],
        close: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => true),
        emitWithAck: vi.fn(async (_event: string, payload: any) => {
          const sessionId = payload.sid;
          const localId = payload.localId;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('expected session id on mixed message payload');
          }
          if (typeof localId !== 'string' || localId.length === 0) {
            throw new Error('expected localId on mixed message payload');
          }
          const sessionLocalIds = localIdsBySessionId.get(sessionId) ?? [];
          sessionLocalIds.push(localId);
          localIdsBySessionId.set(sessionId, sessionLocalIds);
          return {
            ok: true,
            id: `message-${localId}`,
            seq: sessionLocalIds.length,
            localId,
          };
        }),
        rpcCall: vi.fn(),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(async () => ({
        machineId: 'machine-1',
        socket: {
          getEvents: () => [],
          connect: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
          emit: vi.fn(),
          emitWithAck: vi.fn(async () => undefined),
          onRpcRequest: vi.fn(),
          rpcRegister: vi.fn(async () => undefined),
        },
      })),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        const result = await predicate();
        if (!result) throw new Error('predicate remained false');
      }),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 10,
        p95Ms: 20,
        p99Ms: 30,
        maxMs: 40,
      })),
      resolveRpcCallCount: vi.fn(() => 0),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeClusterServiceMetricCounters,
      scrapeClusterServiceMetricSelectors,
      fetchGatewayStubStatus,
      summarizeGatewayLogs: vi.fn(async () => undefined),
      scrapeServiceMetricCounters: vi.fn(async () => ({
        session_alive_events_total: 0,
        machine_alive_events_total: 0,
        presence_stream_pending_entries: 0,
      })),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod: vi.fn(async () => undefined),
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: '/tmp/run-1',
          testDir: () => '/tmp/run-1/mixed-realistic',
        },
        target: {
          mode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          stop: async () => undefined,
          collectDiagnostics: async () => undefined,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 1,
            machinesPerUser: 1,
            sessionsPerUser: 1,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 1,
            messagesPerSecond: 1,
            reconnectRate: 0,
            mixedSessionMode: 'representative',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 1,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 1,
            imageBuildStrategy: 'never',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: true,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: true,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        auths: [{ token: 'token-1', publicKeyBase64: 'pk-1' }],
      }),
    ).resolves.toBeUndefined();

    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          gatewayStatus: {
            active: 14,
            accepts: 101,
            handled: 100,
            requests: 140,
            reading: 1,
            writing: 4,
            waiting: 9,
          },
          failureMetricsError: expect.stringContaining('spawn EBADF'),
        }),
      }),
    );
  });

  it('recovers gateway log summary from persisted compose diagnostics when live gateway scraping fails on a failed run', async () => {
    vi.resetModules();

    const finalize = vi.fn(async () => undefined);
    const localIdsBySessionId = new Map<string, string[]>();
    const diagnosticsDir = mkdtempSync(join(tmpdir(), 'mixed-gateway-logs-'));
    const dockerLogsFile = join(diagnosticsDir, 'docker-compose.logs.txt');
    const composeLogs = [
      'gateway-1     | 127.0.0.1 - - [20/Apr/2026:19:00:01 +0000] "GET /v1/updates HTTP/1.1" 101 0 "-" "socket.io"',
      'gateway-1     | 127.0.0.1 - - [20/Apr/2026:19:00:02 +0000] "GET /v1/updates HTTP/1.1" 499 0 "-" "socket.io"',
      'gateway-1     | 2026/04/20 19:00:02 [error] 30#30: *101 connect() failed (111: Connection refused) while connecting to upstream, client: 127.0.0.1, server: _, request: "GET /v1/updates HTTP/1.1", upstream: "http://172.20.0.10:53288/v1/updates"',
    ].join('\n');
    const collectDiagnostics = vi.fn(async () => {
      writeFileSync(dockerLogsFile, composeLogs, 'utf8');
    });

    class MockFailureArtifacts {
      json(): void {}
      text(): void {}
      async dumpAll(): Promise<void> {}
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 1,
        sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
        rpcListenerCount: 0,
        rpcReadinessProbeCount: 0,
        messageCount: 1,
        reconnectCycles: 0,
        verificationSessionCount: 1,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async (baseUrl: string, token: string, sessionId: string) => {
        void baseUrl;
        void token;
        return (localIdsBySessionId.get(sessionId) ?? []).map((localId, index) => ({
          id: `message-${index}`,
          seq: index + 1,
          localId,
        }));
      }),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn(() => ({
        getEvents: () => [],
        close: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => true),
        emitWithAck: vi.fn(async (_event: string, payload: any) => {
          const sessionId = payload.sid;
          const localId = payload.localId;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('expected session id on mixed message payload');
          }
          if (typeof localId !== 'string' || localId.length === 0) {
            throw new Error('expected localId on mixed message payload');
          }
          const sessionLocalIds = localIdsBySessionId.get(sessionId) ?? [];
          sessionLocalIds.push(localId);
          localIdsBySessionId.set(sessionId, sessionLocalIds);
          return {
            ok: true,
            id: `message-${localId}`,
            seq: sessionLocalIds.length,
            localId,
          };
        }),
        rpcCall: vi.fn(),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(async () => ({
        machineId: 'machine-1',
        socket: {
          getEvents: () => [{ kind: 'connect_error', at: Date.now(), message: 'websocket error' }],
          connect: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => false),
          emit: vi.fn(),
          emitWithAck: vi.fn(async () => undefined),
          onRpcRequest: vi.fn(),
          rpcRegister: vi.fn(async () => undefined),
        },
      })),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        const result = await predicate();
        if (!result) throw new Error('predicate remained false');
      }),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 10,
        p95Ms: 20,
        p99Ms: 30,
        maxMs: 40,
      })),
      resolveRpcCallCount: vi.fn(() => 0),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeClusterServiceMetricCounters: vi.fn(async ({ service }: { service: string }) =>
        service === 'api'
          ? {
              rpc_calls_total: 0,
              socket_cluster_fetch_sockets_total: 0,
              socket_cluster_fetch_sockets_failures_total: 0,
              websocket_auth_handshake_exceptions_total: 0,
              websocket_connections_active: 0,
              websocket_disconnects_total: 0,
              websocket_reconnections_total: 0,
              rpc_registrations_total: 0,
              rpc_unregistrations_total: 0,
              rpc_method_not_available_total: 0,
              rpc_target_lookup_failures_total: 0,
              runtime_rss_bytes: 1024,
              runtime_heap_used_bytes: 512,
            }
          : {
              session_alive_events_total: 0,
              machine_alive_events_total: 0,
              presence_stream_pending_entries: 0,
            }),
      scrapeClusterServiceMetricSelectors: vi.fn(async () => ({
        verify_token_sum: 0,
        verify_token_count: 0,
        login_eligibility_sum: 0,
        login_eligibility_count: 0,
        session_binding_sum: 0,
        session_binding_count: 0,
        connect_start_total: 0,
        connect_complete_total: 0,
        connect_disconnect_before_ready_total: 0,
        connect_ready_sum: 0,
        connect_ready_count: 0,
        connect_disconnect_before_ready_sum: 0,
        connect_disconnect_before_ready_count: 0,
        binding_owner_session_lookup_sum: 0,
        binding_owner_session_lookup_count: 0,
        binding_machine_access_key_lookup_sum: 0,
        binding_machine_access_key_lookup_count: 0,
        eligibility_total_sum: 0,
        eligibility_total_count: 0,
        eligibility_account_lookup_sum: 0,
        eligibility_account_lookup_count: 0,
        eligibility_disabled_check_sum: 0,
        eligibility_disabled_check_count: 0,
        eligibility_provider_checks_sum: 0,
        eligibility_provider_checks_count: 0,
        eligibility_positive_hit_total: 0,
        eligibility_positive_miss_total: 0,
        eligibility_account_snapshot_hit_total: 0,
        eligibility_account_snapshot_miss_total: 0,
        eligibility_inflight_hit_total: 0,
        eligibility_inflight_miss_total: 0,
        access_sum: 0,
        access_count: 0,
        persist_sum: 0,
        persist_count: 0,
        change_tracking_sum: 0,
        change_tracking_count: 0,
        total_sum: 0,
        total_count: 0,
        retry_total: 0,
      })),
      fetchGatewayStubStatus: vi.fn(async () => [
        'Active connections: 2',
        'server accepts handled requests',
        ' 10 10 12',
        'Reading: 0 Writing: 1 Waiting: 1',
      ].join('\n')),
      summarizeGatewayLogs: vi.fn(async () => {
        throw new Error('spawn EBADF');
      }),
      summarizeGatewayLogsFromComposeLogs: vi.fn(() => ({
        access: {
          totalRequests: 2,
          updatesRequests: 2,
          status101: 1,
          status499: 1,
          status502: 0,
          status5xx: 0,
        },
        error: {
          connectFailed: 1,
          upstreamTimedOut: 0,
          upstreamPrematurelyClosed: 0,
          noLiveUpstreams: 0,
        },
      })),
      scrapeServiceMetricCounters: vi.fn(async () => ({
        session_alive_events_total: 0,
        machine_alive_events_total: 0,
        presence_stream_pending_entries: 0,
      })),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod: vi.fn(async () => undefined),
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: diagnosticsDir,
          testDir: () => join(diagnosticsDir, 'mixed-realistic'),
        },
        target: {
          mode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          artifacts: {
            dockerLogsFile,
          },
          stop: async () => undefined,
          collectDiagnostics,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 1,
            machinesPerUser: 1,
            sessionsPerUser: 1,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 1,
            messagesPerSecond: 1,
            reconnectRate: 0,
            mixedSessionMode: 'representative',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 1,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 1,
            imageBuildStrategy: 'never',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: true,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: true,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        auths: [{ token: 'token-1', publicKeyBase64: 'pk-1' }],
      }),
    ).rejects.toThrow('predicate remained false');

    expect(collectDiagnostics).toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);
    const finalizeCalls = finalize.mock.calls as unknown as Array<[{
      metrics: Record<string, unknown>;
    }]>;
    const finalizedMetrics = finalizeCalls[0]?.[0]?.metrics;
    if (!finalizedMetrics) {
      throw new Error('expected finalize to receive metrics');
    }
    expect(finalizedMetrics.gatewayLogSummarySource).toBe('compose-diagnostics');
    expect(finalizedMetrics.gatewayLogSummary).toEqual({
      access: {
        totalRequests: 2,
        updatesRequests: 2,
        status101: 1,
        status499: 1,
        status502: 0,
        status5xx: 0,
      },
      error: {
        connectFailed: 1,
        upstreamTimedOut: 0,
        upstreamPrematurelyClosed: 0,
        noLiveUpstreams: 0,
      },
    });
    expect(finalizedMetrics).not.toHaveProperty('gatewayLogSummaryError');
  });

  it('retries failure-time full-compose metric scraping after closing sockets when the live scrape hits EBADF', async () => {
    vi.resetModules();

    const finalize = vi.fn(async () => undefined);
    let socketsClosed = false;
    const userSocketClose = vi.fn(() => {
      socketsClosed = true;
    });
    const collectorSocketClose = vi.fn(() => {
      socketsClosed = true;
    });
    const scrapeClusterServiceMetricCounters = vi.fn(async ({ service }: { service: string }) => {
      if (!socketsClosed) {
        throw new Error('spawn EBADF');
      }
      return service === 'api'
        ? {
            rpc_calls_total: 3,
            socket_cluster_fetch_sockets_total: 3,
            websocket_auth_handshake_exceptions_total: 0,
            websocket_connections_active: 2,
          }
        : {
            session_alive_events_total: 0,
            machine_alive_events_total: 0,
            presence_stream_pending_entries: 0,
          };
    });
    const scrapeClusterServiceMetricSelectors = vi.fn(async () => {
      if (!socketsClosed) {
        throw new Error('spawn EBADF');
      }
      return {
        verify_token_sum: 0.5,
        verify_token_count: 1,
        login_eligibility_sum: 1,
        login_eligibility_count: 1,
        session_binding_sum: 1.5,
        session_binding_count: 1,
        connect_start_total: 4,
        connect_complete_total: 2,
        connect_disconnect_before_ready_total: 2,
        connect_ready_sum: 0.8,
        connect_ready_count: 2,
        connect_disconnect_before_ready_sum: 1.4,
        connect_disconnect_before_ready_count: 2,
        binding_owner_session_lookup_sum: 0.3,
        binding_owner_session_lookup_count: 1,
        binding_machine_access_key_lookup_sum: 0,
        binding_machine_access_key_lookup_count: 0,
        eligibility_total_sum: 1.1,
        eligibility_total_count: 1,
        eligibility_account_lookup_sum: 0.6,
        eligibility_account_lookup_count: 1,
        eligibility_disabled_check_sum: 0.2,
        eligibility_disabled_check_count: 1,
        eligibility_provider_checks_sum: 0,
        eligibility_provider_checks_count: 0,
        eligibility_positive_hit_total: 0,
        eligibility_positive_miss_total: 1,
        eligibility_account_snapshot_hit_total: 0,
        eligibility_account_snapshot_miss_total: 1,
        eligibility_inflight_hit_total: 0,
        eligibility_inflight_miss_total: 1,
        access_sum: 0,
        access_count: 0,
        persist_sum: 0,
        persist_count: 0,
        change_tracking_sum: 0,
        change_tracking_count: 0,
        total_sum: 0,
        total_count: 0,
        retry_total: 0,
      };
    });
    const fetchGatewayStubStatus = vi.fn(async () => [
      'Active connections: 9',
      'server accepts handled requests',
      ' 50 49 60',
      'Reading: 1 Writing: 2 Waiting: 6',
    ].join('\n'));

    class MockFailureArtifacts {
      json(): void {}
      text(): void {}
      async dumpAll(): Promise<void> {}
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 1,
        sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
        rpcListenerCount: 0,
        rpcReadinessProbeCount: 0,
        messageCount: 0,
        reconnectCycles: 0,
        verificationSessionCount: 0,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async () => []),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn(() => ({
        getEvents: () => [],
        close: userSocketClose,
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => true),
        emitWithAck: vi.fn(async () => ({
          ok: true,
          id: 'message-1',
          seq: 1,
          localId: 'local-1',
        })),
        rpcCall: vi.fn(),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(async () => ({
        machineId: 'machine-1',
        socket: {
          getEvents: () => [],
          connect: vi.fn(),
          disconnect: vi.fn(),
          close: collectorSocketClose,
          isConnected: vi.fn(() => false),
          emit: vi.fn(),
          emitWithAck: vi.fn(async () => undefined),
          onRpcRequest: vi.fn(),
          rpcRegister: vi.fn(async () => undefined),
        },
      })),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async () => {
        throw new Error('Timed out waiting for condition');
      }),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
      })),
      resolveRpcCallCount: vi.fn(() => 0),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeClusterServiceMetricCounters,
      scrapeClusterServiceMetricSelectors,
      fetchGatewayStubStatus,
      summarizeGatewayLogs: vi.fn(async () => undefined),
      scrapeServiceMetricCounters: vi.fn(async () => ({
        session_alive_events_total: 0,
        machine_alive_events_total: 0,
        presence_stream_pending_entries: 0,
      })),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod: vi.fn(async () => undefined),
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: '/tmp/run-1',
          testDir: () => '/tmp/run-1/mixed-realistic',
        },
        target: {
          mode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          stop: async () => undefined,
          collectDiagnostics: async () => undefined,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 1,
            machinesPerUser: 1,
            sessionsPerUser: 1,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 0,
            messagesPerSecond: 0,
            reconnectRate: 0,
            mixedSessionMode: 'representative',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 1,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 1,
            imageBuildStrategy: 'never',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: true,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: true,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        auths: [{ token: 'token-1', publicKeyBase64: 'pk-1' }],
      }),
    ).rejects.toThrow('Timed out waiting for condition');

    expect(scrapeClusterServiceMetricCounters).toHaveBeenCalledTimes(2);
    expect(scrapeClusterServiceMetricSelectors).toHaveBeenCalledTimes(2);
    expect(userSocketClose).toHaveBeenCalled();
    expect(collectorSocketClose).toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        metrics: expect.objectContaining({
          api: expect.objectContaining({
            rpc_calls_total: 3,
            websocket_auth_handshake_exceptions_total: 0,
          }),
          loginEligibilityStages: {
            total: { count: 1, avgMs: 1100, totalMs: 1100 },
            accountLookup: { count: 1, avgMs: 600, totalMs: 600 },
            disabledCheck: { count: 1, avgMs: 200, totalMs: 200 },
            providerChecks: { count: 0, avgMs: 0, totalMs: 0 },
          },
          connectConvergence: {
            phases: {
              startTotal: 4,
              completeTotal: 2,
              disconnectBeforeReadyTotal: 2,
            },
            durations: {
              ready: { count: 2, avgMs: 400, totalMs: 800 },
              disconnectBeforeReady: { count: 2, avgMs: 700, totalMs: 1400 },
            },
          },
          gatewayStatus: {
            active: 9,
            accepts: 50,
            handled: 49,
            requests: 60,
            reading: 1,
            writing: 2,
            waiting: 6,
          },
          sessionBindingStages: {
            ownerSessionLookup: { count: 1, avgMs: 300, totalMs: 300 },
            machineAccessKeyLookup: { count: 0, avgMs: 0, totalMs: 0 },
          },
          loginEligibilityCache: {
            positiveResultHits: 0,
            positiveResultMisses: 1,
            accountSnapshotHits: 0,
            accountSnapshotMisses: 1,
            inflightHits: 0,
            inflightMisses: 1,
          },
        }),
      }),
    );
  });

  it('scrapes failure-time cluster metrics and preserves RPC readiness context when traffic RPC fails', async () => {
    vi.resetModules();

    const finalize = vi.fn(async () => undefined);
    const waitForRegisteredRpcMethod = vi.fn(async () => undefined);
    const scrapeClusterServiceMetricCounters = vi.fn(async ({ service }: { service: string }) =>
      service === 'api'
        ? {
            rpc_calls_total: 9,
            socket_cluster_fetch_sockets_total: 11,
            websocket_auth_handshake_exceptions_total: 2,
            websocket_connections_active: 4,
            rpc_registrations_total: 1,
            rpc_unregistrations_total: 0,
            rpc_method_not_available_total: 1,
            rpc_target_lookup_failures_total: 1,
            socket_cluster_fetch_sockets_failures_total: 1,
          }
        : {
            session_alive_events_total: 0,
            machine_alive_events_total: 0,
            presence_stream_pending_entries: 0,
          });
    const scrapeClusterServiceMetricSelectors = vi.fn(async () => ({
      access_sum: 0.25,
      access_count: 1,
      persist_sum: 0.5,
      persist_count: 1,
      change_tracking_sum: 0.1,
      change_tracking_count: 1,
      total_sum: 0.85,
      total_count: 1,
      retry_total: 0,
    }));

    class MockFailureArtifacts {
      json(): void {}
      text(): void {}
      async dumpAll(): Promise<void> {}
    }

    vi.doMock('../../failureArtifacts', () => ({
      FailureArtifacts: MockFailureArtifacts,
    }));
    vi.doMock('../reporting/finalizeStressScenario', () => ({
      finalizeStressScenario: finalize,
    }));
    vi.doMock('./mixedRealisticWorkload', () => ({
      buildMixedRealisticWorkload: () => ({
        sessionCount: 1,
        sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
        rpcListenerCount: 1,
        rpcReadinessProbeCount: 1,
        messageCount: 1,
        reconnectCycles: 0,
        verificationSessionCount: 0,
        presencePulseCollectorCount: 0,
      }),
    }));
    vi.doMock('../../sessions', () => ({
      createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
      countDuplicateLocalIds: vi.fn(() => 0),
      fetchAllMessages: vi.fn(async () => []),
    }));
    vi.doMock('../../socketClient', () => ({
      createUserScopedSocketCollector: vi.fn(() => ({
        getEvents: () => [],
        close: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => true),
        emitWithAck: vi.fn(async () => ({
          ok: true,
          id: 'message-1',
          seq: 1,
          localId: 'local-1',
        })),
        rpcCall: vi.fn(async () => ({
          ok: false,
          errorCode: 'RPC_METHOD_NOT_AVAILABLE',
        })),
      })),
    }));
    vi.doMock('../../sessionSocketBinding', () => ({
      createMachineBoundSessionScopedSocketCollector: vi.fn(async () => ({
        machineId: 'machine-1',
        socket: {
          getEvents: () => [],
          connect: vi.fn(),
          disconnect: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
          emit: vi.fn(),
          emitWithAck: vi.fn(async () => undefined),
          onRpcRequest: vi.fn(),
          rpcRegister: vi.fn(async () => undefined),
        },
      })),
    }));
    vi.doMock('../../timing', () => ({
      sleep: vi.fn(async () => undefined),
      waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        const result = await predicate();
        if (!result) throw new Error('predicate remained false');
      }),
    }));
    vi.doMock('./stressScenarioRuntime', () => ({
      summarizeLatencySamples: vi.fn(() => ({
        p50Ms: 10,
        p95Ms: 20,
        p99Ms: 30,
        maxMs: 40,
      })),
      resolveRpcCallCount: vi.fn(() => 1),
      resolveStressSocketTransports: vi.fn(() => ['websocket']),
    }));
    const fetchGatewayStubStatus = vi.fn(async () => [
      'Active connections: 5',
      'server accepts handled requests',
      ' 20 20 24',
      'Reading: 1 Writing: 1 Waiting: 3',
    ].join('\n'));
    vi.doMock('./fullComposeScenarioSupport', () => ({
      scrapeClusterServiceMetricCounters,
      scrapeClusterServiceMetricSelectors,
      fetchGatewayStubStatus,
      summarizeGatewayLogs: vi.fn(async () => undefined),
      scrapeServiceMetricCounters: vi.fn(async () => ({
        session_alive_events_total: 0,
        machine_alive_events_total: 0,
        presence_stream_pending_entries: 0,
      })),
    }));
    vi.doMock('./runStressTasksWithConcurrencyLimit', () => ({
      runStressTasksWithConcurrencyLimit: vi.fn(async (items: readonly unknown[], _limit: number, task: (item: unknown, index: number) => Promise<void>) => {
        for (const [index, item] of items.entries()) {
          await task(item, index);
        }
      }),
    }));
    vi.doMock('./waitForRegisteredRpcMethod', () => ({
      waitForRegisteredRpcMethod,
    }));

    const { runMixedRealisticScenario: runScenario } = await import('./runMixedRealisticScenario');

    await expect(
      runScenario({
        run: {
          runId: 'run-1',
          runDir: '/tmp/run-1',
          testDir: () => '/tmp/run-1/mixed-realistic',
        },
        target: {
          mode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          stop: async () => undefined,
          collectDiagnostics: async () => undefined,
          preserveForInspection: () => undefined,
        } as never,
        config: {
          targetMode: 'full-compose',
          baseUrl: 'http://127.0.0.1:43080',
          repeat: 1,
          seed: 42,
          flakeRetry: false,
          socketTransport: 'websocket',
          duration: {
            warmupMs: 0,
            durationMs: 1_000,
            cooldownMs: 0,
            soakMs: 0,
          },
          load: {
            users: 1,
            machinesPerUser: 1,
            sessionsPerUser: 1,
            rpcListenersPerUser: 1,
            rpcCallsPerSecond: 1,
            messagesPerSecond: 1,
            reconnectRate: 0,
            mixedSessionMode: 'representative',
          },
          orchestration: {
            rollingRestartEnabled: false,
            killTarget: 'none',
            expectedApiReplicas: 1,
            expectedWorkerReplicas: 1,
          },
          compose: {
            apiReplicas: 1,
            workerReplicas: 1,
            imageBuildStrategy: 'never',
            reuseRunningTopology: false,
            gatewayPort: undefined,
            postgresPort: undefined,
            redisPort: undefined,
            minioPort: undefined,
            minioConsolePort: undefined,
            metricsEnabled: true,
            filesBackend: 's3',
          },
          artifacts: {
            saveArtifactsOnSuccess: false,
            metricsScrapeEnabled: true,
            keepTopologyOnFailure: false,
            summaryOutputPath: undefined,
          },
        },
        auths: [{ token: 'token-1', publicKeyBase64: 'pk-1' }],
      }),
    ).rejects.toThrow(/RPC_METHOD_NOT_AVAILABLE/);

    expect(waitForRegisteredRpcMethod).toHaveBeenCalledTimes(1);
    expect(scrapeClusterServiceMetricCounters).toHaveBeenCalledTimes(1);
    expect(scrapeClusterServiceMetricSelectors).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        metrics: expect.objectContaining({
          api: expect.objectContaining({
            websocket_auth_handshake_exceptions_total: 2,
            rpc_method_not_available_total: 1,
            rpc_target_lookup_failures_total: 1,
            socket_cluster_fetch_sockets_failures_total: 1,
          }),
          rpcReadiness: expect.objectContaining({
            probed: 1,
            successful: 1,
            failed: 0,
            ledger: [
              expect.objectContaining({
                method: 'session-1:stress.mixed.rpc.0',
                machineId: 'machine-1',
                authIndex: 0,
                status: 'ok',
                durationMs: expect.any(Number),
              }),
            ],
          }),
          failedRpc: expect.objectContaining({
            method: 'session-1:stress.mixed.rpc.0',
            machineId: 'machine-1',
            authIndex: 0,
            rpcCallsCompleted: 1,
            messagesSentBeforeFailure: 1,
            errorCode: 'RPC_METHOD_NOT_AVAILABLE',
          }),
        }),
      }),
    );
  });
});
