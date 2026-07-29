import { beforeEach, describe, expect, it, vi } from 'vitest';

const ioMock = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

import {
  createMachineScopedSocketCollector,
  createSessionScopedSocketCollector,
  createUserScopedSocketCollector,
} from './socketClient';

describe('socketClient collector construction', () => {
  beforeEach(() => {
    ioMock.mockReset();
    ioMock.mockReturnValue({
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck: vi.fn() })),
    });
  });

  it('passes an explicit connect timeout through to user-scoped collectors', () => {
    createUserScopedSocketCollector('http://127.0.0.1:3000', 'token-1', {
      transports: ['websocket'],
      connectTimeoutMs: 65_000,
    });

    expect(ioMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000',
      expect.objectContaining({
        timeout: 65_000,
      }),
    );
  });

  it('passes an explicit connect timeout through to session-scoped collectors', () => {
    createSessionScopedSocketCollector('http://127.0.0.1:3000', 'token-1', 'session-1', 'machine-1', {
      transports: ['websocket'],
      connectTimeoutMs: 65_000,
    });

    expect(ioMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000',
      expect.objectContaining({
        timeout: 65_000,
      }),
    );
  });

  it('constructs machine-scoped collectors with exact machine identity', () => {
    createMachineScopedSocketCollector('http://127.0.0.1:3000', 'token-1', 'machine-1', {
      transports: ['websocket'],
      connectTimeoutMs: 65_000,
    });

    expect(ioMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000',
      expect.objectContaining({
        auth: {
          token: 'token-1',
          clientType: 'machine-scoped',
          machineId: 'machine-1',
        },
        timeout: 65_000,
      }),
    );
  });

  it('forwards the caller timeout to both Socket.IO and the server RPC forwarder', async () => {
    const emitWithAck = vi.fn(async () => ({ ok: true }));
    const timeout = vi.fn(() => ({ emitWithAck }));
    ioMock.mockReturnValue({
      connected: true,
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      timeout,
    });
    const collector = createUserScopedSocketCollector(
      'http://127.0.0.1:3000',
      'token-1',
    );

    await collector.rpcCall('machine-1:daemon.long-running', 'encrypted', 300_000);

    expect(timeout).toHaveBeenCalledWith(300_000);
    expect(emitWithAck).toHaveBeenCalledWith(
      'rpc-call',
      {
        method: 'machine-1:daemon.long-running',
        params: 'encrypted',
        timeoutMs: 300_000,
      },
    );
  });

  it('retains a bounded ordered socket connectivity history', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      connected: false,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn(),
      emit: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck: vi.fn() })),
    };
    ioMock.mockReturnValue(socket);
    const collector = createUserScopedSocketCollector(
      'http://127.0.0.1:3000',
      'token-1',
    );

    for (let index = 0; index < 18; index += 1) {
      listeners.get(index % 2 === 0 ? 'connect' : 'disconnect')?.(
        'transport close',
      );
    }
    socket.connected = true;

    const state = collector.getConnectivityState();
    expect(state.connected).toBe(true);
    expect(state.totalTransitionCount).toBe(18);
    expect(state.transitions).toHaveLength(16);
    expect(state.transitions[0]).toMatchObject({
      sequence: 3,
      kind: 'connect',
    });
    expect(state.transitions.at(-1)).toMatchObject({
      sequence: 18,
      kind: 'disconnect',
      reason: 'transport close',
    });
  });
});
