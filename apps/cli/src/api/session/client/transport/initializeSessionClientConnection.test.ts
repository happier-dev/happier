import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1 } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { initializeSessionClientConnection } from './initializeSessionClientConnection';

const socketState = vi.hoisted(() => ({
  transportParams: [] as Array<Record<string, unknown>>,
  userSocket: null as {
    on: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  } | null,
  sessionSocket: null as {
    on: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    emitWithAck: ReturnType<typeof vi.fn>;
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
  supportsSessionSyncPendingInputV1: (contract: string | { mode?: string; pendingInput?: string }) => (
    typeof contract === 'string'
      ? contract === 'session_sync_v3_publisher_authority_check_v1'
        || contract === 'session_sync_v2_pending_input_v1'
      : contract.pendingInput === 'v1'
        || contract.mode === 'session_sync_v3_publisher_authority_check_v1'
        || contract.mode === 'session_sync_v2_pending_input_v1'
  ),
  supportsRuntimeActivityV2: (contract: { runtimeActivity?: string }) => contract.runtimeActivity === 'v2',
}));

vi.mock('../../sockets', () => ({
  createUserScopedSocket: () => {
    if (!socketState.userSocket) throw new Error('Missing user socket');
    return socketState.userSocket;
  },
}));

vi.mock('../../connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: (params: Record<string, unknown>) => {
    if (!socketState.sessionSocket) throw new Error('Missing session socket');
    socketState.transportParams.push(params);
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
    connectionState.reset();
    socketState.transportParams.length = 0;
    socketState.userSocket = {
      on: vi.fn(),
      disconnect: vi.fn(),
    };
    socketState.sessionSocket = {
      on: vi.fn(),
      disconnect: vi.fn(),
      emitWithAck: vi.fn(async (event: string) => {
        if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
          return { ok: true, capability: 'session-transcript-observation-v1' };
        }
        return { ok: false };
      }),
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

  it.each([
    {
      label: 'declared session metadata',
      localMachineId: undefined,
      metadata: { machineId: ' machine-metadata ' },
      expectedMachineId: 'machine-metadata',
    },
    {
      label: 'the local runtime when metadata has not caught up',
      localMachineId: ' machine-local ',
      metadata: { machineId: 'machine-stale' },
      expectedMachineId: 'machine-local',
    },
  ])('uses the normalized machine id from $label for session socket bootstrap', async ({
    localMachineId,
    metadata,
    expectedMachineId,
  }) => {
    const connection = initializeSessionClientConnection({
      token: 'token-1',
      sessionId: 's1',
      localMachineId,
      getMetadataSnapshot: () => metadata,
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
      markConnected: () => ({ reason: 'connect', epoch: 1 }),
    });

    await connection.sessionConnectionSupervisor.start();

    expect(socketState.transportParams).toEqual([{
      token: 'token-1',
      sessionId: 's1',
      machineId: expectedMachineId,
    }]);
  });

  it('recovers shared offline UX state after the supervised session transport connects', async () => {
    connectionState.fail({ operation: 'Session creation', errorCode: 'ECONNREFUSED' });
    expect(connectionState.isOffline()).toBe(true);

    const connection = initializeSessionClientConnection({
      token: 'token-1', sessionId: 's1', getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(), rpcHandlerManager: { onSocketConnect: vi.fn(), onSocketDisconnect: vi.fn() },
      handleUserScopedUpdate: vi.fn(), installSessionSocketEventHandlers: vi.fn(), classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(), shouldKeepUserSocketConnected: () => false, kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect: vi.fn(async () => {}), shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(async () => {}), flushQueuedSessionMessagesOnReconnect: vi.fn(async () => {}),
      flushDurableSessionMutationsOnReconnect: vi.fn(async () => {}), markConnected: () => ({ reason: 'reconnect', epoch: 1 }),
    });

    await connection.sessionConnectionSupervisor.start();

    expect(connectionState.isOffline()).toBe(false);
  });

  it('publishes the identical compatibility result to the shared Pending/Runtime consumer', async () => {
    const setContractResult = vi.fn();
    const reofferAcceptedProviderInputSettlementsAfterConnection = vi.fn();
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
      reofferAcceptedProviderInputSettlementsAfterConnection,
    });

    await connection.sessionConnectionSupervisor.start();
    expect(setContractResult).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'session_sync_v2_pending_input_v1',
      sessionConnectionEpoch: 9,
      socket: socketState.sessionSocket,
      transcriptTransport: { mode: 'session_transcript_observation_v1' },
    }));
    expect(reofferAcceptedProviderInputSettlementsAfterConnection).toHaveBeenCalledTimes(1);
  });

  it('withholds current Pending input authority until Runtime Activity publisher readiness settles', async () => {
    compatibilityState.resolve.mockImplementation(async (probe) => ({
      mode: 'session_sync_v3_publisher_authority_check_v1',
      runtimeActivity: 'v2',
      pendingInput: 'v1',
      publisherAuthority: 'v1',
      sessionConnectionEpoch: probe.sessionConnectionEpoch,
      socket: probe.socket,
    }));
    let pendingMaterializations = 0;
    let resolvePublisherReadiness!: () => void;
    const publisherReadiness = new Promise<void>((resolve) => {
      resolvePublisherReadiness = resolve;
    });
    const flushDurableSessionMutationsOnReconnect = vi.fn(async () => {
      await publisherReadiness;
    });
    const setContractResult = vi.fn(() => {
      pendingMaterializations += 1;
    });
    const connection = initializeSessionClientConnection({
      token: 'token-1', sessionId: 's1', localMachineId: 'machine-1', getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(), rpcHandlerManager: { onSocketConnect: vi.fn(), onSocketDisconnect: vi.fn() },
      handleUserScopedUpdate: vi.fn(), installSessionSocketEventHandlers: vi.fn(), classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(), shouldKeepUserSocketConnected: () => false, kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect: vi.fn(async () => {}), shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(async () => {}), flushQueuedSessionMessagesOnReconnect: vi.fn(async () => {}),
      flushDurableSessionMutationsOnReconnect, markConnected: () => ({ reason: 'reconnect', epoch: 9 }),
      setSessionSyncPendingInputServerContractResult: setContractResult,
    });

    const reconnect = connection.sessionConnectionSupervisor.start();
    await vi.waitFor(() => expect(flushDurableSessionMutationsOnReconnect).toHaveBeenCalledTimes(1));
    expect(pendingMaterializations).toBe(0);

    resolvePublisherReadiness();
    await reconnect;
    expect(pendingMaterializations).toBe(1);
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
    expect(setContractResult.mock.calls.map(([result]) => result.transcriptTransport.mode)).toEqual([
      'indeterminate',
      'session_transcript_observation_v1',
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
    expect(setContractResult).toHaveBeenLastCalledWith(expect.objectContaining({
      transcriptTransport: { mode: 'indeterminate', reason: 'connection_contract_unresolved' },
    }));
  });

  it('negotiates transcript transport once per authenticated connection epoch and once again after reconnect', async () => {
    let epoch = 0;
    const setContractResult = vi.fn();
    const connection = initializeSessionClientConnection({
      token: 'token-1', sessionId: 's1', localMachineId: 'machine-1', getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(), rpcHandlerManager: { onSocketConnect: vi.fn(), onSocketDisconnect: vi.fn() },
      handleUserScopedUpdate: vi.fn(), installSessionSocketEventHandlers: vi.fn(), classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(), shouldKeepUserSocketConnected: () => false, kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect: vi.fn(async () => {}), shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(async () => {}), flushQueuedSessionMessagesOnReconnect: vi.fn(async () => {}),
      flushDurableSessionMutationsOnReconnect: vi.fn(async () => {}),
      markConnected: () => ({ reason: epoch === 0 ? 'connect' : 'reconnect', epoch: ++epoch }),
      setSessionSyncPendingInputServerContractResult: setContractResult,
    });

    await connection.sessionConnectionSupervisor.start();
    await connection.sessionConnectionSupervisor.start();

    expect(socketState.sessionSocket?.emitWithAck.mock.calls.filter(([event]) => (
      event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1
    ))).toHaveLength(2);
    expect(setContractResult.mock.calls.map(([result]) => result.sessionConnectionEpoch)).toEqual([1, 2]);
    expect(setContractResult.mock.calls.map(([result]) => result.transcriptTransport.mode)).toEqual([
      'session_transcript_observation_v1',
      'session_transcript_observation_v1',
    ]);
  });

  it('stores unsupported transcript transport once and continues without row-scoped capability probes', async () => {
    socketState.sessionSocket?.emitWithAck.mockResolvedValue({ ok: false, error: 'unsupported' });
    const setContractResult = vi.fn();
    const flushDurableSessionMutationsOnReconnect = vi.fn(async () => {});
    const connection = initializeSessionClientConnection({
      token: 'token-1', sessionId: 's1', localMachineId: 'machine-1', getMetadataSnapshot: () => null,
      setSessionSocket: vi.fn(), rpcHandlerManager: { onSocketConnect: vi.fn(), onSocketDisconnect: vi.fn() },
      handleUserScopedUpdate: vi.fn(), installSessionSocketEventHandlers: vi.fn(), classifyTransportErrorToProbeResult: undefined,
      onStateChange: vi.fn(), shouldKeepUserSocketConnected: () => false, kickUserSocketConnect: vi.fn(),
      syncChangesOnConnect: vi.fn(async () => {}), shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: vi.fn(async () => {}), flushQueuedSessionMessagesOnReconnect: vi.fn(async () => {}),
      flushDurableSessionMutationsOnReconnect, markConnected: () => ({ reason: 'connect', epoch: 9 }),
      setSessionSyncPendingInputServerContractResult: setContractResult,
    });

    await connection.sessionConnectionSupervisor.start();

    expect(setContractResult).toHaveBeenCalledWith(expect.objectContaining({
      transcriptTransport: {
        mode: 'unavailable',
        reason: 'capability_missing_or_unsupported',
      },
    }));
    expect(socketState.sessionSocket?.emitWithAck).toHaveBeenCalledTimes(1);
    expect(flushDurableSessionMutationsOnReconnect).toHaveBeenCalledTimes(1);
  });

  it('selects the released server-v0.2.1 transcript seam without probing the new capability', async () => {
    compatibilityState.resolve.mockImplementation(async (probe) => ({
      mode: 'released_server_v0_2_1',
      sessionConnectionEpoch: probe.sessionConnectionEpoch,
      socket: probe.socket,
    }));
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

    expect(setContractResult).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'released_server_v0_2_1',
      transcriptTransport: { mode: 'released_server_v0_2_1' },
    }));
    expect(socketState.sessionSocket?.emitWithAck).not.toHaveBeenCalled();
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
