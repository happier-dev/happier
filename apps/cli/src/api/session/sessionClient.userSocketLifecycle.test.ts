import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    stop: async () => {},
  }),
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
