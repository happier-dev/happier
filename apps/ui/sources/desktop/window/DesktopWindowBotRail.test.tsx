import * as React from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import {
  getActiveServerSnapshot,
  removeServerProfile,
  setActiveServerId,
} from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { WORKSPACE_OPEN_IN_WINDOW_ID } from '@/components/appShell/workspace/useWorkspaceOpenActions';
import {
  DESKTOP_WINDOW_OPEN_IN_HAPPIER_ID,
  DesktopWindowBotRail,
} from './DesktopWindowBotRail';

// Native host acquisition is the real external boundary; role selection, the Bot projection and menus stay real.
vi.hoisted(() => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
});
vi.mock('@tauri-apps/api/core', async () => {
  const secure = (
    await import('@/dev/testkit/mocks/desktopSecureStorage')
  ).createDesktopSecureStorageBoundary();
  return {
    invoke: async (command: string, args?: Record<string, unknown>) =>
      command === 'desktop_host_get_availability'
        ? {
            activity: { kind: 'available' },
            pet: { kind: 'available' },
            windows: { kind: 'available' },
          }
        : secure.invoke(command, args),
  };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
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
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({})
      .module,
);

afterEach(async () => {
  await standardCleanup();
});

async function seedHome() {
  const before = storage.getState();
  const previousServerId = getActiveServerSnapshot().serverId;
  const home = await upsertAndActivateServer({
    serverUrl: 'https://window-bot-rail.test',
  });
  onTestFinished(async () => {
    if (previousServerId) await setActiveServerId(previousServerId);
    await removeServerProfile(home.id);
    storage.setState(before, true);
  });
  const row = (id: string, name: string, bot = true) =>
    createSessionListRenderableSessionFixture({
      id,
      serverId: home.id,
      metadataLayoutVersion: 1,
      metadata: { path: '', ...(bot ? { bot: { kind: 'bot' } } : {}), name },
      updatedAt: 1000,
    });
  storage
    .getState()
    .applyServerScopedSessionListRows(
      home.id,
      [
        row('captain', 'Release captain'),
        row('hunter', 'Flake hunter'),
        row('unpinned', 'Quiet helper'),
        row('plain', 'Fix modal', false),
      ],
      { source: 'ordinary', mode: 'replace' },
    );
  storage
    .getState()
    .applySessionOrganizationSnapshot(home.id, {
      schemaVersion: 1,
      version: 1,
      pins: [
        {
          sessionId: 'hunter',
          sortKey: 'a',
          pinnedAt: 1,
          listPinned: false,
          railPinned: true,
        },
      ],
      folders: [],
      folderAssignments: [],
      tags: [],
      tagAssignments: [],
      orderEntries: [],
      labels: [],
    });
  return home.id;
}

async function renderRail(serverId: string, sessionId: string) {
  const scope = {
    windowId: 'window-1',
    homeId: serverId,
    accountId: 'account',
    sessionId,
  };
  const screen = await renderScreen(
    <DesktopWindowBotRail
      scope={scope}
      fallback={<Text testID="window-title">title</Text>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return screen;
}

describe('Session window Bot rail', () => {
  it('shows the current Bot named among its Home’s rail Bots, each with the shared open menu', async () => {
    const serverId = await seedHome();
    const screen = await renderRail(serverId, 'captain');
    const menus = () => screen.tree.findAllByType(DropdownMenu);
    expect(
      menus()
        .map((node) => node.props.testID)
        .sort(),
    ).toEqual([
      'desktop-window-bot-rail-captain-menu',
      'desktop-window-bot-rail-hunter-menu',
    ]);
    const texts = screen.tree
      .findAllByType(Text)
      .map((node) => node.props.children);
    expect(texts).toContain('Release captain');
    expect(texts).not.toContain('Flake hunter');
    const hunter = () =>
      menus().find(
        (node) => node.props.testID === 'desktop-window-bot-rail-hunter-menu',
      )!;
    await vi.waitFor(() =>
      expect(
        hunter().props.items.map((item: { id: string }) => item.id),
      ).toEqual([
        WORKSPACE_OPEN_IN_WINDOW_ID,
        DESKTOP_WINDOW_OPEN_IN_HAPPIER_ID,
      ]),
    );
  });

  it('keeps the plain title for a Session that is not a Bot', async () => {
    const serverId = await seedHome();
    const screen = await renderRail(serverId, 'plain');
    expect(
      screen.tree.findAll((node) => node.props.testID === 'window-title'),
    ).not.toHaveLength(0);
    expect(screen.tree.findAllByType(DropdownMenu)).toHaveLength(0);
  });
});
