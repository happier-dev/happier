import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionClientInteractionApi } from './sessionClientInteractionApi';
import { encodeBase64, encrypt } from '../../../encryption';

const axiosGetMock = vi.hoisted(() => vi.fn());
const axiosPostMock = vi.hoisted(() => vi.fn());
const socketAckMock = vi.hoisted(() => vi.fn());

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      get: axiosGetMock,
      post: axiosPostMock,
      isAxiosError: actual.default.isAxiosError,
    },
    get: axiosGetMock,
    post: axiosPostMock,
    isAxiosError: actual.isAxiosError,
  };
});

function createSecretAxiosError(): AxiosError {
  return new AxiosError('Initial catch-up failed Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
    method: 'get',
    url: 'https://api.example.test/v1/sessions/s1/messages?token=QUERY_SECRET',
    headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
    data: { access_token: 'BODY_SECRET' },
  });
}

function createSocketStub() {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const socket = {
    connected: true,
    emit: vi.fn(),
    emitWithAck: socketAckMock,
    timeout: vi.fn(() => socket),
    volatile: { emit: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    }),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.get(event)?.delete(handler);
    }),
    trigger: (event: string, ...args: any[]) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
    disconnect: vi.fn(),
  };
  return socket;
}

function mockProviderSocketAck(response: { data: unknown }) {
  socketAckMock.mockResolvedValueOnce(response.data);
}

describe('createSessionClientInteractionApi diagnostics', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();
    socketAckMock.mockReset();
    vi.restoreAllMocks();
  });

  function createApi(overrides: Partial<Parameters<typeof createSessionClientInteractionApi>[0]> = {}) {
    const socket = createSocketStub();
    const defaultContractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket: overrides.getSocket?.() ?? socket,
    };
    return createSessionClientInteractionApi({
      sessionId: 's1',
      token: 'token-1',
      getClosed: () => false,
      setClosed: vi.fn(),
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 1,
      getSessionSyncPendingInputServerContractResult: () => defaultContractResult,
      getUserSocket: () => socket as never,
      getSessionConnectionSupervisor: () => null,
      getRpcHandlerManager: () => ({ handleRequest: vi.fn(async () => null) }),
      getMetadata: () => null,
      updateMetadata: vi.fn(async () => {}),
      setMetadata: vi.fn(),
      getMetadataVersion: () => 0,
      setMetadataVersion: vi.fn(),
      onMetadataUpdated: vi.fn(),
      offMetadataUpdated: vi.fn(),
      getAgentStateVersion: () => 0,
      getPendingWakeSeq: () => 0,
      getProviderInputBacklog: () => [],
      setProviderInputConsumer: vi.fn(),
      getProviderInputConsumerAttachedAtMs: () => null,
      setProviderInputConsumerAttachedAtMs: vi.fn(),
      wakePendingMaterialization: vi.fn(),
      clearUserSocketDisconnectTimer: vi.fn(),
      kickUserSocketConnect: vi.fn(),
      catchUpSessionMessages: vi.fn(async () => {}),
      scheduleNextStartupMessageCatchUpRetry: vi.fn(),
      getLastObservedMessageSeq: () => 0,
      getStartupMessageCatchUpExplicitAfterSeq: () => null,
      getStartedByDaemonProcess: () => true,
      getMetadataStartedBy: () => null,
      getMetadataStartedFromDaemon: () => null,
      getStartupMessageCatchUpStarted: () => false,
      setStartupMessageCatchUpStarted: vi.fn(),
      setStartupMessageCatchUpRetryIndex: vi.fn(),
      setStartupMessageCatchUpInitialAfterSeq: vi.fn(),
      enqueueSessionUserMessage: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      reconcileTurnStatusBeforePendingMaterialization: vi.fn(async () => true),
      maybeScheduleUserSocketDisconnect: vi.fn(),
      handleSessionScopedUpdate: vi.fn(),
      clearStartupMessageCatchUpRetryTimer: vi.fn(),
      clearCommittedLocalIdCleanupTimers: vi.fn(),
      clearPendingMaterializedState: vi.fn(),
      getPendingQueueMaterializedLocalIdsSize: () => 0,
      markPendingQueueMaterializedLocalId: vi.fn(),
      shouldAttemptPendingMaterialization: () => true,
      getPendingQueueState: () => ({ known: false as const }),
      applyPendingQueueState: vi.fn(() => false),
      observePendingMaterializeResult: vi.fn(() => false),
      onPendingQueueStateChanged: vi.fn(),
      getStoredContentCryptoContext: () => ({
        mode: 'e2ee' as const,
        ctx: {
          encryptionKey: new Uint8Array(32),
          encryptionVariant: 'legacy' as const,
        },
      }),
      ...overrides,
    });
  }

  it('reports planned server restart events to the connection supervisor', () => {
    const socket = createSocketStub();
    const reportProbeResult = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({ reportProbeResult }) as never,
    });

    api.installSessionSocketEventHandlers(socket as never);
    socket.trigger('server:restarting', { retryAfterMs: 7_000 });

    expect(reportProbeResult).toHaveBeenCalledWith({
      status: 'retry_later',
      retryAfterMs: 7_000,
      reason: 'server_restarting',
      errorMessage: 'Server restart in progress',
    });
  });

  it.each(['indeterminate', 'auth_failed'] as const)('delivers zero provider input for %s compatibility', async (mode) => {
    const socket = createSocketStub();
    const contractResult = {
      mode,
      runtimeActivity: 'indeterminate' as const,
      pendingInput: 'indeterminate' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const deliver = vi.fn(() => true);
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 1,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      deliverMaterializedUserMessageToAgentQueue: deliver,
    });

    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual(
      mode === 'auth_failed' ? { type: 'auth_failure' } : { type: 'retryable_transport' },
    );
    expect(socketAckMock).not.toHaveBeenCalled();
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('returns the operation-scoped update result for a Run target on a pre-V3 Pending server while main Pending remains usable', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      pendingInputProtocolVersion: 2,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 1,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
    });

    await expect(api.materializeNextExecutionRunPendingMessageSafely({
      recipient: { kind: 'execution_run', runId: 'run-1' },
      sidechainId: 'sidechain-1',
      isCurrent: () => true,
      foregroundState: () => 'ready',
      getMetadataSnapshot: () => null,
      consume: () => false,
      hasCustody: () => false,
      markCustody: () => undefined,
    })).resolves.toEqual({ type: 'unsupported', code: 'session_input_target_update_required' });
    expect(socketAckMock).not.toHaveBeenCalled();

    socketAckMock.mockResolvedValueOnce({
      ok: true,
      didMaterialize: false,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 2,
    });
    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
    expect(socketAckMock).toHaveBeenCalledTimes(1);
  });

  it('does not let an old auth result poison a replacement connection epoch', async () => {
    const oldSocket = createSocketStub();
    const newSocket = createSocketStub();
    const staleAuthResult = {
      mode: 'auth_failed' as const,
      runtimeActivity: 'indeterminate' as const,
      pendingInput: 'indeterminate' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket: oldSocket,
    };
    const api = createApi({
      getSocket: () => newSocket as never,
      getSessionConnectionEpoch: () => 2,
      getSessionSyncPendingInputServerContractResult: () => staleAuthResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
    });

    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'retryable_transport' });
    expect(socketAckMock).not.toHaveBeenCalled();
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('requests one bounded frozen-claim rejoin after a current socket acknowledgement becomes ambiguous', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const transportError = Object.assign(new Error('materialize acknowledgement timed out'), {
      diagnosticCode: 'pending_queue_materialization_ack_timeout',
      classification: 'ack_timeout',
    });
    socketAckMock.mockRejectedValueOnce(transportError);
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
    });

    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({
      type: 'retryable_transport',
      retryAfterMs: 250,
    });
    expect(infoFileSpy).toHaveBeenCalledWith(
      '[pendingQueue] materialize request failed',
      expect.objectContaining({
        sessionId: 's1',
        error: expect.objectContaining({
          diagnosticCode: 'pending_queue_materialization_ack_timeout',
          classification: 'ack_timeout',
          message: 'materialize acknowledgement timed out',
        }),
      }),
    );
    expect(infoFileSpy).toHaveBeenCalledTimes(1);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('identifies the server-claim subphase before awaiting an unsettled materialization transport', async () => {
    const socket = createSocketStub();
    const transport = createDeferred<{
      ok: true;
      didMaterialize: false;
      pendingCount: 0;
      pendingBlockedCount: 0;
      pendingVersion: 2;
    }>();
    socketAckMock.mockImplementationOnce(async () => await transport.promise);
    const observedPhases: string[] = [];
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      }),
    });
    const pending = api.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      onDiagnosticPhase: (phase) => observedPhases.push(phase),
    });

    try {
      await vi.waitFor(() => expect(socketAckMock).toHaveBeenCalledTimes(1));
      expect(observedPhases.at(-1)).toBe('materialize.server_claim');
    } finally {
      transport.resolve({
        ok: true,
        didMaterialize: false,
        pendingCount: 0,
        pendingBlockedCount: 0,
        pendingVersion: 2,
      });
      await pending;
    }
  });

  it('keeps diagnostic callback failures outside pending materialization behavior', async () => {
    socketAckMock.mockResolvedValueOnce({
      ok: true,
      didMaterialize: false,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 2,
    });
    const api = createApi({
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      }),
    });

    await expect(api.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      onDiagnosticPhase: () => {
        throw new Error('diagnostic callback failed');
      },
    })).resolves.toEqual({ type: 'no_pending' });
    expect(socketAckMock).toHaveBeenCalledTimes(1);
  });

  it.each(['plain', 'e2ee'] as const)('uses only the strict released-server adapter in old mode for %s content', async (mode) => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'released_server_v0_2_1' as const,
      runtimeActivity: 'legacy' as const,
      pendingInput: 'released_server_v0_2_1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 3,
      socket,
    };
    socketAckMock.mockResolvedValueOnce({
      ok: true,
      didMaterialize: true,
      didWrite: true,
      message: { id: 'old-message', seq: 8, localId: 'old-local' },
    });
    axiosGetMock.mockResolvedValueOnce({
      status: 200,
      data: {
        message: {
          id: 'old-message', seq: 8, localId: 'old-local', sidechainId: null,
          createdAt: 100, updatedAt: 101,
          content: mode === 'plain'
            ? { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'old prompt' } } }
            : { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32), 'legacy', { role: 'user', content: { type: 'text', text: 'old prompt' } })) },
        },
      },
    });
    const deliver = vi.fn(() => true);
    const observedPhases: string[] = [];
    const supervisor = { getState: () => ({ phase: 'online' }) };
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 3,
      ...(mode === 'plain' ? { getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }) } : {}),
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => supervisor as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      deliverMaterializedUserMessageToAgentQueue: deliver,
    });

    await expect(api.materializeNextPendingMessageSafely({
      onDiagnosticPhase: (phase) => observedPhases.push(phase),
    })).resolves.toMatchObject({
      type: 'materialized', localId: 'old-local', seq: 8,
    });
    expect(observedPhases).toContain('materialize.server_claim');
    expect(observedPhases).toContain('materialize.compatibility_transcript_lookup');
    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', { sid: 's1' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('does not fall back to HTTP when current materialization has no bound socket', async () => {
    const disconnectedSocket = { connected: false };
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket: disconnectedSocket,
    };
    const api = createApi({
      getSocket: () => disconnectedSocket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
    });

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'retryable_transport',
    });

    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(socketAckMock).not.toHaveBeenCalled();
  });

  it('propagates non-auth pending-queue list failures', async () => {
    axiosGetMock.mockRejectedValueOnce(new Error('pending list failed'));
    const api = createApi();

    await expect(api.listPendingMessageQueueV2LocalIds()).rejects.toThrow('pending list failed');
  });

  it('propagates non-auth pending-queue discard failures', async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: { pending: [{ localId: 'pending-1' }] },
    });
    axiosPostMock.mockRejectedValueOnce(new Error('pending discard failed'));
    const api = createApi({
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 }),
    });

    await expect(api.discardPendingMessageQueueV2All({ reason: 'manual' })).rejects.toThrow('pending discard failed');
  });

  it('does not force a session-detail reconciliation for passive known-empty pending peeks', async () => {
    const syncSessionSnapshotFromServer = vi.fn();
    const api = createApi({
      shouldAttemptPendingMaterialization: () => false,
      getPendingQueueState: () => ({ known: true as const, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 }),
      syncSessionSnapshotFromServer,
    });

    await expect(api.peekPendingMessageQueueV2Count()).resolves.toBe(0);

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('reports pending queue reconciliation changes when only the blocked count changes', async () => {
    let pendingQueueState = { known: true as const, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 4 };
    const api = createApi({
      shouldAttemptPendingMaterialization: () => false,
      getPendingQueueState: () => pendingQueueState,
      syncSessionSnapshotFromServer: vi.fn(async () => {
        pendingQueueState = { known: true as const, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 4 };
        return true;
      }),
    });

    await expect(api.reconcilePendingQueueState({ force: true })).resolves.toBe(true);
  });

  it.each([
    { deferredReason: 'waiting_for_runtime_activity', reason: 'runtime_activity_active' },
    { deferredReason: 'waiting_for_quota_reset', reason: 'waiting_for_quota_reset' },
  ])('keeps server-owned $deferredReason deferral queued without claiming input', async ({ deferredReason, reason }) => {
    const socket = createSocketStub();
    socketAckMock.mockResolvedValueOnce({
        ok: true,
        didMaterialize: false,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 7,
        deferredReason,
        localId: 'runtime-idle-head',
    });
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      handleSessionScopedUpdate,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_runtime_idle',
    } as Parameters<typeof api.materializeNextPendingMessageSafely>[0] & { deliveryTiming: 'after_runtime_idle' })).resolves.toEqual({
      type: 'deferred',
      reason,
    });

    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', expect.objectContaining({
      sid: 's1', pendingVersion: 6, deliveryTiming: 'after_runtime_idle', foregroundState: 'ready',
    }));
    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(handleSessionScopedUpdate).not.toHaveBeenCalled();
  });

  it('ignores the retired local Activity veto and asks the server Pending owner', async () => {
    const socket = createSocketStub();
    socketAckMock.mockResolvedValueOnce({
        ok: true,
        didMaterialize: false,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 7,
        deferredReason: 'waiting_for_runtime_activity',
        localId: 'runtime-idle-head',
    });
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 }),
      shouldDeferPendingQueueDrainForRuntimeActivity: ({ deliveryTiming }) => deliveryTiming === 'after_runtime_idle',
    });

    await expect(api.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_runtime_idle',
    } as Parameters<typeof api.materializeNextPendingMessageSafely>[0] & { deliveryTiming: 'after_runtime_idle' })).resolves.toEqual({
      type: 'deferred',
      reason: 'runtime_activity_active',
    });

    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', expect.objectContaining({
      sid: 's1', pendingVersion: 6, deliveryTiming: 'after_runtime_idle', foregroundState: 'ready',
    }));
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('materializes queued rows when Pending Input is supported independently of other session capabilities', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'indeterminate' as const,
      runtimeActivity: 'indeterminate' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    socketAckMock.mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'legacy-local',
        didWrite: true,
        pendingCount: 0,
        pendingVersion: 3,
        message: {
          id: 'm-legacy',
          seq: 1810,
          localId: 'legacy-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after stale row' },
              localId: 'legacy-local',
            },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
    });
    const api = createApi({
      getSocket: () => socket as never,
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 2, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'legacy-local',
      seq: 1810,
    });

    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', expect.objectContaining({
      sid: 's1',
      pendingVersion: 1,
      deliveryState: 'provider',
      deliveryTiming: 'after_foreground_ready',
      foregroundState: 'ready',
    }));
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it.each([
    ['e2ee', 'plain', false],
    ['plain', 'encrypted', false],
    ['e2ee', 'corrupt', false],
    ['plain', 'plain', true],
    ['e2ee', 'encrypted', true],
  ] as const)('opens a %s Session claim with %s content before provider delivery (accepted: %s)', async (mode, envelope, accepted) => {
    const payload = { role: 'user', content: { type: 'text', text: 'pending prompt' } };
    const content = envelope === 'plain'
      ? { t: 'plain', v: payload }
      : { t: 'encrypted', c: envelope === 'corrupt' ? 'invalid' : encodeBase64(encrypt(new Uint8Array(32), 'legacy', payload)) };
    socketAckMock.mockResolvedValue({
      ok: true, didMaterialize: true, didWrite: false, localId: 'pending-local',
      pendingCount: 1, pendingVersion: 2,
      message: {
        id: null, seq: null, localId: 'pending-local', messageRole: 'user', content,
        createdAt: 1_000, updatedAt: 1_000, providerAction: 'send',
        deliveryState: { mode: 'provider', unresolved: true },
      },
    });
    const delivered: unknown[] = [];
    const projected: unknown[] = [];
    const custody = new Set<string>();
    const api = createApi({
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      ...(mode === 'plain' ? { getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }) } : {}),
      deliverMaterializedUserMessageToAgentQueue: (message) => { delivered.push(message); return true; },
      handleSessionScopedUpdate: (update) => { projected.push(update); },
      markPendingQueueMaterializedLocalId: (localId) => { custody.add(localId); },
    });

    const result = await api.materializeNextPendingMessageSafely();
    if (accepted) {
      expect(result).toMatchObject({ type: 'materialized', localId: 'pending-local' });
      expect(delivered).toEqual([{ ...payload, localId: 'pending-local', createdAt: 1_000 }]);
      expect(custody.has('pending-local')).toBe(true);
    } else {
      expect(result).toEqual({ type: 'retryable_transport', retryAfterMs: 250 });
      expect(delivered).toEqual([]);
      expect(projected).toEqual([]);
      expect(custody.size).toBe(0);
      expect(socketAckMock).toHaveBeenCalledTimes(1);
      // Rejoining the same claim remains possible; failed opening takes no custody.
      await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual(result);
      expect(delivered).toEqual([]);
      socketAckMock.mockResolvedValueOnce({
        ok: true, didMaterialize: true, didWrite: false, localId: 'pending-local',
        pendingCount: 1, pendingVersion: 2,
        message: {
          id: null, seq: null, localId: 'pending-local', messageRole: 'user',
          content: mode === 'plain'
            ? { t: 'plain', v: payload }
            : { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32), 'legacy', payload)) },
          createdAt: 1_000, updatedAt: 1_000, providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      });
      await expect(api.materializeNextPendingMessageSafely()).resolves.toMatchObject({ type: 'materialized', localId: 'pending-local' });
      expect(delivered).toEqual([{ ...payload, localId: 'pending-local', createdAt: 1_000 }]);
      expect(custody.has('pending-local')).toBe(true);
    }
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('settles collaborator provenance and protected authority before projection or provider delivery', async () => {
    const callerInputConstraints = { models: [{ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'A' }], permissionModes: null };
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const request = {
      v: 1 as const,
      producer: 'happierApp' as const,
      caller: { kind: 'host' as const },
      permission: { requestedPermissionCeiling: 'read-only' as const },
    };
    const requestContent = {
      t: 'plain' as const,
      v: {
        role: 'user',
        callerInputConstraints: { models: null, permissionModes: null },
        content: { type: 'text', text: 'protected prompt' },
        localId: 'protected-local',
        meta: {
          happierProvenanceV1: { v: 1, kind: 'host', producer: 'happierApp' },
          happierInputRequestV1: request,
        },
      },
    };
    socketAckMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'protected-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'protected-local',
          messageRole: 'user',
          content: requestContent,
          inputAdmissionReceipt: {
            v: 1,
            issuer: 'authenticatedAccount',
            callerInputConstraints,
            actorAccountId: 'collaborator-account',
            sessionRelationship: 'sharedEditor',
          },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        result: { status: 'accepted', localId: 'protected-local' },
      });
    const deliver = vi.fn(() => true);
    const handleSessionScopedUpdate = vi.fn();
    const markPendingQueueMaterializedLocalId = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'safe-yolo' }),
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
      handleSessionScopedUpdate,
      markPendingQueueMaterializedLocalId,
    } as any);

    const outcome = await api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });

    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      decision: expect.objectContaining({ kind: 'admit' }),
    }));
    expect(outcome).toMatchObject({
      type: 'materialized',
      localId: 'protected-local',
      seq: null,
    });

    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      v: 1,
      sessionId: 's1',
      localId: 'protected-local',
      decision: expect.objectContaining({
        kind: 'admit',
        finalContent: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            meta: expect.objectContaining({
              happierInputAuthorityV1: expect.objectContaining({
                permission: {
                  requestedPermissionCeiling: 'read-only',
                  admittedPermissionCeiling: 'read-only',
                },
              }),
              happierProvenanceV1: {
                v: 1,
                kind: 'happierApp',
                actor: { kind: 'sharedCollaborator' },
              },
            }),
          }),
        }),
      }),
    }));
    expect(handleSessionScopedUpdate).toHaveBeenCalledTimes(1);
    expect(handleSessionScopedUpdate).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        message: expect.objectContaining({
          content: expect.objectContaining({
            v: expect.objectContaining({
              meta: expect.not.objectContaining({ happierInputRequestV1: expect.anything() }),
            }),
          }),
        }),
      }),
    }));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      callerInputConstraints,
      meta: expect.objectContaining({
        happierProvenanceV1: {
          v: 1,
          kind: 'happierApp',
          actor: { kind: 'sharedCollaborator' },
        },
        happierInputAuthorityV1: expect.objectContaining({
          permission: expect.objectContaining({ admittedPermissionCeiling: 'read-only' }),
        }),
      }),
    }), 'send', { v: 1, kind: 'enqueue' });
    expect(markPendingQueueMaterializedLocalId).toHaveBeenCalledWith('protected-local');
  });

  it('settles Workflow V2 provenance and authority through the existing Session permission owner', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const request = {
      v: 2 as const,
      producer: 'workflow' as const,
      caller: { kind: 'host' as const },
      workflow: {
        purpose: 'invocation' as const,
        runId: 'workflow-run-1',
        invocationRecordId: 'invocation-1',
      },
      permission: { requestedPermissionCeiling: 'read-only' as const },
    };
    socketAckMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'workflow-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'workflow-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'run workflow step' },
              meta: {
                happierProvenanceV1: {
                  v: 2,
                  kind: 'workflow_invocation',
                  runId: 'workflow-run-1',
                  invocationRecordId: 'invocation-1',
                },
                happierInputRequestV1: request,
              },
            },
          },
          inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        result: { status: 'accepted', localId: 'workflow-local' },
      });
    const deliver = vi.fn(() => true);
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'safe-yolo' }),
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
      handleSessionScopedUpdate,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'workflow-local',
    });
    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      decision: expect.objectContaining({
        kind: 'admit',
        finalContent: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            meta: expect.objectContaining({
              happierInputAuthorityV1: expect.objectContaining({
                v: 2,
                producer: 'workflow',
                workflow: request.workflow,
                permission: {
                  requestedPermissionCeiling: 'read-only',
                  admittedPermissionCeiling: 'read-only',
                },
              }),
              happierProvenanceV1: {
                v: 2,
                kind: 'workflow_invocation',
                runId: 'workflow-run-1',
                invocationRecordId: 'invocation-1',
              },
            }),
          }),
        }),
      }),
    }));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        happierInputAuthorityV1: expect.objectContaining({ v: 2, producer: 'workflow' }),
        happierProvenanceV1: expect.objectContaining({ v: 2, kind: 'workflow_invocation' }),
      }),
    }), 'send', { v: 1, kind: 'enqueue' });
  });

  it('never projects or delivers a protected input rejected by target settlement', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    socketAckMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'rejected-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'rejected-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'reject me' },
              meta: {
                happierInputRequestV1: {
                  v: 1,
                  producer: 'pluginSession',
                  caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
                  permission: { requestedPermissionCeiling: 'yolo' },
                },
              },
            },
          },
          inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        result: { status: 'rejected', code: 'session_input_permission_ceiling_rejected' },
      });
    const deliver = vi.fn(() => true);
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'read-only' }),
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
      handleSessionScopedUpdate,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(handleSessionScopedUpdate).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rejects an Account-admitted plugin assertion before projection or provider delivery', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    socketAckMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'forged-receipt-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'forged-receipt-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'forged provenance' },
              meta: {
                happierInputRequestV1: {
                  v: 1,
                  producer: 'pluginSession',
                  caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
                  permission: {},
                },
              },
            },
          },
          inputAdmissionReceipt: {
            v: 1,
            issuer: 'authenticatedAccount',
            actorAccountId: 'account-1',
            sessionRelationship: 'owner',
          },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        result: { status: 'rejected', code: 'session_input_untrusted_assertion' },
      });
    const deliver = vi.fn(() => true);
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'default' }),
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
      handleSessionScopedUpdate,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      decision: expect.objectContaining({
        kind: 'reject',
        code: 'session_input_untrusted_assertion',
      }),
    }));
    expect(handleSessionScopedUpdate).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('treats user-scoped socket connect as a best-effort snapshot wake boundary', async () => {
    const userSocket = createSocketStub();
    userSocket.connected = false;
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getUserSocket: () => userSocket as never,
      getMetadataVersion: () => 0,
      getAgentStateVersion: () => 0,
      getPendingWakeSeq: () => 0,
      syncSessionSnapshotFromServer,
    });

    const waitPromise = api.waitForMetadataUpdate();
    userSocket.connected = true;
    userSocket.trigger('connect');
    await expect(waitPromise).resolves.toBe(true);

    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'waitForMetadataUpdate' });
  });

  it('does not force a direct metadata-wait detail refresh when only agent state is unknown', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => -1,
      syncSessionSnapshotFromServer,
    });

    const abortController = new AbortController();
    const waitPromise = api.waitForMetadataUpdate(abortController.signal);
    await Promise.resolve();
    abortController.abort();
    await expect(waitPromise).resolves.toBe(false);

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('does not force a direct metadata-wait detail refresh when metadata is still unknown', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadataVersion: () => -1,
      getAgentStateVersion: () => -1,
      syncSessionSnapshotFromServer,
    });

    const abortController = new AbortController();
    const waitPromise = api.waitForMetadataUpdate(abortController.signal);
    await Promise.resolve();
    abortController.abort();
    await expect(waitPromise).resolves.toBe(false);

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('replays pending materialization debt after the provider-input consumer attaches', () => {
    let hasPendingDebt = false;
    const calls: string[] = [];
    const api = createApi({
      setProviderInputConsumer: vi.fn(() => {
        calls.push('consumer-attached');
      }),
      shouldAttemptPendingMaterialization: () => hasPendingDebt,
      wakePendingMaterialization: vi.fn(() => {
        calls.push('pending-wake');
      }),
    });

    hasPendingDebt = true;
    expect(calls).toEqual([]);

    api.onUserMessage(vi.fn());

    expect(calls).toEqual(['consumer-attached', 'pending-wake']);
  });

  it('schedules the bounded startup transcript retries after initial catch-up succeeds', async () => {
    let startupStarted = false;
    const catchUpSessionMessages = vi.fn(async () => {});
    const scheduleNextStartupMessageCatchUpRetry = vi.fn();
    const api = createApi({
      catchUpSessionMessages,
      scheduleNextStartupMessageCatchUpRetry,
      getStartupMessageCatchUpStarted: () => startupStarted,
      setStartupMessageCatchUpStarted: (value) => {
        startupStarted = value;
      },
    });

    api.onUserMessage(vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(catchUpSessionMessages).toHaveBeenCalledTimes(1);
    expect(scheduleNextStartupMessageCatchUpRetry).toHaveBeenCalledTimes(1);
  });

  it('marks startup catch-up as explicit when the attach payload provides an afterSeq cursor', async () => {
    let startupStarted = false;
    const catchUpSessionMessages = vi.fn(async () => {});
    const setStartupMessageCatchUpInitialAfterSeq = vi.fn();
    const api = createApi({
      catchUpSessionMessages,
      getLastObservedMessageSeq: () => 99,
      getStartupMessageCatchUpExplicitAfterSeq: () => 36,
      getStartupMessageCatchUpStarted: () => startupStarted,
      setStartupMessageCatchUpStarted: (value) => {
        startupStarted = value;
      },
      setStartupMessageCatchUpInitialAfterSeq,
    });

    api.onUserMessage(vi.fn());

    expect(setStartupMessageCatchUpInitialAfterSeq).toHaveBeenCalledWith(36);
    expect(catchUpSessionMessages).toHaveBeenCalledWith({
      afterSeq: 36,
    });
  });

  it('does not force a detail refresh for metadata-wait best effort when local versions are known', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadata: () => createTestMetadata({ flavor: 'claude' }),
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => 1,
      syncSessionSnapshotFromServer,
    });

    await api.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('does not force a metadata-wait detail refresh when authoritative local versions are known before metadata is populated', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadata: () => null,
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => 1,
      syncSessionSnapshotFromServer,
    });

    await api.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('does not force a metadata-wait detail refresh when only the local metadata version is authoritative', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadata: () => null,
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => -1,
      syncSessionSnapshotFromServer,
    });

    await api.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('forces an observable authoritative refresh even when local metadata is already populated', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadata: () => createTestMetadata({ flavor: 'claude' }),
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => 1,
      syncSessionSnapshotFromServer,
    });

    await expect(
      api.refreshSessionSnapshotFromServerRequired({
        reason: 'startup-drain',
      }),
    ).resolves.toBeUndefined();

    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({
      reason: 'startup-drain',
    });
  });

  it('rejects a required authoritative refresh when the canonical sync cannot apply a snapshot', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => false);
    const api = createApi({ syncSessionSnapshotFromServer });

    await expect(
      api.refreshSessionSnapshotFromServerRequired({
        reason: 'startup-drain',
      }),
    ).rejects.toThrow(/authoritative session snapshot/i);
  });
});
