import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readReactNativeMmkvStubValues } from '@/dev/testkit/mocks/mmkv';

type FetchChanges = typeof import('./api/session/apiChanges').fetchChanges;
type FetchCurrentChangesCursor = typeof import('./api/session/apiChanges').fetchCurrentChangesCursor;
type MachineDirectSessionTranscriptPage = typeof import('@/sync/ops/machineDirectSessions').machineDirectSessionTranscriptPage;
type MachineDirectSessionTranscriptReadAfter = typeof import('@/sync/ops/machineDirectSessions').machineDirectSessionTranscriptReadAfter;

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
const machineDirectSessionTranscriptPageMock = vi.hoisted(() =>
  vi.fn<MachineDirectSessionTranscriptPage>(async () => ({
    ok: true,
    items: [],
    nextCursor: null,
    hasMore: false,
  })),
);
const machineDirectSessionTranscriptReadAfterMock = vi.hoisted(() =>
  vi.fn<MachineDirectSessionTranscriptReadAfter>(async () => ({
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

vi.mock('@/sync/ops/machineDirectSessions', () => ({
  machineDirectSessionTranscriptPage: machineDirectSessionTranscriptPageMock,
  machineDirectSessionTranscriptReadAfter: machineDirectSessionTranscriptReadAfterMock,
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
import type { NormalizedMessage } from './typesRaw';
import { loadChangesCursor, loadDirectSessionTailCursor, saveProfile } from './domains/state/persistence';
import { profileDefaults } from './domains/profiles/profile';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import {
  clearActiveViewingSessionsForServerScopeReset,
  markSessionVisible,
} from './domains/session/activeViewingSession';
import {
  clearMountedSessionRealtimeScmConsumerScopes,
  readMountedSessionRealtimeScmConsumerScopes,
  registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { WEB_SYNC_INSTANCE_ID_SESSION_KEY } from '@/sync/runtime/webSyncClientIdentity';
import { syncReliabilityTelemetry } from '@/sync/runtime/syncReliabilityTelemetry';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

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

function emptySessionOrganizationSnapshotResponse(): Response {
  return new Response(
    JSON.stringify({
      snapshot: {
        schemaVersion: 1,
        version: 1,
        pins: [],
        folders: [],
        folderAssignments: [],
        tags: [],
        tagAssignments: [],
        orderEntries: [],
        labels: [],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
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
      return emptySessionOrganizationSnapshotResponse();
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
  return fetchMock;
}

function seedMaterializedMessage(sessionId: string, seq: number): void {
  const message: NormalizedMessage = {
    id: `m${seq}`,
    localId: null,
    createdAt: seq,
    role: 'user',
    content: { type: 'text', text: `message ${seq}` },
    seq,
    isSidechain: false,
  };
  storage.getState().applyMessages(sessionId, [message]);
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

describe('sync socket offline tracking', () => {
  const initialStorageState = storage.getState();

  beforeEach(() => {
    storage.setState(initialStorageState, true);
    clearActiveViewingSessionsForServerScopeReset();
    clearMountedSessionRealtimeScmConsumerScopes();
    statusListeners.clear();
    const heartbeatTimer = (sync as any).webSyncClientIdentityHeartbeatTimer as ReturnType<typeof setInterval> | null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    (sync as any).webSyncClientIdentityHeartbeatTimer = null;
    (sync as any).webSyncClientIdentity = null;
    (sync as any).syncTuning = loadSyncTuning();
    (sync as any).changesCursor = null;
    (sync as any).directSessionTailCursorBySessionId.clear();
    (sync as any).directSessionOlderCursorBySessionId.clear();
    (sync as any).directSessionHasMoreOlderBySessionId.clear();
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
    machineDirectSessionTranscriptPageMock.mockReset();
    machineDirectSessionTranscriptPageMock.mockResolvedValue({
      ok: true,
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    machineDirectSessionTranscriptReadAfterMock.mockReset();
    machineDirectSessionTranscriptReadAfterMock.mockResolvedValue({
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
    seedMaterializedMessage('s_reconnect_gap', 20);
    storage.getState().applyMessagesLoaded('s_reconnect_gap');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_gap: 20 };
    (sync as any).isForeground = true;
    markSessionVisible('s_reconnect_gap');

    await (sync as any).fetchMessages('s_reconnect_gap');

    expectApiSocketMessageRequest({ sessionId: 's_reconnect_gap', afterSeq: '20', limit: '150' });
  }, 60_000);

  it('uses configured message page size for loaded transcript catch-up fetches', async () => {
    (sync as any).syncTuning = {
      ...loadSyncTuning(),
      sessionMessagesPageSize: 42,
    };

    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        s_tuned_page_size: {
          id: 's_tuned_page_size',
          seq: 20,
          encryptionMode: 'plain',
          metadata: {},
          agentState: null,
        } as any,
      },
    }), true);
    seedMaterializedMessage('s_tuned_page_size', 20);
    storage.getState().applyMessagesLoaded('s_tuned_page_size');
    (sync as any).sessionMaterializedMaxSeqById = { s_tuned_page_size: 20 };
    (sync as any).isForeground = true;
    markSessionVisible('s_tuned_page_size');

    await (sync as any).fetchMessages('s_tuned_page_size');

    expectApiSocketMessageRequest({ sessionId: 's_tuned_page_size', afterSeq: '20', limit: '42' });
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
    seedMaterializedMessage('s_deferred_durable_gap', 7);
    storage.getState().applyMessagesLoaded('s_deferred_durable_gap');
    (sync as any).sessionMaterializedMaxSeqById = { s_deferred_durable_gap: 7 };
    (sync as any).hasFetchedSessionsSnapshotForActiveServer = false;
    (sync as any).isForeground = true;
    markSessionVisible('s_deferred_durable_gap');
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
    seedMaterializedMessage('s_reconnect_consumed', 20);
    storage.getState().applyMessagesLoaded('s_reconnect_consumed');
    (sync as any).sessionMaterializedMaxSeqById = { s_reconnect_consumed: 20 };
    (sync as any).isForeground = true;
    markSessionVisible('s_reconnect_consumed');

    await (sync as any).fetchMessages('s_reconnect_consumed');
    await (sync as any).fetchMessages('s_reconnect_consumed');

    expect(apiSocketRequestMock).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('includes the turns projection for socket turn-projection hydration', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    apiSocketRequestMock.mockImplementation(async (...args: unknown[]) => {
      const path = String(args[0] ?? '');
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

    (sync as any).hydrateSessionShellByIdFromSocket(
      's_socket_turn_projection',
      'socket-update-turn-projection',
      null,
      () => true,
    );

    await expect.poll(() => apiSocketRequestMock.mock.calls.map((call) => String((call as readonly unknown[])[0] ?? ''))).toContain(
      '/v1/sessions/s_socket_turn_projection/turns',
    );
    await expect.poll(() => storage.getState().sessions.s_socket_turn_projection?.rollbackEligibleTurnStarts).toEqual([3]);
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
      clearMountedSessionRealtimeScmConsumerScopes();
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
      if (url.includes('/v2/session-organization')) {
        return emptySessionOrganizationSnapshotResponse();
      }
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
      if (url.includes('/v2/session-organization')) {
        return emptySessionOrganizationSnapshotResponse();
      }
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

  it('hydrates a required changed session by id when the bounded session snapshot omits it', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    stubSnapshotRefreshFetch();
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
      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
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
    stubSnapshotRefreshFetch();
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
      return new Response(JSON.stringify({ error: `unexpected path ${path}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      initializeSessions: async () => {},
      removeSessionEncryption: vi.fn(),
      getSessionEncryption: () => null,
    };

    await expect((sync as any).fetchSessions({
      requiredHydrationSessionIds: ['s_deleted_while_offline'],
      prioritizeSessionIds: ['s_deleted_while_offline'],
      awaitSessionListHydration: true,
      hydrationTelemetrySource: 'changesCatchUp',
    })).resolves.toBeUndefined();

    expect(apiSocketRequestMock).toHaveBeenCalledWith(
      '/v2/sessions/s_deleted_while_offline',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(storage.getState().sessions.s_deleted_while_offline).toBeUndefined();
    expect((sync as any).encryption.removeSessionEncryption).toHaveBeenCalledWith('s_deleted_while_offline');
  });

  it('marks server-backed pinned rows as required hydration during session list fetches', async () => {
    const profile = upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    storage.getState().applySessionOrganizationSnapshot(profile.id, {
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
    const legacyPinnedQueryKey = 'pinned' + 'SessionIds';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/session-organization')) {
        const organizationUrl = new URL(url, 'http://localhost');
        const includeAllTagAssignments = organizationUrl.searchParams.get('includeAllTagAssignments') === 'true';
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
              tagAssignments: includeAllTagAssignments
                ? [{ sessionId: 'server-pinned-session', tagIds: ['tag-important'] }]
                : [],
              orderEntries: [],
              labels: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v2/sessions')) {
        expect(url.includes(legacyPinnedQueryKey)).toBe(false);
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

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      decryptEncryptionKeys: async () => [],
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };
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

    await (sync as any).fetchSessions();

    expect(storage.getState().sessionOrganizationPinsBySessionKey[`${profile.id}:server-pinned-session`]?.sortKey).toBe('rank-a');
    expect(fetchMock.mock.calls.some((call) => {
      const input = call[0];
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      return url.includes('/v2/session-organization') && url.includes('includeAllTagAssignments=true');
    })).toBe(true);
    const priorityEvent = syncPerformanceTelemetry.snapshot().events.find(
      (event) => event.name === 'sync.sessions.snapshot.hydrationPriority',
    );
    expect(priorityEvent?.fields).toEqual(expect.objectContaining({
      required: 1,
      priority: 0,
      skippedBackground: 0,
    }));
  });

  it('refetches the session list after first-run legacy organization import adds pinned sessions', async () => {
    const profile = upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    let importedLegacyOrganization = false;
    let sessionFetchCount = 0;
    let resolveFirstSessionFetch!: () => void;
    const firstSessionFetchSeen = new Promise<void>((resolve) => {
      resolveFirstSessionFetch = resolve;
    });

    const legacyPinnedSession = {
      id: 'legacy-pinned-session',
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 1,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/legacy-pinned', host: 'host' }),
      metadataVersion: 2,
      agentState: null,
      agentStateVersion: 0,
      dataEncryptionKey: null,
      share: null,
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();

      if (url.includes('/v1/account/encryption')) {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v2/account/settings') && (init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            content: {
              t: 'plain',
              v: {
                pinnedSessionKeysV1: [`${profile.id}:legacy-pinned-session`],
              },
            },
            version: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v2/account/settings') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: true, version: 2 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v2/session-organization/import')) {
        await firstSessionFetchSeen;
        importedLegacyOrganization = true;
        return new Response(
          JSON.stringify({
            imported: { pins: 1, folders: 0, tags: 0, orderEntries: 0, labels: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v2/session-organization')) {
        return new Response(
          JSON.stringify({
            snapshot: {
              schemaVersion: 1,
              version: importedLegacyOrganization ? 2 : 1,
              pins: importedLegacyOrganization
                ? [{ sessionId: 'legacy-pinned-session', sortKey: '00000001', pinnedAt: 1 }]
                : [],
              folders: [],
              folderAssignments: [],
              tags: [],
              tagAssignments: [],
              orderEntries: [],
              labels: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v2/sessions')) {
        sessionFetchCount += 1;
        resolveFirstSessionFetch();
        return new Response(
          JSON.stringify({
            sessions: importedLegacyOrganization ? [legacyPinnedSession] : [],
            nextCursor: null,
            hasNext: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/account/profile')) {
        return new Response(JSON.stringify({ ...profileDefaults, id: 'test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v1/machines') || url.includes('/v1/purchases')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/artifacts')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v1/feed')) {
        return new Response(JSON.stringify({ items: [], hasMore: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
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

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).serverID = 'test';
    (sync as any).pendingSettingsScope = { serverId: profile.id, accountId: 'test' };
    (sync as any).pendingSettings = {};
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      decryptEncryptionKeys: async () => [],
      initializeSessions: async () => {},
      initializeMachines: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
      getMachineEncryption: () => null,
      getContentPrivateKey: () => new Uint8Array(32),
      decryptRaw: async () => null,
    };

    await (sync as any).bootstrapSync();

    expect(sessionFetchCount).toBeGreaterThanOrEqual(2);
    expect(storage.getState().sessionListRenderables['legacy-pinned-session']).toBeDefined();
  }, 60_000);

  it('does not replace the first session list when the initial organization snapshot cannot load', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53289', scope: 'tab' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      if (url.includes('/v2/session-organization')) {
        return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v2/session-organization')) {
        return emptySessionOrganizationSnapshotResponse();
      }
      if (url.includes('/v2/sessions')) {
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

    (sync as any).credentials = { token: 'hdr.eyJzdWIiOiJ0ZXN0In0.sig', secret: 'secret' };
    (sync as any).encryption = {
      decryptEncryptionKey: async () => null,
      decryptEncryptionKeys: async () => [],
      initializeSessions: async () => {},
      removeSessionEncryption: () => {},
      getSessionEncryption: () => null,
    };

    await expect((sync as any).fetchSessions()).rejects.toThrow();

    expect(fetchMock.mock.calls.some((call) => {
      const input = call[0];
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : 'url' in input
            ? String(input.url)
            : input.toString();
      return url.includes('/v2/sessions');
    })).toBe(false);
    expect(storage.getState().sessionListRenderables['server-pinned-session']).toBeUndefined();
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
      if (url.includes('/v2/session-organization')) {
        return emptySessionOrganizationSnapshotResponse();
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
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Minimal Sync prerequisites to allow resumeSync to proceed.
    storage.setState((state) => ({ ...state, profile: { ...(state.profile ?? {}), id: 'test-account' } as any }), true);
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

    await expect.poll(
      () => fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes('/v2/sessions')),
      { timeout: 2_000 },
    ).toBe(true);
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
    expect(readReactNativeMmkvStubValues()).toContain('12');
    expect(readReactNativeMmkvStubValues()).not.toContain('9');
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
            directSessionV1: {
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

    await (sync as any).applyDirectSessionTranscriptItems('s1', [], { nextCursor: 'tail-2' });

    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    expect(loadDirectSessionTailCursor('s1', { serverScope: activeServerId, accountId: 'test', instanceId: 'tab-a' })).toBe('tail-2');
  });

  it('does not persist reconnect cursors after the server scope generation changes mid-resume', async () => {
    const firstServer = upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    let releaseFetchChanges!: () => void;
    fetchChangesMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFetchChanges = resolve;
      });
      return {
        status: 'ok' as const,
        changes: [],
        nextCursor: '12',
      };
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

    const resumePromise = (sync as any).resumeSync('socket-reconnect');
    await expect.poll(() => typeof releaseFetchChanges).toBe('function');

    const secondServer = upsertAndActivateServer({ serverUrl: 'http://localhost:53289', scope: 'tab' });
    (sync as any).resetServerScopedRuntimeState();

    releaseFetchChanges();
    await resumePromise;

    expect(loadChangesCursor({ serverScope: firstServer.id, accountId: 'test' })).toBeNull();
    expect(loadChangesCursor({ serverScope: secondServer.id, accountId: 'test' })).toBeNull();
    expect((sync as any).changesCursor).toBeNull();
  }, 60_000);

  it('catches up loaded direct sessions on resume even when the account changes feed is empty', async () => {
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
    fetchChangesMock.mockResolvedValue({
      status: 'ok' as const,
      changes: [],
      nextCursor: '0',
    });
    machineDirectSessionTranscriptReadAfterMock.mockResolvedValueOnce({
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
            directSessionV1: {
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

    expect(machineDirectSessionTranscriptReadAfterMock).toHaveBeenCalledWith(expect.objectContaining({
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
    const directReadServerId = String(machineDirectSessionTranscriptReadAfterMock.mock.calls[0]?.[1]?.serverId ?? '').trim();
    expect(loadDirectSessionTailCursor('s1', { serverScope: directReadServerId, accountId: 'test' })).toBe('tail-1');
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
