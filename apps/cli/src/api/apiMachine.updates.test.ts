import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

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
    ioMock.mockReset();
    vi.resetModules();
  });

  it('dispatches non-machine updates to subscribers', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(ioMock, machineSocket);

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

    const updateHandler = machineSocket.getHandler('update');
    expect(updateHandler).toBeDefined();

    updateHandler?.({
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
