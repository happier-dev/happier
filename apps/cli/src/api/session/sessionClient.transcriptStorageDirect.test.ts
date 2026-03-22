import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectionState } from '@/api/offline/serverConnectionErrors';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const createdClients: Array<{ close: () => Promise<void> }> = [];
const sessionTransportParamsHistory: Array<Record<string, unknown>> = [];
let supervisorOnConnected: (() => Promise<void> | void) | null = null;

async function getCurrentConnectionState() {
  const mod = await import('@/api/offline/serverConnectionErrors');
  return mod.connectionState;
}

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: (params: Record<string, unknown>) => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    sessionTransportParamsHistory.push(params);
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
      supervisorOnConnected = params.onConnected ?? null;
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

describe('ApiSessionClient (HAPPIER_TRANSCRIPT_STORAGE=direct)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionTransportParamsHistory.length = 0;
    supervisorOnConnected = null;
  });

  afterEach(async () => {
    connectionState.reset();
    for (const client of createdClients.splice(0)) {
      try {
        await client.close();
      } catch {
        // ignore test cleanup failures
      }
    }
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('confirms direct user messages before awaiting the sender echo', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);
    client.sendUserTextMessage('hello');

    await Promise.resolve();

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        sid: 's1',
        echoToSender: true,
      }),
    );
    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith(
      'message',
      expect.anything(),
    );
  });

  it('queues a retry when a best-effort direct send loses confirmation during disconnect', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (_event, _payload, socket) => {
        socket.connected = false;
        throw new Error('socket dropped');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);
    client.sendUserTextMessage('hello', { localId: 'direct-retry-1' });

    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledTimes(1);
    expect((client as any).pendingMaterializedLocalIds.has('direct-retry-1')).toBe(true);
    expect((client as any).committedLocalIdsAwaitingEcho.has('direct-retry-1')).toBe(false);
    expect((client as any).queuedDisconnectedSessionMessages.has('direct-retry-1')).toBe(true);
  });

  it('does not reject the reconnect hook when queued replay fails', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async () => ({ ok: false, error: 'replay_denied' }),
    });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);

    sessionSocketStub.connected = false;
    client.sendUserTextMessage('hello', { localId: 'reconnect-replay-1' });
    await Promise.resolve();

    expect((client as any).queuedDisconnectedSessionMessages.has('reconnect-replay-1')).toBe(true);

    sessionSocketStub.connected = true;
    expect(supervisorOnConnected).not.toBeNull();
    await expect(supervisorOnConnected?.()).resolves.toBeUndefined();
  });

  it('awaits an ack for committed direct user messages', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);
    await client.sendUserTextMessageCommitted('hello', { localId: 'direct-1' });

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        sid: 's1',
        localId: 'direct-1',
        echoToSender: true,
      }),
    );
  });

  it('includes machineId in the session-scoped socket bootstrap when session metadata declares it', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');
    const session = createPlainSessionFixture({ id: 's1' });

    const client = new ApiSessionClient(
      'tok',
      {
        ...session,
        metadata: {
          ...session.metadata,
          machineId: 'machine-1',
        },
      },
    );
    createdClients.push(client);

    expect(sessionTransportParamsHistory).toHaveLength(1);
    expect(sessionTransportParamsHistory[0]).toMatchObject({
      token: 'tok',
      sessionId: 's1',
      machineId: 'machine-1',
    });
  });

  it('recovers shared offline UX state when the supervised session transport reconnects', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');
    const currentConnectionState = await getCurrentConnectionState();

    currentConnectionState.fail({ operation: 'Session creation', errorCode: 'ECONNREFUSED' });
    expect(currentConnectionState.isOffline()).toBe(true);

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);

    expect(supervisorOnConnected).not.toBeNull();
    await expect(supervisorOnConnected?.()).resolves.toBeUndefined();
    expect(currentConnectionState.isOffline()).toBe(false);
  });
});
