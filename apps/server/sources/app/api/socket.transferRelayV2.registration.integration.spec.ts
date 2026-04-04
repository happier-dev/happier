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
vi.mock('@/app/events/eventRouter', () => ({
  buildMachineActivityEphemeral: vi.fn(),
  eventRouter: {
    setIo: (...args: unknown[]) => eventRouterSetIoMock(...args),
    addConnection: vi.fn(),
    emitEphemeral: vi.fn(),
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
  });
});
