import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from './types';

const { configurationMock, mockIo } = vi.hoisted(() => ({
  configurationMock: {
    apiServerUrl: 'http://localhost:3005',
    socketIoTransports: ['websocket', 'polling'] as string[],
  },
  mockIo: vi.fn<(url: string, opts: Record<string, unknown>) => any>(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    emitWithAck: vi.fn(),
    io: { on: vi.fn() },
  })),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

vi.mock('@/configuration', () => ({
  configuration: configurationMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

vi.mock('@/rpc/handlers/registerSessionHandlers', () => ({ registerSessionHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/scm', () => ({ registerScmHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/fileSystem', () => ({ registerFileSystemHandlers: vi.fn() }));
vi.mock('@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers', () => ({ registerMachineFileBrowserHandlers: vi.fn() }));
vi.mock('./machine/rpcHandlers', () => ({ registerMachineRpcHandlers: vi.fn() }));
vi.mock('./rpc/RpcHandlerManager', () => ({
  RpcHandlerManager: class {
    onSocketConnect() {}
    onSocketDisconnect() {}
    async handleRequest() {
      return { ok: true };
    }
    async invokeLocal() {
      return { ok: true };
    }
  },
}));
vi.mock('./changes', () => ({ fetchChanges: vi.fn() }));
vi.mock('@/persistence', () => ({ readLastChangesCursor: vi.fn(), writeLastChangesCursor: vi.fn() }));
vi.mock('./client/loopbackUrl', () => ({ resolveLoopbackHttpUrl: (value: string) => value }));
vi.mock('@/utils/proxy/socketIoProxy', () => ({ getSocketIoProxyOptions: () => ({}) }));
vi.mock('@/utils/time', () => ({ backoff: async <T>(fn: () => Promise<T>) => await fn() }));

describe('ApiMachineClient transports', () => {
  beforeEach(() => {
    mockIo.mockReset();
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.socketIoTransports = ['websocket', 'polling'];
  });

  afterEach(() => {
    configurationMock.apiServerUrl = 'http://localhost:3005';
    configurationMock.socketIoTransports = ['websocket', 'polling'];
  });

  it('uses websocket-first transports by default (fallback to polling)', async () => {
    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['websocket', 'polling']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });

  it('can force websocket-only via config flag', async () => {
    configurationMock.socketIoTransports = ['websocket'];

    const mod = await import('./apiMachine');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    client.connect();

    const opts = mockIo.mock.calls[0]?.[1] as any;
    expect(opts.path).toBe('/v1/updates');
    expect(opts.transports).toEqual(['websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
  });

  it('emits and receives machine transfer envelopes over the machine-scoped socket', async () => {
    const socketHandlers = new Map<string, (...args: any[]) => void>();
    const socketEmit = vi.fn();
    mockIo.mockImplementationOnce(() => ({
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        socketHandlers.set(event, handler);
      }),
      emit: socketEmit,
      emitWithAck: vi.fn(),
      io: { on: vi.fn() },
    }));

    const mod = await import('./apiMachine');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');

    const machine: Machine = {
      id: 'test-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new mod.ApiMachineClient('fake-token', machine);
    const received: unknown[] = [];
    client.onMachineTransferEnvelope((payload) => {
      received.push(payload);
    });
    client.connect();

    client.sendMachineTransferEnvelope({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    socketHandlers.get(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE)?.({
      sourceMachineId: 'machine-source',
      targetMachineId: 'test-machine',
      envelope: {
        transferId: 'transfer_1',
        kind: 'ack',
        nextSequence: 2,
      },
    });

    expect(received).toEqual([
      {
        sourceMachineId: 'machine-source',
        targetMachineId: 'test-machine',
        envelope: {
          transferId: 'transfer_1',
          kind: 'ack',
          nextSequence: 2,
        },
      },
    ]);
  });

});
