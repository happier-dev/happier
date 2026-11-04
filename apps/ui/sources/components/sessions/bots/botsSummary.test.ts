import { describe, expect, it, vi } from 'vitest';

import { createSessionListRenderableSessionFixture, renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot, removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { useAppRailBotHomes } from '@/components/navigation/shell/appRail/AppRailBots';
import { buildAppRailEntries } from '@/components/navigation/shell/appRail/appRailModel';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';

import { createBotsPresentationReader, createBotsSummaryReader, useOrderedBots, useBotsSummary } from './botsSummary';

describe('closed Bots entries summary', () => {
  const now = 1_800_000_000_000;
  it('omits recording-private Bots from roster, summary and raw rail pins, then restores them', async () => {
    const previousState = storage.getState();
    const previousServerId = getActiveServerSnapshot().serverId;
    const home = await upsertAndActivateServer({ serverUrl: 'https://bots-summary.test' });
    const serverId = home.id;
    const rows = Object.fromEntries(['private-bot', 'public-bot'].map(id => [id,
      createSessionListRenderableSessionFixture({ id, metadata: { path: '/repo', bot: { kind: 'bot' } } }),
    ]));
    let hook: Pick<Awaited<ReturnType<typeof renderHook>>, 'unmount'> | undefined;
    try {
      storage.setState({ sessionListBotRowsByServerId: { [serverId]: rows }, sessionListRowsByServerId: { [serverId]: rows } });
      for (const id of ['private-bot', 'public-bot']) storage.getState().setSessionPinOptimistic(serverId, id,
        { sessionId: id, sortKey: null, pinnedAt: 1, listPinned: false, railPinned: true });
      storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
      storage.getState().setSessionTagAssignmentsOptimistic(serverId, 'private-bot', ['private']);
      setScreenSharingPrivacyActive(true);
      const result = await renderHook(() => ({ bots: useOrderedBots(), summary: useBotsSummary(), homes: useAppRailBotHomes() }));
      hook = result;
      expect(result.getCurrent().bots.map(bot => bot.sessionId)).toEqual(['public-bot']);
      expect(result.getCurrent().summary.faces.map(face => face.key)).toEqual([sessionAddressKey({ serverId, sessionId: 'public-bot' })]);
      expect(Object.keys(result.getCurrent().homes[0]?.rowsBySessionId ?? {})).toEqual(['public-bot']);
      expect(buildAppRailEntries([], { botHomes: result.getCurrent().homes }).bots.map(bot => bot.sessionId)).toEqual(['public-bot']);
      await act(async () => { setScreenSharingPrivacyActive(false); });
      expect(result.getCurrent().bots.map(bot => bot.sessionId).sort()).toEqual(['private-bot', 'public-bot']);
      expect(buildAppRailEntries([], { botHomes: result.getCurrent().homes }).bots.map(bot => bot.sessionId).sort()).toEqual(['private-bot', 'public-bot']);
    } finally {
      await hook?.unmount();
      setScreenSharingPrivacyActive(false);
      if (previousServerId) await setActiveServerId(previousServerId);
      await removeServerProfile(home.id);
      storage.setState(previousState, true);
    }
  });

  it('reads Bot facts only when one of its Homes publishes a changed Bot selection', () => {
    let rowReads = 0;
    const bot = createSessionListRenderableSessionFixture({
      id: 'bot',
      metadata: { path: '/project', bot: { kind: 'bot' } },
    });
    const counted = new Proxy(bot, {
      get(target, key, receiver) {
        if (key === 'metadata') rowReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const homeRows = { bot: counted };
    const read = createBotsSummaryReader(['home-a']);

    const first = read({ 'home-a': homeRows, 'home-b': {} }, now);
    const readsAfterFirst = rowReads;
    expect(readsAfterFirst).toBeGreaterThan(0);

    // Another Home changed, or anything else in the store: this Home's map is the same object.
    expect(read({ 'home-a': homeRows, 'home-b': { other: bot } }, now)).toBe(first);
    expect(rowReads).toBe(readsAfterFirst);

    // An equal source replacement does not re-read unchanged Bot identities either.
    expect(read({ 'home-a': { ...homeRows } }, now)).toBe(first);
    expect(rowReads).toBe(readsAfterFirst);
  });

  it('shows three faces by meaningful activity even when heartbeats have the opposite order', () => {
    const rows = Object.fromEntries(
      [
        ...[1, 2, 3, 4].map((n) =>
          createSessionListRenderableSessionFixture({
            id: `bot-${n}`,
            activeAt: 5 - n,
            meaningfulActivityAt: n,
            metadata: { path: '/p', bot: { kind: 'bot' } },
          }),
        ),
      ].map((row) => [row.id, row]),
    );
    const summary = createBotsSummaryReader(['home-a'])({ 'home-a': rows }, now);
    expect(summary.faces.map((face) => face.key)).toEqual([
      ...['bot-4', 'bot-3', 'bot-2'].map(sessionId => sessionAddressKey({ serverId: 'home-a', sessionId })),
    ]);
    expect(summary.needsYou).toBe(0);
  });

  it('publishes nothing for liveness-only heartbeats and forwards a real meaningful reorder', () => {
    const firstBot = createSessionListRenderableSessionFixture({ id: 'first', meaningfulActivityAt: 20, activeAt: now,
      metadata: { path: '/p', bot: { kind: 'bot' } } });
    const secondBot = { ...firstBot, id: 'second', meaningfulActivityAt: 10 };
    const read = createBotsSummaryReader(['home-a']);
    let rows = { first: firstBot, second: secondBot };
    const first = read({ 'home-a': rows }, now);
    let publications = 0;
    let previous = first;
    for (let index = 1; index <= 12; index++) {
      rows = { ...rows, second: { ...rows.second, activeAt: now + index } };
      const next = read({ 'home-a': rows }, now);
      if (next !== previous) publications++;
      previous = next;
    }
    expect(publications).toBe(0);
    expect(previous).toBe(first);
    const changed = read({ 'home-a': { ...rows, second: { ...rows.second, meaningfulActivityAt: 30 } } }, now);
    expect(changed).not.toBe(first);
    expect(changed.faces.map(face => face.key)).toEqual(['second', 'first'].map(sessionId => sessionAddressKey({ serverId: 'home-a', sessionId })));
  });

  it('keeps raw liveness fresh while twelve heartbeats cause zero sorts/publications, then publishes the awareness deadline', () => {
    const bot = createSessionListRenderableSessionFixture({ id: 'working', active: true, activeAt: now, presence: 'online',
      latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: undefined, meaningfulActivityAt: 10,
      metadata: { path: '/p', bot: { kind: 'bot' } } });
    let rows = { working: bot };
    const read = createBotsPresentationReader(['home-a']);
    const first = read({ 'home-a': rows }, now);
    expect(first[0]?.activity).toBe('working');
    const sort = vi.spyOn(Array.prototype, 'sort');
    let publications = 0;
    try {
      for (let index = 1; index <= 12; index++) {
        rows = { working: { ...rows.working, activeAt: now + index } };
        if (read({ 'home-a': rows }, now) !== first) publications++;
      }
      expect(rows.working.activeAt).toBe(now + 12);
      expect(publications).toBe(0);
      // Only the Bot-ranking sort is relevant; shared status internals may sort requests.
      expect(sort.mock.instances.filter(value => Array.isArray(value) && value.some(entry => entry && typeof entry === 'object'
        && 'meaningfulActivityAt' in entry && 'activity' in entry))).toHaveLength(0);
    } finally { sort.mockRestore(); }
    const deadline = readSessionStatusNextRefreshAtMs(rows.working, now + 12);
    expect(deadline).not.toBeNull();
    const stale = read({ 'home-a': rows }, deadline!);
    expect(stale).not.toBe(first);
    expect(stale[0]?.activity).toBe('quiet');
    expect(read({ 'home-a': rows }, deadline! + 300_000)).toBe(stale);
  });
});
