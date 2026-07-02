import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { initializeSessionClientConnection } from './initializeSessionClientConnection';

const socketState = vi.hoisted(() => ({
  userSocket: null as {
    on: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  } | null,
  sessionSocket: null as {
    on: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    connected: boolean;
  } | null,
}));

vi.mock('../../sockets', () => ({
  createUserScopedSocket: () => {
    if (!socketState.userSocket) throw new Error('Missing user socket');
    return socketState.userSocket;
  },
}));

vi.mock('../../connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!socketState.sessionSocket) throw new Error('Missing session socket');
    return {
      socket: socketState.sessionSocket,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => true,
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

function createSecretAxiosError(label: string): AxiosError {
  return new AxiosError(`Request failed ${label} Authorization: Bearer MESSAGE_SECRET`, 'ERR_BAD_RESPONSE', {
    method: 'get',
    url: `https://api.example.test/v2/${label}?token=QUERY_SECRET`,
    headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
    data: { access_token: 'BODY_SECRET' },
  });
}

describe('initializeSessionClientConnection diagnostics', () => {
  beforeEach(() => {
    socketState.userSocket = {
      on: vi.fn(),
      disconnect: vi.fn(),
    };
    socketState.sessionSocket = {
      on: vi.fn(),
      disconnect: vi.fn(),
      connected: true,
    };
    vi.restoreAllMocks();
  });

  it('redacts reconnect diagnostics before logging', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const connection = initializeSessionClientConnection({
      token: 'token-1',
      sessionId: 's1',
      getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(),
      rpcHandlerManager: {
        onSocketConnect: vi.fn(),
        onSocketDisconnect: vi.fn(),
      },
      handleUserScopedUpdate: vi.fn(),
      installSessionSocketEventHandlers: vi.fn(),
      classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(),
      shouldKeepUserSocketConnected: () => false,
      kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect: async () => {
        throw createSecretAxiosError('changes');
      },
      shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(),
      flushQueuedSessionMessagesOnReconnect: async () => {
        throw createSecretAxiosError('queued');
      },
      flushDurableSessionMutationsOnReconnect: async () => {
        throw createSecretAxiosError('mutations');
      },
      markConnected: () => 'reconnect',
    });

    await connection.sessionConnectionSupervisor.start();

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).toContain('[API] Session changes sync on connect failed');
    expect(calls).toContain('[API] Failed to replay queued session messages on reconnect');
    expect(calls).toContain('[API] Failed to flush durable session mutations on reconnect');
    expect(calls).toContain('https://api.example.test/v2/changes');
    expect(calls).not.toContain('MESSAGE_SECRET');
    expect(calls).not.toContain('QUERY_SECRET');
    expect(calls).not.toContain('HEADER_SECRET');
    expect(calls).not.toContain('BODY_SECRET');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
  });
});
