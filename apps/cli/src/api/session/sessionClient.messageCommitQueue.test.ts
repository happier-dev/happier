import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
  createSessionTurnMutationAppliedSocketAck,
} from '@/testkit/backends/apiSessionSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';

type Ack = { ok: true; id: string; seq: number; localId: string };

type DelayedSocketStub = ApiSessionSocketStub & {
  state: {
    maxInFlight: number;
    inFlight: number;
    pendingResolvers: Array<(ack: Ack) => void>;
  };
  resolveNext: (ack: Ack) => void;
};

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}>;

function createDelayedSocketStub(): DelayedSocketStub {
  const state = {
    maxInFlight: 0,
    inFlight: 0,
    pendingResolvers: [] as Array<(ack: Ack) => void>,
  };

  return Object.assign(
    createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        if (event !== 'message') {
          return { ok: true };
        }

        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);

        return new Promise((resolve) => {
          state.pendingResolvers.push((ack) => {
            state.inFlight -= 1;
            resolve(ack);
          });
        });
      },
    }),
    {
      state,
      resolveNext: (ack: Ack) => {
        const next = state.pendingResolvers.shift();
        if (!next) {
          throw new Error('No pending socket ack resolver');
        }
        next(ack);
      },
    },
  );
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const supervisorStartMock = vi.hoisted(() => vi.fn());
const openClients: Array<{ close: () => Promise<void> }> = [];

function trackClient<T extends { close: () => Promise<void> }>(client: T): T {
  openClients.push(client);
  return client;
}

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      supervisorStartMock();
      params.createTransport();
      await params.onConnected?.();
    },
    getState: () => ({ phase: 'online' }),
    stop: async () => {},
  }),
}));

describe('ApiSessionClient message commit queue', () => {
  afterEach(async () => {
    const clients = openClients.splice(0);
    await Promise.allSettled(clients.map((client) => client.close()));
    sessionSocketStub = null;
    userSocketStub = null;
    vi.clearAllMocks();
  });

  it('records committed user message seqs by local id from transcript echoes', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = trackClient(new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' })));

    sessionSocketStub.trigger('update', {
      id: 'update-1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'msg-echo-1',
          seq: 57,
          localId: 'echo-local-1',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'echo' },
              meta: { sentFrom: 'cli' },
            },
          },
        },
      },
    });

    expect((client as any).getCommittedUserMessageSeq('echo-local-1')).toBe(57);
  });

  it('flush waits for queued session turn mutation writes', async () => {
    vi.resetModules();
    const originalSocketAckTimeoutMs = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '50';

    const mutationAck = createDeferred<unknown>();
    let sessionTurnMutationPayload: unknown = null;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (event: string, payload: any) => {
        if (event === 'session-turn-mutation') {
          sessionTurnMutationPayload = payload;
          return await mutationAck.promise;
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = trackClient(new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' })));
      await flushMicrotasks();

      const enqueuePromise = client.enqueueSessionTurnMutation({
        v: 1,
        sessionId: 's1',
        mutationId: 'mutation-complete',
        action: 'complete',
        turnId: 'turn-1',
        agentId: 'codex',
        agentTurnId: 'turn-1',
        observedAt: 123,
      });

      await vi.waitFor(() => {
        expect(sessionTurnMutationPayload).not.toBeNull();
      }, { timeout: 5_000 });

      let didFlush = false;
      const flushPromise = client.flush().then(() => {
        didFlush = true;
      });

      expect(sessionTurnMutationPayload).toEqual(expect.objectContaining({
        v: 1,
        sessionId: 's1',
        mutationId: 'mutation-complete',
        action: 'complete',
        turnId: 'turn-1',
        agentId: 'codex',
        agentTurnId: 'turn-1',
      }));
      expect(didFlush).toBe(false);

      mutationAck.resolve(createSessionTurnMutationAppliedSocketAck(
        sessionTurnMutationPayload as SessionTurnMutationV1,
      ));
      await Promise.all([enqueuePromise, flushPromise]);
      expect(didFlush).toBe(true);
    } finally {
      mutationAck.resolve(createSessionTurnMutationAppliedSocketAck(
        sessionTurnMutationPayload as SessionTurnMutationV1,
      ));
      if (originalSocketAckTimeoutMs === undefined) {
        delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = originalSocketAckTimeoutMs;
      }
    }
  });
});
