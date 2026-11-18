// @vitest-environment jsdom

import * as React from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import {
  getActiveServerSnapshot,
  removeServerProfile,
  setActiveServerId,
} from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { openDesktopAppWindow, registerDesktopAppWindowWorkspace } from '@/desktop/window/appWindowRuntime';
import { registerDesktopAppWindowReturnHandler } from '@/sync/ops/actions/desktopAppWindowActionDispatch';
import { WORKSPACE_OPEN_IN_WINDOW_ID } from '@/components/appShell/workspace/useWorkspaceOpenActions';
import {
  DESKTOP_WINDOW_OPEN_IN_HAPPIER_ID,
  DesktopWindowBotRail,
} from './DesktopWindowBotRail';

// Native host acquisition is the real external boundary; role selection, the Bot projection and menus stay real.
vi.hoisted(() => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
});
const native = vi.hoisted(() => ({
    opens: [] as Array<{ windowId: string; homeId: string; accountId: string; selectedAddress: unknown }>,
}));
vi.mock('@tauri-apps/api/core', async () => {
  const secure = (
    await import('@/dev/testkit/mocks/desktopSecureStorage')
  ).createDesktopSecureStorageBoundary();
  return {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === 'desktop_host_get_availability') return {
        activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
      };
      if (command === 'desktop_app_window_restore') return [];
      if (command === 'desktop_app_window_placement') return { frame: null, previousFrame: null, workArea: null };
      if (command === 'desktop_app_window_open') {
        const record = args?.record as (typeof native.opens)[number];
        native.opens.push(record);
        return { windowId: record.windowId, ready: true, reused: record.windowId === 'window-1' };
      }
      return secure.invoke(command, args);
    },
  };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal),
);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
// The test renderer has no DOM portal or layout, so mount the real menu in place.
vi.mock('@/components/ui/popover', async importOriginal =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal),
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
  await homes.reset();
  const serverUrl = 'https://window-bot-rail.test';
  const homeId = await homes.addHome({ serverUrl, name: 'Bot rail Home', accountId: 'account', currentAccount: true });
  const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: homeId });
  if (!credentials) throw new Error('Expected test Home credentials');
  const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account',
    credentials, request: homes.request });
  const home = connection.home;
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  onTestFinished(async () => {
    await connection.dispose();
    publishAppliedActiveServerRuntimeAvailability(false);
    if (previousServerId !== home.id) await setActiveServerId(previousServerId);
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
  storage.getState().applySessions(['captain', 'hunter'].map(id => createSessionFixture({ id })));
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
    { createNodeMock: () => null },
  );
  await act(async () => {
    await Promise.resolve();
  });
  return screen;
}

describe('Session window Bot rail', () => {
  it('shows the current Bot named among its Home’s rail Bots, each with the shared open menu', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks');
    mockIPC((command, args) => {
      if (command === 'plugin:event|listen') return Number((args as { handler: number }).handler);
      if (command === 'plugin:event|unlisten') return null;
      return invoke(command, args);
    });
    const { __TAURI_INTERNALS__: internals } = window as unknown as {
      __TAURI_INTERNALS__: { metadata?: { currentWindow: { label: string } } };
    };
    internals.metadata = { currentWindow: { label: 'destination_window-1' } };
    onTestFinished(clearMocks);
    const serverId = await seedHome();
    onTestFinished(registerDesktopAppWindowReturnHandler(async () => true));
    const scope = { serverId, accountId: 'account' };
    const state = createWorkspaceState({
      id: 'main-home', target: { kind: 'home', params: {} }, pinned: false, preview: false,
    });
    onTestFinished(registerDesktopAppWindowWorkspace({ windowId: 'main', scope,
      getState: () => state, dispatch: () => {}, catalog: [], activateTab: () => {},
      placementMetrics: { cascadeOffset: 24, screenInset: 24 } }));
    await openDesktopAppWindow({
      windowId: 'window-1',
      target: { ...scope, kind: 'session', sessionId: 'captain' },
    });
    native.opens.length = 0;
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

    await act(async () => { screen.pressByTestId('desktop-window-bot-rail-hunter'); });
    await vi.waitFor(() => expect(native.opens).toEqual([expect.objectContaining({
      windowId: 'window-1', homeId: serverId, accountId: 'account',
      selectedAddress: { kind: 'session', sessionId: 'hunter' },
    })]));

    await act(async () => {
      invokeTestInstanceHandler(screen.findByTestId('desktop-window-bot-rail-captain'), 'onContextMenu',
        { preventDefault() {} });
    });
    await vi.waitFor(() => expect(screen.findByTestId('workspace-open-window')).toBeTruthy());
    await act(async () => { screen.pressByTestId('workspace-open-window'); });
    await vi.waitFor(() => expect(native.opens).toHaveLength(2));
    expect(native.opens[1]).toMatchObject({ homeId: serverId, accountId: 'account',
      selectedAddress: { kind: 'session', sessionId: 'captain' } });
    expect(native.opens[1]?.windowId).not.toBe('window-1');
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
