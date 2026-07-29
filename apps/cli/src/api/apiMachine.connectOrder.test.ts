import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { ApiMachineClient } from './apiMachine';

const callOrder = vi.hoisted(() => [] as string[]);
const ioMock = vi.hoisted(() => vi.fn());
const probeReadinessMock = vi.hoisted(() => vi.fn(async () => ({ status: 'ready' as const })));

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
    warn: () => undefined,
    debugLargeJson: () => undefined,
  },
}));

describe('ApiMachineClient connect ordering', () => {
  afterEach(() => {
    callOrder.length = 0;
    probeReadinessMock.mockClear();
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
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as {
      registerHandler: (method: string, handler: () => Promise<unknown>) => void;
    };
    rpcHandlerManager.registerHandler('neutral.reconnect', async () => ({ ok: true }));

    try {
      client.connect();
      await vi.waitFor(() => expect(ioMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(firstSocket.connect).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(callOrder).toContain('state:machine-socket-1'));
      firstSocket.disconnect();
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

  it('fails closed when the server rejects a provider-starting RPC registration as upgrade-required', async () => {
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
          minimumSessionSyncProtocolVersion: 2,
          clientKind: 'daemon',
          minimumAppVersion: '0.3.0',
          updateUrl: null,
        },
      });

      expect(reportProbeResult).toHaveBeenCalledWith({
        status: 'auth_failed',
        statusCode: 426,
        errorMessage: 'This Happier daemon must be upgraded before it can sync sessions.',
      }, expect.objectContaining({ generation: expect.any(Number) }));
      await vi.waitFor(() => expect(phases).toContain('auth_failed'));
    } finally {
      await client.shutdown();
    }
  }, 5_000);
});
