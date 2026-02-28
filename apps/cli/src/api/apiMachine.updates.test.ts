import { afterEach, describe, expect, it, vi } from 'vitest';

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
    onSocketConnect() {}
    onSocketDisconnect() {}
    async handleRequest() {
      return '';
    }
  }
  return { RpcHandlerManager };
});

describe('ApiMachineClient updates', () => {
  afterEach(() => {
    socketHandlers.clear();
    ioMock.mockReset();
    vi.resetModules();
  });

  it('dispatches non-machine updates to subscribers', async () => {
    const fakeSocket: any = {
      on: (event: string, handler: (...args: any[]) => void) => {
        socketHandlers.set(event, handler);
        return fakeSocket;
      },
      emit: vi.fn(),
      emitWithAck: vi.fn(),
      close: vi.fn(),
      io: { on: vi.fn() },
      connect: () => undefined,
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

    const handler = vi.fn(() => true);
    client.onUpdate(handler);

    client.connect();

    const onUpdate = socketHandlers.get('update');
    expect(onUpdate).toBeDefined();

    onUpdate?.({
      id: 'u-1',
      seq: 123,
      createdAt: Date.now(),
      body: {
        t: 'automation-assignment-updated',
        machineId: 'machine-1',
        automationId: 'automation-1',
        enabled: true,
        updatedAt: Date.now(),
      },
    } as any);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
