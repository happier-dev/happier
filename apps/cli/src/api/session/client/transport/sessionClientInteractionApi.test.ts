import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionClientInteractionApi } from './sessionClientInteractionApi';

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
      clearAgentQueueEchoSuppressedLocalIdCleanupTimers: vi.fn(),
      clearPendingMaterializedState: vi.fn(),
      getPendingQueueMaterializedLocalIdsSize: () => 0,
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
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingVersion: 3 }),
    });

    await expect(api.discardPendingMessageQueueV2All({ reason: 'manual' })).rejects.toThrow('pending discard failed');
  });

  it('does not force a session-detail reconciliation for passive known-empty pending peeks', async () => {
    const syncSessionSnapshotFromServer = vi.fn();
    const api = createApi({
      shouldAttemptPendingMaterialization: () => false,
      getPendingQueueState: () => ({ known: true as const, pendingCount: 0, pendingVersion: 4 }),
      syncSessionSnapshotFromServer,
    });

    await expect(api.peekPendingMessageQueueV2Count()).resolves.toBe(0);

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('does not treat user-scoped socket connect as a session-detail catch-up boundary', async () => {
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

    const abortController = new AbortController();
    const waitPromise = api.waitForMetadataUpdate(abortController.signal);
    userSocket.connected = true;
    userSocket.trigger('connect');
    await Promise.resolve();
    abortController.abort();
    await expect(waitPromise).resolves.toBe(false);

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
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
      clearAgentQueueEchoSuppressedLocalIdCleanupTimers: vi.fn(),
      clearPendingMaterializedState: vi.fn(),
      getPendingQueueMaterializedLocalIdsSize: () => 0,
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
