import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ApiMachineClient } from './apiMachine';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';

const callOrder = vi.hoisted(() => [] as string[]);

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
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
    RPC_METHODS.STOP_SESSION,
  ]) {
    rpcHandlerManager.registerHandler(method, async () => ({ ok: true }));
  }
}

const ioMock = vi.hoisted(() => vi.fn());
const connectionHarness = vi.hoisted(() => {
  let config: {
    createTransport: () => {
      connect: () => Promise<void>;
    };
    onConnected: () => Promise<void>;
  } | null = null;
  const reportProbeResult = vi.fn();

  const connectNextTransport = async () => {
    if (!config) throw new Error('connection supervisor was not created');
    const transport = config.createTransport();
    await transport.connect();
    await config.onConnected();
  };

  return {
    reset() {
      config = null;
      reportProbeResult.mockReset();
    },
    reportProbeResult,
    connectNextTransport,
    createManagedConnectionSupervisor(nextConfig: typeof config) {
      config = nextConfig;
      return {
        start: vi.fn(async () => {
          await connectNextTransport();
        }),
        stop: vi.fn(async () => {}),
        reportProbeResult,
        getState: vi.fn(() => ({
          phase: 'online',
          reason: null,
          attempt: 0,
          nextRetryAt: null,
          lastConnectedAt: Date.now(),
          lastDisconnectedAt: null,
          lastErrorMessage: null,
        })),
      };
    },
  };
});

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: connectionHarness.createManagedConnectionSupervisor,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://example.test',
    apiServerUrl: 'https://example.test',
    socketForceWebsocketOnly: false,
    socketIoTransports: ['polling', 'websocket'],
  },
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
  getSocketIoProxyOptions: () => ({}),
}));

vi.mock('@/rpc/handlers/registerSessionHandlers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/rpc/handlers/registerSessionHandlers')>()),
  registerSessionHandlers: () => ({ dispose: async () => {} }),
}));

vi.mock('@/rpc/handlers/scm', () => ({
  registerScmHandlers: () => undefined,
}));

vi.mock('@/rpc/handlers/fileSystem', () => ({
  registerFileSystemHandlers: () => ({ dispose: async () => {} }),
}));

vi.mock('@/rpc/handlers/workspaceAnchors/registerWorkspaceAnchorHandlers', () => ({
  registerWorkspaceAnchorHandlers: () => undefined,
}));

vi.mock('@/rpc/handlers/workspaceFavicon/registerWorkspaceFaviconHandlers', () => ({
  registerWorkspaceFaviconHandlers: () => undefined,
}));

vi.mock('@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers', () => ({
  registerMachineFileBrowserHandlers: () => undefined,
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
    connectionHarness.reset();
    ioMock.mockReset();
  });

  it('installs the RPC listener before connecting and replays client handlers before state on every reconnect', async () => {
    const firstSocket = createApiSessionSocketStub({
      id: 'machine-socket-1',
      onConnect: (socket) => {
        callOrder.push(
          `${socket.getHandlers(SOCKET_RPC_EVENTS.REQUEST).length === 1 ? 'attach' : 'attach-missing'}:machine-socket-1`,
        );
      },
      emit: (event) => {
        if (event === SOCKET_RPC_EVENTS.REGISTER) {
          callOrder.push('register:machine-socket-1');
        }
      },
    });
    const secondSocket = createApiSessionSocketStub({
      id: 'machine-socket-2',
      onConnect: (socket) => {
        callOrder.push(
          `${socket.getHandlers(SOCKET_RPC_EVENTS.REQUEST).length === 1 ? 'attach' : 'attach-missing'}:machine-socket-2`,
        );
      },
      emit: (event) => {
        if (event === SOCKET_RPC_EVENTS.REGISTER) {
          callOrder.push('register:machine-socket-2');
        }
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

    Object.defineProperty(client, 'startKeepAlive', { value: () => undefined });
    Object.defineProperty(client, 'syncChangesOnConnect', { value: async () => undefined });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    rpcHandlerManager.registerHandler('neutral.reconnect', async () => ({ ok: true }));
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    const firstReadiness = createDeferred<{ status: 'ready' }>();
    const secondReadiness = createDeferred<{ status: 'ready' }>();
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockReturnValueOnce(firstReadiness.promise)
      .mockReturnValueOnce(secondReadiness.promise);

    vi.spyOn(client, 'updateDaemonState').mockImplementation(async () => {
      const socket = Reflect.get(client, 'socket') as { id?: string } | null;
      callOrder.push(`state:${socket?.id ?? 'none'}`);
    });

    client.connect();
    await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
    expect(callOrder).not.toContain('state:machine-socket-1');
    firstReadiness.resolve({ status: 'ready' });
    await vi.waitFor(() => expect(callOrder).toContain('state:machine-socket-1'));

    const reconnect = connectionHarness.connectNextTransport();
    await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2));
    expect(callOrder).not.toContain('state:machine-socket-2');
    secondReadiness.resolve({ status: 'ready' });
    await reconnect;

    expect(callOrder.indexOf('attach:machine-socket-1')).toBeLessThan(callOrder.indexOf('state:machine-socket-1'));
    expect(callOrder.indexOf('register:machine-socket-1')).toBeLessThan(callOrder.indexOf('state:machine-socket-1'));
    expect(callOrder.indexOf('attach:machine-socket-2')).toBeLessThan(callOrder.indexOf('state:machine-socket-2'));
    expect(callOrder.indexOf('register:machine-socket-2')).toBeLessThan(callOrder.indexOf('state:machine-socket-2'));
    expect(firstSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
      method: 'machine-1:neutral.reconnect',
    });
    expect(secondSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTER, {
      method: 'machine-1:neutral.reconnect',
    });
  });

  it('does not publish running when a required machine-control registration is missing', async () => {
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
    Object.defineProperty(client, 'startKeepAlive', { value: () => undefined });
    Object.defineProperty(client, 'syncChangesOnConnect', { value: async () => undefined });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers').mockResolvedValue({
      status: 'timeout',
      missingMethods: [RPC_METHODS.STOP_SESSION],
    });
    const updateDaemonState = vi.spyOn(client, 'updateDaemonState');

    client.connect();
    await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(updateDaemonState).not.toHaveBeenCalled();
  });

  it('publishes running when the current transport receives every required registration after the initial deadline', async () => {
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
    Object.defineProperty(client, 'startKeepAlive', { value: () => undefined });
    Object.defineProperty(client, 'syncChangesOnConnect', { value: async () => undefined });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    const waitForRegisteredHandlers = rpcHandlerManager.waitForRegisteredHandlers.bind(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockResolvedValueOnce({
        status: 'timeout',
        missingMethods: [
          RPC_METHODS.SPAWN_HAPPY_SESSION,
          RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
          RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
          RPC_METHODS.STOP_SESSION,
        ],
      })
      .mockImplementation(waitForRegisteredHandlers);
    const updateDaemonState = vi.spyOn(client, 'updateDaemonState').mockResolvedValue();

    client.connect();
    await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalled());
    expect(updateDaemonState).not.toHaveBeenCalled();

    for (const method of [
      RPC_METHODS.SPAWN_HAPPY_SESSION,
      RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
      RPC_METHODS.STOP_SESSION,
    ]) {
      socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
    }
    await vi.waitFor(() => expect(updateDaemonState).toHaveBeenCalledTimes(1));
  });

  it('ignores late registration acknowledgements from a superseded transport', async () => {
    const firstSocket = createApiSessionSocketStub({ id: 'machine-socket-1' });
    const secondSocket = createApiSessionSocketStub({ id: 'machine-socket-2' });
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
    Object.defineProperty(client, 'startKeepAlive', { value: () => undefined });
    Object.defineProperty(client, 'syncChangesOnConnect', { value: async () => undefined });
    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    registerRequiredMachineControlHandlers(rpcHandlerManager);
    const waitForRegisteredHandlers = rpcHandlerManager.waitForRegisteredHandlers.bind(rpcHandlerManager);
    vi.spyOn(rpcHandlerManager, 'waitForRegisteredHandlers')
      .mockResolvedValueOnce({ status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] })
      .mockResolvedValueOnce({ status: 'timeout', missingMethods: [RPC_METHODS.STOP_SESSION] })
      .mockImplementation(waitForRegisteredHandlers);
    const updateDaemonState = vi.spyOn(client, 'updateDaemonState').mockResolvedValue();

    client.connect();
    await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(1));
    await connectionHarness.connectNextTransport();
    await vi.waitFor(() => expect(rpcHandlerManager.waitForRegisteredHandlers).toHaveBeenCalledTimes(2));

    for (const method of [
      RPC_METHODS.SPAWN_HAPPY_SESSION,
      RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
      RPC_METHODS.STOP_SESSION,
    ]) {
      firstSocket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
    }
    await Promise.resolve();
    expect(updateDaemonState).not.toHaveBeenCalled();

    for (const method of [
      RPC_METHODS.SPAWN_HAPPY_SESSION,
      RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
      RPC_METHODS.STOP_SESSION,
    ]) {
      secondSocket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: `machine-1:${method}` });
    }
    await vi.waitFor(() => expect(updateDaemonState).toHaveBeenCalledTimes(1));
  });

  it('fails closed when the server rejects a provider-starting RPC registration as upgrade-required', async () => {
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
    Object.defineProperty(client, 'startKeepAlive', { value: () => undefined });
    Object.defineProperty(client, 'syncChangesOnConnect', { value: async () => undefined });

    client.connect();
    await vi.waitFor(() => expect(socket.getHandlers(SOCKET_RPC_EVENTS.ERROR)).toHaveLength(1));
    socket.trigger(SOCKET_RPC_EVENTS.ERROR, {
      type: 'register',
      error: 'client-upgrade-required',
      requirement: {
        v: 1,
        clientKind: 'daemon',
        minimumAppVersion: '0.3.0',
        updateUrl: null,
      },
    });

    expect(connectionHarness.reportProbeResult).toHaveBeenCalledWith({
      status: 'auth_failed',
      statusCode: 426,
      errorMessage: 'This Happier daemon must be upgraded before it can sync sessions.',
    });
  });
});
