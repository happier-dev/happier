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
      onStatusChange: vi.fn(() => () => {}),
    },
  };
});

vi.mock('@/log', () => ({
  log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
  voiceHooks: {
    onMessages: vi.fn(),
    onReady: vi.fn(),
    onSessionFocus: vi.fn(),
    onSessionOffline: vi.fn(),
    onSessionOnline: vi.fn(),
    reportContextualUpdate: vi.fn(),
  },
}));

import { storage } from '@/sync/domains/state/storage';
import { sync } from './sync';

const initialStorageState = storage.getState();

describe('sync transcript-draft ephemerals', () => {
  beforeEach(() => {
    kvStore.clear();
    storage.setState(initialStorageState, true);
  });

  it('decrypts transcript draft deltas and applies them to session draft buffers', async () => {
    (sync as any).encryption = {
      getSessionEncryption: () => ({
        decryptRaw: async () => ({
          role: 'agent',
          content: { type: 'acp', provider: 'codex', data: { type: 'message', message: 'Hello' } },
        }),
      }),
    };

    (sync as any).handleEphemeralUpdate({
      type: 'transcript-draft',
      sessionId: 's1',
      localId: 'local-1',
      segmentKind: 'assistant',
      sidechainId: null,
      delta: { t: 'encrypted', c: 'ciphertext' },
      createdAt: 123,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const drafts = storage.getState().sessionMessages.s1?.draftsByLocalId ?? {};
    expect(drafts['local-1']?.text).toBe('Hello');
  });

  it('applies plaintext transcript draft deltas without requiring session encryption', async () => {
    (sync as any).encryption = {
      getSessionEncryption: () => null,
    };

    (sync as any).handleEphemeralUpdate({
      type: 'transcript-draft',
      sessionId: 's1',
      localId: 'local-plain',
      segmentKind: 'assistant',
      sidechainId: null,
      delta: {
        t: 'plain',
        v: {
          role: 'agent',
          content: { type: 'acp', provider: 'codex', data: { type: 'message', message: 'Plain hello' } },
        },
      },
      createdAt: 456,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const drafts = storage.getState().sessionMessages.s1?.draftsByLocalId ?? {};
    expect(drafts['local-plain']?.text).toBe('Plain hello');
  });

  it('seeds post-commit draft deltas from the committed transcript text', async () => {
    (sync as any).encryption = {
      getSessionEncryption: () => null,
    };

    storage.getState().applyMessages('s1', [
      {
        id: 'msg-1',
        seq: 1,
        localId: 'local-seeded',
        createdAt: 100,
        isSidechain: false,
        role: 'agent',
        content: [{ type: 'text', text: 'Hello', uuid: 'u-1', parentUUID: null }],
      } as any,
    ]);

    (sync as any).handleEphemeralUpdate({
      type: 'transcript-draft',
      sessionId: 's1',
      localId: 'local-seeded',
      segmentKind: 'assistant',
      sidechainId: null,
      delta: {
        t: 'plain',
        v: {
          role: 'agent',
          content: { type: 'acp', provider: 'codex', data: { type: 'message', message: ' world' } },
        },
      },
      createdAt: 200,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const drafts = storage.getState().sessionMessages.s1?.draftsByLocalId ?? {};
    expect(drafts['local-seeded']?.text).toBe('Hello world');
  });

  it('ignores stale draft deltas that are older than the committed stream snapshot', async () => {
    (sync as any).encryption = {
      getSessionEncryption: () => null,
    };

    storage.getState().applyMessages('s1', [
      {
        id: 'msg-2',
        seq: 2,
        localId: 'local-stale',
        createdAt: 300,
        isSidechain: false,
        role: 'agent',
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'local-stale',
            updatedAtMs: 300,
          },
        },
        content: [{ type: 'text', text: 'Hello world', uuid: 'u-2', parentUUID: null }],
      } as any,
    ]);

    (sync as any).handleEphemeralUpdate({
      type: 'transcript-draft',
      sessionId: 's1',
      localId: 'local-stale',
      segmentKind: 'assistant',
      sidechainId: null,
      delta: {
        t: 'plain',
        v: {
          role: 'agent',
          content: { type: 'acp', provider: 'codex', data: { type: 'message', message: ' world' } },
        },
      },
      createdAt: 250,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const drafts = storage.getState().sessionMessages.s1?.draftsByLocalId ?? {};
    expect(drafts['local-stale']).toBeUndefined();
  });
});
