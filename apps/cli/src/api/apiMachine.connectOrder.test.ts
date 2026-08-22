import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import {
  MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
} from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiMachineClient } from './apiMachine';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';

const callOrder = vi.hoisted(() => [] as string[]);
const ioMock = vi.hoisted(() => vi.fn());
const probeReadinessMock = vi.hoisted(() => vi.fn(async () => ({ status: 'ready' as const })));
const loggerWarnMock = vi.hoisted(() => vi.fn());

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function registerRequiredMachineControlHandlers(rpcHandlerManager: RpcHandlerManager): void {
  for (const method of [
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_SPAWN_NEW,
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
    RPC_METHODS.STOP_SESSION,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
  ]) {
    rpcHandlerManager.registerHandler(method, async () => ({ ok: true }));
  }
}

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://example.test',
    apiServerUrl: 'https://example.test',
    currentCliVersion: '0.0.0-test',
    socketForceWebsocketOnly: false,
    socketIoTransports: ['polling', 'websocket'],
    activeServerDir: '/private/tmp/happier-api-machine-connect-order',
    happyHomeDir: '/private/tmp/happier-api-machine-connect-order-home',
  },
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
  getSocketIoProxyOptions: () => ({}),
}));

vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
  createLoopbackReadinessProbe: () => probeReadinessMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: () => undefined,
    warn: loggerWarnMock,
    debugLargeJson: () => undefined,
  },
}));

describe('ApiMachineClient connect ordering', () => {
  afterEach(() => {
    callOrder.length = 0;
    probeReadinessMock.mockClear();
    loggerWarnMock.mockClear();
    ioMock.mockReset();
    vi.unstubAllEnvs();
  });

  it('installs the RPC listener before connecting and replays client handlers before state on every generation', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const firstSocket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      disconnectReason: 'transport close',
      onConnect: (socket) => {
        callOrder.push(
          `${socket.getHandlers(SOCKET_RPC_EVENTS.REQUEST).length === 1 ? 'attach' : 'attach-missing'}:machine-socket-1`,
        );
      },
      emit: (event, args) => {
        if (
          event === SOCKET_RPC_EVENTS.REGISTER
          && (args[0] as { method?: unknown } | undefined)?.method === 'machine-1:neutral.reconnect'
        ) {
          callOrder.push('register:machine-socket-1');
        }
      },
      emitWithAck: (event, payload) => {
        if (event === 'machine-update-state') {
          callOrder.push('state:machine-socket-1');
          return {
            result: 'success',
            version: 1,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 1 };
      },
    });
    const secondSocket = createApiSessionSocketStub({
      id: 'machine-socket-2',
      disconnectReason: 'transport close',
      onConnect: (socket) => {
        callOrder.push(
          `${socket.getHandlers(SOCKET_RPC_EVENTS.REQUEST).length === 1 ? 'attach' : 'attach-missing'}:machine-socket-2`,
        );
      },
      emit: (event, args) => {
        if (
          event === SOCKET_RPC_EVENTS.REGISTER
          && (args[0] as { method?: unknown } | undefined)?.method === 'machine-1:neutral.reconnect'
        ) {
          callOrder.push('register:machine-socket-2');
        }
      },
      emitWithAck: (event, payload) => {
        if (event === 'machine-update-state') {
          callOrder.push('state:machine-socket-2');
          return {
            result: 'success',
            version: 2,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 2 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);

    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    client.onConnectedServicesProjection(async () => {});
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    rpcHandlerManager.registerHandler('neutral.reconnect', async () => ({ ok: true }));
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    const firstReadiness = createDeferred<{ status: 'ready' }>();
    const secondReadiness = createDeferred<{ status: 'ready' }>();
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockReturnValueOnce(firstReadiness.promise)
      .mockReturnValueOnce(secondReadiness.promise);

    try {
      client.connect();
      await vi.waitFor(() => expect(ioMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(firstSocket.connect).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      expect(callOrder).not.toContain('state:machine-socket-1');
      firstReadiness.resolve({ status: 'ready' });
      await vi.waitFor(() => expect(callOrder).toContain('state:machine-socket-1'));
      firstSocket.disconnect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2));
      expect(callOrder).not.toContain('state:machine-socket-2');
      secondReadiness.resolve({ status: 'ready' });
      await vi.waitFor(() => expect(callOrder).toContain('state:machine-socket-2'));

      expect(callOrder).toEqual([
        'attach:machine-socket-1',
        'register:machine-socket-1',
        'state:machine-socket-1',
        'attach:machine-socket-2',
        'register:machine-socket-2',
        'state:machine-socket-2',
      ]);
      expect(firstSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
        method: 'machine-1:neutral.reconnect',
      });
      expect(secondSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
        method: 'machine-1:neutral.reconnect',
      });
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('withdraws stale capability state before advertising session spawn after the exact daemon RPCs are ready', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const capabilityPayloads: unknown[] = [];
    const socket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          capabilityPayloads.push(payload);
          return {
            v: 1,
            result: 'success',
            revision: capabilityPayloads.length,
          };
        }
        if (event === 'machine-update-state') {
          return {
            result: 'success',
            version: 1,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 1 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      sessionSpawnV1OutcomeRequired: true,
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    const readiness = createDeferred<{ status: 'ready' }>();
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockReturnValue(readiness.promise);

    try {
      client.connect();
      await vi.waitFor(() => expect(capabilityPayloads).toEqual([
        { machineId: 'machine-1', capabilities: {} },
      ]));
      expect(capabilityPayloads).toHaveLength(1);
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledWith(
        expect.arrayContaining([
          RPC_METHODS.SESSION_SPAWN_NEW,
          SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
        ]),
        expect.any(Object),
      ));

      readiness.resolve({ status: 'ready' });

      await vi.waitFor(() => expect(capabilityPayloads).toEqual([
        { machineId: 'machine-1', capabilities: {} },
        {
          machineId: 'machine-1',
          capabilities: {
            sessionInputAdmission: { protocolVersions: [1] },
            sessionSpawn: { protocolVersions: [1] },
            pluginWebhookClaim: { protocolVersions: [1] },
          },
        },
      ]));
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('does not advertise session spawn from an embedding without the required creation-outcome attestation', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const capabilityPayloads: unknown[] = [];
    const socket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          capabilityPayloads.push(payload);
          return { v: 1, result: 'success', revision: capabilityPayloads.length };
        }
        return { result: 'success', version: 1 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockResolvedValue({ status: 'ready' });

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(capabilityPayloads).toEqual([
        { machineId: 'machine-1', capabilities: {} },
      ]);
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('does not publish running when a required machine-control registration is missing', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const socket = createApiSessionSocketStub({ id: 'machine-socket-1' });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockResolvedValue({
      status: 'timeout',
      missingMethods: [RPC_METHODS.STOP_SESSION],
    });
    const updateDaemonState = vi.spyOn(client, 'updateDaemonState');

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(updateDaemonState).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(loggerWarnMock).toHaveBeenCalledWith(
          '[API MACHINE] Core machine-control RPC registration did not become ready',
          { status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] },
        ),
      );
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('publishes current capabilities and running when the active transport becomes ready after the initial deadline', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const capabilityPayloads: unknown[] = [];
    const statePayloads: unknown[] = [];
    const socket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      emitWithAck: (event, payload) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          capabilityPayloads.push(payload);
          return { v: 1, result: 'success', revision: capabilityPayloads.length };
        }
        if (event === 'machine-update-state') {
          statePayloads.push(payload);
          return {
            result: 'success',
            version: statePayloads.length,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        return { result: 'success', version: 1 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      sessionSpawnV1OutcomeRequired: true,
      resolveSpawnSessionByNonce: async () => ({ status: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    const waitForRegisteredHandlers = rpcHandlerManager.waitForRegisteredHandlers.bind(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockResolvedValueOnce({ status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] })
      .mockImplementation(waitForRegisteredHandlers);

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      expect(capabilityPayloads).toEqual([{ machineId: 'machine-1', capabilities: {} }]);
      expect(statePayloads).toEqual([]);

      for (const method of [
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        RPC_METHODS.SESSION_SPAWN_NEW,
        RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
        RPC_METHODS.STOP_SESSION,
        SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
      ]) {
        socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
      }

      await vi.waitFor(() => expect(statePayloads).toHaveLength(1));
      expect(capabilityPayloads).toEqual([
        { machineId: 'machine-1', capabilities: {} },
        {
          machineId: 'machine-1',
          capabilities: {
            sessionInputAdmission: { protocolVersions: [1] },
            sessionSpawn: { protocolVersions: [1] },
            pluginWebhookClaim: { protocolVersions: [1] },
          },
        },
      ]);
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('ignores late registration acknowledgements from a superseded transport', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const stateSockets: string[] = [];
    const createSocket = (id: string) => createApiSessionSocketStub({
      id,
      disconnectReason: 'transport close',
      emitWithAck: (event, payload) => {
        if (event === 'machine-update-state') {
          stateSockets.push(id);
          return {
            result: 'success',
            version: stateSockets.length,
            daemonState: (payload as { daemonState: string }).daemonState,
          };
        }
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          return { v: 1, result: 'success', revision: 1 };
        }
        return { result: 'success', version: 1 };
      },
    });
    const firstSocket = createSocket('machine-socket-1');
    const secondSocket = createSocket('machine-socket-2');
    bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    const waitForRegisteredHandlers = rpcHandlerManager.waitForRegisteredHandlers.bind(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockResolvedValueOnce({ status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] })
      .mockResolvedValueOnce({ status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] })
      .mockImplementation(waitForRegisteredHandlers);

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      firstSocket.disconnect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2));

      for (const method of [
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        RPC_METHODS.SESSION_SPAWN_NEW,
        RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
        RPC_METHODS.STOP_SESSION,
        SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
      ]) {
        firstSocket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
      }
      await Promise.resolve();
      expect(stateSockets).toEqual([]);

      for (const method of [
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        RPC_METHODS.SESSION_SPAWN_NEW,
        RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
        RPC_METHODS.STOP_SESSION,
        SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
      ]) {
        secondSocket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
      }
      await vi.waitFor(() => expect(stateSockets).toEqual(['machine-socket-2']));
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('does not warn about unready registration when a ready result lands on a superseded transport', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const firstSocket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      disconnectReason: 'transport close',
    });
    const secondSocket = createApiSessionSocketStub({
      id: 'machine-socket-2',
      disconnectReason: 'transport close',
      emitWithAck: (event) => {
        if (event === 'machine-update-state') {
          callOrder.push('state:machine-socket-2');
        }
        return { result: 'success', version: 2 };
      },
    });
    bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);

    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    const staleReadiness = createDeferred<{ status: 'ready' }>();
    const liveReadiness = createDeferred<{ status: 'ready' }>();
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockReturnValueOnce(staleReadiness.promise)
      .mockReturnValueOnce(liveReadiness.promise);

    try {
      client.connect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
      firstSocket.disconnect();
      await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2));

      // The first transport's readiness wait resolves *ready* only after its socket was
      // superseded: the registration did become ready, so the operator must not be told
      // it "did not become ready".
      staleReadiness.resolve({ status: 'ready' });
      liveReadiness.resolve({ status: 'ready' });
      await vi.waitFor(() => expect(callOrder).toContain('state:machine-socket-2'));

      expect(
        loggerWarnMock.mock.calls.filter(
          ([message]) => message === '[API MACHINE] Core machine-control RPC registration did not become ready',
        ),
      ).toEqual([]);
    } finally {
      await client.shutdown();
    }
  }, 5_000);

  it('keeps account-storage RPC upgrade results operation-scoped', async () => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    const socket = createApiSessionSocketStub({ id: 'machine-socket-1' });
    bindApiSessionSocketSequenceMock(ioMock, [socket]);
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });
    const phases: string[] = [];
    client.onConnectionStateChange((state) => phases.push(state.phase));

    try {
      client.connect();
      await vi.waitFor(() => expect(socket.getHandlers(SOCKET_RPC_EVENTS.ERROR)).toHaveLength(1));
      const supervisor = Reflect.get(client, 'connectionSupervisor') as {
        reportProbeResult?: (probe: unknown) => void;
      };
      const reportProbeResult = vi.spyOn(supervisor, 'reportProbeResult');
      socket.trigger(SOCKET_RPC_EVENTS.ERROR, {
        type: 'register',
        error: 'client-upgrade-required',
        requirement: {
          v: 1,
          kind: 'account-stored-content',
          minimumProtocolVersion: 2,
        },
      });

      expect(reportProbeResult).not.toHaveBeenCalled();
      expect(phases).not.toContain('auth_failed');
    } finally {
      await client.shutdown();
    }
  }, 5_000);
});
