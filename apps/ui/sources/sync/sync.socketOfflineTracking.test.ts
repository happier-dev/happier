import { beforeEach, describe, expect, it, vi } from 'vitest';

type FetchChanges = typeof import('./api/session/apiChanges').fetchChanges;
type FetchCurrentChangesCursor = typeof import('./api/session/apiChanges').fetchCurrentChangesCursor;
type MachineDirectSessionTranscriptPage = typeof import('@/sync/ops/machineDirectSessions').machineDirectSessionTranscriptPage;
type MachineDirectSessionTranscriptReadAfter = typeof import('@/sync/ops/machineDirectSessions').machineDirectSessionTranscriptReadAfter;

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
      request: vi.fn(async () => new Response('ok', { status: 200 })),
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
import { loadChangesCursor, loadDirectSessionTailCursor, saveProfile } from './domains/state/persistence';
import { profileDefaults } from './domains/profiles/profile';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
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
