import * as React from 'react';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import {
  getActiveServerSnapshot,
  removeServerProfile,
  setActiveServerId,
} from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { BotFaceMarker } from '@/components/sessions/bots/BotFaceMarker';
import {
  BotsRosterRuntimeProvider,
  useOptionalBotsRosterRuntime,
} from '@/components/sessions/bots/BotsRosterRuntime';
import { HomeBotFaces } from './HomeBotFaces';

// Where the router was sent (navigate or push): the route boundary of a face's tap.
const router = vi.hoisted(() => ({ routes: [] as unknown[] }));

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@shopify/react-native-skia', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/reactNativeSkia')
  ).createReactNativeSkiaMock();
  return {
    ...mock,
    AlphaType: { Unpremul: 'unpremul' },
    ColorType: { RGBA_8888: 'rgba' },
    Skia: {
      ...mock.Skia,
      Image: { MakeImage: () => ({ dispose() {} }) },
      Data: { fromBytes: (bytes: Uint8Array) => bytes },
    },
  };
});
vi.mock('expo-router', async () => {
  const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: {
      navigate: (value: unknown) => { router.routes.push(value); },
      push: (value: unknown) => { router.routes.push(value); },
    },
  });
  return mock.module;
});

afterEach(async () => {
  await standardCleanup();
});

async function seedBots(count: number) {
  const before = storage.getState();
  const previousServerId = getActiveServerSnapshot().serverId;
  const home = await upsertAndActivateServer({
    serverUrl: 'https://home-bot-faces.test',
  });
  onTestFinished(async () => {
    if (previousServerId) await setActiveServerId(previousServerId);
    await removeServerProfile(home.id);
    storage.setState(before, true);
  });
  const bots = Array.from({ length: count }, (_, index) =>
    createSessionListRenderableSessionFixture({
      id: `face-bot-${index}`,
      serverId: home.id,
      metadataLayoutVersion: 1,
      metadata: { path: '', bot: { kind: 'bot' }, name: `Helper ${index}` },
      updatedAt: 1000 - index,
    }),
  );
  storage
    .getState()
    .applyServerScopedSessionListRows(home.id, bots, {
      source: 'ordinary',
      mode: 'replace',
    });
  return { serverId: home.id, bots };
}

const row = () => (
  <InjectedAuthProvider credentials={null}>
    <HomeBotFaces />
  </InjectedAuthProvider>
);

it('shows every Bot as a face in one sideways row, and a face opens its Bot', async () => {
  const { bots } = await seedBots(9);
  const screen = await renderScreen(row());
  try {
    const strip = screen.findByTestId('home-bot-faces');
    // More faces than a phone holds: all of them are in the one row, reached by swiping it.
    expect(strip?.props.horizontal).toBe(true);
    expect(screen.findAllByType(SessionBotFace)).toHaveLength(bots.length);
    const first = screen.findAll(
      (node) =>
        typeof node.props.onPress === 'function' &&
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('home-bot-faces.'),
    )[0];
    expect(first).toBeDefined();
    await act(async () => {
      first!.props.onPress();
    });
    const pushed = router.routes.map((route) => JSON.stringify(route));
    expect(
      pushed.some((route) => bots.some((bot) => route.includes(bot.id))),
    ).toBe(true);
  } finally {
    await screen.unmount();
  }
});

it('marks a Bot that needs you with the attention dot on its face, as every row of Bot faces does (lab mnBots B)', async () => {
  const { serverId, bots } = await seedBots(2);
  const waiting = createSessionListRenderableSessionFixture({
    id: 'face-bot-waiting',
    serverId,
    metadataLayoutVersion: 1,
    metadata: { path: '', bot: { kind: 'bot' }, name: 'Gardener' },
    active: true,
    activeAt: Date.now(),
    hasPendingPermissionRequests: true,
    pendingRequestObservedAt: Date.now(),
    updatedAt: 2000,
  });
  storage.getState().applyServerScopedSessionListRows(serverId, [...bots, waiting], { source: 'ordinary', mode: 'replace' });
  const screen = await renderScreen(row());
  try {
    const markers = screen.findAllByType(BotFaceMarker);
    expect(markers.map((marker) => marker.props.activity).filter((activity) => activity === 'needsYou')).toHaveLength(1);
    expect(markers.filter((marker) => marker.props.activity !== 'needsYou')).toHaveLength(2);
  } finally {
    await screen.unmount();
  }
});

function RegisterRosterOpener(props: Readonly<{ onOpen: () => void }>) {
  const runtime = useOptionalBotsRosterRuntime();
  React.useEffect(() => runtime?.registerAnchoredOpener(props.onOpen), [runtime, props.onOpen]);
  return null;
}

it('ends the session list rail in All Bots, which opens the one Bots roster (lab list L1)', async () => {
  const { bots } = await seedBots(7);
  const opened: string[] = [];
  const onOpen = () => { opened.push('roster'); };
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={null}>
      <BotsRosterRuntimeProvider>
        <RegisterRosterOpener onOpen={onOpen} />
        <HomeBotFaces presentation="column" />
      </BotsRosterRuntimeProvider>
    </InjectedAuthProvider>,
  );
  try {
    // Every Bot is a compact face in the column, then the All Bots cell closes the row.
    const markers = screen.findAllByType(BotFaceMarker);
    expect(markers).toHaveLength(bots.length);
    expect(new Set(markers.map((marker) => marker.props.size)).size).toBe(1);
    expect(markers[0]!.props.size).toBeLessThan(44);
    const all = screen.findByTestId('home-bot-faces.all');
    expect(all).not.toBeNull();
    await act(async () => {
      all!.props.onPress();
    });
    expect(opened).toEqual(['roster']);
  } finally {
    await screen.unmount();
  }
});

it('draws nothing when the person turns Bot faces on Home off', async () => {
  await seedBots(3);
  const before = storage.getState();
  storage.setState({
    settings: { ...before.settings, homeBotFacesEnabled: false },
  });
  const screen = await renderScreen(row());
  try {
    expect(screen.findByTestId('home-bot-faces')).toBeNull();
    expect(screen.findAllByType(SessionBotFace)).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});
