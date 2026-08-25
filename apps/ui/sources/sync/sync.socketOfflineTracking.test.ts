import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SessionOrganizationSnapshot } from '@happier-dev/protocol';

type FetchChanges = typeof import('./api/session/apiChanges').fetchChanges;
type FetchCurrentChangesCursor = typeof import('./api/session/apiChanges').fetchCurrentChangesCursor;
type MachineExternalSessionTranscriptPage = typeof import('@/sync/ops/machineExternalSessions').machineExternalSessionTranscriptPage;
type MachineExternalSessionTranscriptReadAfter = typeof import('@/sync/ops/machineExternalSessions').machineExternalSessionTranscriptReadAfter;

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
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
    clearAll() {
      kvStore.clear();
    }
  }

  return { MMKV };
});

const statusListeners = vi.hoisted(() => new Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void>());
const apiSocketRequestMock = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => new Response(
    JSON.stringify({ messages: [], nextAfterSeq: null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )),
);
const fetchChangesMock = vi.hoisted(() =>
  vi.fn<FetchChanges>(async () => ({
    status: 'ok' as const,
    changes: [],
    nextCursor: '0',
  })),
);
const fetchCurrentChangesCursorMock = vi.hoisted(() =>
  vi.fn<FetchCurrentChangesCursor>(async () => ({ status: 'ok' as const, cursor: '0' })),
);
const machineExternalSessionTranscriptPageMock = vi.hoisted(() =>
  vi.fn<MachineExternalSessionTranscriptPage>(async () => ({
    ok: true,
    items: [],
    nextCursor: null,
    hasMore: false,
  })),
);
const machineExternalSessionTranscriptReadAfterMock = vi.hoisted(() =>
  vi.fn<MachineExternalSessionTranscriptReadAfter>(async () => ({
    ok: true,
    items: [],
    nextCursor: null,
    truncated: false,
  })),
);

vi.mock('./api/session/apiChanges', () => ({
  fetchChanges: fetchChangesMock,
  fetchCurrentChangesCursor: fetchCurrentChangesCursorMock,
}));

vi.mock('@/sync/ops/machineExternalSessions', () => ({
  machineExternalSessionTranscriptPage: machineExternalSessionTranscriptPageMock,
  machineExternalSessionTranscriptReadAfter: machineExternalSessionTranscriptReadAfterMock,
}));

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                currentState: 'active',
                                                addEventListener: appStateAddListener as any,
                                            },
                                        }
    );
});

vi.mock('@/sync/api/session/apiSocket', () => {
  return {
    apiSocket: {
      onMessage: vi.fn(),
      onError: vi.fn(),
      onReconnected: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      initialize: vi.fn(),
      request: apiSocketRequestMock,
      onStatusChange: (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        statusListeners.add(listener);
        // Match ApiSocket behavior: immediately notify with current status.
        listener('disconnected');
        return () => statusListeners.delete(listener);
      },
    },
  };
});

vi.mock('@/log', () => ({
  log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
  voiceHooks: {
    onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        onAgentRequest: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

import { sync } from './sync';
import { storage } from './domains/state/storage';
import type { Machine, Session } from './domains/state/storageTypes';
import { loadChangesCursor, loadExternalSessionTailCursor, saveProfile } from './domains/state/persistence';
import { profileDefaults } from './domains/profiles/profile';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import {
  readMountedSessionRealtimeScmConsumerScopes,
  registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import {
  markSessionSurfaceVisible,
  resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { WEB_SYNC_INSTANCE_ID_SESSION_KEY } from '@/sync/runtime/webSyncClientIdentity';
import { syncReliabilityTelemetry } from '@/sync/runtime/syncReliabilityTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';

class MemoryWebStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function routeApiSocketRequestsThroughFetch(
  fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  apiSocketRequestMock.mockImplementation((path, init) => fetchMock(path, init));
}

function stubSnapshotRefreshFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url: string =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
    if (url.includes('/v2/session-organization')) {
      return new Response(JSON.stringify({
        snapshot: {
          schemaVersion: 1,
          version: 0,
          pins: [],
          folders: [],
          folderAssignments: [],
          tags: [],
          tagAssignments: [],
          orderEntries: [],
          labels: [],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/v2/sessions')) {
      return new Response(
        JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/v1/machines')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/v1/artifacts')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/v1/feed')) {
      return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/v1/account/profile')) {
      return new Response(JSON.stringify({ ...profileDefaults, id: 'test-account' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  routeApiSocketRequestsThroughFetch(fetchMock);
  return fetchMock;
}

function expectApiSocketMessageRequest(params: {
  sessionId: string;
  afterSeq: string;
  limit: string;
}): void {
  const requestPath = `/v1/sessions/${encodeURIComponent(params.sessionId)}/messages`;
  const calls = apiSocketRequestMock.mock.calls as Array<[string, RequestInit | undefined]>;
  const call = calls.find(([path]) => String(path).startsWith(`${requestPath}?`));
  expect(call).toBeDefined();
  if (!call) {
    throw new Error(`Expected apiSocket request for ${requestPath}`);
  }
  const [path, init] = call;
  expect(init).toEqual({ method: 'GET' });

  const [, query = ''] = String(path).split('?');
  const searchParams = new URLSearchParams(query);
  expect(searchParams.get('scope')).toBe('main');
  expect(searchParams.get('afterSeq')).toBe(params.afterSeq);
  expect(searchParams.get('limit')).toBe(params.limit);
  expect(searchParams.has('beforeSeq')).toBe(false);
  expect(searchParams.has('sidechainId')).toBe(false);
}

type FakeSyncUnit = Readonly<{
  invalidateCoalesced: ReturnType<typeof vi.fn>;
  awaitQueue: ReturnType<typeof vi.fn>;
  release: () => void;
  started: Promise<void>;
}>;

function createFakeSyncUnit(name: string, events: string[], options?: Readonly<{ block?: boolean }>): FakeSyncUnit {
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = options?.block === true
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  return {
    invalidateCoalesced: vi.fn(() => {
      events.push(`${name}:invalidate`);
    }),
    awaitQueue: vi.fn(async () => {
      events.push(`${name}:await:start`);
      markStarted();
      await released;
      events.push(`${name}:await:end`);
    }),
    release: () => release?.(),
    started,
  };
}

describe('sync socket offline tracking', () => {
  const initialStorageState = storage.getState();

  beforeEach(() => {
    // `sync` is a shared singleton, so clear server-scoped private state before
    // restoring this test's storage fixture.
    sync.disconnectServer();
    storage.setState(initialStorageState, true);
    kvStore.clear();
    statusListeners.clear();
    const heartbeatTimer = (sync as any).webSyncClientIdentityHeartbeatTimer as ReturnType<typeof setInterval> | null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    (sync as any).webSyncClientIdentityHeartbeatTimer = null;
    (sync as any).webSyncClientIdentity = null;
    (sync as any).lastSocketDisconnectedAtMs = null;
    (sync as any).lastSocketOfflineDurationMs = null;
    (sync as any).socketOfflineCatchUpConsumedSessionIds?.clear?.();
    (sync as any).changesCursor = null;
    (sync as any).externalSessionTailCursorBySessionId.clear();
    (sync as any).externalSessionOlderCursorBySessionId.clear();
    (sync as any).externalSessionHasMoreOlderBySessionId.clear();
    (sync as any).transcriptAuthorityKeyBySessionId.clear();
    (sync as any).safeCursorLagState = null;
    resetSessionSurfaceVisibilityForTests();
    syncReliabilityTelemetry.reset();
    fetchChangesMock.mockReset();
    fetchChangesMock.mockResolvedValue({
      status: 'ok' as const,
      changes: [],
      nextCursor: '0',
    });
    fetchCurrentChangesCursorMock.mockReset();
    fetchCurrentChangesCursorMock.mockResolvedValue({ status: 'ok' as const, cursor: '0' });
    machineExternalSessionTranscriptPageMock.mockReset();
    machineExternalSessionTranscriptPageMock.mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    machineExternalSessionTranscriptReadAfterMock.mockReset();
    machineExternalSessionTranscriptReadAfterMock.mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      truncated: false,
    });
    apiSocketRequestMock.mockReset();
    apiSocketRequestMock.mockImplementation(async () => new Response(
      JSON.stringify({ messages: [], nextAfterSeq: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    appStateAddListener.mockClear();
    vi.unstubAllGlobals();
  });

  it('clears lastSocketDisconnectedAtMs when socket becomes connected again', async () => {
    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();

    // subscribeToUpdates installs the socket listeners and should set the timestamp on disconnected.
    (sync as any).subscribeToUpdates();

    const afterDisconnected = (sync as any).lastSocketDisconnectedAtMs;
    expect(typeof afterDisconnected).toBe('number');

    for (const listener of statusListeners) {
      listener('connected');
    }

    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();
  }, 60_000);

  it('uses captured offline duration for loaded transcript catch-up after connected status clears the disconnect timestamp', async () => {
    (sync as any).subscribeToUpdates();

    for (const listener of statusListeners) {
      listener('disconnected');
    }
    const disconnectedAt = (sync as any).lastSocketDisconnectedAtMs;
    expect(typeof disconnectedAt).toBe('number');
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    for (const listener of statusListeners) {
      listener('connected');
    }
    expect((sync as any).lastSocketDisconnectedAtMs ?? null).toBeNull();

    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_reconnect_gap: {
          id: 's_reconnect_gap',
          seq: 20,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    storage.getState().applyMessagesLoaded('s_reconnect_gap');
    markSessionSurfaceVisible('s_reconnect_gap');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_gap: 20 };
    (sync as any).isForeground = true;

    await (sync as any).fetchMessages('s_reconnect_gap');

    expectApiSocketMessageRequest({ sessionId: 's_reconnect_gap', afterSeq: '20', limit: '150' });
  }, 60_000);

  it('uses deferred durable transcript seq for visible catch-up when the stored session seq is stale', async () => {
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_deferred_durable_gap: {
          id: 's_deferred_durable_gap',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    storage.getState().applyMessagesLoaded('s_deferred_durable_gap');
    markSessionSurfaceVisible('s_deferred_durable_gap');
    (sync as any).sessionMaterializedMaxSeqById = { s_deferred_durable_gap: 7 };
    (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
    (sync as any).isForeground = true;
    (sync as any).markSessionTranscriptDeferred('s_deferred_durable_gap', {
      updateType: 'new-message',
      seq: 8,
      messageId: 'm8',
    });

    await (sync as any).fetchMessages('s_deferred_durable_gap');

    expectApiSocketMessageRequest({ sessionId: 's_deferred_durable_gap', afterSeq: '7', limit: '150' });
  }, 60_000);

  it('does not reuse captured offline duration for the same loaded transcript after catch-up succeeds', async () => {
    (sync as any).subscribeToUpdates();

    for (const listener of statusListeners) {
      listener('disconnected');
      (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;
      listener('connected');
    }

    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_reconnect_consumed: {
          id: 's_reconnect_consumed',
          seq: 20,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    storage.getState().applyMessagesLoaded('s_reconnect_consumed');
    markSessionSurfaceVisible('s_reconnect_consumed');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_consumed: 20 };
    (sync as any).isForeground = true;

    await (sync as any).fetchMessages('s_reconnect_consumed');
    await (sync as any).fetchMessages('s_reconnect_consumed');

    expect(apiSocketRequestMock).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('does not reopen consumed transcript catch-up on duplicate connected statuses without a new disconnect', async () => {
    (sync as any).subscribeToUpdates();

    for (const listener of statusListeners) {
      listener('disconnected');
      (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;
      listener('connected');
    }

    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_reconnect_duplicate_connected: {
          id: 's_reconnect_duplicate_connected',
          seq: 20,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    storage.getState().applyMessagesLoaded('s_reconnect_duplicate_connected');
    markSessionSurfaceVisible('s_reconnect_duplicate_connected');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_duplicate_connected: 20 };
    (sync as any).isForeground = true;

    await (sync as any).fetchMessages('s_reconnect_duplicate_connected');

    for (const listener of statusListeners) {
      listener('connected');
    }

    await (sync as any).fetchMessages('s_reconnect_duplicate_connected');

    expect(apiSocketRequestMock).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('includes the turns projection for socket turn-projection hydration', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    apiSocketRequestMock.mockImplementation(async (requestPath) => {
      const path = String(requestPath);
      if (path === '/v2/sessions/s_socket_turn_projection') {
        return new Response(JSON.stringify({
          session: {
            id: 's_socket_turn_projection',
            createdAt: 1,
            updatedAt: 2,
            seq: 3,
            active: false,
            activeAt: 2,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({
              path: '/workspace',
              host: 'localhost',
              flavor: 'codex',
              codexBackendMode: 'appServer',
            }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: false }),
            share: null,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (path === '/v1/sessions/s_socket_turn_projection/turns') {
        return new Response(JSON.stringify({
          v: 1,
          sessionId: 's_socket_turn_projection',
          latestTurnId: 'turn-1',
          updatedAt: 4,
          turns: [
            {
              turnId: 'turn-1',
              status: 'completed',
              startedAt: 1,
              updatedAt: 4,
              terminalAt: 4,
              transcriptAnchors: {
                startUserMessageSeq: 3,
                userMessageSeqs: [3],
                startSeqInclusive: 3,
                endSeqInclusive: 4,
              },
              rollback: { state: 'eligible', updatedAt: 4 },
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      getSessionEncryption: () => null,
      removeSessionEncryption: () => {},
    };

    await (sync as any).hydrateSessionFromSocketUpdate(
      's_socket_turn_projection',
      'socket-update-turn-projection',
      null,
    );

    expect(apiSocketRequestMock.mock.calls.map((call) => String((call as readonly unknown[])[0] ?? ''))).toContain(
      '/v1/sessions/s_socket_turn_projection/turns',
    );
    expect(storage.getState().sessions.s_socket_turn_projection?.rollbackEligibleTurnStarts).toEqual([3]);
  }, 60_000);

  it('clears active server machine cache during server-scoped runtime reset', () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const staleMachine: Machine = {
      id: 'machine-stale',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { host: 'stale', platform: 'darwin', happyCliVersion: 'test', happyHomeDir: '/stale/.happier', homeDir: '/stale' },
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 0,
      revokedAt: null,
    };

    storage.setState((state) => ({
      ...state,
      isDataReady: true,
      machines: { [staleMachine.id]: staleMachine },
      machineDisplayById: { [staleMachine.id]: staleMachine },
      machineListByServerId: { [activeServerId]: [staleMachine] },
      machineListStatusByServerId: { [activeServerId]: 'idle' },
    }), true);

    (sync as any).resetServerScopedRuntimeState();

    expect(storage.getState().machines).toEqual({});
    expect(storage.getState().machineDisplayById).toEqual({});
    expect(storage.getState().machineListByServerId).not.toHaveProperty(activeServerId);
    expect(storage.getState().machineListStatusByServerId).not.toHaveProperty(activeServerId);
  });

  it('clears mounted SCM transcript consumers during server-scoped runtime reset', () => {
    const unregister = registerSessionRealtimeScmConsumerScope({ sessionId: 'stale-scm-session' });

    try {
      expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual([
        {
          sessionId: 'stale-scm-session',
          needsMutationTranscript: true,
        },
      ]);

      (sync as any).resetServerScopedRuntimeState();

      expect(readMountedSessionRealtimeScmConsumerScopes()).toEqual([]);
    } finally {
      unregister();
    }
  });

  it('coalesces concurrent default session snapshot fetches', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

    let resolveSessions!: () => void;
    const sessionResponseReady = new Promise<void>((resolve) => {
      resolveSessions = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/sessions')) {
        await sessionResponseReady;
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };

    const sessionFetchCalls = () => fetchMock.mock.calls.filter((call) => {
      const input = call[0];
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      return url.includes('/v2/sessions');
    });

    const firstFetch = (sync as any).fetchSessions();
    await expect.poll(() => sessionFetchCalls().length).toBe(1);

    const secondFetch = (sync as any).fetchSessions();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(sessionFetchCalls()).toHaveLength(1);

    resolveSessions();
    await Promise.all([firstFetch, secondFetch]);
  });

  it.each([
    [
      'delete-session',
      (sessionId: string) => ({ t: 'delete-session' as const, sid: sessionId }),
    ],
    [
      'session-share-revoked',
      (sessionId: string) => ({
        t: 'session-share-revoked' as const,
        sessionId,
        shareId: 'voice-history-share',
      }),
    ],
  ])('does not restore a deleted Voice History carrier from an older in-flight session snapshot after %s', async (
    updateKind,
    buildUpdateBody,
  ) => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    stubSnapshotRefreshFetch();

    const sessionId = `voice-history-carrier-deleted-during-snapshot-${updateKind}`;
    const ownerMetadata = {
      path: '/tmp/voice-history',
      host: 'test-host',
      systemSessionV1: {
        v: 1,
        key: 'voice_transcript_history',
        hidden: true,
      },
    } as const;
    const existingCarrier = {
      id: sessionId,
      seq: 4,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      encryptionMode: 'plain',
      metadata: ownerMetadata,
      metadataVersion: 1,
      agentState: {},
      agentStateVersion: 1,
      thinking: false,
      thinkingAt: 0,
      presence: 2,
    } satisfies Session;
    storage.getState().applySessions([existingCarrier]);

    let releaseSnapshot!: () => void;
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const staleListRow = {
      id: sessionId,
      seq: 4,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify(ownerMetadata),
      metadataVersion: 1,
      agentState: JSON.stringify({}),
      agentStateVersion: 1,
      dataEncryptionKey: null,
      share: null,
    };
    let activeSnapshotCalls = 0;
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path.startsWith('/v2/sessions/active')) {
        activeSnapshotCalls += 1;
        if (activeSnapshotCalls === 1) {
          await snapshotReleased;
        }
        return new Response(JSON.stringify({
          sessions: activeSnapshotCalls === 1 ? [staleListRow] : [],
          nextCursor: null,
          hasNext: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path.startsWith('/v2/sessions?')) {
        return new Response(JSON.stringify({
          sessions: [],
          nextCursor: null,
          hasNext: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ2b2ljZS1oaXN0b3J5In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      decryptEncryptionKeys: async () => [],
      initializeSessions: async () => {},
      removeSessionEncryption: vi.fn(),
      getSessionEncryption: () => null,
    };

    const snapshotFetch = (sync as any).fetchSessions({ awaitSessionListHydration: true });
    await expect.poll(() => apiSocketRequestMock.mock.calls.some(([path]) => (
      path.startsWith('/v2/sessions/active')
    ))).toBe(true);

    await (sync as any).handleUpdate({
      id: `delete-voice-history-carrier-during-snapshot-${updateKind}`,
      seq: 10,
      createdAt: 10,
      body: buildUpdateBody(sessionId),
    });
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(storage.getState().sessionListRenderables[sessionId]).toBeUndefined();

    releaseSnapshot();
    await snapshotFetch;
    await (sync as any).sessionsSync.awaitQueue();
    expect(activeSnapshotCalls).toBe(2);

    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(storage.getState().sessionListRenderables[sessionId]).toBeUndefined();
  });

  it('does not restore a Voice History carrier from an older session snapshot when exact hydration reports it absent', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    stubSnapshotRefreshFetch();

    const sessionId = 'voice-history-carrier-absent-during-snapshot';
    const ownerMetadata = {
      path: '/tmp/voice-history',
      host: 'test-host',
      systemSessionV1: {
        v: 1,
        key: 'voice_transcript_history',
        hidden: true,
      },
    } as const;
    storage.getState().applySessions([{
      id: sessionId,
      seq: 4,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      encryptionMode: 'plain',
      metadata: ownerMetadata,
      metadataVersion: 1,
      agentState: {},
      agentStateVersion: 1,
      thinking: false,
      thinkingAt: 0,
      presence: 2,
    } satisfies Session]);

    let releaseOlderSnapshot!: () => void;
    const olderSnapshotReleased = new Promise<void>((resolve) => {
      releaseOlderSnapshot = resolve;
    });
    const staleListRow = {
      id: sessionId,
      seq: 4,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 2,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify(ownerMetadata),
      metadataVersion: 1,
      agentState: JSON.stringify({}),
      agentStateVersion: 1,
      dataEncryptionKey: null,
      share: null,
    };
    let activeSnapshotCalls = 0;
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path.startsWith('/v2/sessions/active')) {
        const snapshotCall = ++activeSnapshotCalls;
        if (snapshotCall === 1) {
          await olderSnapshotReleased;
        }
        return new Response(JSON.stringify({
          sessions: snapshotCall === 1 ? [staleListRow] : [],
          nextCursor: null,
          hasNext: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path === `/v2/sessions/${sessionId}`) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path.startsWith('/v2/sessions?')) {
        return new Response(JSON.stringify({
          sessions: [],
          nextCursor: null,
          hasNext: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ2b2ljZS1oaXN0b3J5In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      decryptEncryptionKeys: async () => [],
      initializeSessions: async () => {},
      removeSessionEncryption: vi.fn(),
      getSessionEncryption: () => null,
    };

    const originalSyncTuning = (sync as any).syncTuning;
    (sync as any).syncTuning = {
      ...originalSyncTuning,
      // The stale list response is the thing under test. Do not let optional
      // list hydration issue a second exact read that masks its resurrection.
      sessionListEagerHydrationCount: 0,
      sessionListBackgroundHydrationMaxRows: 0,
    };
    onTestFinished(() => {
      (sync as any).syncTuning = originalSyncTuning;
    });

    const olderSnapshot = (sync as any).fetchSessions();
    await expect.poll(() => activeSnapshotCalls).toBe(1);

    const exactHydration = (sync as any).fetchSessions({
      requiredHydrationSessionIds: [sessionId],
      prioritizeSessionIds: [sessionId],
      awaitSessionListHydration: true,
    });
    await expect.poll(() => apiSocketRequestMock.mock.calls.some(([path]) => (
      path === `/v2/sessions/${sessionId}`
    ))).toBe(true);
    await exactHydration;

    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(storage.getState().sessionListRenderables[sessionId]).toBeUndefined();

    releaseOlderSnapshot();
    await olderSnapshot;
    await (sync as any).sessionsSync.awaitQueue({ timeoutMs: 2_000 });

    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(storage.getState().sessionListRenderables[sessionId]).toBeUndefined();
  });

  it('fetches and hydrates cold hidden Voice attention rows when session-list attention placement is off', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    storage.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        sessionListAttentionPromotionModeV1: 'off',
      },
    }), true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/sessions')) {
        const sessions = url.includes('includeAttention=true')
          ? [
              {
                id: 'cold-hidden-voice-permission',
                seq: 2,
                createdAt: 1,
                updatedAt: 10,
                active: true,
                activeAt: 10,
                archivedAt: null,
                encryptionMode: 'plain',
                metadata: JSON.stringify({
                  path: '/tmp/cold-hidden-voice-permission',
                  host: 'test-host',
                  systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
                }),
                metadataVersion: 1,
                agentState: JSON.stringify({
                  requests: {
                    approve: {
                      tool: 'Bash',
                      kind: 'permission',
                      arguments: { command: 'git status' },
                      createdAt: 10,
                    },
                  },
                }),
                agentStateVersion: 1,
                dataEncryptionKey: null,
                share: null,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: 10,
                lastViewedSessionSeq: 2,
                latestReadyEventSeq: 2,
              },
              {
                id: 'cold-hidden-voice-late-result',
                seq: 4,
                createdAt: 1,
                updatedAt: 20,
                active: false,
                activeAt: 20,
                archivedAt: null,
                encryptionMode: 'plain',
                metadata: JSON.stringify({
                  path: '/tmp/cold-hidden-voice-late-result',
                  host: 'test-host',
                  systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
                }),
                metadataVersion: 1,
                agentState: JSON.stringify({}),
                agentStateVersion: 1,
                dataEncryptionKey: null,
                share: null,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 0,
                lastViewedSessionSeq: 2,
                latestReadyEventSeq: 4,
                latestReadyEventAt: 20,
              },
            ]
          : [];
        return new Response(
          JSON.stringify({ sessions, nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJkdXJhYmxlLWF0dGVudGlvbiJ9.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };

    await (sync as any).fetchSessions();

    const initialSessionsRequest = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/v2/sessions?'));
    expect(initialSessionsRequest).toContain('includeAttention=true');
    await expect.poll(() => Object.keys(storage.getState().sessions).filter((sessionId) => (
      sessionId.startsWith('cold-hidden-voice-')
    )).sort()).toEqual([
      'cold-hidden-voice-late-result',
      'cold-hidden-voice-permission',
    ]);
    expect(storage.getState().sessions['cold-hidden-voice-permission']).toMatchObject({
      agentState: {
        requests: {
          approve: {
            kind: 'permission',
            tool: 'Bash',
          },
        },
      },
    });
    expect(storage.getState().sessions['cold-hidden-voice-late-result']).toMatchObject({
      latestReadyEventSeq: 4,
      lastViewedSessionSeq: 2,
    });
  });

  it('does not prefetch session folder assignments for every session snapshot page', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({
            sessions: [{
              id: 'snapshot-session',
              seq: 1,
              createdAt: 1,
              updatedAt: 1,
              active: true,
              activeAt: 1,
              archivedAt: null,
              metadata: 'metadata-snapshot-session',
              metadataVersion: 1,
              agentState: null,
              agentStateVersion: 0,
              dataEncryptionKey: null,
              share: null,
            }],
            nextCursor: null,
            hasNext: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ assignments: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };

    await (sync as any).fetchSessions();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(fetchMock.mock.calls.some((call) => {
      const input = call[0];
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      return url.includes('/v2/session-folder-assignments');
    })).toBe(false);
  });

  it('hydrates a required changed session by id when the bounded session snapshot omits it', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path === '/v2/sessions/s_required_changed') {
        return new Response(JSON.stringify({
          session: {
            id: 's_required_changed',
            createdAt: 1,
            updatedAt: 35,
            seq: 7,
            active: false,
            activeAt: 34,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
            metadataVersion: 1,
            metadata: JSON.stringify({ path: '/workspace', host: 'localhost' }),
            agentStateVersion: 1,
            agentState: JSON.stringify({ controlledByUser: false }),
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 35,
            runtimeActivityRevision: 35,
            share: null,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return snapshotRefreshFetch(path);
    });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };

    await (sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_required_changed'],
      prioritizeSessionIds: ['s_required_changed'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    });

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_required_changed',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_required_changed).toEqual(expect.objectContaining({
      id: 's_required_changed',
      active: false,
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: 0,
      runtimeActivityRevision: 35,
    }));
  });

  it('retires a required changed session when exact hydration proves it was deleted', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_deleted_while_offline: {
          id: 's_deleted_while_offline',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path === '/v2/sessions/s_deleted_while_offline') {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return snapshotRefreshFetch(path);
    });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: vi.fn(),
      getSessionEncryption: () => null,
    };

    await (sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_deleted_while_offline'],
      prioritizeSessionIds: ['s_deleted_while_offline'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    });

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_deleted_while_offline',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_deleted_while_offline).toBeUndefined();
    expect((sync as any).encryption.removeSessionEncryption).toHaveBeenCalledWith('s_deleted_while_offline');
  });

  it('keeps a required changed session when exact hydration receives an unparseable 404', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_compatibility_404: {
          id: 's_compatibility_404',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path === '/v2/sessions/s_compatibility_404') {
        return new Response('Not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return snapshotRefreshFetch(path);
    });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: vi.fn(),
      getSessionEncryption: () => null,
    };

    await expect((sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_compatibility_404'],
      prioritizeSessionIds: ['s_compatibility_404'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    })).rejects.toThrow(
      'Required session shell hydration failed for s_compatibility_404: invalid_response',
    );

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_compatibility_404',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_compatibility_404).toEqual(expect.objectContaining({
      id: 's_compatibility_404',
    }));
    expect((sync as any).encryption.removeSessionEncryption).not.toHaveBeenCalled();
  });

  it('keeps a required changed session when a current-text hydration 404 carries route metadata', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    const snapshotRefreshFetch = stubSnapshotRefreshFetch();
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_current_text_extra_404: {
          id: 's_current_text_extra_404',
          seq: 7,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (path === '/v2/sessions/s_current_text_extra_404') {
        return new Response(JSON.stringify({
          error: 'Session not found',
          path: '/v2/sessions/s_current_text_extra_404',
          method: 'GET',
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return snapshotRefreshFetch(path);
    });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: vi.fn(),
      getSessionEncryption: () => null,
    };

    const hydrationError = await (sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_current_text_extra_404'],
      prioritizeSessionIds: ['s_current_text_extra_404'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_current_text_extra_404',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_current_text_extra_404).toEqual(expect.objectContaining({
      id: 's_current_text_extra_404',
    }));
    expect((sync as any).encryption.removeSessionEncryption).not.toHaveBeenCalled();
    expect(hydrationError).toBeInstanceOf(Error);
    expect(hydrationError).toMatchObject({
      message: 'Required session shell hydration failed for s_current_text_extra_404: invalid_response',
    });
  });

  it('waits for settings before bootstrapping sessions so pinned ids are available on first load', async () => {
    const events: string[] = [];
    const originalUnits = {
      settingsSync: (sync as any).settingsSync,
      profileSync: (sync as any).profileSync,
      accountPetsSync: (sync as any).accountPetsSync,
      sessionsSync: (sync as any).sessionsSync,
      machinesSync: (sync as any).machinesSync,
      purchasesSync: (sync as any).purchasesSync,
      artifactsSync: (sync as any).artifactsSync,
      automationsSync: (sync as any).automationsSync,
      todosSync: (sync as any).todosSync,
      friendsSync: (sync as any).friendsSync,
      friendRequestsSync: (sync as any).friendRequestsSync,
      feedSync: (sync as any).feedSync,
      pushTokenSync: (sync as any).pushTokenSync,
      nativeUpdateSync: (sync as any).nativeUpdateSync,
      credentials: (sync as any).credentials,
    };
    const settingsUnit = createFakeSyncUnit('settings', events, { block: true });
    const fakeUnits = {
      settingsSync: settingsUnit,
      profileSync: createFakeSyncUnit('profile', events),
      accountPetsSync: createFakeSyncUnit('pets', events),
      sessionsSync: createFakeSyncUnit('sessions', events),
      machinesSync: createFakeSyncUnit('machines', events),
      purchasesSync: createFakeSyncUnit('purchases', events),
      artifactsSync: createFakeSyncUnit('artifacts', events),
      automationsSync: createFakeSyncUnit('automations', events),
      todosSync: createFakeSyncUnit('todos', events),
      friendsSync: createFakeSyncUnit('friends', events),
      friendRequestsSync: createFakeSyncUnit('friendRequests', events),
      feedSync: createFakeSyncUnit('feed', events),
      pushTokenSync: createFakeSyncUnit('pushToken', events),
      nativeUpdateSync: createFakeSyncUnit('nativeUpdate', events),
    };

    try {
      Object.assign(sync as any, fakeUnits, {
        credentials: { token: 'hdr.eyJzdWIiOiJhY2NvdW50LWJvb3RzdHJhcCJ9.sig', secret: 'secret' },
      });

      const bootstrap = (sync as any).bootstrapSync();
      await settingsUnit.started;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(events).not.toContain('sessions:invalidate');

      settingsUnit.release();
      await bootstrap;
      expect(events.indexOf('settings:await:end')).toBeLessThan(events.indexOf('sessions:invalidate'));
    } finally {
      Object.assign(sync as any, originalUnits);
    }
  });

  it('loads session organization before the initial session bootstrap request', async () => {
    const serverUrl = 'http://localhost:53289';
    upsertAndActivateServer({ serverUrl, scope: 'device' });
    setServerProfileIdentityForUrl(serverUrl, 'srv_test_identity');
    setActiveServer({ serverId: 'srv_test_identity', scope: 'device' });
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(activeServerId).toBe('srv_test_identity');

    const organizationSnapshot: SessionOrganizationSnapshot = {
      schemaVersion: 1,
      version: 1,
      pins: [
        { sessionId: 's_organization_pin', sortKey: '0001', pinnedAt: 1 },
        { sessionId: 's_identity_pin', sortKey: '0002', pinnedAt: 2 },
        { sessionId: 's_unscoped_pin', sortKey: '0003', pinnedAt: 3 },
      ],
      folders: [],
      folderAssignments: [],
      tags: [],
      tagAssignments: [],
      orderEntries: [],
      labels: [],
    };
    storage.getState().applySessionOrganizationSnapshot('other-server', {
      ...organizationSnapshot,
      pins: [{ sessionId: 's_other_pin', sortKey: '0001', pinnedAt: 1 }],
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v2/session-organization')) {
        return new Response(JSON.stringify({ snapshot: organizationSnapshot }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJhY2NvdW50LXBpbnMifQ.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };
    apiSocketRequestMock.mockImplementation(async (path) => {
      if (
        path.startsWith('/v2/sessions/')
        && !path.startsWith('/v2/sessions/active')
      ) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return fetchMock(path);
    });

    await (sync as any).fetchSessions();

    const initialSessionsRequest = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/v2/sessions'));
    const organizationSnapshotRequest = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/v2/session-organization'));
    expect(initialSessionsRequest).toBeDefined();
    expect(initialSessionsRequest).not.toContain('pinnedSessionIds=');
    expect(organizationSnapshotRequest).toBeDefined();
    expect(organizationSnapshotRequest).toContain('includeAllFolderAssignments=true');
    expect(organizationSnapshotRequest).toContain('includeAllTagAssignments=true');
    // The band the list paints on first frame includes sessions the user asked to keep in it, so
    // the list's own organization fetch has to ask for standings; the server omits them otherwise.
    expect(organizationSnapshotRequest).toContain('includeAttentionStandings=true');
  });

  it('marks server-backed pinned rows as required hydration during session list fetches', async () => {
    const serverUrl = 'http://localhost:53291';
    upsertAndActivateServer({ serverUrl, scope: 'device' });
    setServerProfileIdentityForUrl(serverUrl, 'srv_required_pin_hydration');
    setActiveServer({ serverId: 'srv_required_pin_hydration', scope: 'device' });
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(activeServerId).toBe('srv_required_pin_hydration');

    storage.getState().applySessionOrganizationSnapshot(activeServerId, {
      schemaVersion: 1,
      version: 7,
      pins: [{ sessionId: 'server-pinned-session', sortKey: 'rank-a', pinnedAt: 1 }],
      folders: [],
      folderAssignments: [],
      tags: [],
      tagAssignments: [],
      orderEntries: [],
      labels: [],
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/session-organization')) {
        return new Response(
          JSON.stringify({
            snapshot: {
              schemaVersion: 1,
              version: 7,
              pins: [{ sessionId: 'server-pinned-session', sortKey: 'rank-a', pinnedAt: 1 }],
              folders: [],
              folderAssignments: [],
              tags: [{
                tagId: 'tag-important',
                tagKey: 'opaque-tag-important',
                sortKey: null,
                display: { t: 'plain', v: { label: 'Important' } },
                archivedAt: null,
                createdAt: 1,
                updatedAt: 1,
              }],
              tagAssignments: [{ sessionId: 'server-pinned-session', tagIds: ['tag-important'] }],
              orderEntries: [],
              labels: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v2/sessions')) {
        expect(url.includes('pinnedSessionIds')).toBe(false);
        return new Response(
          JSON.stringify({
            sessions: [{
              id: 'server-pinned-session',
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: false,
              activeAt: 1,
              archivedAt: null,
              encryptionMode: 'plain',
              metadata: JSON.stringify({ path: '/pinned', host: 'host' }),
              metadataVersion: 2,
              agentState: null,
              agentStateVersion: 0,
              dataEncryptionKey: null,
              share: null,
            }],
            nextCursor: null,
            hasNext: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJwaW5uZWQtaHlkcmF0aW9uIn0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      decryptEncryptionKeys: async () => [],
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };
    const originalSyncTuning = (sync as any).syncTuning;
    (sync as any).syncTuning = {
      ...loadSyncTuning(),
      sessionListEagerHydrationCount: 0,
      sessionListBackgroundHydrationMaxRows: 0,
    };
    syncPerformanceTelemetry.configure({
      enabled: true,
      slowThresholdMs: 1_000_000,
      flushIntervalMs: 60_000,
    });
    syncPerformanceTelemetry.reset();

    try {
      await (sync as any).fetchSessions();
    } finally {
      (sync as any).syncTuning = originalSyncTuning;
    }

    expect(storage.getState().sessionOrganizationPinsBySessionKey[`${activeServerId}:server-pinned-session`]?.sortKey).toBe('rank-a');
    const priorityEvent = syncPerformanceTelemetry.snapshot().events.find(
      (event) => event.name === 'sync.sessions.snapshot.hydrationPriority',
    );
    expect(priorityEvent?.fields).toEqual(expect.objectContaining({
      required: 1,
      priority: 0,
      skippedBackground: 0,
    }));
  });

  it('continues clean session bootstrap when optional session organization route is unavailable', async () => {
    const serverUrl = 'http://localhost:53290';
    upsertAndActivateServer({ serverUrl, scope: 'device' });
    setServerProfileIdentityForUrl(serverUrl, 'srv_session_org_unavailable');
    setActiveServer({ serverId: 'srv_session_org_unavailable', scope: 'device' });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/session-organization')) {
        return new Response(JSON.stringify({ error: 'preview_not_found', reasonCode: 'preview_not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJhY2NvdW50LW9yZy1mYWxsYmFjayJ9.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };

    await (sync as any).fetchSessions();

    const requestedUrls = fetchMock.mock.calls.map((call) => {
      const input = call[0];
      return typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
    });
    expect(requestedUrls.some((url) => url.includes('/v2/session-organization'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/v2/sessions'))).toBe(true);
  });

  it('replaces the active machine snapshot so an empty account list clears stale machines', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const staleMachine: Machine = {
      id: 'machine-stale',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      metadata: { host: 'stale', platform: 'darwin', happyCliVersion: 'test', happyHomeDir: '/stale/.happier', homeDir: '/stale' },
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 0,
      revokedAt: null,
    };

    storage.setState((state) => ({
      ...state,
      isDataReady: true,
      machines: { [staleMachine.id]: staleMachine },
      machineDisplayById: { [staleMachine.id]: staleMachine },
      machineListByServerId: { [activeServerId]: [staleMachine] },
      machineListStatusByServerId: { [activeServerId]: 'idle' },
    }), true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v1/machines')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJhY2NvdW50LWMifQ.sig', secret: 'secret' };
    (sync as any).serverID = 'account-c';
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeMachines: async () => {},
      getMachineEncryption: () => null,
    };

    await (sync as any).fetchMachines();

    expect(storage.getState().machines).toEqual({});
    expect(storage.getState().machineDisplayById).toEqual({});
    expect(storage.getState().machineListByServerId[activeServerId]).toEqual([]);
  }, 60_000);

  it('refreshes sessions on socket reconnect (recovers missed activity ephemerals)', async () => {
    // Ensure serverFetch has an active server target.
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url: string =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : 'url' in input
              ? String(input.url)
              : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/machines')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    // Minimal Sync prerequisites to allow resumeSync to proceed.
    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeMachines: async () => {},
      initializeSessions: async () => {},
      getSessionEncryption: () => null,
    };
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('/v2/sessions')]),
    );
  }, 60_000);

  it('captures a fresh snapshot-base cursor before cursor-gone snapshot repair', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    fetchChangesMock
      .mockResolvedValueOnce({ status: 'cursor-gone' as const, currentCursor: '9' })
      .mockResolvedValueOnce({ status: 'ok' as const, changes: [], nextCursor: '12' });
    fetchCurrentChangesCursorMock.mockResolvedValue({ status: 'ok' as const, cursor: '12' });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url: string =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : 'url' in input
              ? String(input.url)
              : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/machines')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/artifacts')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/feed')) {
        return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/account/profile')) {
        return new Response(JSON.stringify({ ...profileDefaults, id: 'test-account' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    routeApiSocketRequestsThroughFetch(fetchMock);

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'stale-profile-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).serverID = 'test';
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      initializeMachines: async () => {},
      getSessionEncryption: () => null,
    };
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    expect(fetchCurrentChangesCursorMock).toHaveBeenCalledTimes(1);
    expect(Array.from(kvStore.values())).toContain('12');
    expect(Array.from(kvStore.values())).not.toContain('9');
  }, 60_000);

  it('persists snapshot-base cursor fetch failure telemetry when cursor-gone repair cannot capture /v2/cursor', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    fetchChangesMock.mockResolvedValueOnce({ status: 'cursor-gone' as const, currentCursor: '9' });
    fetchCurrentChangesCursorMock.mockResolvedValue({ status: 'error' as const });
    stubSnapshotRefreshFetch();

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).serverID = 'test';
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      initializeMachines: async () => {},
      getSessionEncryption: () => null,
    };
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    expect(syncReliabilityTelemetry.snapshot().persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sync.cursor.snapshotBaseFetchFailed',
          fields: expect.objectContaining({
            trigger: 'cursor-gone',
            fallbackCursor: '9',
            error: 'status:error',
          }),
        }),
      ]),
    );
  }, 60_000);

  it('persists cursor contract anomaly telemetry when /v2/changes repeats the requested after cursor', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    fetchChangesMock.mockResolvedValueOnce({
      status: 'ok' as const,
      changes: [
        { cursor: 10, kind: 'session' as const, entityId: 's0', changedAt: 1 },
        { cursor: 11, kind: 'session' as const, entityId: 's1', changedAt: 1 },
      ],
      nextCursor: '11',
    });
    stubSnapshotRefreshFetch();

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).changesCursor = '10';
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).serverID = 'test';
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      initializeMachines: async () => {},
      getSessionEncryption: () => null,
    };
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    expect(syncReliabilityTelemetry.snapshot().persistedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sync.cursor.contractAnomaly',
          fields: expect.objectContaining({
            reason: 'returned-after-cursor',
            afterCursor: '10',
            offendingCursor: '10',
            nextCursor: '11',
          }),
        }),
      ]),
    );
  }, 60_000);

  it('persists web reconnect cursors under the current tab instance scope only', async () => {
    const sessionStorage = new MemoryWebStorage();
    const localStorage = new MemoryWebStorage();
    sessionStorage.setItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY, 'tab-a');
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('localStorage', localStorage);

    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    fetchChangesMock
      .mockResolvedValueOnce({ status: 'cursor-gone' as const, currentCursor: '9' })
      .mockResolvedValueOnce({ status: 'ok' as const, changes: [], nextCursor: '12' });
    fetchCurrentChangesCursorMock.mockResolvedValue({ status: 'ok' as const, cursor: '12' });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url: string =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : 'url' in input
              ? String(input.url)
              : input.toString();
      if (url.includes('/v2/sessions')) {
        return new Response(
          JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/machines')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/artifacts')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/feed')) {
        return new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/account/profile')) {
        return new Response(JSON.stringify({ ...profileDefaults, id: 'test-account' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).serverID = 'test';
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      initializeMachines: async () => {},
      getSessionEncryption: () => null,
    };
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    await (sync as any).resumeSync('socket-reconnect');

    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect({
      instanceId: sessionStorage.getItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY),
      instanceCursor: loadChangesCursor({ serverScope: activeServerId, accountId: 'test', instanceId: 'tab-a' }),
      staleProfileCursor: loadChangesCursor({ serverScope: activeServerId, accountId: 'test-account', instanceId: 'tab-a' }),
    }).toMatchObject({
      instanceId: 'tab-a',
      instanceCursor: '12',
      staleProfileCursor: null,
    });
  }, 60_000);

  it('persists direct-session tail cursors under the current tab instance scope', async () => {
    const sessionStorage = new MemoryWebStorage();
    const localStorage = new MemoryWebStorage();
    sessionStorage.setItem(WEB_SYNC_INSTANCE_ID_SESSION_KEY, 'tab-a');
    vi.stubGlobal('sessionStorage', sessionStorage);
    vi.stubGlobal('localStorage', localStorage);

    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    storage.setState((state) => ({
      ...state,
      profile: { ...(state.profile ?? {}), id: 'test-account' } as any,
      sessions: {
        ...state.sessions,
        s1: {
          id: 's1',
          currentStorageState: 'machine_only',
          metadata: {
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'm1',
              remoteSessionId: 'remote-1',
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        } as any,
      },
    }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    (sync as any).serverID = 'test';

    const tailCursor = 'happier_external_cursor_v1:dGFpbC0y';
    await (sync as any).applyExternalSessionTranscriptItems('s1', [], { nextCursor: tailCursor });

    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(loadExternalSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test', instanceId: 'tab-a' })).toBe(tailCursor);
  });

  it('catches up loaded direct sessions on resume even when the account changes feed is empty', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    fetchChangesMock.mockResolvedValue({
      status: 'ok' as const,
      changes: [],
      nextCursor: '0',
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url: string =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : 'url' in input
              ? String(input.url)
              : input.toString();
      if (url.includes('/v1/purchases')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/push-token')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/native-update')) {
        return new Response(JSON.stringify({ updateAvailable: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    storage.setState((state) => ({
      ...state,
      profile: { ...(state.profile ?? {}), id: 'test-account' } as any,
      sessions: {
        ...state.sessions,
        s1: {
          id: 's1',
          currentStorageState: 'machine_only',
          metadata: {
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'm1',
              remoteSessionId: 'remote-1',
              linkedAtMs: 1,
              source: { kind: 'codexHome', home: 'user' },
            },
          },
        } as any,
      },
    }), true);
    saveProfile({ ...profileDefaults, id: 'test-account' });
    storage.getState().applyMessagesLoaded('s1');
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).serverID = 'test';
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      initializeMachines: async () => {},
      getSessionEncryption: () => null,
    };
    (sync as any).isForeground = true;
    (sync as any).lastSocketDisconnectedAtMs = Date.now() - 1000;

    // Establish the same authority identity that a previously loaded direct
    // transcript carries before reconnect catch-up switches to read-after.
    await (sync as any).fetchMessages('s1');
    machineExternalSessionTranscriptReadAfterMock.mockReset();
    machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
      ok: true,
      items: [
        {
          id: 'direct-msg-1',
          createdAtMs: 1,
          raw: { role: 'user', content: { type: 'text', text: 'caught up direct' } },
        },
      ],
      nextCursor: 'happier_external_cursor_v1:dGFpbC0x',
      truncated: false,
    });

    await (sync as any).resumeSync('socket-reconnect');

    expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      cursor: 'tail',
    }), expect.anything());
    const sessionMessages = storage.getState().sessionMessages.s1;
    const texts = (sessionMessages?.messageIdsOldestFirst ?? [])
      .map((id) => sessionMessages?.messagesById[id])
      .filter((message): message is NonNullable<typeof message> => Boolean(message))
      .filter((message) => message.kind === 'user-text')
      .map((message) => message.text);
    expect(texts).toEqual(['caught up direct']);
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(loadExternalSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test' })).toBe(
      'happier_external_cursor_v1:dGFpbC0x',
    );
  }, 60_000);

  it('persists a safe cursor lag tripwire only after two over-threshold checks', () => {
    (sync as any).rememberBlockedChangesCursorLag({
      blockedCursor: 'cursor-2',
      blockedReason: 'unsupported-kind',
      safeAdvanceCursor: 'cursor-1',
      nowMs: 1_000,
    });

    (sync as any).evaluateSafeCursorLagTripwireNow(301_000);
    expect(syncReliabilityTelemetry.snapshot().persistedEvents.map((event) => event.name)).not.toContain('sync.cursor.safeCursorLagExceeded');

    (sync as any).evaluateSafeCursorLagTripwireNow(331_000);
    expect(syncReliabilityTelemetry.snapshot().persistedEvents).toEqual([
      expect.objectContaining({
        name: 'sync.cursor.safeCursorLagExceeded',
        fields: expect.objectContaining({
          blockedCursor: 'cursor-2',
          blockedReason: 'unsupported-kind',
          safeAdvanceCursor: 'cursor-1',
        }),
      }),
    ]);
  });
});
