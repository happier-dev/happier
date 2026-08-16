import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

type Ack = { ok: true; id: string; seq: number; localId: string; didWrite?: boolean };

type CommittedUserMessageSeqApi = {
  getCommittedUserMessageSeq: (localId: string) => number | null;
  waitForCommittedUserMessageSeq: (
    localId: string,
    opts?: { timeoutMs?: number },
  ) => Promise<number | null>;
};

type DelayedSocketStub = ApiSessionSocketStub & {
  state: {
    maxInFlight: number;
    inFlight: number;
    pendingResolvers: Array<(ack: Ack) => void>;
  };
  resolveNext: (ack: Ack) => void;
};

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

function createDeferred<T>() {
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

function expectCommittedUserMessageSeqApi(client: unknown): asserts client is CommittedUserMessageSeqApi {
  expect(typeof (client as Partial<CommittedUserMessageSeqApi>).getCommittedUserMessageSeq).toBe('function');
  expect(typeof (client as Partial<CommittedUserMessageSeqApi>).waitForCommittedUserMessageSeq).toBe('function');
}

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
let supervisorStartCount = 0;
let materializeNextPendingQueueV2MessageStub: null | (() => Promise<unknown>) = null;
let listPendingQueueV2LocalIdsFromServerStub: null | (() => Promise<string[]>) = null;
let fetchSessionSnapshotUpdateFromServerStub: null | (() => Promise<unknown>) = null;

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
      supervisorStartCount += 1;
      params.createTransport();
      await params.onConnected?.();
    },
    getState: () => ({ phase: 'online' }),
    stop: async () => {},
  }),
}));

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: async (...args: Parameters<typeof actual.materializeNextPendingQueueV2Message>) => {
      if (materializeNextPendingQueueV2MessageStub) {
        return await materializeNextPendingQueueV2MessageStub();
      }
      return await actual.materializeNextPendingQueueV2Message(...args);
    },
    listPendingQueueV2LocalIdsFromServer: async (...args: Parameters<typeof actual.listPendingQueueV2LocalIdsFromServer>) => {
      if (listPendingQueueV2LocalIdsFromServerStub) {
        return await listPendingQueueV2LocalIdsFromServerStub();
      }
      return await actual.listPendingQueueV2LocalIdsFromServer(...args);
    },
  };
});

vi.mock('./snapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshotSync')>();
  return {
    ...actual,
    fetchSessionSnapshotUpdateFromServer: async (...args: Parameters<typeof actual.fetchSessionSnapshotUpdateFromServer>) => {
      if (fetchSessionSnapshotUpdateFromServerStub) {
        return await fetchSessionSnapshotUpdateFromServerStub();
      }
      return await actual.fetchSessionSnapshotUpdateFromServer(...args);
    },
  };
});

describe('ApiSessionClient message commit queue', () => {
  it('persists turn_failed as failed session turn runtime state', async () => {
    vi.resetModules();
    const runtimeStateUpdates: unknown[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: any) => {
        if (event === 'session-turn-mutation') {
          runtimeStateUpdates.push(payload);
          return { ok: true };
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode' as any, { type: 'task_started', id: 'turn-1' } as any);
    client.sendAgentMessage('opencode' as any, {
      type: 'turn_failed',
      id: 'turn-1',
      issue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'opencode_idle_without_terminal_assistant',
        source: 'stream_error',
        occurredAt: 123,
        provider: 'opencode',
        providerTurnId: 'turn-1',
        sanitizedPreview: 'OpenCode became idle without producing a completed assistant message.',
      },
    } as any);

    await expect.poll(() => runtimeStateUpdates).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        providerTurnId: 'turn-1',
        action: 'begin',
        turnId: expect.any(String),
      }),
      expect.objectContaining({
        provider: 'opencode',
        providerTurnId: 'turn-1',
        action: 'fail',
        turnId: expect.any(String),
        issue: expect.objectContaining({
          status: 'failed',
          code: 'opencode_idle_without_terminal_assistant',
          providerTurnId: 'turn-1',
        }),
      }),
    ]);
    expect((runtimeStateUpdates[0] as { turnId?: unknown }).turnId).not.toBe('turn-1');
    expect((runtimeStateUpdates[1] as { turnId?: unknown }).turnId).toBe((runtimeStateUpdates[0] as { turnId?: unknown }).turnId);
    await client.close();
  });

  it('requests reconnect when message commits queue while disconnected', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await expect.poll(() => supervisorStartCount).toBe(1);

    client.sendAgentMessage('claude' as any, { type: 'message', message: 'FAKE_CLAUDE_OK_2' } as any);

    await expect.poll(() => supervisorStartCount).toBeGreaterThan(1);
  });

  it('redacts socket commit errors before logging', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async () => {
        throw new Error(
          'ack failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/messages?token=secret Authorization: Bearer SOCKET_SECRET',
        );
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { logger: runtimeLogger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(runtimeLogger, 'debug').mockImplementation(() => {});

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      client.sendAgentMessage('claude' as any, { type: 'message', message: 'hello' } as any, { localId: 'log-redaction-1' });

      await expect.poll(() => debugSpy.mock.calls.some(([message]) =>
        message === '[SOCKET] Persisted transcript commit ack failed'
      )).toBe(true);
      const [, logged] = debugSpy.mock.calls.find(([message]) =>
        message === '[SOCKET] Persisted transcript commit ack failed'
      ) ?? [];
      expect(logged).toEqual(expect.objectContaining({
        error: expect.objectContaining({
          name: 'Error',
          message: 'ack failed for https://api.example.test/v1/messages Authorization: <redacted>',
        }),
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('SOCKET_SECRET');
      expect(JSON.stringify(logged)).not.toContain('stack');
      await client.close();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('redacts usage report errors before logging', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emit: (event: string) => {
        if (event === 'usage-report') {
          throw new Error(
            'usage failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/usage?token=secret Authorization: Bearer USAGE_SECRET',
          );
        }
      },
      emitWithAck: async (_event: string, payload: any) => {
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { logger: runtimeLogger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(runtimeLogger, 'debug').mockImplementation(() => {});

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      client.sendAgentMessage('opencode' as any, { type: 'token_count', tokens: { total: 1 } } as any, { localId: 'usage-redaction-1' });

      await expect.poll(() => debugSpy.mock.calls.some(([message]) =>
        message === '[SOCKET] Failed to send token_count usage report (non-fatal)'
      )).toBe(true);
      const [, logged] = debugSpy.mock.calls.find(([message]) =>
        message === '[SOCKET] Failed to send token_count usage report (non-fatal)'
      ) ?? [];
      expect(logged).toEqual(expect.objectContaining({
        name: 'Error',
        message: 'usage failed for https://api.example.test/v1/usage Authorization: <redacted>',
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('USAGE_SECRET');
      expect(JSON.stringify(logged)).not.toContain('stack');
      await client.close();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('preserves computed event roles for queued reconnect commits', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (_event: string, payload: any) => {
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendAgentMessage('opencode' as any, { type: 'turn_failed', id: 'turn-1' } as any, { localId: 'queued-event-1' });

    await expect.poll(() => (client as any).queuedDisconnectedSessionMessages.get('queued-event-1')?.messageRole).toBe('event');

    sessionSocketStub.connected = true;
    await (client as any).flushQueuedSessionMessagesOnReconnect();
    await client.flush();

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        localId: 'queued-event-1',
        messageRole: 'event',
      }),
    );
    await client.close();
  });

  it('keeps best-effort commits paced while required commits bypass their ack backlog', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const firstBestEffort = createDeferred<void>();
    const secondBestEffort = createDeferred<void>();
    const required = createDeferred<void>();
    const dispatched: string[] = [];
    const enqueue = (client as unknown as {
      enqueueMessageCommit: (
        delivery: 'best-effort' | 'required',
        context: { operation: string; details: { requireCommit: boolean } },
        fn: () => Promise<void>,
      ) => Promise<void>;
    }).enqueueMessageCommit.bind(client) as (
      delivery: 'best-effort' | 'required',
      context: { operation: string; details: { requireCommit: boolean } },
      fn: () => Promise<void>,
    ) => Promise<void>;

    const firstBestEffortCommit = enqueue('best-effort', {
      operation: 'best-effort-1',
      details: { requireCommit: false },
    }, async () => {
      dispatched.push('best-effort-1');
      await firstBestEffort.promise;
    });
    const secondBestEffortCommit = enqueue('best-effort', {
      operation: 'best-effort-2',
      details: { requireCommit: false },
    }, async () => {
      dispatched.push('best-effort-2');
      await secondBestEffort.promise;
    });
    const requiredCommit = enqueue('required', {
      operation: 'required',
      details: { requireCommit: true },
    }, async () => {
      dispatched.push('required');
      await required.promise;
    });

    await vi.waitFor(() => {
      expect(dispatched).toEqual(['best-effort-1', 'required']);
    });

    firstBestEffort.resolve();
    await expect(firstBestEffortCommit).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(dispatched).toEqual(['best-effort-1', 'required', 'best-effort-2']);
    });

    required.resolve();
    secondBestEffort.resolve();
    await expect(requiredCommit).resolves.toBeUndefined();
    await expect(secondBestEffortCommit).resolves.toBeUndefined();
  }, 60_000);

  it('records committed user message seqs from commit acks', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 42, localId: 'prompt-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    expectCommittedUserMessageSeqApi(client);

    const waiter = client.waitForCommittedUserMessageSeq('prompt-1', { timeoutMs: 1_000 });
    await client.sendUserTextMessageCommitted('hello', { localId: 'prompt-1' });

    await expect(waiter).resolves.toBe(42);
    expect(client.getCommittedUserMessageSeq('prompt-1')).toBe(42);
  });

  it('awaits caller-identified Codex transcript custody and reports an idempotent duplicate', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    const firstAck = createDeferred<Ack>();
    const messagePayloads: any[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: any) => {
        if (event !== 'message') return { ok: true };
        messagePayloads.push(payload);
        if (messagePayloads.length === 1) return await firstAck.promise;
        return { ok: true, id: 'message-1', seq: 41, localId: payload.localId, didWrite: false };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const exactClient = client;
    expect(typeof exactClient.sendCodexMessageCommitted).toBe('function');

    let firstResolved = false;
    const firstCommit = Promise.resolve().then(() => exactClient.sendCodexMessageCommitted(
      { type: 'tool-call', callId: 'call-1', name: 'Bash', input: { cmd: 'pwd' } },
      { localId: 'rollout-effect-1' },
    )).then((result) => {
      firstResolved = true;
      return result;
    });
    await flushMicrotasks();

    expect(firstResolved).toBe(false);
    expect(messagePayloads[0]).toEqual(expect.objectContaining({ localId: 'rollout-effect-1' }));

    firstAck.resolve({ ok: true, id: 'message-1', seq: 41, localId: 'rollout-effect-1', didWrite: true });
    await expect(firstCommit).resolves.toEqual({
      localId: 'rollout-effect-1',
      messageId: 'message-1',
      seq: 41,
      didWrite: true,
    });

    await expect(exactClient.sendCodexMessageCommitted(
      { type: 'tool-call', callId: 'call-1', name: 'Bash', input: { cmd: 'pwd' } },
      { localId: 'rollout-effect-1' },
    )).resolves.toEqual({
      localId: 'rollout-effect-1',
      messageId: 'message-1',
      seq: 41,
      didWrite: false,
    });
    expect(messagePayloads.map((payload) => payload.localId)).toEqual([
      'rollout-effect-1',
      'rollout-effect-1',
    ]);
  });

  it('commits recovered Claude history through the durable transcript-observation outbox', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    const firstAck = createDeferred<unknown>();
    const messagePayloads: any[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: any) => {
        if (event === 'transcript-observation-capability-v1') {
          return { ok: true, capability: 'session-transcript-observation-v1' };
        }
        if (event !== 'transcript-observation-v1') return { ok: true };
        messagePayloads.push(payload);
        if (messagePayloads.length === 1) return await firstAck.promise;
        return {
          ok: true,
          status: 'observed',
          id: 'claude-message-1',
          seq: 43,
          localId: payload.localId,
          didWrite: false,
          ingestedAt: 1,
        };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
      capabilities: {
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: 1 },
        },
      },
    }), { status: 200 })));

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      metadata: createTestMetadata({ machineId: 'machine-1' }),
    }));
    await expect.poll(
      () => (client as any).sessionSyncPendingInputServerContract?.pendingInput,
    ).toBe('v1');
    const message = {
      type: 'assistant' as const,
      uuid: 'claude-assistant-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'caught up' }] },
    };

    let commitResolved = false;
    const observation = {
      createdAt: 1_754_301_600_000,
      updatedAt: 1_754_301_600_000,
      provenance: { kind: 'non_dependent' as const, source: 'history' as const },
    };
    const commit = Promise.resolve().then(() => client.sendClaudeSessionMessageCommitted(message, observation)).then((result) => {
      commitResolved = true;
      return result;
    });
    await expect.poll(() => messagePayloads.length).toBe(1);

    expect(commitResolved).toBe(false);
    expect(messagePayloads[0]).toEqual(expect.objectContaining({
      localId: 'claude-jsonl:main:assistant:claude-assistant-1',
      messageRole: 'agent',
      createdAt: observation.createdAt,
      updatedAt: observation.updatedAt,
      provenance: observation.provenance,
    }));

    firstAck.resolve({
      ok: true,
      status: 'observed',
      id: 'claude-message-1',
      seq: 43,
      localId: 'claude-jsonl:main:assistant:claude-assistant-1',
      didWrite: true,
      ingestedAt: 1,
    });
    await expect(commit).resolves.toEqual({
      persisted: true,
      delivered: true,
    });

    await expect(client.sendClaudeSessionMessageCommitted(message, observation)).resolves.toEqual({
      persisted: true,
      delivered: true,
    });
    await client.close();
    vi.unstubAllGlobals();
  });

  it('fails closed for exact session-event ACKs with missing disposition or mismatched identity', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    const messagePayloads: any[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: any) => {
        if (event !== 'message') return { ok: true };
        messagePayloads.push(payload);
        if (messagePayloads.length === 1) {
          return { ok: true, id: 'event-message-1', seq: 51, localId: payload.localId };
        }
        if (messagePayloads.length === 2) {
          return { ok: true, id: 'event-message-1', seq: 51, localId: 'wrong-effect-id', didWrite: false };
        }
        return { ok: true, id: 'event-message-1', seq: 51, localId: payload.localId, didWrite: false };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const exactClient = client;

    await expect(Promise.resolve().then(() => exactClient.sendSessionEventCommitted(
      { type: 'context-compaction', phase: 'completed' },
      { localId: 'rollout-event-1' },
    ))).rejects.toThrow('didWrite');

    await expect(exactClient.sendSessionEventCommitted(
      { type: 'context-compaction', phase: 'completed' },
      { localId: 'rollout-event-1' },
    )).rejects.toThrow('localId mismatch');

    await expect(exactClient.sendSessionEventCommitted(
      { type: 'context-compaction', phase: 'completed' },
      { localId: 'rollout-event-1' },
    )).resolves.toEqual({
      localId: 'rollout-event-1',
      messageId: 'event-message-1',
      seq: 51,
      didWrite: false,
    });
    expect(messagePayloads).toHaveLength(3);
    expect(messagePayloads[2]).toEqual(expect.objectContaining({
      localId: 'rollout-event-1',
      messageRole: 'event',
    }));
    expect(messagePayloads[2].message).toEqual({
      t: 'plain',
      v: expect.objectContaining({
        content: expect.objectContaining({ id: 'rollout-event-1', type: 'event' }),
      }),
    });
  });

  it('queues a retry and throws an explicit unsupported confirmation error when persisted ACK-timeout recovery hits an older server', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
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
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      const commitPromise = client.sendUserTextMessageCommitted('hello', { localId: 'persisted-unsupported-1' });

      await expect(commitPromise).rejects.toThrow(
        'Message commit confirmation unsupported by server (ACK timed out and transcript lookup route is unavailable)',
      );

      expect((client as any).pendingMaterializedLocalIds.has('persisted-unsupported-1')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect.poll(() => messageAttempts).toBe(2);
      expect((client as any).committedLocalIdsAwaitingEcho.has('persisted-unsupported-1')).toBe(true);
      await client.close();
    } finally {
      restoreAdapter();
      await app.close().catch(() => {});
    }
  });

  it('records committed user message seqs from user transcript echoes', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    expectCommittedUserMessageSeqApi(client);

    const waiter = client.waitForCommittedUserMessageSeq('steer-1', { timeoutMs: 1_000 });
    userSocketStub.trigger('update', {
      id: 'u1',
      seq: 7,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm7',
          seq: 7,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'steer' },
              localId: 'steer-1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          localId: 'steer-1',
          messageRole: 'user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    await expect(waiter).resolves.toBe(7);
    expect(client.getCommittedUserMessageSeq('steer-1')).toBe(7);
  });

  it('records committed user message seqs from pending queue materialization acks', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
      capabilities: {
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: 1 },
        },
      },
    }), { status: 200 })));
    materializeNextPendingQueueV2MessageStub = async () => ({
      didMaterialize: true,
      localId: 'pending-user-1',
      didWrite: true,
      message: {
        seq: 55,
        localId: 'pending-user-1',
        messageRole: 'user',
      },
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        metadata: createTestMetadata({ machineId: 'machine-1' }),
        pendingCount: 1,
        pendingVersion: 1,
      }));
      await expect.poll(
        () => (client as any).sessionSyncPendingInputServerContract?.pendingInput,
      ).toBe('v1');
      expectCommittedUserMessageSeqApi(client);

      await expect(client.popPendingMessage()).resolves.toBe(true);
      expect(client.getCommittedUserMessageSeq('pending-user-1')).toBe(55);
    } finally {
      materializeNextPendingQueueV2MessageStub = null;
      vi.unstubAllGlobals();
    }
  });

  it('reconciles authoritative pending state before treating known-zero pending count as empty', async () => {
    vi.resetModules();
    supervisorStartCount = 0;
    fetchSessionSnapshotUpdateFromServerStub = async () => ({
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 6,
      },
    });
    listPendingQueueV2LocalIdsFromServerStub = async () => ['pending-user-1'];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        pendingCount: 0,
        pendingVersion: 5,
      }));

      await expect(client.peekPendingMessageQueueV2Count()).resolves.toBe(1);
      expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    } finally {
      fetchSessionSnapshotUpdateFromServerStub = null;
      listPendingQueueV2LocalIdsFromServerStub = null;
    }
  });

  it('returns null when a committed user message seq is not observed before timeout', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    supervisorStartCount = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ack-1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      expectCommittedUserMessageSeqApi(client);

      const waiter = client.waitForCommittedUserMessageSeq('missing-1', { timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);

      await expect(waiter).resolves.toBeNull();
      expect(client.getCommittedUserMessageSeq('missing-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush waits for queued best-effort transcript commits', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    supervisorStartCount = 0;

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
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

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

  it('flush waits for queued session turn runtime state updates', async () => {
    vi.resetModules();
    supervisorStartCount = 0;

    const projectionAck = createDeferred<{ ok: true }>();
    let runtimeStatePayload: unknown = null;
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
          runtimeStatePayload = payload;
          return await projectionAck.promise;
        }
        return { ok: true, id: 'm1', seq: 1, localId: payload?.localId ?? 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex' as any, { type: 'task_started', id: 'turn-1' } as any);
    client.sendAgentMessage('codex' as any, { type: 'task_complete', id: 'turn-1' } as any);

    await expect.poll(() => runtimeStatePayload).toEqual(expect.objectContaining({
      provider: 'codex',
      providerTurnId: 'turn-1',
      action: 'begin',
      turnId: expect.any(String),
    }));

    let didFlush = false;
    const flushPromise = client.flush().then(() => {
      didFlush = true;
    });

    await flushMicrotasks();
    expect(didFlush).toBe(false);

    projectionAck.resolve({ ok: true });
    await flushPromise;
    expect(didFlush).toBe(true);
    await client.close();
  });

  it('does not reset a message commit retry budget across reconnect flushes', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    let emitted = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        if (event === 'message') {
          emitted += 1;
          return null;
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      const commitQueueAccess = client as unknown as {
        commitSessionMessage(params: {
          message: { t: 'plain'; v: unknown };
          localId: string;
          sidechainId: string | null;
          messageRole: 'agent';
          requireCommit: false;
        }): Promise<unknown>;
        flushQueuedSessionMessagesOnReconnect(): Promise<void>;
      };

      await commitQueueAccess.commitSessionMessage({
        message: { t: 'plain', v: { revision: 1 } },
        localId: 'bounded-reconnect-local-id',
        sidechainId: null,
        messageRole: 'agent',
        requireCommit: false,
      });

      for (let reconnect = 0; reconnect < 6; reconnect += 1) {
        sessionSocketStub.connected = false;
        await vi.runOnlyPendingTimersAsync();
        sessionSocketStub.connected = true;
        await commitQueueAccess.flushQueuedSessionMessagesOnReconnect();
      }

      expect(emitted).toBe(4);
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
