import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, createSessionFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { act } from 'react-test-renderer';
import { createRenderCommitCounter, countStoreNotifications, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useUserMessageHistory } = await import('./useUserMessageHistory');
const { useUserMessageHistoryEntries } = await import('./useUserMessageHistoryEntries');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
let serverId = '';

describe('useUserMessageHistory', () => {
  beforeEach(async () => {
    await account.reset();
    ({ serverId } = await account.restore());
    storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId }) } });
    account.home.answer(serverId, '/v1/sessions/s1/messages', { body: { messages: [], hasMore: false, nextBeforeSeq: null } });
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.session.messages.role = false;
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  });
  afterEach(async () => { await account.reset(); });

  it.each(['navigator', 'entries'] as const)('keeps global %s idle when an assistant-only transcript is first admitted', async reader => {
    storage.setState(state => ({ sessions: { ...state.sessions,
      sibling: createSessionFixture({ id: 'sibling', serverId }) } }));
    storage.getState().applyMessages('s1', Array.from({ length: 1000 }, (_, index) => ({
      id: `prefix-${index}`, localId: null, seq: index + 1, createdAt: index + 1,
      isSidechain: false, role: 'user' as const, content: { type: 'text' as const, text: `prefix ${index}` },
    })));
    const counts = createRenderCommitCounter();
    const hook = await renderHook(() => {
      useRenderCommitCounter(counts);
      return reader === 'navigator' ? useUserMessageHistory({ scope: 'global', sessionId: 's1', serverId })
        : useUserMessageHistoryEntries({ scope: 'global', sessionId: 's1', serverId });
    });
    try {
      counts.reset();
      await act(async () => { storage.getState().applyMessages('sibling', [{
        id: 'only-assistant', localId: null, seq: 1, createdAt: 1, isSidechain: false, role: 'agent',
        content: [{ type: 'text', text: 'not a prompt', uuid: 'only-assistant', parentUUID: null }],
      }]); });
      expect(counts.read()).toEqual({ renders: 0, commits: 0 });
      await act(async () => { storage.getState().applyMessages('sibling', [{
        id: 'first-sibling-user', localId: null, seq: 2, createdAt: 2000, isSidechain: false,
        role: 'user', content: { type: 'text', text: 'expanded user body' }, meta: { displayText: 'first sibling prompt' },
      }]); });
      const fresh = hook.getCurrent();
      if ('entries' in fresh) expect(fresh.entries[0]?.text).toBe('first sibling prompt');
      else expect(fresh.moveUp('draft')).toBe('first sibling prompt');
    } finally { await hook.unmount(); }
  });

  it.each([
    { reader: 'navigator', scope: 'perSession' },
    { reader: 'navigator', scope: 'global' },
    { reader: 'entries', scope: 'perSession' },
    { reader: 'entries', scope: 'global' },
  ] as const)('does no $reader/$scope history work across same-Session assistant revisions', async ({ reader, scope }) => {
    const counts = createRenderCommitCounter();
    const assistant = (text: string, revision = 0) => ({
      id: 'streaming-tail', localId: null, seq: 1001, createdAt: 1001,
      isSidechain: false, role: 'agent' as const,
      content: [{ type: 'text' as const, text, uuid: 'streaming-tail', parentUUID: null }],
      meta: { happierStreamSegmentV1: { v: 1 as const, segmentKind: 'assistant' as const, segmentLocalId: 'streaming-tail',
        segmentState: 'streaming' as const, startedAtMs: 1001, updatedAtMs: 2000 + revision } },
    });
    storage.getState().applyMessages('s1', [
      ...Array.from({ length: 1000 }, (_, index) => ({
        id: `prompt-${index}`, localId: null, seq: index + 1, createdAt: index + 1,
        isSidechain: false, role: 'user' as const, content: { type: 'text' as const, text: `prompt ${index}` },
      })), assistant('start'),
    ]);
    const hook = await renderHook(() => {
      useRenderCommitCounter(counts);
      return reader === 'navigator'
        ? useUserMessageHistory({ scope, sessionId: 's1', serverId, maxEntries: 20 })
        : useUserMessageHistoryEntries({ scope, sessionId: 's1', serverId });
    });
    const notifications = countStoreNotifications(storage);
    let historicalDisplayReads = 0;
    // Observe genuine reducer output without replacing admission or history logic.
    for (const message of Object.values(storage.getState().sessionMessages.s1.messagesById)) {
      if (message.kind !== 'user-text') continue;
      const displayText = message.displayText;
      Object.defineProperty(message, 'displayText', { configurable: true,
        get() { historicalDisplayReads += 1; return displayText; } });
    }
    try {
      const initial = hook.getCurrent();
      if ('moveUp' in initial) expect(initial.moveUp('my draft')).toBe('prompt 999');
      else expect(initial.entries[0]?.text).toBe('prompt 999');
      counts.reset();
      for (let revision = 1; revision <= 10; revision++) {
        await act(async () => { storage.getState().applyMessages('s1', [assistant(`stream revision ${revision}`, revision)]); });
      }
      expect(notifications.read().length).toBeGreaterThan(0);
      expect(Object.values(storage.getState().sessionMessages.s1.messagesById)
        .some(message => message.kind === 'agent-text' && message.text === 'stream revision 10')).toBe(true);
      expect(counts.read()).toEqual({ renders: 0, commits: 0 });
      expect(historicalDisplayReads).toBe(0);
      for (let arrival = 1; arrival <= 10; arrival++) {
        await act(async () => { storage.getState().applyMessages('s1', [{
          id: `assistant-arrival-${arrival}`, localId: null, seq: 1001 + arrival, createdAt: 1001,
          isSidechain: false, role: 'agent', content: [{ type: 'text', text: `new block ${arrival}`,
            uuid: `assistant-arrival-${arrival}`, parentUUID: null }],
        }]); });
      }
      expect(counts.read()).toEqual({ renders: 0, commits: 0 });
      expect(historicalDisplayReads).toBe(0);
      const afterStream = hook.getCurrent();
      if ('moveUp' in initial && 'moveUp' in afterStream) {
        expect(afterStream).toBe(initial);
        expect(afterStream.isBrowsing()).toBe(true);
        expect(afterStream.moveDown('prompt 999')).toBe('my draft');
      } else if ('entries' in initial && 'entries' in afterStream) expect(afterStream.entries).toBe(initial.entries);

      await act(async () => { storage.getState().applyMessages('s1', [{
        id: 'fresh-user', localId: null, seq: 1002, createdAt: 1002, isSidechain: false,
        role: 'user', content: { type: 'text', text: 'expanded scaffolding' }, meta: { displayText: 'fresh prompt' },
      }]); });
      const fresh = hook.getCurrent();
      if ('moveUp' in fresh) { fresh.reset(); expect(fresh.moveUp('new draft')).toBe('fresh prompt'); }
      else expect(fresh.entries[0]?.text).toBe('fresh prompt');
      await act(async () => { const correctedUser = {
        id: 'fresh-user', localId: null, seq: 1002, createdAt: 1002, isSidechain: false,
        role: 'user' as const, content: { type: 'text' as const, text: 'corrected expanded scaffolding' },
        meta: { displayText: 'corrected prompt' }, isAuthoritativeUpdate: true as const,
      }; storage.getState().applyMessages('s1', [correctedUser]); });
      const corrected = hook.getCurrent();
      if ('moveUp' in corrected) { corrected.reset(); expect(corrected.moveUp('last draft')).toBe('corrected prompt'); }
      else expect(corrected.entries[0]?.text).toBe('corrected prompt');
    } finally {
      notifications.stop();
      await hook.unmount();
    }
  });

  it.each([
    { reader: 'navigator', scope: 'perSession' }, { reader: 'navigator', scope: 'global' },
    { reader: 'entries', scope: 'perSession' }, { reader: 'entries', scope: 'global' },
  ] as const)('retires $reader/$scope prompts through transcript and Account lifecycles', async ({ reader, scope }) => {
    const prompt = (id: string, text: string) => ({ id, localId: null, createdAt: 10,
      isSidechain: false, role: 'user' as const, content: { type: 'text' as const, text } });
    storage.getState().applyMessages('s1', [prompt('old', 'old private prompt')]);
    const hook = await renderHook(() => reader === 'navigator'
      ? useUserMessageHistory({ scope, sessionId: 's1', serverId })
      : useUserMessageHistoryEntries({ scope, sessionId: 's1', serverId }));
    const texts = () => {
      const value = hook.getCurrent();
      if ('entries' in value) return value.entries.map(entry => entry.text);
      value.reset();
      const first = value.moveUp('draft');
      return first === null ? [] : [first];
    };
    try {
      expect(texts()).toEqual(['old private prompt']);
      await act(async () => { storage.getState().replaceSessionMessages('s1', [prompt('new', 'replacement prompt')]); });
      expect(texts()).toEqual(['replacement prompt']);
      await act(async () => { storage.getState().resetSessionMessages('s1'); });
      expect(texts()).toEqual([]);
      await act(async () => { storage.getState().applyMessages('s1', [prompt('evicted', 'evicted prompt')]); });
      expect(texts()).toEqual(['evicted prompt']);
      await act(async () => { storage.getState().evictSessionMessages('s1'); });
      expect(texts()).toEqual([]);
      await act(async () => { storage.getState().applyMessages('s1', [prompt('deleted', 'deleted prompt')]); });
      expect(texts()).toEqual(['deleted prompt']);
      await act(async () => { storage.getState().deleteSession('s1', serverId); });
      expect(texts()).toEqual([]);
      await act(async () => {
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId })]);
        storage.getState().applyMessages('s1', [prompt('account-old', 'prior Account prompt')]);
      });
      expect(texts()).toEqual(['prior Account prompt']);
      await act(async () => { await account.reset(); await account.restore({ accountId: 'next-history-account' }); });
      expect(texts()).toEqual([]);
    } finally { await hook.unmount(); }
  });

  it('does no per-Session history work when a sibling streams through the real message owner', async () => {
    const counts = createRenderCommitCounter();
    storage.setState(state => ({
      sessions: { ...state.sessions, sibling: createSessionFixture({ id: 'sibling', serverId }) },
    }));
    storage.getState().applyMessages('s1', [{ id: 'u1', localId: null, createdAt: 1,
      isSidechain: false, role: 'user', content: { type: 'text', text: 'my prompt' } }]);
    const hook = await renderHook(() => {
      useRenderCommitCounter(counts);
      return useUserMessageHistoryEntries({ scope: 'perSession', sessionId: 's1', serverId });
    });
    const notifications = countStoreNotifications(storage);
    try {
      const initial = hook.getCurrent().entries;
      expect(initial.map(entry => entry.text)).toEqual(['my prompt']);
      counts.reset();
      for (const chunk of ['one', 'two', 'three']) {
        await act(async () => {
          storage.getState().applyMessages('sibling', [{
            id: `chunk-${chunk}`, localId: null, createdAt: 10,
            isSidechain: false, role: 'agent', content: [{ type: 'text', text: chunk, uuid: `chunk-${chunk}`, parentUUID: null }],
          }]);
        });
      }
      expect(notifications.read().length).toBeGreaterThan(0);
      expect(counts.read()).toEqual({ renders: 0, commits: 0 });
      expect(hook.getCurrent().entries).toBe(initial);
      // A real change to this history still arrives immediately.
      await act(async () => {
        storage.getState().applyMessages('s1', [{ id: 'new-prompt', localId: null, createdAt: 20,
          isSidechain: false, role: 'user', content: { type: 'text', text: 'next prompt' } }]);
      });
      expect(hook.getCurrent().entries[0]?.text).toBe('next prompt');
    } finally {
      notifications.stop();
      await hook.unmount();
    }
  });

  it('returns a referentially stable navigator when store state is unchanged', async () => {
    const previousState = storage.getState();
    try {
      storage.getState().applyMessages('s1', [
        { id: 'u1', localId: null, createdAt: 1, isSidechain: false, role: 'user', content: { type: 'text', text: 'hi' } },
        { id: 'a1', localId: null, createdAt: 2, isSidechain: false, role: 'agent', content: [{ type: 'text', text: 'ok', uuid: 'a1', parentUUID: null }] },
        { id: 'u2', localId: null, createdAt: 3, isSidechain: false, role: 'user', content: { type: 'text', text: 'bye' } },
      ]);

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'global', sessionId: null, maxEntries: 20 }),
      );

      const first = hook.getCurrent();

      await hook.rerender();

      expect(hook.getCurrent()).toBe(first);

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });

  it('normalizes session ids before reading per-session history', async () => {
    const previousState = storage.getState();
    try {
      storage.getState().applyMessages('s1', [
        { id: 'u1', localId: null, createdAt: 1, isSidechain: false, role: 'user', content: { type: 'text', text: 'first' } },
        { id: 'u2', localId: null, createdAt: 2, isSidechain: false, role: 'user', content: { type: 'text', text: 'expanded second' }, meta: { displayText: '  second\n' } },
      ]);

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'perSession', sessionId: '  s1  ', maxEntries: 20 }),
      );

      expect(hook.getCurrent().moveUp('draft')).toBe('  second\n');

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });

  it('preserves active per-session browsing when role-query support becomes ready', async () => {
    const previousState = storage.getState();
    try {
      storage.getState().applyMessages('s1', [
        { id: 'u1', localId: null, createdAt: 1, isSidechain: false, role: 'user', content: { type: 'text', text: 'first' } },
        { id: 'u2', localId: null, createdAt: 2, isSidechain: false, role: 'user', content: { type: 'text', text: 'second' } },
      ]);

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
      );

      const browsingNavigator = hook.getCurrent();
      expect(browsingNavigator.moveUp('draft')).toBe('second');
      expect(browsingNavigator.isBrowsing()).toBe(true);

      const features = createRootLayoutFeaturesResponse();
      features.capabilities.session.messages.role = true;
      primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
      await hook.rerender();

      expect(hook.getCurrent()).toBe(browsingNavigator);
      expect(hook.getCurrent().moveUp('second')).toBe('first');

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });
});
