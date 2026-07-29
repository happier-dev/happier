import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const fetchSessionByIdCompatMock = vi.hoisted(() => vi.fn());

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
        destroy: async () => {
          sessionSocketStub?.close();
        },
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
    createTransport: () => { destroy?: () => Promise<void> | void };
    onConnected?: () => Promise<void> | void;
  }) => {
    let transport: { destroy?: () => Promise<void> | void } | null = null;
    return {
      start: async () => {
        transport = params.createTransport();
        await params.onConnected?.();
      },
      stop: async () => {
        await transport?.destroy?.();
      },
    };
  },
}));

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: vi.fn(async () => {}),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
  return {
    ...actual,
    fetchSessionByIdCompat: fetchSessionByIdCompatMock,
  };
});

describe('ApiSessionClient user socket lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSessionByIdCompatMock.mockReset();
  });

  it('connects the user-scoped socket when agent user-message callback attaches', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
    userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    expect(userSocketStub.connect).toHaveBeenCalledTimes(0);
    client.onUserMessage(() => {});
    await Promise.resolve();
    expect(userSocketStub.connect).toHaveBeenCalledTimes(1);

    await client.close();
  });

  it('closes the exact session publisher before disconnecting the session socket', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      id: 'session-socket',
      connected: true,
      emitWithAckResult: { status: 'closed', sessionId: 's1' },
    });
    userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await client.close();

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'session-runtime-activity-close',
      { sessionId: 's1' },
    );
    const closeRequestOrder = sessionSocketStub.emitWithAck.mock.invocationCallOrder.at(-1) ?? 0;
    const socketCloseOrder = sessionSocketStub.close.mock.invocationCallOrder.at(-1) ?? 0;
    expect(closeRequestOrder).toBeGreaterThan(0);
    expect(socketCloseOrder).toBeGreaterThan(closeRequestOrder);
  });

  it('accepts an authoritative inactive session when the close acknowledgement is lost', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      id: 'session-socket',
      connected: true,
      emitWithAck: async (event) => {
        if (event === 'session-runtime-activity-close') {
          throw new Error('ack lost');
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
    fetchSessionByIdCompatMock.mockResolvedValue({ active: false });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await client.close();

    expect(fetchSessionByIdCompatMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      reason: 'legacy-compat-proof',
    });
  });

  it('keeps the user-scoped socket connected while a user-message callback is attached', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
    userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.onUserMessage(() => {});

    const abortController = new AbortController();
    const waitPromise = client.waitForMetadataUpdate(abortController.signal);
    abortController.abort();
    await waitPromise;

    await vi.advanceTimersByTimeAsync(2_100);

    expect(userSocketStub.disconnect).toHaveBeenCalledTimes(0);

    await client.close();
  });

  it('does not fetch session detail for passive metadata-wait best-effort refreshes', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
    userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
    fetchSessionByIdCompatMock.mockResolvedValue(null);

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as unknown as { metadata: unknown; metadataVersion: number }).metadata = null;
    (client as unknown as { metadata: unknown; metadataVersion: number }).metadataVersion = -1;

    await client.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });

    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();

    await client.close();
  });

  it('emits metadata-updated after storing the fresh metadata snapshot from update-session', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ id: 'session-socket', connected: true });
    userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const snapshots: Array<string | null> = [];

    client.on('metadata-updated', () => {
      snapshots.push(client.getMetadataSnapshot()?.path ?? null);
    });

    sessionSocketStub.trigger('update', {
      id: 'u1',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        sid: 's1',
        metadata: {
          version: 1,
          value: JSON.stringify({ path: '/tmp/fresh', host: 'test' }),
        },
      },
    });

    expect(snapshots).toEqual(['/tmp/fresh']);
    expect(client.getMetadataSnapshot()?.path).toBe('/tmp/fresh');

    await client.close();
  });

});
