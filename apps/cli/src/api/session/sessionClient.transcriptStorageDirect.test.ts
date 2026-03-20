import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { Session } from '@/api/types';

type SocketStub = {
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
    connected: boolean;
  };
};

function createSocketStub(opts?: {
  connected?: boolean;
  emitWithAck?: (event: string, payload: unknown, state: { connected: boolean }) => Promise<unknown>;
}): SocketStub {
  const state = { connected: opts?.connected ?? true };
  const socket: SocketStub['socket'] = {
    id: 'sock-1',
    get connected() {
      return state.connected;
    },
    set connected(value: boolean) {
      state.connected = value;
    },
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    timeout: vi.fn(function timeout() {
      return socket;
    }),
    emitWithAck: vi.fn(async (event: string, payload: unknown) => {
      if (opts?.emitWithAck) {
        return opts.emitWithAck(event, payload, state);
      }
      return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
    }),
  };
  return { socket, state };
}

let sessionSocketStub: SocketStub | null = null;
let userSocketStub: SocketStub | null = null;
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
    return userSocketStub.socket as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: (params: Record<string, unknown>) => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    sessionTransportParamsHistory.push(params);
    return {
      socket: sessionSocketStub.socket as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.socket.connected === true,
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
    sessionSocketStub = createSocketStub();
    userSocketStub = createSocketStub();

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const session: Session = {
      id: 's1',
      seq: 0,
      encryptionMode: 'plain',
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
    createdClients.push(client);
    client.sendUserTextMessage('hello');

    await Promise.resolve();

    expect(sessionSocketStub.socket.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        sid: 's1',
        echoToSender: true,
      }),
    );
    expect(sessionSocketStub.socket.emit).not.toHaveBeenCalledWith(
      'message',
      expect.anything(),
    );
  });

  it('queues a retry when a best-effort direct send loses confirmation during disconnect', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({
      emitWithAck: async (_event, _payload, state) => {
        state.connected = false;
        throw new Error('socket dropped');
      },
    });
    userSocketStub = createSocketStub();

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const session: Session = {
      id: 's1',
      seq: 0,
      encryptionMode: 'plain',
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
    createdClients.push(client);
    client.sendUserTextMessage('hello', { localId: 'direct-retry-1' });

    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    expect(sessionSocketStub.socket.emitWithAck).toHaveBeenCalledTimes(1);
    expect((client as any).pendingMaterializedLocalIds.has('direct-retry-1')).toBe(true);
    expect((client as any).committedLocalIdsAwaitingEcho.has('direct-retry-1')).toBe(false);
    expect((client as any).queuedDisconnectedSessionMessages.has('direct-retry-1')).toBe(true);
  });

  it('does not reject the reconnect hook when queued replay fails', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub({
      connected: true,
      emitWithAck: async () => ({ ok: false, error: 'replay_denied' }),
    });
    userSocketStub = createSocketStub();

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const session: Session = {
      id: 's1',
      seq: 0,
      encryptionMode: 'plain',
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
    createdClients.push(client);

    sessionSocketStub.socket.connected = false;
    client.sendUserTextMessage('hello', { localId: 'reconnect-replay-1' });
    await Promise.resolve();

    expect((client as any).queuedDisconnectedSessionMessages.has('reconnect-replay-1')).toBe(true);

    sessionSocketStub.socket.connected = true;
    expect(supervisorOnConnected).not.toBeNull();
    await expect(supervisorOnConnected?.()).resolves.toBeUndefined();
  });

  it('awaits an ack for committed direct user messages', async () => {
    vi.resetModules();
    sessionSocketStub = createSocketStub();
    userSocketStub = createSocketStub();

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const session: Session = {
      id: 's1',
      seq: 0,
      encryptionMode: 'plain',
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
    createdClients.push(client);
    await client.sendUserTextMessageCommitted('hello', { localId: 'direct-1' });

    expect(sessionSocketStub.socket.emitWithAck).toHaveBeenCalledWith(
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
    sessionSocketStub = createSocketStub();
    userSocketStub = createSocketStub();

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');

    const session: Session = {
      id: 's1',
      seq: 0,
      encryptionMode: 'plain',
      metadata: {
        path: '/tmp',
        host: 'test',
        machineId: 'machine-1',
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
    sessionSocketStub = createSocketStub({ connected: true });
    userSocketStub = createSocketStub();

    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');

    const { ApiSessionClient } = await import('./sessionClient');
    const currentConnectionState = await getCurrentConnectionState();

    const session: Session = {
      id: 's1',
      seq: 0,
      encryptionMode: 'plain',
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

    currentConnectionState.fail({ operation: 'Session creation', errorCode: 'ECONNREFUSED' });
    expect(currentConnectionState.isOffline()).toBe(true);

    const client = new ApiSessionClient('tok', session);
    createdClients.push(client);

    expect(supervisorOnConnected).not.toBeNull();
    await expect(supervisorOnConnected?.()).resolves.toBeUndefined();
    expect(currentConnectionState.isOffline()).toBe(false);
  });
});
