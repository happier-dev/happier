import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/api/types';

type Ack = { ok: true; id: string; seq: number; localId: string };

type DelayedSocketStub = {
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
  state: {
    maxInFlight: number;
    inFlight: number;
    pendingResolvers: Array<(ack: Ack) => void>;
  };
  resolveNext: (ack: Ack) => void;
};

function createDelayedSocketStub(): DelayedSocketStub {
  const state: DelayedSocketStub['state'] = {
    maxInFlight: 0,
    inFlight: 0,
    pendingResolvers: [],
  };

  const socket: DelayedSocketStub['socket'] = {
    id: 'sock-1',
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    timeout: vi.fn(function timeout() {
      return socket;
    }),
    emitWithAck: vi.fn((event: string) => {
      if (event !== 'message') {
        return Promise.resolve({ ok: true });
      }

      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);

      return new Promise((resolve) => {
        state.pendingResolvers.push((ack) => {
          state.inFlight -= 1;
          resolve(ack);
        });
      });
    }),
  };

  return {
    socket,
    state,
    resolveNext: (ack) => {
      const next = state.pendingResolvers.shift();
      if (!next) {
        throw new Error('No pending socket ack resolver');
      }
      next(ack);
    },
  };
}

type ImmediateSocketStub = {
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
};

function createImmediateSocketStub(): ImmediateSocketStub {
  const socket: ImmediateSocketStub['socket'] = {
    id: 'sock-2',
    connected: true,
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    timeout: vi.fn(function timeout() {
      return socket;
    }),
    emitWithAck: vi.fn(async () => ({ ok: true })),
  };
  return { socket };
}

let sessionSocketStub: DelayedSocketStub | null = null;
let userSocketStub: ImmediateSocketStub | null = null;

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

describe('ApiSessionClient message commit queue', () => {
  it('serializes best-effort message commits to avoid concurrent socket acks', async () => {
    vi.resetModules();
    sessionSocketStub = createDelayedSocketStub();
    userSocketStub = createImmediateSocketStub();

    const { ApiSessionClient } = await import('./sessionClient');

    const session: Session = {
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

    const client = new ApiSessionClient('tok', session);

    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'a' } as any);
    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'b' } as any);
    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'c' } as any);

    const waitForPending = async (count: number) => {
      const start = Date.now();
      while (sessionSocketStub && sessionSocketStub.state.pendingResolvers.length < count) {
        if (Date.now() - start > 1_000) {
          throw new Error('Timed out waiting for socket ack resolvers');
        }
        await Promise.resolve();
      }
    };

    await waitForPending(1);

    expect(sessionSocketStub.state.maxInFlight).toBe(1);

    sessionSocketStub.resolveNext({ ok: true, id: 'm1', seq: 1, localId: 'l1' });
    await waitForPending(1);

    sessionSocketStub.resolveNext({ ok: true, id: 'm2', seq: 2, localId: 'l2' });
    await waitForPending(1);

    sessionSocketStub.resolveNext({ ok: true, id: 'm3', seq: 3, localId: 'l3' });
  });
});
