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

describe('sync socket offline tracking', () => {
  beforeEach(() => {
    kvStore.clear();
    statusListeners.clear();
    appStateAddListener.mockClear();
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
});
