import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  createSessionComposerTextMutationToken,
  readSessionComposerSemanticRevision,
  resetSessionDraftValueCachesForTests,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import { clearPersistence, loadSessionDrafts } from '@/sync/domains/state/persistence';

function createHarness() {
  let state: any = {
    sessions: {},
    concurrentSessionListCacheByServerId: {},
    sessionScmStatus: {},
    sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        settings: { groupInactiveSessionsByProject: false },
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

describe('sessions domain: drafts', () => {
  beforeEach(() => {
    clearPersistence();
    resetSessionDraftValueCachesForTests();
  });

  it('persists drafts even when the session is not yet loaded', () => {
    const { get, domain } = createHarness();
    expect(Object.keys(get().sessions).length).toBe(0);

    domain.updateSessionDraft('s_missing', 'hello');
    expect(loadSessionDrafts()).toEqual({ s_missing: 'hello' });
    expect(Object.keys(get().sessions).length).toBe(0);
  });

  it('does not let an external text write consume a stale visible-text mutation token', () => {
    const { domain } = createHarness();
    const firstVisibleToken = createSessionComposerTextMutationToken(null, 's_missing');

    if (!firstVisibleToken) throw new Error('Expected visible text mutation token');
    domain.updateSessionDraft('s_missing', 'visible', {
      composerTextMutationToken: firstVisibleToken,
    });
    expect(readSessionComposerSemanticRevision(null, 's_missing')).toBe(1);

    const staleVisibleToken = createSessionComposerTextMutationToken(null, 's_missing');
    if (!staleVisibleToken) throw new Error('Expected stale visible text mutation token');
    domain.updateSessionDraft('s_missing', 'external');
    domain.updateSessionDraft('s_missing', 'visible again', {
      composerTextMutationToken: staleVisibleToken,
    });

    expect(readSessionComposerSemanticRevision(null, 's_missing')).toBe(4);
  });

  it('applies a persisted draft when the session is later loaded', () => {
    const { get, domain } = createHarness();
    expect(Object.keys(get().sessions).length).toBe(0);

    domain.updateSessionDraft('s_new', 'hello');
    expect(loadSessionDrafts()).toEqual({ s_new: 'hello' });

    domain.applySessions([
      {
        id: 's_new',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
      } as any,
    ]);

    expect(get().sessions.s_new?.draft).toBe('hello');
  });

  it('applies persisted drafts for new sessions even when some sessions are already loaded', () => {
    const { get, domain } = createHarness();

    domain.applySessions([
      {
        id: 's_existing',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
      } as any,
    ]);

    expect(Object.keys(get().sessions).length).toBe(1);

    domain.updateSessionDraft('s_new', 'hello');
    expect(loadSessionDrafts()).toEqual({ s_new: 'hello' });

    domain.applySessions([
      {
        id: 's_new',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
      } as any,
    ]);

    expect(get().sessions.s_new?.draft).toBe('hello');
  });

  it('preserves persisted drafts for unloaded sessions when updating a loaded session draft', () => {
    const { get, domain } = createHarness();

    domain.updateSessionDraft('s_unloaded', 'keep this draft');
    expect(loadSessionDrafts()).toEqual({ s_unloaded: 'keep this draft' });

    domain.applySessions([
      {
        id: 's_loaded',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
      } as any,
    ]);

    expect(get().sessions.s_unloaded).toBeUndefined();

    domain.updateSessionDraft('s_loaded', 'loaded draft');

    expect(loadSessionDrafts()).toEqual({
      s_unloaded: 'keep this draft',
      s_loaded: 'loaded draft',
    });
  });

  it('preserves persisted drafts for unloaded sessions when clearing a loaded session draft', () => {
    const { get, domain } = createHarness();

    domain.updateSessionDraft('s_unloaded', 'keep this draft');
    expect(loadSessionDrafts()).toEqual({ s_unloaded: 'keep this draft' });

    domain.applySessions([
      {
        id: 's_loaded',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
      } as any,
    ]);

    domain.updateSessionDraft('s_loaded', 'loaded draft');
    expect(loadSessionDrafts()).toEqual({
      s_unloaded: 'keep this draft',
      s_loaded: 'loaded draft',
    });

    domain.updateSessionDraft('s_loaded', '');

    expect(get().sessions.s_loaded?.draft).toBeNull();
    expect(loadSessionDrafts()).toEqual({
      s_unloaded: 'keep this draft',
    });
  });
});
