import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEventMessage } from './sessionMessageTypes';
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
    getState: () => ({ phase: 'online' }),
  }),
}));

async function createClient(sessionOverrides: Record<string, unknown>) {
  sessionSocketStub = createApiSessionSocketStub({ connected: true });
  userSocketStub = createApiSessionSocketStub({ connected: false });
  const { ApiSessionClient } = await import('./sessionClient');
  const client = new ApiSessionClient('tok', {
    ...createPlainSessionFixture({ id: 's-stuck-thinking' }),
    ...sessionOverrides,
  } as any);
  return client;
}

function readPresenceThinking(client: unknown): boolean {
  return (client as { latestSessionPresence: { thinking: boolean } }).latestSessionPresence.thinking;
}

describe('ApiSessionClient stuck-thinking keepalive guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('self-heals a thinking keepalive that stays latched against a terminal turn status', async () => {
    const client = await createClient({ latestTurnStatus: 'completed' });
    const localPresence = vi.fn();
    client.on('local-presence', localPresence);

    // First tick: a fresh turn's status update can lag its thinking flip, so a brief window is tolerated.
    client.keepAlive(true, 'remote');
    expect(readPresenceThinking(client)).toBe(true);

    vi.setSystemTime(5_000);
    client.keepAlive(true, 'remote');
    expect(readPresenceThinking(client)).toBe(true);

    // Past the guard window the latch is definitively stuck (terminal status wins) → self-heal to idle.
    vi.setSystemTime(16_000);
    client.keepAlive(true, 'remote');
    expect(readPresenceThinking(client)).toBe(false);
    expect(localPresence.mock.calls.map(([presence]) => presence.thinking)).toEqual([true, true, false]);
  });

  it('keeps republishing thinking while the turn status is still active', async () => {
    const client = await createClient({ latestTurnStatus: 'in_progress' });

    client.keepAlive(true, 'remote');
    vi.setSystemTime(60_000);
    client.keepAlive(true, 'remote');

    expect(readPresenceThinking(client)).toBe(true);
  });

  it('notifies local terminal integrations when the session closes', async () => {
    const client = await createClient({});
    const onClosed = vi.fn();
    client.on('local-closed', onClosed);

    await client.close();

    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('keeps a new local turn thinking when its best-effort status record has not displaced a stale terminal snapshot', async () => {
    const client = await createClient({ latestTurnStatus: 'completed' });

    client.keepAlive(true, 'remote');
    await client.sessionTurnLifecycle.beginTurn({ provider: 'codex' });
    // The new turn has started locally, but the best-effort status write has not yet displaced
    // the stale terminal snapshot the keepalive guard can see.
    (client as any).latestTurnStatus = 'completed';

    vi.setSystemTime(16_000);
    client.keepAlive(true, 'remote');

    expect(readPresenceThinking(client)).toBe(true);
  });

  it.each([
    { name: 'no transcript progress', event: null, recovers: true },
    { name: 'informational notice', event: { type: 'message', message: 'hub: CI failed' }, recovers: true },
    { name: 'provider compaction progress', event: { type: 'context-compaction', phase: 'progress' }, recovers: false },
  ] satisfies Array<{ name: string; event: SessionEventMessage | null; recovers: boolean }>)('reconciles stale thinking with $name', async ({ event, recovers }) => {
    const client = await createClient({ latestTurnStatus: 'completed' });
    const { logger } = await import('@/ui/logger');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    await client.sessionTurnLifecycle.beginTurn({ provider: 'codex' });
    (client as any).latestTurnStatus = 'completed';

    vi.setSystemTime(5 * 60 * 1000 + 1);
    if (event) {
      sessionSocketStub!.trigger('update', {
        id: 'update-notice', seq: 1, createdAt: Date.now(),
        body: { t: 'new-message', sid: 's-stuck-thinking', message: {
          id: 'notice-message', seq: 1, localId: 'notice-1', createdAt: Date.now(), updatedAt: Date.now(),
          content: { t: 'plain', v: { role: 'agent', content: {
            id: 'notice-1', type: 'event', data: event,
          } } },
        } },
      });
    }
    client.keepAlive(true, 'remote');
    expect(readPresenceThinking(client)).toBe(true);

    vi.setSystemTime(5 * 60 * 1000 + 16_001);
    client.keepAlive(true, 'remote');
    expect(readPresenceThinking(client)).toBe(!recovers);

    vi.setSystemTime(5 * 60 * 1000 + 18_001);
    client.keepAlive(true, 'remote');
    expect(readPresenceThinking(client)).toBe(!recovers);
    expect(infoSpy).toHaveBeenCalledTimes(recovers ? 1 : 0);
    infoSpy.mockRestore();
  });
});
