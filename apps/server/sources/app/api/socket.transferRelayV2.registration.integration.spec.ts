import { describe, expect, it, vi } from 'vitest';

const serverCtor = vi.hoisted(() => vi.fn());
vi.mock('socket.io', () => ({
  Server: function ServerMock(this: any, ...args: any[]) {
    return serverCtor(...args);
  },
}));

const onShutdownMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/process/shutdown', () => ({
  onShutdown: (...args: unknown[]) => onShutdownMock(...args),
}));

const eventRouterSetIoMock = vi.hoisted(() => vi.fn());
const eventRouterEmitEphemeralMock = vi.hoisted(() => vi.fn());
const buildMachineActivityEphemeralMock = vi.hoisted(() => vi.fn(() => ({
  t: 'machine-activity',
  machineId: 'mock-machine',
  active: true,
  activeAt: 0,
})));
vi.mock('@/app/events/eventRouter', () => ({
  buildMachineActivityEphemeral: buildMachineActivityEphemeralMock,
  eventRouter: {
    setIo: (...args: unknown[]) => eventRouterSetIoMock(...args),
    addConnection: vi.fn(),
    emitEphemeral: (...args: unknown[]) => eventRouterEmitEphemeralMock(...args),
  },
}));

const rpcHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/rpcHandler', () => ({
  rpcHandler: (...args: unknown[]) => rpcHandlerMock(...args),
}));
const usageHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/usageHandler', () => ({
  usageHandler: (...args: unknown[]) => usageHandlerMock(...args),
}));
const sessionUpdateHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/sessionUpdateHandler', () => ({
  sessionUpdateHandler: (...args: unknown[]) => sessionUpdateHandlerMock(...args),
}));
const pingHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/pingHandler', () => ({
  pingHandler: (...args: unknown[]) => pingHandlerMock(...args),
}));
const machineUpdateHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/machineUpdateHandler', () => ({
  machineUpdateHandler: (...args: unknown[]) => machineUpdateHandlerMock(...args),
}));
const machineTransferHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/machineTransferHandler', () => ({
  machineTransferHandler: (...args: unknown[]) => machineTransferHandlerMock(...args),
}));
const transferRelayV2HandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/transferRelayV2Handler', () => ({
  transferRelayV2Handler: (...args: unknown[]) => transferRelayV2HandlerMock(...args),
}));
const peerTcpTunnelRelayHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/peer/mediation/tunnel/registerRelay', () => ({
  registerPeerTcpTunnelRelaySocketHandler: (...args: unknown[]) => peerTcpTunnelRelayHandlerMock(...args),
}));
const artifactUpdateHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/artifactUpdateHandler', () => ({
  artifactUpdateHandler: (...args: unknown[]) => artifactUpdateHandlerMock(...args),
}));
const accessKeyHandlerMock = vi.hoisted(() => vi.fn());
vi.mock('./socket/accessKeyHandler', () => ({
  accessKeyHandler: (...args: unknown[]) => accessKeyHandlerMock(...args),
}));
const createServerRpcForwarderMock = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock('./socket/serverRpcForwarder', () => ({
  createServerRpcForwarder: () => createServerRpcForwarderMock(),
}));

describe('startSocket transfer relay v2 registration', () => {
  it('registers the new relay v2 handler beside the existing machine transfer handler', async () => {
    const fakeServer = {
      on: vi.fn(),
      use: vi.fn(),
      close: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
    };
    serverCtor.mockReturnValue(fakeServer);

    const { startSocket } = await import('./socket');
    const app = { server: {} } as any;
    startSocket(app);

    const connectionHandler = fakeServer.on.mock.calls.find(([event]) => event === 'connection')?.[1] as
      | ((socket: any) => Promise<void>)
      | undefined;
    expect(connectionHandler).toBeTypeOf('function');

    const socket = {
      id: 'socket-1',
      data: {
        userId: 'user-1',
        clientType: 'user-scoped',
        clientPurpose: 'transfer',
      },
      emit: vi.fn(),
      on: vi.fn(),
      join: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck: vi.fn() })),
      connected: true,
      handshake: {
        address: '127.0.0.1',
        headers: {
          'user-agent': 'happier-test-agent',
        },
      },
      conn: {
        transport: { name: 'websocket' },
        remotePort: 1234,
      },
      disconnect: vi.fn(),
    } as any;

    await connectionHandler!(socket);

    expect(socket.join).toHaveBeenCalledWith(['user:user-1', 'user-scoped:user-1']);
    expect(machineTransferHandlerMock).toHaveBeenCalledTimes(1);
    expect(machineTransferHandlerMock).toHaveBeenCalledWith('user-1', socket, expect.objectContaining({ io: fakeServer }));
    expect(transferRelayV2HandlerMock).toHaveBeenCalledTimes(1);
    expect(transferRelayV2HandlerMock).toHaveBeenCalledWith('user-1', socket, expect.objectContaining({ io: fakeServer }));
    expect(peerTcpTunnelRelayHandlerMock).toHaveBeenCalledTimes(1);
    expect(peerTcpTunnelRelayHandlerMock).toHaveBeenCalledWith('user-1', socket, expect.objectContaining({
      io: expect.objectContaining({
        to: expect.any(Function),
      }),
      coordinator: expect.objectContaining({
        admit: expect.any(Function),
        routeMachineEnvelope: expect.any(Function),
        release: expect.any(Function),
        close: expect.any(Function),
      }),
      serverRoutedEnabled: false,
      maxBytes: 64 * 1024 * 1024,
      maxActiveTunnelsPerSocket: 8,
      maxFrameBytes: 64 * 1024,
    }));
  });

  it('waits for the socket room join before publishing machine online status', async () => {
    const fakeServer = {
      on: vi.fn(),
      use: vi.fn(),
      close: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
    };
    serverCtor.mockReturnValue(fakeServer);

    const { startSocket } = await import('./socket');
    const app = { server: {} } as any;
    startSocket(app);

    const connectionHandler = fakeServer.on.mock.calls.find(([event]) => event === 'connection')?.[1] as
      | ((socket: any) => Promise<void>)
      | undefined;
    expect(connectionHandler).toBeTypeOf('function');

    let resolveJoin!: () => void;
    const joinPromise = new Promise<void>((resolve) => {
      resolveJoin = resolve;
    });

    const socket = {
      id: 'socket-1',
      data: {
        userId: 'user-1',
        clientType: 'machine-scoped',
        clientPurpose: 'transfer',
        machineId: 'm-1',
      },
      emit: vi.fn(),
      on: vi.fn(),
      join: vi.fn(() => joinPromise),
      timeout: vi.fn(() => ({ emitWithAck: vi.fn() })),
      connected: true,
      handshake: {
        address: '127.0.0.1',
        headers: {
          'user-agent': 'happier-test-agent',
        },
      },
      conn: {
        transport: { name: 'websocket' },
        remotePort: 1234,
      },
      disconnect: vi.fn(),
    } as any;

    const connectionPromise = connectionHandler!(socket);
    await Promise.resolve();

    expect(socket.join).toHaveBeenCalledWith([
      'user-machines:user-1',
      'machine:m-1:user-1',
    ]);
    expect(eventRouterEmitEphemeralMock).not.toHaveBeenCalled();

    resolveJoin();
    await connectionPromise;
    await Promise.resolve();

    expect(buildMachineActivityEphemeralMock).toHaveBeenCalledWith('m-1', true, expect.any(Number));
    expect(eventRouterEmitEphemeralMock).toHaveBeenCalledTimes(1);
    expect(eventRouterEmitEphemeralMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      payload: expect.objectContaining({
        t: 'machine-activity',
        active: true,
      }),
      recipientFilter: { type: 'user-scoped-only' },
    }));
  });
});
