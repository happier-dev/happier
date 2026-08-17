import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub,
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
  createManagedConnectionSupervisor: (params: {
    createTransport: () => unknown;
    onConnected?: () => Promise<void> | void;
  }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

type CommitPayload = string | { t: 'plain'; v: unknown };
type CommitSessionMessage = (params: {
  message: CommitPayload;
  localId: string;
  sidechainId: string | null;
  requireCommit: boolean;
}) => Promise<number | null>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function readMessagePayloads(socket: ApiSessionSocketStub): CommitPayload[] {
  return socket.emitWithAck.mock.calls
    .filter((call) => call[0] === 'message')
    .map((call) => (call[1] as { message: CommitPayload }).message);
}

describe('ApiSessionClient transcript revision retry ordering', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.HAPPIER_TRANSCRIPT_STORAGE;
  });

  it.each([
    {
      storageMode: 'plain',
      first: { t: 'plain' as const, v: { revision: 1 } },
      second: { t: 'plain' as const, v: { revision: 2 } },
    },
    {
      storageMode: 'e2ee-re-encrypted',
      first: 'ciphertext-for-revision-1',
      second: 'different-ciphertext-for-revision-2',
    },
  ])('never lets a delayed $storageMode retry overwrite a newer same-localId intent', async ({ first, second }) => {
    vi.resetModules();
    vi.useFakeTimers();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== 'message') return { ok: true };
        const attempt = readMessagePayloads(sessionSocketStub!).length;
        if (attempt <= 2) return null;
        return {
          ok: true,
          id: `message-${attempt}`,
          seq: attempt,
          localId: (payload as { localId: string }).localId,
        };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const commit = (client as unknown as { commitSessionMessage: CommitSessionMessage }).commitSessionMessage.bind(client);

    await commit({ message: first, localId: 'stable-tool-local-id', sidechainId: null, requireCommit: false });
    await commit({ message: second, localId: 'stable-tool-local-id', sidechainId: null, requireCommit: false });
    await vi.advanceTimersByTimeAsync(1_100);

    const sent = readMessagePayloads(sessionSocketStub);
    expect(sent).toEqual([first, second, second]);
  });

  it('does not let an older ACK clear the retry state for a newer generation', async () => {
    vi.resetModules();
    const firstAck = createDeferred<unknown>();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== 'message') return { ok: true };
        const message = (payload as { message: CommitPayload }).message;
        if (message === 'revision-1') return await firstAck.promise;
        return null;
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const commit = (client as unknown as { commitSessionMessage: CommitSessionMessage }).commitSessionMessage.bind(client);

    const firstCommit = commit({ message: 'revision-1', localId: 'stable-tool-local-id', sidechainId: null, requireCommit: false });
    await Promise.resolve();
    const secondCommit = commit({ message: 'revision-2', localId: 'stable-tool-local-id', sidechainId: null, requireCommit: false });
    firstAck.resolve({ ok: true, id: 'old', seq: 1, localId: 'stable-tool-local-id' });
    await firstCommit;
    await secondCommit;

    const retryOwner = (client as unknown as { sessionMessageCommitRetry: { size: number } }).sessionMessageCommitRetry;
    expect(retryOwner.size).toBe(1);
  });

  it('cancels the current retry generation when transcript recovery materializes the localId', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => event === 'message' ? null : { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      deleteMaterializedLocalId(localId: string): void;
      sessionMessageCommitRetry: { size: number };
    };
    await internals.commitSessionMessage.call(client, {
      message: 'revision-1',
      localId: 'recovered-local-id',
      sidechainId: null,
      requireCommit: false,
    });
    expect(internals.sessionMessageCommitRetry.size).toBe(1);

    internals.deleteMaterializedLocalId.call(client, 'recovered-local-id');

    expect(internals.sessionMessageCommitRetry.size).toBe(0);
  });

  it('disposes retry timers before close begins asynchronous drain work', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => event === 'message' ? null : { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const drain = createDeferred<void>();
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      drainBestEffortSessionWrites(): Promise<void>;
      sessionMessageCommitRetry: { size: number };
    };
    await internals.commitSessionMessage.call(client, {
      message: 'revision-1',
      localId: 'closing-local-id',
      sidechainId: null,
      requireCommit: false,
    });
    internals.drainBestEffortSessionWrites = async () => await drain.promise;

    const closePromise = client.close();
    await Promise.resolve();

    expect(internals.sessionMessageCommitRetry.size).toBe(0);
    drain.resolve();
    await closePromise;
  });

  it('does not retain retry state when a required commit fails before any retry is scheduled', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: false, emitWithAckResult: null });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      sessionMessageCommitRetry: { size: number };
    };

    await expect(internals.commitSessionMessage.call(client, {
      message: 'required-revision',
      localId: 'disconnected-required-local-id',
      sidechainId: null,
      requireCommit: true,
    })).rejects.toThrow(/not connected/i);

    expect(internals.sessionMessageCommitRetry.size).toBe(0);
  });

  it('clears retry state when an unconfirmed required direct commit throws without scheduling recovery', async () => {
    vi.resetModules();
    process.env.HAPPIER_TRANSCRIPT_STORAGE = 'direct';
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => event === 'message' ? null : { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const internals = client as unknown as {
      commitSessionMessage: CommitSessionMessage;
      sessionMessageCommitRetry: { size: number };
    };

    await expect(internals.commitSessionMessage.call(client, {
      message: 'required-revision',
      localId: 'unconfirmed-required-local-id',
      sidechainId: null,
      requireCommit: true,
    })).rejects.toThrow(/not confirmed/i);

    expect(internals.sessionMessageCommitRetry.size).toBe(0);
  });

  it('does not resolve close() until pending best-effort transcript commits settle', async () => {
    vi.resetModules();
    const messageAck = createDeferred<{ ok: true; id: string; seq: number; localId: string }>();
    let messageCommitStarted = false;
    let messagePayload: any = null;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
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

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendSessionEvent({ type: 'ready' });
    await vi.waitFor(() => expect(messageCommitStarted).toBe(true));

    let didClose = false;
    const closePromise = client.close().then(() => {
      didClose = true;
    });

    for (let tick = 0; tick < 25; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(didClose).toBe(false);

    messageAck.resolve({ ok: true, id: 'm1', seq: 1, localId: messagePayload.localId });
    await closePromise;
    expect(didClose).toBe(true);
  });
});
