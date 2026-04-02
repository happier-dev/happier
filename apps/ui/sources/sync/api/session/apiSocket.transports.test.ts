import { afterEach, describe, expect, it, vi } from 'vitest';

const ioSpy = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioSpy(...args),
}));

function createSocketStub() {
  const socket = {
    connected: false,
    connect: vi.fn(() => {
      socket.connected = true;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onAny: vi.fn(),
    emit: vi.fn(),
    emitWithAck: vi.fn(),
    timeout: vi.fn(() => socket),
  };
  return socket;
}

describe('sync socket transports', () => {
  const previousForceWebsocket = process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET;

  afterEach(() => {
    ioSpy.mockReset();
    vi.resetModules();
    if (previousForceWebsocket === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET;
    else process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET = previousForceWebsocket;
  });

  it('uses the Engine.IO defaults by default (polling then upgrade)', async () => {
    const fakeSocket = createSocketStub();
    ioSpy.mockReturnValue(fakeSocket);

    const { resolveSocketIoTransports } = await import('@/sync/runtime/socketIoTransports');
    const { createSyncSocketTransport } = await import('./connection/createSyncSocketTransport');
    const transports = resolveSocketIoTransports();
    createSyncSocketTransport({ endpoint: 'https://server.example.test', token: 'token-1', transports });

    expect(ioSpy).toHaveBeenCalledWith(
      'https://server.example.test',
      expect.objectContaining({
        path: '/v1/updates/',
      }),
    );
    const opts = ioSpy.mock.calls[0]?.[1] as any;
    expect(opts).not.toHaveProperty('transports');
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
    expect(opts.forceNew).toBe(true);
    expect(opts.multiplex).toBe(false);
  });

  it('does not override transports in web runtimes by default', async () => {
    const fakeSocket = createSocketStub();
    ioSpy.mockReturnValue(fakeSocket);

    (globalThis as any).window = {};
    (globalThis as any).document = {};
    try {
      const { resolveSocketIoTransports } = await import('@/sync/runtime/socketIoTransports');
      const { createSyncSocketTransport } = await import('./connection/createSyncSocketTransport');
      const transports = resolveSocketIoTransports();
      createSyncSocketTransport({ endpoint: 'https://server.example.test', token: 'token-1', transports });

      const opts = ioSpy.mock.calls[0]?.[1] as any;
      expect(opts).not.toHaveProperty('transports');
    } finally {
      delete (globalThis as any).window;
      delete (globalThis as any).document;
    }
  });

  it('can force websocket-only via config flag', async () => {
    process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';

    const fakeSocket = createSocketStub();
    ioSpy.mockReturnValue(fakeSocket);

    const { resolveSocketIoTransports } = await import('@/sync/runtime/socketIoTransports');
    const { createSyncSocketTransport } = await import('./connection/createSyncSocketTransport');
    const transports = resolveSocketIoTransports();
    createSyncSocketTransport({ endpoint: 'https://server.example.test', token: 'token-1', transports });

    const opts = ioSpy.mock.calls[0]?.[1] as any;
    expect(opts.transports).toEqual(['websocket']);
    expect(opts.reconnection).toBe(false);
    expect(opts.autoConnect).toBe(false);
    expect(opts.forceNew).toBe(true);
    expect(opts.multiplex).toBe(false);
  });

  it('normalizes trailing slashes in the socket endpoint before connecting', async () => {
    const fakeSocket = createSocketStub();
    ioSpy.mockReturnValue(fakeSocket);

    const { createSyncSocketTransport } = await import('./connection/createSyncSocketTransport');
    createSyncSocketTransport({ endpoint: 'https://server.example.test/', token: 'token-1' });

    expect(ioSpy).toHaveBeenCalledWith(
      'https://server.example.test',
      expect.objectContaining({
        path: '/v1/updates/',
      }),
    );
  });
});
