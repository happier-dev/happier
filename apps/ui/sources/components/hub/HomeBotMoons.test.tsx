import * as React from 'react';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot, removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import { HomeOrbitBotMoon } from '@/components/atmosphere/orbit/HomeOrbitBotMoon';
import { HomeBotMoons } from './HomeBotMoons';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { BotFaceMotion } from '@/components/sessions/bots/face/BotFaceMotion';
import { readSessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@shopify/react-native-skia', async () => {
  const mock = (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock();
  return { ...mock, AlphaType: { Unpremul: 'unpremul' }, ColorType: { RGBA_8888: 'rgba' },
    Skia: { ...mock.Skia, Image: { MakeImage: () => ({ dispose() {} }) },
      Data: { fromBytes: (bytes: Uint8Array) => bytes } } };
});
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

afterEach(async () => { await standardCleanup(); });

it('plays the compact face done reaction once per canonical completion, settles, and never replays on remount', async () => {
  resetReanimatedFrameCallbacks();
  const before = storage.getState();
  storage.setState({ settings: { ...before.settings, botMotion: 'reactions' } });
  const bot = createSessionListRenderableSessionFixture({ id: 'compact-completion', seq: 4, lastViewedSessionSeq: 3,
    metadata: { path: '/repo', bot: { kind: 'bot' } }, lastTurnCompletedAt: null,
    latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 10 });
  const face = (status: 'in_progress' | 'completed', at: number) => {
    const facts = readSessionBotFaceFacts({ ...bot,
      latestTurnStatus: status, latestTurnStatusObservedAt: at }, null);
    if (!facts) throw new Error('Expected a Bot face');
    return <SessionBotFace facts={facts} size={24} motion />;
  };
  let screen = await renderScreen(face('in_progress', 10));
  const active = () => readReanimatedFrameCallbacks().filter(record => record.handle.isActive);
  const settle = async () => { await act(async () => {
    for (let frame = 0; frame < 120; frame++) for (const record of active()) record.run({
      timestamp: frame * 16, timeSincePreviousFrame: 16, timeSinceFirstFrame: frame * 16,
    });
  }); };
  try {
    expect(active()).toHaveLength(0);
    await screen.update(face('completed', 20));
    expect(screen.findByType(BotFaceMotion).props.mood).toBe('done');
    expect(active()).toHaveLength(1);
    await settle();
    expect(active()).toHaveLength(0);
    await screen.update(face('completed', 20));
    expect(active()).toHaveLength(0);
    await screen.unmount();
    screen = await renderScreen(face('completed', 20));
    expect(active()).toHaveLength(0);
    await screen.update(face('in_progress', 30));
    await screen.update(face('completed', 40));
    expect(active()).toHaveLength(1);
    await settle();
    expect(active()).toHaveLength(0);
  } finally { await screen.unmount(); storage.setState(before, true); }
});

it('sparks once for each followed recipient Turn without private owner metadata, and learns remounts and hidden finishes', async () => {
  const before = storage.getState();
  const previousServerId = getActiveServerSnapshot().serverId;
  const home = await upsertAndActivateServer({ serverUrl: 'https://home-bot-moons.test' });
  onTestFinished(async () => {
    if (previousServerId) await setActiveServerId(previousServerId);
    await removeServerProfile(home.id);
    storage.setState(before, true);
  });
  const serverId = home.id;
  const bot = createSessionListRenderableSessionFixture({ id: 'recipient-bot', serverId, ownerAccountId: 'another-account', accessLevel: 'view',
    metadataLayoutVersion: 1,
    metadata: { path: '', bot: { kind: 'bot' }, name: 'Helper' },
    active: true, presence: 'online', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 10,
    lastTurnCompletedAt: null,
    viewer: createSessionViewerFixture({ follow: { follows: true, notificationLevel: 'none' } }),
  });
  storage.getState().applyServerScopedSessionListRows(serverId, [bot], { source: 'ordinary', mode: 'replace' });
  expect(storage.getState().sessionListBotRowsByServerId[serverId]?.[bot.id]?.metadata?.bot).toEqual({ kind: 'bot' });
  const scene = (shown = true) => <InjectedAuthProvider credentials={null}>
    <HomeBotMoons planet={horizonPlanetGeometry({ width: 900, height: 600 })} width={900} height={600}
      phone={false} shown={shown} viewport={null} />
  </InjectedAuthProvider>;
  let screen = await renderScreen(scene());
  const spark = () => screen.findByType(HomeOrbitBotMoon).props.spark;
  const patch = async (observedAt: number, status: 'in_progress' | 'completed' = 'completed') => {
    await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId: bot.id,
      patch: { latestTurnStatus: status, latestTurnStatusObservedAt: observedAt } }]); });
  };
  try {
    expect(spark()).toBe(0);
    await patch(20);
    expect(spark()).toBe(1);
    await patch(20);
    expect(spark()).toBe(1);
    await act(async () => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId: bot.id,
      patch: { latestReadyEventAt: 25, latestReadyEventSeq: 2 } }]); });
    expect(spark()).toBe(1);
    await screen.unmount();
    screen = await renderScreen(scene());
    expect(spark()).toBe(0);
    await patch(30, 'in_progress');
    await patch(40);
    expect(spark()).toBe(1);
    await screen.update(scene(false));
    await patch(50, 'in_progress');
    await patch(60);
    await screen.update(scene());
    expect(spark()).toBe(1);
  } finally { await screen.unmount(); }
});
