import { describe, expect, it, vi } from 'vitest';

const writeLastChangesCursor = vi.fn(async () => {});
const readLastChangesCursor = vi.fn(async () => 0);

vi.mock('@/persistence', () => ({ writeLastChangesCursor, readLastChangesCursor }));

class FakeSocket {
  connected = false;
  handlers = new Map<string, (...args: unknown[]) => void>();
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  emit() {}
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

const sessionScopedSockets: FakeSocket[] = [];
const userScopedSockets: FakeSocket[] = [];

vi.mock('./session/sockets', () => ({
  createSessionScopedSocket: () => {
    const socket = new FakeSocket();
    sessionScopedSockets.push(socket);
    return socket;
  },
  createUserScopedSocket: () => {
    const socket = new FakeSocket();
    userScopedSockets.push(socket);
    return socket;
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

vi.mock('./rpc/handlerManager', () => ({
  RpcHandlerManager: class {
    onSocketConnect() {}
    onSocketDisconnect() {}
    async handleRequest() {
      return '';
    }
  },
}));

vi.mock('./session/handlers', () => ({
  registerSessionHandlers: vi.fn(),
}));

describe('ApiSessionClient changesCursor isolation', () => {
  it('does not persist /v2/changes cursor from socket updates', async () => {
    const { ApiSessionClient } = await import('./session/sessionClient');

    const client = new ApiSessionClient('tok', {
      id: 's1',
      metadata: { path: '/tmp', flavor: 'codex' },
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      encryptionKey: new Uint8Array([1, 2, 3]),
      encryptionVariant: 'v1',
    } as any);

    const userScopedUpdateHandler = userScopedSockets.at(-1)?.handlers.get('update');
    expect(userScopedUpdateHandler).toBeTypeOf('function');

    userScopedUpdateHandler?.(
      { id: 'upd-1', seq: 999, createdAt: 1, body: { t: 'update-machine', machineId: 'm1' } },
    );

    expect(writeLastChangesCursor).not.toHaveBeenCalled();
    await client.close();
  }, 20_000);
});
