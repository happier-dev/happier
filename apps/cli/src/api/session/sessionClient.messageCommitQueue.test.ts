import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

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

  it('records committed user message seqs by local id from socket acks', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: {
        ok: true,
        id: 'msg-1',
        seq: 42,
        localId: 'user-local-1',
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = trackClient(new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' })));

    const waitingSeq = (client as any).waitForCommittedUserMessageSeq('user-local-1', {
      timeoutMs: 250,
      pollMs: 5,
    });
    await client.sendUserTextMessageCommitted('hello', { localId: 'user-local-1' });

    expect((client as any).getCommittedUserMessageSeq('user-local-1')).toBe(42);
    await expect(waitingSeq).resolves.toBe(42);
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

  it('queues a retry and throws an explicit unsupported confirmation error when persisted ACK-timeout recovery hits an older server', async () => {
    vi.resetModules();
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://adapter.test');
    vi.stubEnv('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', '5');

    const app = fastify({ logger: false });
    app.get('/v2/sessions/:sid/messages/by-local-id/:localId', async (req: any, reply) => (
      reply.code(404).send({
        error: 'Not found',
        path: `/v2/sessions/${req.params.sid}/messages/by-local-id/${req.params.localId}`,
      })
    ));
    await app.ready();
    const restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    let messageAttempts = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== 'message') {
          return { ok: true };
        }
        messageAttempts += 1;
        if (messageAttempts === 1) {
          throw Object.assign(new Error('message ack timed out after 5ms'), {
            code: 'socket_ack_timeout',
            event,
            retryable: true,
            timeoutMs: 5,
          });
        }
        return {
          ok: true,
          id: `m-${messageAttempts}`,
          seq: messageAttempts,
          localId: (payload as { localId?: string }).localId ?? 'l1',
        };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');

      const client = trackClient(new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' })));
      const commitPromise = client.sendUserTextMessageCommitted('hello', { localId: 'persisted-unsupported-1' });

      await expect(commitPromise).rejects.toThrow(
        'Message commit confirmation unsupported by server (ACK timed out and transcript lookup route is unavailable)',
      );

      expect((client as any).pendingMaterializedLocalIds.has('persisted-unsupported-1')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect.poll(() => messageAttempts).toBe(2);
      expect((client as any).committedLocalIdsAwaitingEcho.has('persisted-unsupported-1')).toBe(true);
    } finally {
      restoreAdapter();
      await app.close().catch(() => {});
      vi.unstubAllEnvs();
    }
  });

  it('serializes best-effort message commits to avoid concurrent socket acks', async () => {
    vi.resetModules();
    const delayedSessionSocket = createDelayedSocketStub();
    sessionSocketStub = delayedSessionSocket;
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = trackClient(new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' })));

    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'a' } as any);
    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'b' } as any);
    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'c' } as any);

    const waitForPending = async (count: number) => {
      const start = Date.now();
      while (delayedSessionSocket.state.pendingResolvers.length < count) {
        if (Date.now() - start > 1_000) {
          throw new Error('Timed out waiting for socket ack resolvers');
        }
        await Promise.resolve();
      }
    };

    await waitForPending(1);

    expect(delayedSessionSocket.state.maxInFlight).toBe(1);

    delayedSessionSocket.resolveNext({ ok: true, id: 'm1', seq: 1, localId: 'l1' });
    await waitForPending(1);

    delayedSessionSocket.resolveNext({ ok: true, id: 'm2', seq: 2, localId: 'l2' });
    await waitForPending(1);

    delayedSessionSocket.resolveNext({ ok: true, id: 'm3', seq: 3, localId: 'l3' });
  });

  it('flush waits for queued best-effort transcript commits', async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const messageAck = createDeferred<Ack>();
    let messageCommitStarted = false;
    let messagePayload: any = null;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (event: string, payload: any) => {
        if (event === 'message') {
          messageCommitStarted = true;
          messagePayload = payload;
          return await messageAck.promise;
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = trackClient(new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' })));

      client.sendSessionEvent({ type: 'ready' });

      for (let i = 0; i < 20 && !messageCommitStarted; i += 1) {
        await Promise.resolve();
      }
      expect(messageCommitStarted).toBe(true);
      expect(messagePayload).toEqual(expect.objectContaining({
        messageRole: 'event',
        sessionEventType: 'ready',
      }));

      let didFlush = false;
      const flushPromise = client.flush().then(() => {
        didFlush = true;
      });

      await flushMicrotasks();
      expect(didFlush).toBe(false);

      messageAck.resolve({ ok: true, id: 'm1', seq: 1, localId: 'ready-1' });
      await flushPromise;
      expect(didFlush).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush waits for queued session turn mutation writes', async () => {
    vi.resetModules();
    const originalSocketAckTimeoutMs = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '50';

    const mutationAck = createDeferred<{ ok: true }>();
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

      await client.enqueueSessionTurnMutation({
        v: 1,
        sessionId: 's1',
        mutationId: 'mutation-complete',
        action: 'complete',
        turnId: 'turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        observedAt: 123,
      });

      let didFlush = false;
      const flushPromise = client.flush().then(() => {
        didFlush = true;
      });

      await flushMicrotasks();
      expect(sessionTurnMutationPayload).toEqual(expect.objectContaining({
        v: 1,
        sessionId: 's1',
        mutationId: 'mutation-complete',
        action: 'complete',
        turnId: 'turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
      }));
      expect(didFlush).toBe(false);

      mutationAck.resolve({ ok: true });
      await flushPromise;
      expect(didFlush).toBe(true);
    } finally {
      if (originalSocketAckTimeoutMs === undefined) {
        delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = originalSocketAckTimeoutMs;
      }
    }
  });
});
