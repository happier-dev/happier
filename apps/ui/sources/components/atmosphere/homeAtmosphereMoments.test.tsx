import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import {
  DEFAULT_HOME_ATMOSPHERE,
  type HomeAtmosphere,
} from '@happier-dev/protocol/account/settings/accountSettings';

import { renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { atmosphereResettleFact } from './atmosphereStage';
import { builtinPictureLocalId } from './ensureBuiltinPicture';
import {
  useIdleResettle,
  buildSessionTurnStates,
  useSessionFinishedRipple,
  createSessionTurnStateSelector,
  createSessionFinishedRippleObserver,
  type SessionTurnState,
} from './homeAtmosphereMoments';
import { sessionRippleFrame } from './sessionRipple';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';

// React Native is the platform boundary; the moment policies and Look edits stay real.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const HOUR_MS = 3_600_000;
const working: SessionTurnState = {
  lastTurnCompletedAt: null,
  pendingApproval: false,
};
const finished: SessionTurnState = {
  lastTurnCompletedAt: 1,
  pendingApproval: false,
};
const approval: SessionTurnState = {
  lastTurnCompletedAt: 1,
  pendingApproval: true,
};
const states = (entries: Readonly<Record<string, SessionTurnState>>) =>
  new Map(Object.entries(entries));

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('session-finished ripple (Home owner, fake clock)', () => {
  it('publishes retirement of a hydrated Voice Session after its list corpus was cleared', () => {
    const previous = storage.getState();
    const session = createSessionFixture({ id: 'voice-without-list-row', serverId: 'server-a', metadata: {
      path: '/voice', host: 'test', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
    } });
    try {
      storage.getState().applySessions([session]);
      storage.getState().clearSessionListRowsForServerScope('server-a');
      expect(storage.getState().sessions[session.id]).toBeDefined();
      expect(storage.getState().sessionListRowsByServerId['server-a']?.[session.id]).toBeUndefined();
      storage.getState().deleteSession(session.id, 'server-a');
      expect(storage.getState().sessionListRenderableDelta.removedSessionIds).toContain(session.id);
    } finally { storage.setState(previous, true); }
  });
  it('keeps same-id Sessions on separate Homes current and rebuilds membership without replaying removals', () => {
    const session = createSessionFixture({ id: 'same-id', serverId: 'server-a', lastTurnCompletedAt: 10 });
    const sibling = { ...session, serverId: 'server-b', lastTurnCompletedAt: 20 };
    const membership = { membershipByServerId: {}, statesByServerId: {}, coverageComplete: false };
    const active = getActiveServerSnapshot();
    const project = createSessionTurnStateSelector();
    const state = {
      ...storage.getState(), isDataReady: true,
      sessions: { [session.id]: session },
      ordinarySessionListMembershipByServerId: { 'server-a': [session.id], 'server-b': [sibling.id] },
      sessionListRowsByServerId: {
        'server-a': { [session.id]: buildSessionListRenderableFromSession(session) },
        'server-b': { [sibling.id]: buildSessionListRenderableFromSession(sibling) },
      },
      sessionListRenderableDelta: { revision: 1, changedSessionIds: [session.id], removedSessionIds: [], rebuiltSessionListIndex: true },
    };
    expect(project(state, membership, active)?.states.size).toBe(2);
    const changed = { ...state, sessionListRowsByServerId: {
      ...state.sessionListRowsByServerId,
      'server-b': { [sibling.id]: buildSessionListRenderableFromSession({ ...sibling, lastTurnCompletedAt: 30 }) },
    }, sessionListRenderableDelta: { ...state.sessionListRenderableDelta, revision: 2, rebuiltSessionListIndex: false } };
    expect([...project(changed, membership, active)?.states ?? []]).toEqual([
      ['server-b\u0000same-id', { lastTurnCompletedAt: 30, pendingApproval: false }],
    ]);
    const removed = { ...changed, ordinarySessionListMembershipByServerId: { 'server-a': [session.id], 'server-b': [] } };
    expect([...project(removed, membership, active)?.states ?? []]).toEqual([['server-b\u0000same-id', null]]);
    // A new membership/policy is authoritative even without a new changed-id revision.
    expect(project(removed, { ...membership, membershipByServerId: { 'server-b': [sibling.id] } }, active)?.states.get('server-b\u0000same-id'))
      .toEqual({ lastTurnCompletedAt: 30, pendingApproval: false });
  });
  it('reads only the changed Session after learning a thousand-session Home', async () => {
    const previous = storage.getState();
    let inventoryScans = 0;
    let rowReads = 0;
    let machineReads = 0;
    const sessions = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
      const id = `scale-${index}`;
      return [id, createSessionFixture({ id, serverId: 'server-a', active: true, activeAt: Date.now(), lastTurnCompletedAt: 10 })];
    }));
    const rows = Object.fromEntries(Object.entries(sessions).map(([id, session]) => [id, buildSessionListRenderableFromSession(session)]));
    // The app also has an independent Voice inventory subscriber. Count this corridor's work,
    // including Activity's source selector, instead of charging Voice's reads to Atmosphere.
    const fromAtmosphere = () => /(?:homeAtmosphereMoments|buildActivityOverviewFromSource|createActivityAttentionStoreSourceSelector)\.tsx?:/.test(new Error().stack ?? '');
    const countScans = (values: typeof sessions) => new Proxy(values, { ownKeys(target) { if (fromAtmosphere()) inventoryScans += 1; return Reflect.ownKeys(target); } });
    const countRows = (values: typeof rows) => new Proxy(values, { get(target, key, receiver) { if (typeof key === 'string' && key.startsWith('scale-') && fromAtmosphere()) rowReads += 1; return Reflect.get(target, key, receiver); } });
    const machines = Object.fromEntries(Array.from({ length: 139 }, (_, index) => {
      const id = `machine-scale-${index}`;
      return [id, createMachineFixture({ id })];
    }));
    const countMachines = (values: typeof machines) => new Proxy(values, { get(target, key, receiver) { if (fromAtmosphere()) machineReads += 1; return Reflect.get(target, key, receiver); }, ownKeys(target) { if (fromAtmosphere()) machineReads += 1; return Reflect.ownKeys(target); } });
    const base = {
      ...previous,
      isDataReady: true,
      sessions: countScans(sessions),
      machines: countMachines(machines),
      sessionListRowsByServerId: { 'server-a': countRows(rows) },
      ordinarySessionListMembershipByServerId: { 'server-a': Object.keys(sessions) },
      sessionListIndexByServerId: { 'server-a': Object.keys(sessions).map(sessionId => ({ type: 'session' as const, sessionId, serverId: 'server-a' })) },
      concurrentSessionListCacheByServerId: {},
      sessionListRenderableDelta: { revision: 100, changedSessionIds: Object.keys(sessions), removedSessionIds: [], rebuiltSessionListIndex: true },
    };
    storage.setState(base, true);
    let answers = 0;
    let renders = 0;
    function Probe() { answers = useSessionFinishedRipple({ enabled: true, visible: true }); renders += 1; return null; }
    const screen = await renderScreen(<Probe />);
    try {
      const changed = { ...sessions['scale-42']!, lastTurnCompletedAt: 20 };
      const nextSessions = countScans({ ...sessions, [changed.id]: changed });
      inventoryScans = 0;
      rowReads = 0;
      renders = 0;
      await act(async () => storage.setState({
        sessions: nextSessions,
        sessionListRowsByServerId: { 'server-a': countRows({ ...rows, [changed.id]: buildSessionListRenderableFromSession(changed) }) },
        sessionListRenderableDelta: { revision: 101, changedSessionIds: [changed.id], removedSessionIds: [], rebuiltSessionListIndex: false },
      }));
      expect({ inventoryScans, rowReads }).toEqual({ inventoryScans: 0, rowReads: 2 });
      expect(answers).toBe(1);
      expect(renders).toBe(1);
      // Both publications occur in one React batch. A later non-finish must not erase the first finish.
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        const another = { ...sessions['scale-43']!, lastTurnCompletedAt: 30 };
        const latestRows = { ...rows, [changed.id]: buildSessionListRenderableFromSession(changed), [another.id]: buildSessionListRenderableFromSession(another) };
        storage.setState({ sessionListRowsByServerId: { 'server-a': latestRows }, sessionListRenderableDelta: {
          revision: 102, changedSessionIds: [another.id], removedSessionIds: [], rebuiltSessionListIndex: false,
        } });
        storage.setState({ sessionListRowsByServerId: { 'server-a': { ...latestRows, 'scale-44': { ...rows['scale-44']!, seq: 2 } } }, sessionListRenderableDelta: {
          revision: 103, changedSessionIds: ['scale-44'], removedSessionIds: [], rebuiltSessionListIndex: false,
        } });
      });
      expect(answers).toBe(2);
      const arriving = createSessionFixture({ id: 'scale-1000', serverId: 'server-a', lastTurnCompletedAt: 40 });
      const membershipBeforeArrival = storage.getState().ordinarySessionListMembershipByServerId['server-a'] ?? [];
      const rowsBeforeArrival = storage.getState().sessionListRowsByServerId['server-a'] ?? {};
      inventoryScans = 0;
      rowReads = 0;
      await act(async () => storage.setState({
        sessionListRowsByServerId: { 'server-a': countRows({ ...rowsBeforeArrival, [arriving.id]: buildSessionListRenderableFromSession(arriving) }) },
        ordinarySessionListMembershipByServerId: { 'server-a': [...membershipBeforeArrival, arriving.id] },
        sessionListRenderableDelta: {
          revision: 104, changedSessionIds: [arriving.id], removedSessionIds: [], rebuiltSessionListIndex: true,
          ordinaryMembershipChanges: [{ serverId: 'server-a', addedSessionIds: [arriving.id], removedSessionIds: [] }],
        },
      }));
      expect({ inventoryScans, rowReads, answers }).toEqual({ inventoryScans: 0, rowReads: 2, answers: 2 });
      inventoryScans = 0;
      rowReads = 0;
      await act(async () => storage.setState({
        ordinarySessionListMembershipByServerId: { 'server-a': membershipBeforeArrival },
        sessionListRenderableDelta: {
          revision: 105, changedSessionIds: [], removedSessionIds: [arriving.id], rebuiltSessionListIndex: true,
          ordinaryMembershipChanges: [{ serverId: 'server-a', addedSessionIds: [], removedSessionIds: [arriving.id] }],
        },
      }));
      expect({ inventoryScans, rowReads, answers }).toEqual({ inventoryScans: 0, rowReads: 0, answers: 2 });
      inventoryScans = 0;
      rowReads = 0;
      machineReads = 0;
      renders = 0;
      await act(async () => storage.setState({ machines: countMachines({ ...machines, 'machine-scale-42': { ...machines['machine-scale-42']!, activeAt: Date.now() } }) }));
      expect({ inventoryScans, rowReads, machineReads, renders, answers }).toEqual({ inventoryScans: 0, rowReads: 0, machineReads: 0, renders: 0, answers: 2 });
      // Exercise the real writer -> ephemeral delta -> Activity candidacy -> ripple admission seam.
      for (const source of ['rowOnly', 'archived', 'ordinary'] as const) {
        const id = `producer-${source}`;
        const entry = createSessionFixture({ id, serverId: 'server-a', lastTurnCompletedAt: 50,
          archivedAt: source === 'archived' ? 1 : null });
        await act(async () => { storage.getState().applyServerScopedSessionListRows('server-a', [buildSessionListRenderableFromSession(entry)], { source, mode: 'append' }); });
        expect(storage.getState().sessionListRenderableDelta.ordinaryMembershipChanges).toEqual([
          { serverId: 'server-a', addedSessionIds: source === 'ordinary' ? [id] : [], removedSessionIds: [] },
        ]);
        await act(async () => {
          vi.advanceTimersByTime(10_000);
          storage.getState().applyServerScopedSessionListRowPatches('server-a', [{ sessionId: id, patch: { lastTurnCompletedAt: 60 } }]);
        });
        expect(answers).toBe(source === 'ordinary' ? 3 : 2);
      }
      await act(async () => storage.getState().applyServerScopedSessionListRowPatches('server-a', [{ sessionId: 'producer-ordinary', patch: { archivedAt: 1 } }]));
      expect(storage.getState().sessionListRenderableDelta.ordinaryMembershipChanges).toEqual([
        { serverId: 'server-a', addedSessionIds: [], removedSessionIds: ['producer-ordinary'] },
      ]);
    } finally { await screen.unmount(); storage.setState(previous, true); }
  });
  type Input = Parameters<ReturnType<typeof createSessionFinishedRippleObserver>>[0];
  async function mountRipple(initial: Input) {
    let ripples = 0;
    const observe = createSessionFinishedRippleObserver(() => { ripples += 1; });
    observe(initial);
    return {
      ripples: () => ripples,
      async next(input: Input, advanceMs = 0) {
        await act(async () => {
          vi.advanceTimersByTime(advanceMs);
        });
        observe(input);
      },
    };
  }

  it('answers new canonical completion facts, never queued, interrupted or cleared approvals', async () => {
    const session = createSessionFixture({ id: 'a', serverId: 'server-a', active: true, activeAt: Date.now(), lastTurnCompletedAt: 10 });
    const fromActivity = (changes: Partial<typeof session>) => {
      const next = { ...session, ...changes };
      const source: ActivityAttentionSource = {
        isDataReady: true,
        sessionsById: { a: next },
        sessionListRowsByServerId: { 'server-a': { a: buildSessionListRenderableFromSession(next) } },
        ordinarySessionListMembershipByServerId: { 'server-a': ['a'] },
        sessionListIndexByServerId: { 'server-a': [{ type: 'session', sessionId: 'a', serverId: 'server-a' }] },
        concurrentSessionListCacheByServerId: {},
        activeServerId: 'server-a',
      };
      return buildSessionTurnStates({ source, nowMs: Date.now() });
    };
    const home = await mountRipple({ enabled: true, visible: true, states: fromActivity({ latestTurnStatus: 'in_progress' }) });
    for (const changes of [
      { latestTurnStatus: null, thinking: false, pendingCount: 1 },
      { thinking: false, pendingCount: 0 },
      { agentState: { controlledByUser: null, requests: { request_1: { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: Date.now() } } } },
      { agentState: null, pendingCount: 1 },
    ] satisfies Partial<typeof session>[]) {
      await home.next({ enabled: true, visible: true, states: fromActivity(changes) }, 10_000);
      expect(home.ripples()).toBe(0);
    }
    await home.next({ enabled: true, visible: true, states: fromActivity({ lastTurnCompletedAt: 20 }) }, 10_000);
    expect(home.ripples()).toBe(1);
    await home.next({ enabled: true, visible: true, states: fromActivity({ lastTurnCompletedAt: 30 }) }, 10_000);
    expect(home.ripples()).toBe(2);
  });

  it('answers a session that finishes while Home is visible', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({ a: working }),
    });
    await home.next(
      { enabled: true, visible: true, states: states({ a: finished }) },
      1_000,
    );
    expect(home.ripples()).toBe(1);
  });

  it('consumes a finish that happened while Home was hidden and never replays it', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({ a: working }),
    });
    await home.next(
      { enabled: true, visible: false, states: states({ a: finished }) },
      1_000,
    );
    await home.next(
      { enabled: true, visible: true, states: states({ a: finished }) },
      1_000,
    );
    expect(home.ripples()).toBe(0);
  });

  it('does not answer a turn that ends on a pending approval', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({ a: working }),
    });
    await home.next(
      { enabled: true, visible: true, states: states({ a: approval }) },
      1_000,
    );
    expect(home.ripples()).toBe(0);
  });

  it('merges finishes inside 8 s into one answer and answers again after it', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({ a: working, b: working, c: working }),
    });
    await home.next(
      {
        enabled: true,
        visible: true,
        states: states({ a: finished, b: working, c: working }),
      },
      1_000,
    );
    await home.next(
      {
        enabled: true,
        visible: true,
        states: states({ a: finished, b: finished, c: working }),
      },
      3_000,
    );
    expect(home.ripples()).toBe(1);
    await home.next(
      {
        enabled: true,
        visible: true,
        states: states({ a: finished, b: finished, c: finished }),
      },
      8_000,
    );
    expect(home.ripples()).toBe(2);
  });

  it('learns a session it first sees finished without answering it', async () => {
    const home = await mountRipple({
      enabled: true,
      visible: true,
      states: states({}),
    });
    await home.next(
      { enabled: true, visible: true, states: states({ a: finished }) },
      1_000,
    );
    expect(home.ripples()).toBe(0);
  });

  it('stays still while switched off, and switching it on does not replay what finished meanwhile', async () => {
    const home = await mountRipple({
      enabled: false,
      visible: true,
      states: states({ a: working }),
    });
    await home.next(
      { enabled: false, visible: true, states: states({ a: finished }) },
      1_000,
    );
    await home.next(
      { enabled: true, visible: true, states: states({ a: finished }) },
      1_000,
    );
    expect(home.ripples()).toBe(0);
  });

  it('names each Session that finishes while visible, every time, for its own moment (Bot moons spark once each)', async () => {
    const finishes: string[][] = [];
    const observe = createSessionFinishedRippleObserver(() => {}, keys => finishes.push([...keys]));
    // First sight learns: a completion seen before this Home mount never sparks.
    observe({ enabled: true, visible: true, states: states({ a: finished, b: working, c: working }) });
    expect(finishes).toEqual([]);
    // Inside the ripple's merge window each finish is still its own Session's moment.
    observe({ enabled: true, visible: true, states: states({ b: finished }) });
    observe({ enabled: true, visible: true, states: states({ c: finished }) });
    // A finish while hidden is consumed and never replayed; an approval is not a finish.
    observe({ enabled: true, visible: false, states: states({ a: { lastTurnCompletedAt: 2, pendingApproval: false } }) });
    observe({ enabled: true, visible: true, states: states({ b: { lastTurnCompletedAt: 2, pendingApproval: true } }) });
    expect(finishes).toEqual([['b'], ['c']]);
  });
});

describe('session-finished ripple playback', () => {
  const geometry = {
    width: 1060,
    theme: 'light' as const,
    cx: 983.5,
    cy: 153,
    R: 306,
  };

  it('sends the ring from the planet and brightens it for the brand window', () => {
    const start = sessionRippleFrame(0, { ...geometry, reducedMotion: false });
    const mid = sessionRippleFrame(500, { ...geometry, reducedMotion: false });
    const end = sessionRippleFrame(1_600, {
      ...geometry,
      reducedMotion: false,
    });
    expect(mid.ring).toEqual({
      progress: expect.any(Number),
      x: geometry.cx,
      y: geometry.cy,
    });
    expect(mid.gain).toBeGreaterThan(1);
    expect(start.done || mid.done).toBe(false);
    expect(end).toEqual({ gain: 1, ring: null, done: true });
  });

  it('under reduced motion only brightens and settles in the shared 140 ms fade, with no ring', () => {
    const first = sessionRippleFrame(0, { ...geometry, reducedMotion: true });
    const half = sessionRippleFrame(70, { ...geometry, reducedMotion: true });
    expect(first.ring).toBeNull();
    expect(first.gain).toBeGreaterThan(half.gain);
    expect(half.gain).toBeGreaterThan(1);
    expect(
      sessionRippleFrame(140, { ...geometry, reducedMotion: true }),
    ).toEqual({ gain: 1, ring: null, done: true });
  });
});

describe('idle resettle (Home owner, fake clock)', () => {
  const pictures = ATMOSPHERE_PICTURES;
  const pictureHome: HomeAtmosphere = {
    ...DEFAULT_HOME_ATMOSPHERE,
    source: 'picture',
    picture: { ...DEFAULT_HOME_ATMOSPHERE.picture, selectedAtMs: 1_800_000_000_000 },
  };
  type Input = Parameters<typeof useIdleResettle>[0];

  async function mountResettle(overrides: Partial<Input> = {}) {
    vi.setSystemTime(pictureHome.picture.selectedAtMs!);
    const ensured: string[] = [];
    const base: Input = {
      enabled: true,
      picture: 'white-rocks-open-sea',
      idle: true,
      visible: true,
      reducedMotion: false,
      value: pictureHome,
      pictures,
      ensure: async (picture) => {
        ensured.push(picture.id);
      },
      ...overrides,
    };
    function Probe(props: Input) {
      useIdleResettle(props);
      return null;
    }
    const screen = await renderScreen(<Probe {...base} />);
    return {
      ensured,
      async set(patch: Partial<Input>) {
        await screen.update(<Probe {...base} {...patch} />);
      },
      async advance(ms: number) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      },
    };
  }

  it('waits for the next shared window, downloads its picture and announces the resettle', async () => {
    const home = await mountResettle();
    await home.advance(HOUR_MS - 1);
    expect(home.ensured).toEqual([]);
    await home.advance(1);
    const id = pictures[1]!.id;
    expect(home.ensured).toEqual([id]);
    expect(atmosphereResettleFact.get()).toMatchObject({
      localId: builtinPictureLocalId(id),
      reducedMotion: false,
    });
  });

  it('waits while Home is not idle and settles once it is idle again', async () => {
    const home = await mountResettle({ idle: false });
    await home.advance(2 * HOUR_MS);
    expect(home.ensured).toEqual([]);
    await home.set({ idle: true });
    await home.advance(0);
    expect(home.ensured).toEqual([pictures[2]!.id]);
  });

  it('waits while Home is hidden', async () => {
    const home = await mountResettle({ visible: false });
    await home.advance(2 * HOUR_MS);
    expect(home.ensured).toEqual([]);
  });

  it('only resettles a built-in picture', async () => {
    const home = await mountResettle({ picture: null });
    await home.advance(2 * HOUR_MS);
    expect(home.ensured).toEqual([]);
  });

  it('stays still while switched off', async () => {
    const home = await mountResettle({ enabled: false });
    await home.advance(2 * HOUR_MS);
    expect(home.ensured).toEqual([]);
  });

  it('keeps the picture when Home stops being idle while the next one downloads', async () => {
    let finishDownload = () => {};
    const home = await mountResettle({
      ensure: () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    });
    await home.advance(HOUR_MS);
    await home.set({ idle: false });
    await act(async () => {
      finishDownload();
    });
    expect(atmosphereResettleFact.get()).toBeNull();
  });

  it('resettles on successive hourly windows', async () => {
    const home = await mountResettle();
    await home.advance(HOUR_MS);
    expect(home.ensured).toEqual([pictures[1]!.id]);
    await home.set({ picture: pictures[1]!.id });
    await home.advance(HOUR_MS);
    expect(home.ensured).toEqual([pictures[1]!.id, pictures[2]!.id]);
  });

  it('waits the next hour after a failed download, then tries again', async () => {
    let attempts = 0;
    const home = await mountResettle({ ensure: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
    } });
    await home.advance(HOUR_MS);
    expect(atmosphereResettleFact.get()).toBeNull();
    await home.advance(HOUR_MS - 1);
    expect(attempts).toBe(1);
    await home.advance(1);
    expect(attempts).toBe(2);
    expect(atmosphereResettleFact.get()?.localId).toBe(builtinPictureLocalId(pictures[2]!.id));
  });

  it('waits the next hour when no alternative picture is available', async () => {
    const home = await mountResettle({ pictures: pictures.filter(picture => picture.id === 'white-rocks-open-sea') });
    await home.advance(HOUR_MS);
    expect(atmosphereResettleFact.get()).toBeNull();
    expect(home.ensured).toEqual([]);
    await home.set({ pictures });
    await home.advance(HOUR_MS);
    expect(home.ensured).toEqual([pictures[2]!.id]);
  });

  it('uses the current motion preference when an acquired picture lands', async () => {
    let finishDownload = () => {};
    const home = await mountResettle({ ensure: () => new Promise<void>(resolve => { finishDownload = resolve; }) });
    await home.advance(HOUR_MS);
    await home.set({ reducedMotion: true });
    await act(async () => { finishDownload(); });
    expect(atmosphereResettleFact.get()?.reducedMotion).toBe(true);
  });

  it('discards an acquired choice after a manual picture selection', async () => {
    let finishDownload = () => {};
    const home = await mountResettle({ ensure: () => new Promise<void>(resolve => { finishDownload = resolve; }) });
    await home.advance(HOUR_MS);
    const manual = pictures.at(-1)!;
    const value: HomeAtmosphere = { ...pictureHome, picture: { ...pictureHome.picture,
      selectedAtMs: Date.now(), ref: { kind: 'builtin', id: manual.id } } };
    await home.set({ picture: manual.id, value });
    await act(async () => { finishDownload(); });
    expect(atmosphereResettleFact.get()).toBeNull();
  });
});
