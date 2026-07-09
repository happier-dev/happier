import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionClientInteractionApi } from './sessionClientInteractionApi';
import { encrypt } from '../../../encryption';
import { handleSessionNewMessageUpdate } from '../../sessionNewMessageUpdate';

const axiosGetMock = vi.hoisted(() => vi.fn());
const axiosPostMock = vi.hoisted(() => vi.fn());

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

function createMaterializeAxiosError(): AxiosError {
  return new AxiosError('materialize failed', 'ERR_BAD_RESPONSE', {
    method: 'post',
    url: 'https://api.example.test/v2/sessions/s1/pending/materialize-next?token=SECRET',
    headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
  }, undefined, {
    data: { error: 'pending_conflict' },
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
}

function createSocketStub() {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  return {
    connected: true,
    emit: vi.fn(),
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
}

describe('createSessionClientInteractionApi diagnostics', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();
    vi.restoreAllMocks();
  });

  function createApi(overrides: Partial<Parameters<typeof createSessionClientInteractionApi>[0]> = {}) {
    const socket = createSocketStub();
    return createSessionClientInteractionApi({
      sessionId: 's1',
      token: 'token-1',
      getClosed: () => false,
      setClosed: vi.fn(),
      getSocket: () => socket as never,
      getUserSocket: () => socket as never,
      getSessionConnectionSupervisor: () => null,
      getRpcHandlerManager: () => ({ handleRequest: vi.fn(async () => null) }),
      getMetadata: () => null,
      setMetadata: vi.fn(),
      getMetadataVersion: () => 0,
      setMetadataVersion: vi.fn(),
      onMetadataUpdated: vi.fn(),
      offMetadataUpdated: vi.fn(),
      getAgentStateVersion: () => 0,
      getPendingWakeSeq: () => 0,
      getPendingMessages: () => [],
      getPendingMessageCallback: () => null,
      setPendingMessageCallback: vi.fn(),
      getUserMessageCallbackAttachedAtMs: () => null,
      setUserMessageCallbackAttachedAtMs: vi.fn(),
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
      getDaemonInitialPrompt: () => null,
      setDaemonInitialPrompt: vi.fn(),
      getDaemonInitialPromptSeeded: () => true,
      setDaemonInitialPromptSeeded: vi.fn(),
      enqueueSessionUserMessage: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      reconcileTurnStatusBeforePendingMaterialization: vi.fn(async () => true),
      maybeScheduleUserSocketDisconnect: vi.fn(),
      handleSessionScopedUpdate: vi.fn(),
      clearStartupMessageCatchUpRetryTimer: vi.fn(),
      stopStaleSafety: vi.fn(),
      clearCommittedLocalIdCleanupTimers: vi.fn(),
      clearPendingMaterializedState: vi.fn(),
      getPendingQueueMaterializedLocalIdsSize: () => 0,
      markPendingQueueMaterializedLocalId: vi.fn(),
      shouldAttemptPendingMaterialization: () => true,
      getPendingQueueState: () => ({ known: false as const }),
      applyPendingQueueState: vi.fn(() => false),
      observePendingMaterializeResult: vi.fn(() => false),
      onPendingQueueStateChanged: vi.fn(),
      scheduleMaterializationRecovery: vi.fn(),
      getMetadataLock: () => ({
        inLock: async <T>(fn: () => Promise<T>) => await fn(),
      }),
      getSessionEncryptionMode: () => 'plain' as const,
      getEncryptionKey: () => new Uint8Array(32),
      getEncryptionVariant: () => 'legacy' as const,
      ...overrides,
    });
  }

  it('logs structured axios diagnostics when pending materialization fails', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    axiosPostMock.mockRejectedValueOnce(createMaterializeAxiosError());
    const api = createApi({
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
    });

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(debugSpy).toHaveBeenCalledWith('[pendingQueue] materialize request failed', {
      sessionId: 's1',
      error: expect.objectContaining({
        code: 'ERR_BAD_RESPONSE',
        status: 409,
        method: 'POST',
        url: 'https://api.example.test/v2/sessions/s1/pending/materialize-next',
      }),
    });
    expect(JSON.stringify(debugSpy.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(debugSpy.mock.calls)).not.toContain('HEADER_SECRET');
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
      }),
    });

    await expect(api.reconcilePendingQueueState({ force: true })).resolves.toBe(true);
  });

  it('blocks provider deliveries before close marks the client closed and clears pending state', async () => {
    const calls: string[] = [];
    const blockProviderDeliveriesBeforeClose = vi.fn(async () => {
      calls.push('block-provider-deliveries');
    });
    const setClosed = vi.fn(() => {
      calls.push('set-closed');
    });
    const clearPendingMaterializedState = vi.fn(() => {
      calls.push('clear-pending-state');
    });
    const api = createApi({
      blockProviderDeliveriesBeforeClose,
      setClosed,
      clearPendingMaterializedState,
    } as any);

    await api.close();

    expect(blockProviderDeliveriesBeforeClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'block-provider-deliveries',
      'set-closed',
      'clear-pending-state',
    ]);
  });

  it('requests provider-owned pending materialization only when the runtime opts into provider delivery state', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId: 'provider-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'provider-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'provider prompt' },
              localId: 'provider-local',
            },
          },
          deliveryState: { mode: 'provider', unresolved: true },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      handleSessionScopedUpdate,
      shouldRequestProviderDeliveryState: () => true,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-local',
      seq: null,
      deliveryState: { mode: 'provider', unresolved: true },
    });

    expect(axiosPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/pending/materialize-next'),
      { deliveryState: 'provider' },
      expect.any(Object),
    );
    expect(handleSessionScopedUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns runtime-activity deferral when runtime-idle pending delivery timing is still blocked', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: false,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 7,
        deliveryState: { mode: 'awaiting_runtime_idle', unresolved: true },
      },
    });
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
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

    expect(axiosPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/pending/materialize-next'),
      { deliveryTiming: 'after_runtime_idle' },
      expect.any(Object),
    );
    expect(handleSessionScopedUpdate).not.toHaveBeenCalled();
  });

  it('defers runtime-idle materialization locally when the owning runtime still has active runtime activity', async () => {
    const api = createApi({
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

    expect(axiosPostMock).not.toHaveBeenCalled();
  });


  it('delivers encrypted provider claim materialization with null seq and null server role metadata', async () => {
    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(9);
    const ciphertext = Buffer.from(encrypt(encryptionKey, 'legacy', {
      role: 'user',
      content: { type: 'text', text: 'encrypted provider claim prompt' },
      localId: 'provider-claim-local',
    })).toString('base64');

    axiosPostMock.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId: 'provider-claim-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        deliveryState: { mode: 'provider', unresolved: true },
        message: {
          id: null,
          seq: null,
          localId: 'provider-claim-local',
          messageRole: null,
          content: { t: 'encrypted', c: ciphertext },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });
    const pendingMessages: any[] = [];
    const handleSessionScopedUpdate = vi.fn((update) => {
      handleSessionNewMessageUpdate({
        update,
        sessionId: 's1',
        encryptionKey,
        encryptionVariant: 'legacy',
        receivedMessageIds: new Set<string>(),
        lastObservedMessageSeq: 0,
        lastObservedUserMessageSeq: 0,
        hasSelfEchoSuppressedLocalId: () => false,
        hasAgentQueueEchoSuppressedLocalId: () => false,
        markAgentQueueEchoSuppressedLocalId: () => void 0,
        hasPendingQueueMaterializedLocalId: () => true,
        deleteMaterializedLocalId: () => void 0,
        pendingMessageCallback: (message) => {
          pendingMessages.push(message);
        },
        pendingMessages,
        emit: () => void 0,
        debug: () => void 0,
        debugLargeJson: () => void 0,
      });
    });
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      handleSessionScopedUpdate,
      shouldRequestProviderDeliveryState: () => true,
      getSessionEncryptionMode: () => 'e2ee',
      getEncryptionKey: () => encryptionKey,
      getEncryptionVariant: () => 'legacy',
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-claim-local',
      seq: null,
      deliveryState: { mode: 'provider', unresolved: true },
    });

    expect(handleSessionScopedUpdate).toHaveBeenCalledTimes(1);
    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content).toEqual({ type: 'text', text: 'encrypted provider claim prompt' });
  });

  it('delivers row-first unresolved daemon initial provider materialization through the provider queue', async () => {
    const localId = 'daemon-initial-prompt:s1';
    axiosPostMock.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId,
        didWrite: true,
        pendingCount: 1,
        pendingVersion: 2,
        deliveryState: { mode: 'provider', unresolved: true },
        message: {
          id: 'm-row-first-provider',
          seq: 1,
          localId,
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'row-first daemon provider prompt' },
              localId,
              meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
            },
          },
          deliveryState: { mode: 'provider', unresolved: true },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });
    const pendingMessages: any[] = [];
    const handleSessionScopedUpdate = vi.fn((update) => {
      handleSessionNewMessageUpdate({
        update,
        sessionId: 's1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        receivedMessageIds: new Set<string>(),
        lastObservedMessageSeq: 0,
        lastObservedUserMessageSeq: 0,
        hasSelfEchoSuppressedLocalId: () => false,
        hasAgentQueueEchoSuppressedLocalId: () => false,
        hasAgentQueueDeliveredLocalId: () => false,
        markAgentQueueEchoSuppressedLocalId: () => void 0,
        markAgentQueueDeliveredLocalId: () => void 0,
        hasPendingQueueMaterializedLocalId: () => true,
        deleteMaterializedLocalId: () => void 0,
        pendingMessageCallback: (message) => {
          pendingMessages.push(message);
        },
        pendingMessages,
        emit: () => void 0,
        debug: () => void 0,
        debugLargeJson: () => void 0,
      });
    });
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      handleSessionScopedUpdate,
      shouldRequestProviderDeliveryState: () => true,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
      seq: 1,
      deliveryState: { mode: 'provider', unresolved: true },
    });

    expect(handleSessionScopedUpdate).toHaveBeenCalledTimes(1);
    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.localId).toBe(localId);
    expect(pendingMessages[0]?.content).toEqual({ type: 'text', text: 'row-first daemon provider prompt' });
  });

  it('normalizes top-level ack local id into provider-claimed materialized message ownership', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    axiosPostMock.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId: 'provider-claim-top-level',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        deliveryState,
        message: {
          id: null,
          seq: null,
          localId: null,
          messageRole: null,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'provider claim top-level id prompt' },
              localId: 'provider-claim-top-level',
            },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });
    const handleSessionScopedUpdate = vi.fn();
    const observeMaterializedPendingDeliveryState = vi.fn();
    const markPendingQueueMaterializedLocalId = vi.fn();
    const scheduleMaterializationRecovery = vi.fn();
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      handleSessionScopedUpdate,
      observeMaterializedPendingDeliveryState,
      markPendingQueueMaterializedLocalId,
      scheduleMaterializationRecovery,
      shouldRequestProviderDeliveryState: () => true,
    });

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-claim-top-level',
      seq: null,
      deliveryState,
    });

    expect(observeMaterializedPendingDeliveryState).toHaveBeenCalledWith({
      localId: 'provider-claim-top-level',
      deliveryState,
    });
    expect(markPendingQueueMaterializedLocalId).toHaveBeenCalledWith('provider-claim-top-level');
    expect(scheduleMaterializationRecovery).not.toHaveBeenCalled();
    expect(handleSessionScopedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          message: expect.objectContaining({
            id: 'pending-claim:provider-claim-top-level:1000',
            localId: 'provider-claim-top-level',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('infers provider claim ownership for uncommitted materialization with opaque id and omitted delivery state', async () => {
    const inferredDeliveryState = { mode: 'provider' as const, unresolved: true };
    axiosPostMock.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId: 'provider-claim-opaque-id',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: 'opaque-pending-materialization-id',
          seq: null,
          localId: 'provider-claim-opaque-id',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'opaque id provider claim prompt' },
              localId: 'provider-claim-opaque-id',
            },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });
    const handleSessionScopedUpdate = vi.fn();
    const observeMaterializedPendingDeliveryState = vi.fn();
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      handleSessionScopedUpdate,
      observeMaterializedPendingDeliveryState,
      shouldRequestProviderDeliveryState: () => true,
    });

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-claim-opaque-id',
      seq: null,
      deliveryState: inferredDeliveryState,
    });

    expect(observeMaterializedPendingDeliveryState).toHaveBeenCalledWith({
      localId: 'provider-claim-opaque-id',
      deliveryState: inferredDeliveryState,
    });
    expect(handleSessionScopedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          message: expect.objectContaining({
            id: 'opaque-pending-materialization-id',
            seq: null,
            localId: 'provider-claim-opaque-id',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('normalizes stale resolved provider state on uncommitted provider claim materialization', async () => {
    const normalizedDeliveryState = { mode: 'provider' as const, unresolved: true };
    axiosPostMock.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId: 'provider-claim-resolved-state',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        deliveryState: { mode: 'provider', unresolved: false },
        message: {
          id: 'opaque-resolved-state-materialization-id',
          seq: null,
          localId: 'provider-claim-resolved-state',
          messageRole: 'user',
          deliveryState: { mode: 'provider', unresolved: false },
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'resolved-state provider claim prompt' },
              localId: 'provider-claim-resolved-state',
            },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });
    const handleSessionScopedUpdate = vi.fn();
    const observeMaterializedPendingDeliveryState = vi.fn();
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      handleSessionScopedUpdate,
      observeMaterializedPendingDeliveryState,
      shouldRequestProviderDeliveryState: () => true,
    });

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-claim-resolved-state',
      seq: null,
      deliveryState: normalizedDeliveryState,
    });

    expect(observeMaterializedPendingDeliveryState).toHaveBeenCalledWith({
      localId: 'provider-claim-resolved-state',
      deliveryState: normalizedDeliveryState,
    });
    expect(handleSessionScopedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          message: expect.objectContaining({
            id: 'opaque-resolved-state-materialization-id',
            seq: null,
            localId: 'provider-claim-resolved-state',
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('blocks malformed provider delivery metadata by local id before returning no pending work', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: {
        ok: true,
        didMaterialize: true,
        localId: 'malformed-provider-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        deliveryState: { mode: 'provider', unresolved: 'bad-shape' },
        message: {
          id: null,
          seq: null,
          localId: 'malformed-provider-local',
          messageRole: null,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'malformed metadata prompt' },
              localId: 'malformed-provider-local',
            },
          },
          deliveryState: { mode: 'provider', unresolved: 'bad-shape' },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      },
    });
    const blockMalformedPendingDelivery = vi.fn(async () => ({
      pendingQueueState: { known: true as const, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
    }));
    const applyPendingQueueState = vi.fn(() => true);
    const onPendingQueueStateChanged = vi.fn();
    const handleSessionScopedUpdate = vi.fn();
    const observeMaterializedPendingDeliveryState = vi.fn();
    const shouldAttemptPendingMaterialization = vi.fn(() => true);
    const reconcileTurnStatusBeforePendingMaterialization = vi.fn(async () => true);
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      applyPendingQueueState,
      observePendingMaterializeResult: vi.fn(() => false),
      onPendingQueueStateChanged,
      handleSessionScopedUpdate,
      observeMaterializedPendingDeliveryState,
      blockMalformedPendingDelivery,
      shouldAttemptPendingMaterialization,
      reconcileTurnStatusBeforePendingMaterialization,
      shouldRequestProviderDeliveryState: () => true,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(blockMalformedPendingDelivery).toHaveBeenCalledWith({
      localId: 'malformed-provider-local',
      reason: 'unknown',
    });
    expect(applyPendingQueueState).toHaveBeenCalledWith({
      known: true,
      pendingCount: 1,
      pendingBlockedCount: 1,
      pendingVersion: 3,
    });
    expect(onPendingQueueStateChanged).toHaveBeenCalledTimes(1);
    expect(handleSessionScopedUpdate).not.toHaveBeenCalled();
    expect(observeMaterializedPendingDeliveryState).not.toHaveBeenCalled();
  });

  it('retries accepted provider delivery resolution before the materialization gate can defer', async () => {
    const retryAcceptedCanonicalPendingDeliveryResolutions = vi.fn(async () => {});
    const shouldAttemptPendingMaterialization = vi.fn(() => false);
    const reconcileTurnStatusBeforePendingMaterialization = vi.fn(async () => false);
    const api = createApi({
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      shouldAttemptPendingMaterialization,
      reconcileTurnStatusBeforePendingMaterialization,
      retryAcceptedCanonicalPendingDeliveryResolutions,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'skip' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(retryAcceptedCanonicalPendingDeliveryResolutions).toHaveBeenCalledBefore(shouldAttemptPendingMaterialization);
  });

  it('reconciles stale accepted-through seqs before materializing queued rows', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: {
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
        },
      },
    });
    const reconcileAcceptedPendingDeliveriesThroughSeq = vi.fn(async () => ({
      pendingQueueState: { known: true as const, pendingCount: 1, pendingVersion: 2 },
    }));
    const api = createApi({
      getSocket: () => ({ connected: false }) as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 2, pendingVersion: 1 }),
      observePendingMaterializeResult: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      getAcceptedUserMessageDeliverySeqForPendingReconciliation: () => 1809,
      reconcileAcceptedPendingDeliveriesThroughSeq,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'legacy-local',
      seq: 1810,
    });

    expect(reconcileAcceptedPendingDeliveriesThroughSeq).toHaveBeenCalledWith(1809);
    expect(axiosPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/pending/materialize-next'),
      {},
      expect.any(Object),
    );
  });

  it('treats user-scoped socket connect as a best-effort snapshot wake boundary', async () => {
    const userSocket = createSocketStub();
    userSocket.connected = false;
    const syncSessionSnapshotFromServer = vi.fn(async () => {});
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
    const syncSessionSnapshotFromServer = vi.fn(async () => {});
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
    const syncSessionSnapshotFromServer = vi.fn(async () => {});
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

  it('captures the startup catch-up baseline before seeding but starts catch-up after daemon prompt suppression is installed', async () => {
    let startupStarted = false;
    let daemonInitialPrompt: string | null = 'daemon-startup-prompt';
    let daemonInitialPromptSeeded = false;
    let lastObservedMessageSeq = 0;
    const catchUpSessionMessages = vi.fn(async () => {});
    const enqueueSessionUserMessage = vi.fn(() => {
      lastObservedMessageSeq = 1;
    });
    const setStartupMessageCatchUpInitialAfterSeq = vi.fn();
    const api = createApi({
      catchUpSessionMessages,
      enqueueSessionUserMessage,
      getLastObservedMessageSeq: () => lastObservedMessageSeq,
      getStartupMessageCatchUpStarted: () => startupStarted,
      setStartupMessageCatchUpStarted: (value) => {
        startupStarted = value;
      },
      setStartupMessageCatchUpInitialAfterSeq,
      getDaemonInitialPrompt: () => daemonInitialPrompt,
      setDaemonInitialPrompt: (value) => {
        daemonInitialPrompt = value;
      },
      getDaemonInitialPromptSeeded: () => daemonInitialPromptSeeded,
      setDaemonInitialPromptSeeded: (value) => {
        daemonInitialPromptSeeded = value;
      },
    });

    api.onUserMessage(vi.fn());

    expect(setStartupMessageCatchUpInitialAfterSeq).toHaveBeenCalledWith(0);
    expect(enqueueSessionUserMessage).toHaveBeenCalledWith({
      text: 'daemon-startup-prompt',
      localId: 'daemon-initial-prompt:s1',
      meta: {
        source: 'daemon-initial-prompt',
        sentFrom: 'cli',
      },
    });
    expect(catchUpSessionMessages).toHaveBeenCalledWith({
      afterSeq: 0,
      authorization: 'startup_recovery',
    });
    expect(setStartupMessageCatchUpInitialAfterSeq.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueSessionUserMessage.mock.invocationCallOrder[0],
    );
    expect(enqueueSessionUserMessage.mock.invocationCallOrder[0]).toBeLessThan(
      catchUpSessionMessages.mock.invocationCallOrder[0],
    );
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
      authorization: 'explicit_cursor',
    });
  });

  it('does not force a detail refresh for metadata-wait best effort when local versions are known', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => {});
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
    const syncSessionSnapshotFromServer = vi.fn(async () => {});
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
    const syncSessionSnapshotFromServer = vi.fn(async () => {});
    const api = createApi({
      getMetadata: () => null,
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => -1,
      syncSessionSnapshotFromServer,
    });

    await api.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('redacts startup transcript catch-up failures before logging', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    let startupStarted = false;
    const socket = createSocketStub();

    const api = createSessionClientInteractionApi({
      sessionId: 's1',
      token: 'token-1',
      getClosed: () => false,
      setClosed: vi.fn(),
      getSocket: () => socket as never,
      getUserSocket: () => socket as never,
      getSessionConnectionSupervisor: () => null,
      getRpcHandlerManager: () => ({ handleRequest: vi.fn(async () => null) }),
      getMetadata: () => null,
      setMetadata: vi.fn(),
      getMetadataVersion: () => 0,
      setMetadataVersion: vi.fn(),
      onMetadataUpdated: vi.fn(),
      offMetadataUpdated: vi.fn(),
      getAgentStateVersion: () => 0,
      getPendingWakeSeq: () => 0,
      getPendingMessages: () => [],
      getPendingMessageCallback: () => null,
      setPendingMessageCallback: vi.fn(),
      getUserMessageCallbackAttachedAtMs: () => null,
      setUserMessageCallbackAttachedAtMs: vi.fn(),
      clearUserSocketDisconnectTimer: vi.fn(),
      kickUserSocketConnect: vi.fn(),
      catchUpSessionMessages: async () => {
        throw createSecretAxiosError();
      },
      scheduleNextStartupMessageCatchUpRetry: vi.fn(),
      getLastObservedMessageSeq: () => 0,
      getStartupMessageCatchUpExplicitAfterSeq: () => null,
      getStartedByDaemonProcess: () => true,
      getMetadataStartedBy: () => null,
      getMetadataStartedFromDaemon: () => null,
      getStartupMessageCatchUpStarted: () => startupStarted,
      setStartupMessageCatchUpStarted: (value) => {
        startupStarted = value;
      },
      setStartupMessageCatchUpRetryIndex: vi.fn(),
      setStartupMessageCatchUpInitialAfterSeq: vi.fn(),
      getDaemonInitialPrompt: () => null,
      setDaemonInitialPrompt: vi.fn(),
      getDaemonInitialPromptSeeded: () => true,
      setDaemonInitialPromptSeeded: vi.fn(),
      enqueueSessionUserMessage: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      reconcileTurnStatusBeforePendingMaterialization: vi.fn(async () => true),
      maybeScheduleUserSocketDisconnect: vi.fn(),
      handleSessionScopedUpdate: vi.fn(),
      clearStartupMessageCatchUpRetryTimer: vi.fn(),
      stopStaleSafety: vi.fn(),
      clearCommittedLocalIdCleanupTimers: vi.fn(),
      clearPendingMaterializedState: vi.fn(),
      getPendingQueueMaterializedLocalIdsSize: () => 0,
      markPendingQueueMaterializedLocalId: vi.fn(),
      shouldAttemptPendingMaterialization: () => false,
      getPendingQueueState: () => ({ known: false }),
      applyPendingQueueState: vi.fn(() => false),
      observePendingMaterializeResult: vi.fn(() => false),
      onPendingQueueStateChanged: vi.fn(),
      scheduleMaterializationRecovery: vi.fn(),
      getMetadataLock: () => ({ inLock: async (fn) => await fn() }),
      getSessionEncryptionMode: () => 'plain',
      getEncryptionKey: () => new Uint8Array(32),
      getEncryptionVariant: () => 'legacy',
    });

    api.onUserMessage(vi.fn());

    await expect.poll(() => JSON.stringify(debugSpy.mock.calls)).toContain('[API] Initial transcript catch-up failed');

    const calls = JSON.stringify(debugSpy.mock.calls);
    expect(calls).not.toContain('MESSAGE_SECRET');
    expect(calls).not.toContain('QUERY_SECRET');
    expect(calls).not.toContain('HEADER_SECRET');
    expect(calls).not.toContain('BODY_SECRET');
    expect(calls).not.toContain('"headers"');
    expect(calls).not.toContain('"data"');
  });
});
