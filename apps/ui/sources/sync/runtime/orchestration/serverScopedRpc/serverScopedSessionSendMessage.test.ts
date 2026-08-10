import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const runtimeFetchWithServerReachabilityMock = vi.hoisted(() => vi.fn());
const kvStore = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
  class MMKV {
    getString(key: string) {
      return kvStore.get(key);
    }
    set(key: string, value: string) {
      kvStore.set(key, value);
    }
    delete(key: string) {
      kvStore.delete(key);
    }
    getAllKeys() {
      return [...kvStore.keys()];
    }
    clearAll() {
      kvStore.clear();
    }
  }

  return { MMKV };
});

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
  getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
  runtimeFetchWithServerReachability: runtimeFetchWithServerReachabilityMock,
}));

import { loadPendingOutboxForSession } from '@/sync/domains/state/pendingOutboxPersistence';
import { storage } from '@/sync/domains/state/storage';
import { parseReleasedServerV021Features } from '@/dev/testkit';
import {
  buildSession,
  resetPendingQueueState,
} from '@/sync/engine/pending/pendingQueueV2.testHelpers';

import { createServerScopedSessionSendMessage } from './serverScopedSessionSendMessage';

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    active: true,
    activeAt: Date.now(),
    presence: 'online',
    encryptionMode: 'plain',
    permissionMode: 'default',
    metadata: { flavor: 'claude' },
    agentStateVersion: 1,
    agentState: null,
    thinking: false,
    thinkingAt: 0,
    runtimeActivityState: 'idle',
    runtimeActivityRevision: 1,
    ...overrides,
  } as any;
}

function createHarness(params?: Readonly<{
  session?: ReturnType<typeof activeSession> | null;
  enqueueResult?: Readonly<{ localId: string; accepted: boolean; cancelled?: true; terminal?: true }>;
}>) {
  const enqueuePendingMessageActive = vi.fn(async () => params?.enqueueResult ?? {
    localId: 'local-1',
    accepted: true,
  });
  const schedulePendingOutboxRetry = vi.fn();
  const subject = createServerScopedSessionSendMessage({
    getSession: () => params?.session === undefined ? activeSession() : params.session,
    resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })) as any,
    getScopedSessionEncryption: vi.fn(async () => ({ encryptRawRecord: vi.fn(async () => 'cipher') })),
    enqueuePendingMessageActive,
    schedulePendingOutboxRetry,
  });
  return { ...subject, enqueuePendingMessageActive, schedulePendingOutboxRetry };
}

function currentPendingInputFeatures() {
  return {
    status: 'ready',
    features: {
      capabilities: {
        compatibility: {
          pendingInput: { currentPendingInputProtocolVersion: 1 },
        },
        session: {
          pendingInput: { protocolVersion: 1 },
        },
      },
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
    },
  } as any;
}

function releasedServerV021Features() {
  return {
    status: 'ready',
    features: parseReleasedServerV021Features(),
  } as any;
}

function releasedPendingAck(localId: string): Response {
  return Response.json({
    didWrite: true,
    pending: {
      localId,
      content: {
        t: 'plain',
        v: { role: 'user', content: { type: 'text', text: 'scoped prompt' } },
      },
      status: 'queued',
      position: 1,
      createdAt: 100,
      updatedAt: 100,
      discardedAt: null,
      discardedReason: null,
      authorAccountId: 'account-b',
    },
    pendingCount: 1,
    pendingVersion: 1,
  });
}

function createScopedHarness(params?: Readonly<{
  markSessionLiveTailIntent?: (sessionId: string) => void;
}>) {
  const session = buildSession({
    sessionId: 's1',
    overrides: { encryptionMode: 'plain' },
  });
  storage.getState().applySessions([session]);
  const schedulePendingOutboxRetry = vi.fn();
  const subject = createServerScopedSessionSendMessage({
    getSession: () => session,
    resolveContext: vi.fn(async () => ({
      scope: 'scoped' as const,
      timeoutMs: 1_000,
      targetServerId: 'server-b',
      targetServerUrl: 'https://server-b.example',
      targetAccountId: 'account-b',
      token: 'token-b',
      encryption: {} as any,
    })) as any,
    getScopedSessionEncryption: vi.fn(async () => ({ encryptRawRecord: vi.fn(async () => 'cipher') })),
    enqueuePendingMessageActive: vi.fn(),
    schedulePendingOutboxRetry,
    markSessionLiveTailIntent: params?.markSessionLiveTailIntent ?? vi.fn(),
  });
  return { ...subject, schedulePendingOutboxRetry };
}

describe('sendSessionMessageWithServerScope', () => {
  beforeEach(() => {
    resetPendingQueueState();
    kvStore.clear();
    getServerFeaturesSnapshotMock.mockReset();
    runtimeFetchWithServerReachabilityMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects missing session ids and blank messages before enqueue', async () => {
    const harness = createHarness();

    await expect(harness.sendSessionMessageWithServerScope({ sessionId: '', message: 'hello' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(harness.sendSessionMessageWithServerScope({ sessionId: 's1', message: '   ' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(harness.enqueuePendingMessageActive).not.toHaveBeenCalled();
  });

  it('persists a first-turn send_now action on the pending row', async () => {
    const harness = createHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue(currentPendingInputFeatures());

    const result = await harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'first prompt',
      localId: 'first-local',
      providerDeliveryIntent: 'first_turn',
    });

    expect(harness.enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      'first prompt',
      undefined,
      undefined,
      { localId: 'first-local', requestedAction: { v: 1, kind: 'send_now' } },
    );
    expect(result).toEqual({
      ok: true,
      ack: { ok: true, localId: 'local-1', persistence: 'pending', accepted: false },
    });
  });

  it('maps an active-server first turn to ordinary enqueue for the released server contract', async () => {
    const harness = createHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue(releasedServerV021Features());

    await harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'first prompt',
      localId: 'released-active-first',
      providerDeliveryIntent: 'first_turn',
    });

    expect(harness.enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      'first prompt',
      undefined,
      undefined,
      { localId: 'released-active-first', requestedAction: { v: 1, kind: 'enqueue' } },
    );
  });

  it('retains an active-server first turn as ordinary enqueue while the wire contract is indeterminate', async () => {
    const harness = createHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'timeout' });

    await harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'first prompt',
      localId: 'indeterminate-active-first',
      providerDeliveryIntent: 'first_turn',
    });

    expect(harness.enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      'first prompt',
      undefined,
      undefined,
      { localId: 'indeterminate-active-first', requestedAction: { v: 1, kind: 'enqueue' } },
    );
  });

  it('persists ordinary active input with the canonical enqueue action', async () => {
    const harness = createHarness();

    await harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'later prompt',
      displayText: 'Later prompt',
      profileId: 'profile-1',
      metaOverrides: { source: 'rpc' },
      localId: 'later-local',
    });

    expect(harness.enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      'later prompt',
      'Later prompt',
      { source: 'rpc', profileId: 'profile-1' },
      { localId: 'later-local', requestedAction: { v: 1, kind: 'enqueue' } },
    );
  });

  it('preserves an explicit settings-aware steering action from the action executor', async () => {
    const harness = createHarness();

    await harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'steer when configured',
      localId: 'settings-aware-local',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    expect(harness.enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      'steer when configured',
      undefined,
      undefined,
      { localId: 'settings-aware-local', requestedAction: { v: 1, kind: 'steer_if_active' } },
    );
  });

  it('reports cancellation without a second delivery path', async () => {
    const harness = createHarness({
      enqueueResult: { localId: 'cancelled-local', accepted: false, cancelled: true },
    });

    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'cancelled prompt',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'PENDING_MESSAGE_CANCELLED',
      error: 'Pending message was cancelled before dispatch',
    });
    expect(harness.enqueuePendingMessageActive).toHaveBeenCalledTimes(1);
  });

  it('uses the current Pending serializer for the resolved non-active target server', async () => {
    const harness = createScopedHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue(currentPendingInputFeatures());
    runtimeFetchWithServerReachabilityMock.mockImplementation(async ({ init }: { init: RequestInit }) => {
      expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
        localId: 'scoped-current',
        messageRole: 'user',
        requestedAction: { v: 1, kind: 'enqueue' },
        content: expect.any(Object),
      }));
      return Response.json({
        requestedAction: { v: 1, kind: 'enqueue' },
        pending: { localId: 'scoped-current' },
      });
    });

    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-b',
      localId: 'scoped-current',
      message: 'scoped prompt',
    })).resolves.toMatchObject({ ok: true });

    expect(getServerFeaturesSnapshotMock).toHaveBeenCalledWith({ serverId: 'server-b' });
    expect(runtimeFetchWithServerReachabilityMock).toHaveBeenCalledTimes(1);
  });

  it('establishes live-tail intent before a scoped first-turn pending projection', async () => {
    const { sync } = await import('@/sync/sync');
    const harness = createScopedHarness({
      markSessionLiveTailIntent: (sessionId) => sync.markSessionLiveTailIntent(sessionId),
    });
    sync.onSessionViewportChange('s1', {
      isPinned: false,
      offsetY: 420,
      shouldPersistViewport: false,
      shouldRestoreViewport: true,
      anchor: {
        kind: 'message',
        messageId: 'message-1',
        seq: 1,
        itemId: 'msg:message-1',
        itemOffsetPx: 12,
        capturedAtMs: 1_000,
      },
    });
    expect(sync.getSessionViewport('s1')).toMatchObject({
      isPinned: false,
      source: 'observed',
    });

    const originalMarkOptimisticThinking = storage.getState().markSessionOptimisticThinking;
    const markOptimisticThinking = vi
      .spyOn(storage.getState(), 'markSessionOptimisticThinking')
      .mockImplementation((sessionId) => {
        expect(sessionId).toBe('s1');
        expect(sync.getSessionViewport('s1')).toMatchObject({
          isPinned: true,
          offsetY: 0,
          source: 'default',
          anchor: null,
        });
        originalMarkOptimisticThinking(sessionId);
      });
    getServerFeaturesSnapshotMock.mockResolvedValue(currentPendingInputFeatures());
    runtimeFetchWithServerReachabilityMock.mockResolvedValue(Response.json({
      requestedAction: { v: 1, kind: 'send_now' },
      pending: { localId: 'scoped-cross-mount-first-turn' },
    }));

    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-b',
      localId: 'scoped-cross-mount-first-turn',
      message: 'scoped first prompt',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true });

    expect(markOptimisticThinking).toHaveBeenCalled();
  });

  it('preserves send_now for a spawn-first first prompt on the current server contract', async () => {
    const harness = createScopedHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue(currentPendingInputFeatures());
    runtimeFetchWithServerReachabilityMock.mockImplementation(async ({ init }: { init: RequestInit }) => {
      expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
        localId: 'scoped-current-first-turn',
        messageRole: 'user',
        requestedAction: { v: 1, kind: 'send_now' },
        content: expect.any(Object),
      }));
      return Response.json({
        requestedAction: { v: 1, kind: 'send_now' },
        pending: { localId: 'scoped-current-first-turn' },
      });
    });

    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-b',
      localId: 'scoped-current-first-turn',
      message: 'scoped prompt',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true });

    expect(runtimeFetchWithServerReachabilityMock).toHaveBeenCalledTimes(1);
  });

  it('uses the released serializer for the resolved non-active target and rejects unsupported actions locally', async () => {
    const harness = createScopedHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue(releasedServerV021Features());
    runtimeFetchWithServerReachabilityMock.mockImplementation(async ({ init }: { init: RequestInit }) => {
      expect(JSON.parse(String(init.body))).toEqual({
        localId: 'scoped-released',
        content: expect.any(Object),
      });
      return releasedPendingAck('scoped-released');
    });

    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-b',
      localId: 'scoped-released',
      message: 'scoped prompt',
    })).resolves.toMatchObject({ ok: true });
    expect(runtimeFetchWithServerReachabilityMock).toHaveBeenCalledTimes(1);

    runtimeFetchWithServerReachabilityMock.mockClear();
    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-b',
      localId: 'scoped-released-action',
      message: 'scoped prompt',
      providerDeliveryIntent: 'immediate',
    })).rejects.toMatchObject({ code: 'server-upgrade-required' });
    expect(runtimeFetchWithServerReachabilityMock).not.toHaveBeenCalled();
  });

  it('maps only a spawn-first first prompt to ordinary enqueue for the released server contract', async () => {
    const harness = createScopedHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue(releasedServerV021Features());
    runtimeFetchWithServerReachabilityMock.mockImplementation(async ({ init }: { init: RequestInit }) => {
      expect(JSON.parse(String(init.body))).toEqual({
        localId: 'scoped-released-first-turn',
        content: expect.any(Object),
      });
      return releasedPendingAck('scoped-released-first-turn');
    });

    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-b',
      localId: 'scoped-released-first-turn',
      message: 'scoped prompt',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true });

    expect(runtimeFetchWithServerReachabilityMock).toHaveBeenCalledTimes(1);
  });

  it('retains scoped custody without a POST or retry cadence while target-server wire mode is indeterminate', async () => {
    const harness = createScopedHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'timeout' });

    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-b',
      localId: 'scoped-indeterminate',
      message: 'scoped prompt',
    })).resolves.toEqual({
      ok: true,
      ack: { ok: true, localId: 'scoped-indeterminate', persistence: 'pending', accepted: false },
    });

    expect(runtimeFetchWithServerReachabilityMock).not.toHaveBeenCalled();
    expect(harness.schedulePendingOutboxRetry).not.toHaveBeenCalled();
    expect(loadPendingOutboxForSession('s1', { serverId: 'server-b', accountId: 'account-b' }))
      .toEqual([expect.objectContaining({ localId: 'scoped-indeterminate', operation: 'enqueue' })]);
  });

  it('retains an indeterminate spawn-first prompt as conservative enqueue custody for later reclassification', async () => {
    const harness = createScopedHarness();
    getServerFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'timeout' });

    await expect(harness.sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-b',
      localId: 'scoped-indeterminate-first-turn',
      message: 'scoped prompt',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true });

    const [persisted] = loadPendingOutboxForSession(
      's1',
      { serverId: 'server-b', accountId: 'account-b' },
    );
    expect(JSON.parse(persisted!.request.body)).toEqual(expect.objectContaining({
      localId: 'scoped-indeterminate-first-turn',
      requestedAction: { v: 1, kind: 'enqueue' },
    }));
    expect(runtimeFetchWithServerReachabilityMock).not.toHaveBeenCalled();
    expect(harness.schedulePendingOutboxRetry).not.toHaveBeenCalled();
  });
});
