import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionClientInteractionApi } from './sessionClientInteractionApi';
import { encrypt } from '../../../encryption';

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
      getEncryptionKey: () => new Uint8Array(32),
      getEncryptionVariant: () => 'legacy' as const,
      ...overrides,
    });
  }

  it.each(['indeterminate', 'auth_failed'] as const)('delivers zero provider input for %s compatibility', async (mode) => {
    const socket = createSocketStub();
    const contractResult = { mode, sessionConnectionEpoch: 1, socket };
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

  it('does not let an old auth result poison a replacement connection epoch', async () => {
    const oldSocket = createSocketStub();
    const newSocket = createSocketStub();
    const staleAuthResult = { mode: 'auth_failed' as const, sessionConnectionEpoch: 1, socket: oldSocket };
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

  it('uses only the strict released-server adapter in old mode', async () => {
    const socket = createSocketStub();
    const contractResult = { mode: 'released_server_v0_2_1' as const, sessionConnectionEpoch: 3, socket };
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
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'old prompt' } } },
        },
      },
    });
    const deliver = vi.fn(() => true);
    const supervisor = { getState: () => ({ phase: 'online' }) };
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 3,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => supervisor as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      deliverMaterializedUserMessageToAgentQueue: deliver,
    });

    await expect(api.materializeNextPendingMessageSafely()).resolves.toMatchObject({
      type: 'materialized', localId: 'old-local', seq: 8,
    });
    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', { sid: 's1' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('does not fall back to HTTP when current materialization has no bound socket', async () => {
    const disconnectedSocket = { connected: false };
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
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

  it('keeps server-owned runtime-activity deferral queued without a local Activity state', async () => {
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
      reason: 'runtime_activity_active',
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

  it('materializes queued rows without sequence-based reconciliation', async () => {
    const socket = createSocketStub();
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

  it('does not schedule startup transcript retry after initial catch-up succeeds', async () => {
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
    expect(scheduleNextStartupMessageCatchUpRetry).not.toHaveBeenCalled();
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
