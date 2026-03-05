import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('./api/session/apiChanges', () => ({
  fetchChanges: vi.fn(async () => ({
    status: 'ok' as const,
    changes: [],
    nextCursor: '0',
  })),
}));

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    Platform: { ...(actual?.Platform ?? {}), OS: 'web' },
    AppState: { currentState: 'active', addEventListener: appStateAddListener as any },
  };
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
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

describe('sync socket offline tracking', () => {
  const initialStorageState = storage.getState();

  beforeEach(() => {
    storage.setState(initialStorageState, true);
    kvStore.clear();
    statusListeners.clear();
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

  it('refreshes sessions on socket reconnect (recovers missed activity ephemerals)', async () => {
    // Ensure serverFetch has an active server target.
    upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
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
});
