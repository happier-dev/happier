import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/api/types';

type SocketStub = {
  socket: {
    id: string;
    connected: boolean;
    on: (event: string, handler: (...args: any[]) => void) => void;
    off: (event: string, handler?: (...args: any[]) => void) => void;
    close: () => void;
    connect: () => void;
    disconnect: () => void;
    emit: (...args: any[]) => void;
    timeout: (ms: number) => any;
    emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
  };
  emit: (event: string, ...args: any[]) => void;
  calls: {
    connect: number;
    disconnect: number;
  };
};

function createSocketStub(params: { id: string; connected: boolean }): SocketStub {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const calls = { connect: 0, disconnect: 0 };
  const state = { connected: params.connected };

  const emit = (event: string, ...args: any[]) => {
    const set = handlers.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      handler(...args);
    }
  };

  const socket: SocketStub['socket'] = {
    id: params.id,
    get connected() {
      return state.connected;
    },
    set connected(value: boolean) {
      state.connected = value;
    },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const set = handlers.get(event) ?? new Set<(...args: any[]) => void>();
      set.add(handler);
      handlers.set(event, set);
      return socket;
    }),
    off: vi.fn((event: string, handler?: (...args: any[]) => void) => {
      if (!handler) {
        handlers.delete(event);
        return socket;
      }
      const set = handlers.get(event);
      set?.delete(handler);
      if (set && set.size === 0) handlers.delete(event);
      return socket;
    }),
    close: vi.fn(() => {
      state.connected = false;
      emit('disconnect', 'io client disconnect');
    }),
    connect: vi.fn(() => {
      calls.connect += 1;
      state.connected = true;
      emit('connect');
    }),
    disconnect: vi.fn(() => {
      calls.disconnect += 1;
      state.connected = false;
      emit('disconnect', 'io client disconnect');
    }),
    emit: vi.fn(),
    timeout: vi.fn(function timeout() {
      return socket;
    }),
    emitWithAck: vi.fn(async () => ({ ok: true })),
  };

  return { socket, emit, calls };
}

let sessionSocketStub: SocketStub | null = null;
let userSocketStub: SocketStub | null = null;

vi.mock('./sockets', () => ({
  createSessionScopedSocket: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return sessionSocketStub.socket as any;
  },
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub.socket as any;
  },
}));

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: vi.fn(async () => {}),
}));

describe('ApiSessionClient user socket lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createSession(): Session {
    return {
      id: 's1',
      seq: 0,
      encryptionMode: 'plain',
      encryptionKey: new Uint8Array([1, 2, 3]),
      encryptionVariant: 'legacy',
      metadata: {
        path: '/tmp',
        host: 'test',
        homeDir: '/home/test',
        happyHomeDir: '/home/test/.happier',
        happyLibDir: '/home/test/.happier/lib',
        happyToolsDir: '/home/test/.happier/tools',
      },
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
    };
  }

  it('connects the user-scoped socket when agent user-message callback attaches', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({ id: 'session-socket', connected: true });
    userSocketStub = createSocketStub({ id: 'user-socket', connected: false });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createSession());

    expect(userSocketStub.calls.connect).toBe(0);
    client.onUserMessage(() => {});
    expect(userSocketStub.calls.connect).toBe(1);

    await client.close();
  });

  it('keeps the user-scoped socket connected while a user-message callback is attached', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({ id: 'session-socket', connected: true });
    userSocketStub = createSocketStub({ id: 'user-socket', connected: false });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createSession());
    client.onUserMessage(() => {});

    const abortController = new AbortController();
    const waitPromise = client.waitForMetadataUpdate(abortController.signal);
    abortController.abort();
    await waitPromise;

    await vi.advanceTimersByTimeAsync(2_100);

    expect(userSocketStub.calls.disconnect).toBe(0);

    await client.close();
  });
});
