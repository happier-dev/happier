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

const compatibilityState = vi.hoisted(() => ({
  resolve: vi.fn(),
  invalidate: vi.fn(),
}));

const supervisorState = vi.hoisted(() => ({
  reportProbeResult: vi.fn(),
}));

vi.mock('@/api/clientCompatibility/sessionSyncPendingInputServerContract', () => ({
  createSessionSyncPendingInputServerContractController: () => compatibilityState,
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
  createManagedConnectionSupervisor: (params: {
    createTransport: () => unknown;
    onConnected?: () => Promise<void> | void;
    onDisconnected?: (value: { event: { reason?: string } }) => Promise<void> | void;
    onAuthFailed?: () => Promise<void> | void;
  }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
    triggerDisconnected: async () => await params.onDisconnected?.({ event: { reason: 'test' } }),
    triggerAuthFailed: async () => await params.onAuthFailed?.(),
    captureProbeReportScope: () => ({ epoch: 1 }),
    reportProbeResult: supervisorState.reportProbeResult,
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
    vi.restoreAllMocks();
    socketState.userSocket = {
      on: vi.fn(),
      disconnect: vi.fn(),
    };
    socketState.sessionSocket = {
      on: vi.fn(),
      disconnect: vi.fn(),
      connected: true,
    };
    compatibilityState.resolve.mockReset().mockImplementation(async (probe) => ({
      mode: 'session_sync_v2_pending_input_v1',
      sessionConnectionEpoch: probe.sessionConnectionEpoch,
      socket: probe.socket,
    }));
    compatibilityState.invalidate.mockReset().mockImplementation((probe) => probe?.socket ? ({
      mode: 'indeterminate',
      sessionConnectionEpoch: probe.sessionConnectionEpoch ?? 0,
      socket: probe.socket,
    }) : null);
    supervisorState.reportProbeResult.mockReset();
  });

  it('publishes the identical compatibility result to the shared Pending/Runtime consumer', async () => {
    const setContractResult = vi.fn();
    const connection = initializeSessionClientConnection({
      token: 'token-1',
      sessionId: 's1',
      localMachineId: 'machine-1',
      getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(),
      rpcHandlerManager: { onSocketConnect: vi.fn(), onSocketDisconnect: vi.fn() },
      handleUserScopedUpdate: vi.fn(),
      installSessionSocketEventHandlers: vi.fn(),
      classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(),
      shouldKeepUserSocketConnected: () => false,
      kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect: vi.fn(async () => {}),
      shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(async () => {}),
      flushQueuedSessionMessagesOnReconnect: vi.fn(async () => {}),
      flushDurableSessionMutationsOnReconnect: vi.fn(async () => {}),
      markConnected: () => ({ reason: 'connect', epoch: 9 }),
      setSessionSyncPendingInputServerContractResult: setContractResult,
    });

    await connection.sessionConnectionSupervisor.start();
    const resolved = await compatibilityState.resolve.mock.results[0]?.value;

    expect(setContractResult).toHaveBeenCalledWith(resolved);
    expect(setContractResult.mock.calls[0]?.[0]).toBe(resolved);
  });

  it('re-probes a transient indeterminate result on the same connected epoch before continuing startup', async () => {
    compatibilityState.resolve
      .mockImplementationOnce(async (probe) => ({
        mode: 'indeterminate',
        sessionConnectionEpoch: probe.sessionConnectionEpoch,
        socket: probe.socket,
      }))
      .mockImplementationOnce(async (probe) => ({
        mode: 'session_sync_v2_pending_input_v1',
        sessionConnectionEpoch: probe.sessionConnectionEpoch,
        socket: probe.socket,
      }));
    const setContractResult = vi.fn();
    const flushDurableSessionMutationsOnReconnect = vi.fn(async () => {});
    const connection = initializeSessionClientConnection({
      token: 'token-1',
      sessionId: 's1',
      localMachineId: 'machine-1',
      getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(),
      rpcHandlerManager: { onSocketConnect: vi.fn(), onSocketDisconnect: vi.fn() },
      handleUserScopedUpdate: vi.fn(),
      installSessionSocketEventHandlers: vi.fn(),
      classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(),
      shouldKeepUserSocketConnected: () => false,
      kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect: vi.fn(async () => {}),
      shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(async () => {}),
      flushQueuedSessionMessagesOnReconnect: vi.fn(async () => {}),
      flushDurableSessionMutationsOnReconnect,
      markConnected: () => ({ reason: 'connect', epoch: 9 }),
      setSessionSyncPendingInputServerContractResult: setContractResult,
    });

    await connection.sessionConnectionSupervisor.start();

    expect(compatibilityState.resolve).toHaveBeenCalledTimes(2);
    expect(compatibilityState.resolve.mock.calls[0]?.[0]).toEqual({
      sessionConnectionEpoch: 9,
      socket: socketState.sessionSocket,
      machineId: 'machine-1',
    });
    expect(compatibilityState.resolve.mock.calls[1]?.[0]).toEqual(
      compatibilityState.resolve.mock.calls[0]?.[0],
    );
    expect(setContractResult.mock.calls.map(([result]) => result.mode)).toEqual([
      'indeterminate',
      'session_sync_v2_pending_input_v1',
    ]);
    expect(flushDurableSessionMutationsOnReconnect).toHaveBeenCalledTimes(1);
    expect(supervisorState.reportProbeResult).not.toHaveBeenCalled();
  });

  it('parks persistent indeterminate compatibility through the connection supervisor after two probes', async () => {
    compatibilityState.resolve.mockImplementation(async (probe) => ({
      mode: 'indeterminate',
      sessionConnectionEpoch: probe.sessionConnectionEpoch,
      socket: probe.socket,
    }));
    const syncChangesOnConnect = vi.fn(async () => {});
    const flushQueuedSessionMessagesOnReconnect = vi.fn(async () => {});
    const flushDurableSessionMutationsOnReconnect = vi.fn(async () => {});
    const connection = initializeSessionClientConnection({
      token: 'token-1',
      sessionId: 's1',
      localMachineId: 'machine-1',
      getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(),
      rpcHandlerManager: { onSocketConnect: vi.fn(), onSocketDisconnect: vi.fn() },
      handleUserScopedUpdate: vi.fn(),
      installSessionSocketEventHandlers: vi.fn(),
      classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(),
      shouldKeepUserSocketConnected: () => false,
      kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect,
      shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(async () => {}),
      flushQueuedSessionMessagesOnReconnect,
      flushDurableSessionMutationsOnReconnect,
      markConnected: () => ({ reason: 'connect', epoch: 9 }),
      setSessionSyncPendingInputServerContractResult: vi.fn(),
    });

    await connection.sessionConnectionSupervisor.start();

    expect(compatibilityState.resolve).toHaveBeenCalledTimes(2);
    expect(supervisorState.reportProbeResult).toHaveBeenCalledWith({
      status: 'retry_later',
      reason: 'probe_failed',
      errorMessage: 'Session compatibility remained indeterminate after bounded probes',
    }, { epoch: 1 });
    expect(syncChangesOnConnect).not.toHaveBeenCalled();
    expect(flushQueuedSessionMessagesOnReconnect).not.toHaveBeenCalled();
    expect(flushDurableSessionMutationsOnReconnect).not.toHaveBeenCalled();
  });

  it.each(['triggerDisconnected', 'triggerAuthFailed'] as const)('clears authority through no-I/O invalidation on %s', async (trigger) => {
    const setContractResult = vi.fn();
    const connection = initializeSessionClientConnection({
      token: 'token-1', sessionId: 's1', localMachineId: 'machine-1', getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(), rpcHandlerManager: { onSocketConnect: vi.fn(), onSocketDisconnect: vi.fn() },
      handleUserScopedUpdate: vi.fn(), installSessionSocketEventHandlers: vi.fn(), classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(), shouldKeepUserSocketConnected: () => false, kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect: vi.fn(async () => {}), shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(async () => {}), flushQueuedSessionMessagesOnReconnect: vi.fn(async () => {}),
      flushDurableSessionMutationsOnReconnect: vi.fn(async () => {}), markConnected: () => ({ reason: 'connect', epoch: 9 }),
      setSessionSyncPendingInputServerContractResult: setContractResult,
    });
    await connection.sessionConnectionSupervisor.start();
    compatibilityState.resolve.mockClear();
    await (connection.sessionConnectionSupervisor as never as Record<typeof trigger, () => Promise<void>>)[trigger]();
    expect(compatibilityState.invalidate).toHaveBeenCalledTimes(1);
    expect(compatibilityState.resolve).not.toHaveBeenCalled();
    expect(setContractResult).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'indeterminate' }));
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
