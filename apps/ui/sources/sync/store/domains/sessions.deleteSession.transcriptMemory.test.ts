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
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

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
  return { get, set, domain };
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

  it.each([false, true])('deletes only the owning Home cache with an identity alias: %s', (useIdentityAlias) => {
    const remote = upsertServerProfile({ serverUrl: 'https://delete-remote.example' });
    const remoteServerId = useIdentityAlias
      ? setServerProfileIdentityForUrl(remote.serverUrl, 'srv_delete_remote')!.serverIdentityId!
      : remote.id;
    const activeServerId = getActiveServerSnapshot().serverId;
    const activeSession = createSessionFixture({ id: 'same-id', serverId: activeServerId });
    const renderable = buildSessionListRenderableFromSession(activeSession);
    const remoteRows = [
      { type: 'session', session: renderable, serverId: remote.id },
      { type: 'session', session: { ...renderable, id: 'remote-kept' }, serverId: remote.id },
    ] satisfies SessionListViewItem[];
    const activeRows = [{ type: 'session', session: renderable, serverId: activeServerId }] satisfies SessionListViewItem[];
    const cleared: string[] = [];
    unregisterFns.push(registerSessionTranscriptDerivedCacheClear((sessionId) => cleared.push(sessionId)));
    const { get, set, domain } = createHarness();
    set({
      sessions: { 'same-id': activeSession },
      sessionListRenderables: { 'same-id': renderable },
      sessionListViewDataByServerId: { [activeServerId]: activeRows, [remote.id]: remoteRows },
    });

    domain.deleteSession('same-id', remoteServerId);

    expect(get().sessions['same-id']).toBe(activeSession);
    expect(get().sessionListRenderables['same-id']).toBe(renderable);
    expect(get().sessionListViewDataByServerId[activeServerId]).toBe(activeRows);
    expect(get().sessionListViewDataByServerId[remoteServerId]).toEqual([
      expect.objectContaining({ session: expect.objectContaining({ id: 'remote-kept' }) }),
    ]);
    expect(cleared).toEqual([]);

    const afterDelete = get();
    domain.deleteSession('same-id', remoteServerId);
    expect(get().sessionListViewDataByServerId).toBe(afterDelete.sessionListViewDataByServerId);
  });
});
