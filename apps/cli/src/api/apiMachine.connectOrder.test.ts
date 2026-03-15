import { afterEach, describe, expect, it, vi } from 'vitest';

const callOrder = vi.hoisted(() => [] as string[]);

const socketHandlers = vi.hoisted(() => new Map<string, (...args: any[]) => void>());
const ioMock = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://example.test',
    apiServerUrl: 'https://example.test',
    socketForceWebsocketOnly: false,
    socketIoTransports: ['websocket', 'polling'],
  },
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
  getSocketIoProxyOptions: () => ({}),
}));

vi.mock('@/rpc/handlers/registerSessionHandlers', () => ({
  registerSessionHandlers: () => undefined,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: () => undefined,
    warn: () => undefined,
    debugLargeJson: () => undefined,
  },
}));

vi.mock('./rpc/RpcHandlerManager', () => {
  class RpcHandlerManager {
    registerHandler() {}
    onSocketConnect() {
      callOrder.push('rpc');
    }
    onSocketDisconnect() {}
    async handleRequest() {
      return '';
    }
  }
  return { RpcHandlerManager };
});

describe('ApiMachineClient connect ordering', () => {
  afterEach(() => {
    callOrder.length = 0;
    socketHandlers.clear();
    ioMock.mockReset();
    vi.resetModules();
  });

  it('registers RPC handlers before publishing daemon state on connect', async () => {
    const fakeSocket: any = {
      on: (event: string, handler: (...args: any[]) => void) => {
        socketHandlers.set(event, handler);
        return fakeSocket;
      },
      emit: vi.fn(),
      emitWithAck: vi.fn(),
      close: vi.fn(),
      io: { on: vi.fn() },
      connect: () => {
        const onConnect = socketHandlers.get('connect');
        if (onConnect) onConnect();
      },
    };

    ioMock.mockReturnValue(fakeSocket);

    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    (client as any).startKeepAlive = () => undefined;
    (client as any).syncChangesOnConnect = () => undefined;

    vi.spyOn(client, 'updateDaemonState').mockImplementation(async () => {
      callOrder.push('state');
    });

    client.connect();

    expect(callOrder[0]).toBe('rpc');
    expect(callOrder).toContain('state');
  });
});
