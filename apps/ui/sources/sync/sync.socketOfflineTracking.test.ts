import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  vi.fn(async () => new Response(
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
    reportContextualUpdate: vi.fn(),
  },
}));

import { sync } from './sync';
import { storage } from './domains/state/storage';
import type { Machine } from './domains/state/storageTypes';
import { loadChangesCursor, loadExternalSessionTailCursor, saveProfile } from './domains/state/persistence';
import { profileDefaults } from './domains/profiles/profile';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import {
  readMountedSessionRealtimeScmConsumerScopes,
  registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { WEB_SYNC_INSTANCE_ID_SESSION_KEY } from '@/sync/runtime/webSyncClientIdentity';
import { syncReliabilityTelemetry } from '@/sync/runtime/syncReliabilityTelemetry';

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
  return fetchMock;
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
    (sync as any).safeCursorLagState = null;
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
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_gap: 20 };
    (sync as any).isForeground = true;

    await (sync as any).fetchMessages('s_reconnect_gap');

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v1/sessions/s_reconnect_gap/messages?afterSeq=20&limit=150&scope=main',
      { method: 'GET' },
    );
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
    (sync as any).sessionMaterializedMaxSeqById = { s_deferred_durable_gap: 7 };
    (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
    (sync as any).isForeground = true;
    (sync as any).markSessionTranscriptDeferred('s_deferred_durable_gap', {
      updateType: 'new-message',
      seq: 8,
      messageId: 'm8',
    });

    await (sync as any).fetchMessages('s_deferred_durable_gap');

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v1/sessions/s_deferred_durable_gap/messages?afterSeq=7&limit=150&scope=main',
      { method: 'GET' },
    );
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
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_duplicate_connected: 20 };
    (sync as any).isForeground = true;

    await (sync as any).fetchMessages('s_reconnect_duplicate_connected');

    for (const listener of statusListeners) {
      listener('connected');
    }

    await (sync as any).fetchMessages('s_reconnect_duplicate_connected');

    expect(apiSocketRequestMock).toHaveBeenCalledTimes(1);
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

  it('includes legacy server-scoped pinned session ids in the initial session bootstrap request', async () => {
    const serverUrl = 'http://localhost:53289';
    const profile = upsertAndActivateServer({ serverUrl, scope: 'device' });
    setServerProfileIdentityForUrl(serverUrl, 'srv_test_identity');
    setActiveServer({ serverId: 'srv_test_identity', scope: 'device' });
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(activeServerId).toBe('srv_test_identity');

    storage.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        pinnedSessionKeysV1: [
          `${profile.id}:s_legacy_pin`,
          'srv_test_identity:s_identity_pin',
          's_unscoped_pin',
          'other-server:s_other_pin',
        ],
      },
    }));

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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJhY2NvdW50LXBpbnMifQ.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };

    await (sync as any).fetchSessions();

    const initialSessionsRequest = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/v2/sessions?') && url.includes('pinnedSessionIds='));
    expect(initialSessionsRequest).toContain('pinnedSessionIds=s_legacy_pin%2Cs_identity_pin%2Cs_unscoped_pin');
    expect(initialSessionsRequest).not.toContain('s_other_pin');
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
          metadata: {
            externalSessionV1: {
              v: 1,
              providerId: 'codex',
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

    await (sync as any).applyExternalSessionTranscriptItems('s1', [], { nextCursor: 'tail-2' });

    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(loadExternalSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test', instanceId: 'tab-a' })).toBe('tail-2');
  });

  it('catches up loaded direct sessions on resume even when the account changes feed is empty', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    fetchChangesMock.mockResolvedValue({
      status: 'ok' as const,
      changes: [],
      nextCursor: '0',
    });
    machineExternalSessionTranscriptReadAfterMock.mockResolvedValueOnce({
      ok: true,
      items: [
        {
          id: 'direct-msg-1',
          createdAtMs: 1,
          raw: { role: 'user', content: { type: 'text', text: 'caught up direct' } },
        },
      ],
      nextCursor: 'tail-1',
      truncated: false,
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
          metadata: {
            externalSessionV1: {
              v: 1,
              providerId: 'codex',
              machineId: 'm1',
              remoteSessionId: 'remote-1',
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

    await (sync as any).resumeSync('socket-reconnect');

    expect(machineExternalSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
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
    expect(loadExternalSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test' })).toBe('tail-1');
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
