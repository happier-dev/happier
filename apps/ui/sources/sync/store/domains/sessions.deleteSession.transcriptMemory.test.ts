import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Boundary mock (platform storage): the sessions domain persists drafts/permission
// modes through react-native-mmkv, which has no JS implementation in vitest.
const mmkvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
  class MMKV {
    getString(key: string) {
      return mmkvStore.get(key);
    }
    set(key: string, value: string) {
      mmkvStore.set(key, value);
    }
    delete(key: string) {
      mmkvStore.delete(key);
    }
    clearAll() {
      mmkvStore.clear();
    }
  }
  return { MMKV };
});

import { createSessionsDomain } from './sessions';
import { clearPersistence } from '@/sync/domains/state/persistence';
import { registerSessionTranscriptDerivedCacheClear } from '@/sync/runtime/sessionTranscriptDerivedCaches';

function createHarness() {
  let state: any = {
    sessions: {},
    sessionListRenderables: {},
    sessionsData: null,
    sessionListViewData: null,
    sessionListViewDataByServerId: {},
    sessionScmStatus: {},
    sessionLastViewed: {},
    sessionRepositoryTreeExpandedPathsBySessionId: {},
    reviewCommentsDraftsBySessionId: {},
    reviewCommentsDraftsByWorkspaceCacheKey: {},
    actionDraftsBySessionId: {},
    isDataReady: false,
    machines: {},
    sessionMessages: {},
    settings: { groupInactiveSessionsByProject: false },
    machineDisplayById: {},
  };

  const get = () => state;
  const set = (updater: any) => {
    const next = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...next };
  };

  const domain = createSessionsDomain({ get, set } as any);
  set(domain as any);
  return { get, domain };
}

describe('sessions domain: deleteSession transcript memory release', () => {
  const unregisterFns: Array<() => void> = [];

  beforeEach(() => {
    clearPersistence();
  });

  afterEach(() => {
    while (unregisterFns.length > 0) {
      unregisterFns.pop()?.();
    }
  });

  it('clears per-session derived transcript caches through the shared release seam', () => {
    const cleared: string[] = [];
    unregisterFns.push(registerSessionTranscriptDerivedCacheClear((sessionId) => {
      cleared.push(sessionId);
    }));

    const { get, domain } = createHarness();
    domain.deleteSession('s_gone');

    expect(cleared).toEqual(['s_gone']);
    expect(get().sessionMessages.s_gone).toBeUndefined();
  });

  /**
   * `sessionListRenderables` is the presence answer every consumer asking "does this session
   * still exist for this viewer" reads — the `@session` picker through the view data derived
   * from it, and `useSessionReferenceTarget` directly. If a delete left the renderable behind,
   * a transcript reference to a deleted session would stay pressable and navigate nowhere.
   */
  it('removes the session-list renderable so a reference to a deleted session reads as gone', () => {
    const { get, domain } = createHarness();
    domain.mergeSessionListRenderables([
      {
        id: 's_gone',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { name: 'Gone', path: '/tmp/gone' },
        thinking: false,
        thinkingAt: 0,
        presence: 1,
      },
      {
        id: 's_kept',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { name: 'Kept', path: '/tmp/kept' },
        thinking: false,
        thinkingAt: 0,
        presence: 1,
      },
    ] as any);
    expect(get().sessionListRenderables.s_gone).toBeDefined();

    domain.deleteSession('s_gone');

    expect(get().sessionListRenderables.s_gone).toBeUndefined();
    expect(get().sessionListRenderables.s_kept).toBeDefined();
  });
});
