import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectionState } from '@/api/offline/serverConnectionErrors';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
  flushApiSessionClientMessageCommitQueue,
} from '@/testkit/backends/apiSessionSocketHarness';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const createdClients: Array<{ close: () => Promise<void> }> = [];
const sessionTransportParamsHistory: Array<Record<string, unknown>> = [];
let supervisorOnConnected: (() => Promise<void> | void) | null = null;
let supervisorOnDisconnected: ((params: { event: { reason?: string } }) => Promise<void> | void) | null = null;
let supervisorReportProbeResult: ReturnType<typeof vi.fn> | null = null;

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
  createManagedConnectionSupervisor: (params: {
    createTransport: () => unknown;
    onConnected?: () => Promise<void> | void;
    onDisconnected?: (params: { event: { reason?: string } }) => Promise<void> | void;
  }) => ({
    start: async () => {
      supervisorOnConnected = params.onConnected ?? null;
      supervisorOnDisconnected = params.onDisconnected ?? null;
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
    reportProbeResult: (...args: unknown[]) => supervisorReportProbeResult?.(...args),
  }),
}));

describe('ApiSessionClient (HAPPIER_TRANSCRIPT_STORAGE=direct)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionTransportParamsHistory.length = 0;
    supervisorOnConnected = null;
    supervisorOnDisconnected = null;
    supervisorReportProbeResult = vi.fn();
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
        messageRole: 'user',
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

  it('reports planned server restart socket events to the session connection supervisor', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);
    await Promise.resolve();

    sessionSocketStub.trigger('server:restarting', { retryAfterMs: 7_000 });

    expect(supervisorReportProbeResult).toHaveBeenCalledWith({
      status: 'retry_later',
      retryAfterMs: 7_000,
      reason: 'server_restarting',
      errorMessage: 'Server restart in progress',
    });
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
        messageRole: 'user',
      }),
    );
  });

  it('keeps a server-echoed user message observation-only even when the localId was committed locally', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);

    const onUserMessage = vi.fn();
    client.onUserMessage(onUserMessage);

    client.sendUserTextMessage('hello', {
      localId: 'local-1',
      meta: { source: 'ui', sentFrom: 'web' },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect((client as any).committedLocalIdsAwaitingEcho.has('local-1')).toBe(true);

    sessionSocketStub.trigger('update', {
      id: 'u1',
      seq: 1,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          localId: 'local-1',
          sidechainId: null,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              createdAt: Date.now(),
              localId: 'local-1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
        },
      },
    });

    expect(onUserMessage).not.toHaveBeenCalled();
  });

  it('does not let direct enqueue or its transcript echo bypass Pending materialization', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);

    const onUserMessage = vi.fn();
    client.onUserMessage(onUserMessage);

    await client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
      params: {
        text: 'hello',
        localId: 'local-2',
        meta: { source: 'ui', sentFrom: 'web' },
      },
    } as any);

    expect(onUserMessage).not.toHaveBeenCalled();

    sessionSocketStub.trigger('update', {
      id: 'u2',
      seq: 2,
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm2',
          seq: 2,
          localId: 'local-2',
          sidechainId: null,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              createdAt: Date.now(),
              localId: 'local-2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
        },
      },
    });

    expect(onUserMessage).not.toHaveBeenCalled();
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

  it('uses the local runtime machineId for session socket bootstrap when metadata has not caught up', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      { localMachineId: ' machine-local ' },
    );
    createdClients.push(client);

    expect(sessionTransportParamsHistory).toHaveLength(1);
    expect(sessionTransportParamsHistory[0]).toMatchObject({
      token: 'tok',
      sessionId: 's1',
      machineId: 'machine-local',
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

  it('durably publishes the fresh idle presence before using volatile idle heartbeats', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);

    client.keepAlive(false, 'remote');

    expect(sessionSocketStub.emit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
      sid: 's1',
      thinking: false,
      mode: 'remote',
    }));
    expect(sessionSocketStub.volatile.emit).not.toHaveBeenCalledWith('session-alive', expect.anything());

    sessionSocketStub.emit.mockClear();
    client.keepAlive(false, 'remote');

    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith('session-alive', expect.anything());
    expect(sessionSocketStub.volatile.emit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
      sid: 's1',
      thinking: false,
      mode: 'remote',
    }));
  });

  it('replays the latest session presence after the supervised session transport reconnects', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);

    client.keepAlive(true, 'local');
    expect(sessionSocketStub.emit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
      sid: 's1',
      thinking: true,
      mode: 'local',
    }));

    sessionSocketStub.emit.mockClear();
    await expect(supervisorOnConnected?.()).resolves.toBeUndefined();

    expect(sessionSocketStub.emit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
      sid: 's1',
      thinking: true,
      mode: 'local',
    }));
  });

  it('replays presence updated while the supervised session transport is reconnecting after a proxy disconnect', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true });
    userSocketStub = createApiSessionSocketStub({ connected: true });

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    createdClients.push(client);

    expect(supervisorOnDisconnected).not.toBeNull();
    sessionSocketStub.connected = false;
    await expect(supervisorOnDisconnected?.({ event: { reason: 'transport close' } })).resolves.toBeUndefined();

    sessionSocketStub.emit.mockClear();
    sessionSocketStub.volatile.emit.mockClear();
    client.keepAlive(true, 'local');

    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith('session-alive', expect.anything());
    expect(sessionSocketStub.volatile.emit).not.toHaveBeenCalledWith('session-alive', expect.anything());

    sessionSocketStub.connected = true;
    await expect(supervisorOnConnected?.()).resolves.toBeUndefined();

    expect(sessionSocketStub.emit).toHaveBeenCalledWith('session-alive', expect.objectContaining({
      sid: 's1',
      thinking: true,
      mode: 'local',
    }));
  });
});
