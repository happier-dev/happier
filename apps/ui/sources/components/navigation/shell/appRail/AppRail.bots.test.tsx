import * as React from 'react';
import 'fake-indexeddb/auto';
import { View, type LayoutChangeEvent } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionFixture,
  createSessionListRenderableSessionFixture,
  createRootLayoutFeaturesResponse,
  flushHookEffects,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import {
  BotsRosterRuntimeProvider,
  useOptionalBotsRosterRuntime,
  type BotsRosterRuntime,
} from '@/components/sessions/bots/BotsRosterRuntime';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import {
  buildSessionOrganizationProjection,
  buildSessionOrganizationSessionKey,
} from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storage';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { AppRailSurface } from './AppRail';
import { buildAppRailEntries } from './appRailModel';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
    styleSheet: { hairlineWidth: 1 },
  }),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal),
);
installDisconnectedServerSocketBoundary();
// Portal measurement is a platform boundary; the popover owner, the rail and the roster stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
  return createInlinePopoverModuleMock(importOriginal, { maxHeight: 600, maxWidth: 400, placement: 'bottom' });
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const initialStorageState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
  standardCleanup();
  vi.useRealTimers();
  await connection?.dispose();
  connection = undefined;
  getStorage().setState(initialStorageState, true);
});

const layout = (height: number): LayoutChangeEvent =>
  ({
    nativeEvent: { layout: { x: 0, y: 0, width: 56, height } },
  }) as LayoutChangeEvent;

function railWithPinnedBot(pinned?: Readonly<{ serverId: string; bot: ReturnType<typeof createSessionFixture> }>) {
  const serverId = pinned?.serverId ?? 'home-a';
  const bot = pinned?.bot ?? createSessionFixture({
    id: 'release-captain',
    metadata: { path: '/repo', host: 'host', bot: { kind: 'bot' } },
  });
  const organization = buildSessionOrganizationProjection(
    {
      schemaVersionByServerId: {},
      appearancesBySessionKey: {},
      sessionAppearancesSupportedByServerId: {},
      snapshotVersionByServerId: {},
      pinsBySessionKey: {
        [buildSessionOrganizationSessionKey(serverId, bot.id)]: {
          sessionId: bot.id,
          sortKey: 'a',
          pinnedAt: 1,
          listPinned: false,
          railPinned: true,
        },
      },
      foldersByFolderKey: {},
      folderAssignmentsBySessionKey: {},
      tagsByTagKey: {},
      tagAssignmentsBySessionKey: {},
      attentionStandingsBySessionKey: {},
      orderEntriesByScopeKey: {},
      labelsByLabelKey: {},
    },
    serverId,
  );
  return buildAppRailEntries(
    resolveCompactAppDestinations({
      builtins: {
        externalSessions: true,
        inbox: true,
        workflows: true,
        friends: true,
        bots: true,
        botsRoster: true,
      },
      pages: [],
    }),
    {
      botHomes: [
        { serverId, rowsBySessionId: { [bot.id]: bot }, organization },
      ],
    },
  );
}

function RuntimeProbe(
  props: Readonly<{ onRuntime: (runtime: BotsRosterRuntime | null) => void }>,
) {
  props.onRuntime(useOptionalBotsRosterRuntime());
  return null;
}

function railTestIds(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): string[] {
  return screen
    .findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props.testID === 'string' &&
        /^app-rail:(bots|bot:|sessions)/.test(node.props.testID) &&
        !node.props.testID.endsWith('-badge'),
    )
    .map((node) => node.props.testID as string)
    .filter((id, index, all) => all.indexOf(id) === index);
}

/** The pinned Bot face's resting opacity (owner 2026-11-10: idle Bots rest muted, active ones in full). */
function railBotFaceOpacity(screen: Awaited<ReturnType<typeof renderScreen>>): number | undefined {
  const face = screen.findAll((node) => typeof node.type === 'string'
    && typeof node.props.testID === 'string' && /^app-rail:bot:.*-face$/.test(node.props.testID))[0];
  if (!face) return undefined;
  const styles = [face.props.style].flat(Infinity) as ({ opacity?: number } | null | undefined | false)[];
  return styles.reduce<number>((opacity, style) => (style && typeof style.opacity === 'number' ? style.opacity : opacity), 1);
}

describe('AppRail Bots', () => {
  it('selects the pinned Bot from the workspace before Expo mirrors navigation and clears it on Search return', async () => {
    const entries = railWithPinnedBot();
    const bot = entries.bots[0]!;
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
      externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    const workspace: WorkspaceNavigationContextValue = {
      active: true, catalog,
      state: createWorkspaceState({ id: 'bot-tab', target: { kind: 'session', params: { id: bot.sessionId, serverId: bot.serverId } }, pinned: false, preview: false }),
      canGoBack: false, canGoForward: false, openHref: () => true,
      activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
      navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
      registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    const render = (value: WorkspaceNavigationContextValue) => (
      <BotsRosterRuntimeProvider><InjectedAuthProvider credentials={null}><InboxSummaryProvider>
        <WorkspaceNavigationProvider value={value}>
          <AppRailSurface entries={entries} activeId={null} onOpen={() => {}}
            renderFooter={item => <View testID={item.id} />} />
        </WorkspaceNavigationProvider>
      </InboxSummaryProvider></InjectedAuthProvider></BotsRosterRuntimeProvider>
    );
    const screen = await renderScreen(render(workspace));
    await act(async () => screen.findByTestId('app-rail')?.props.onLayout?.(layout(810)));
    expect(screen.findHostByTestId(`app-rail:${bot.id}`)?.props['aria-pressed']).toBe(true);
    await screen.update(render({ ...workspace, state: createWorkspaceState({ id: 'search-tab',
      target: { kind: 'search', params: {} }, pinned: false, preview: false }) }));
    expect(screen.findHostByTestId(`app-rail:${bot.id}`)?.props['aria-pressed']).toBe(false);
  });

  it('keeps Bot attention contextual without another global numeric badge', async () => {
    const accountId = 'rail-bots-account';
    const home = createHomeHubArtifactHttpBoundary(accountId);
    connection = await restoreServerAccountForTest({ serverUrl: 'https://rail-bots.test', accountId,
      request: (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features') return Promise.resolve(Response.json(createRootLayoutFeaturesResponse()));
        return Promise.resolve(createEmptyAccountBootstrapHttpResponse(path, init) ?? home.request(url, init));
      },
    });
    await flushHookEffects({ cycles: 3 });
    const serverId = connection.serverId;
    const bot = createSessionListRenderableSessionFixture({
      id: 'approval-bot',
      metadata: { path: '/repo', host: 'host', bot: { kind: 'bot' } },
      active: true,
      activeAt: Date.now(),
      hasPendingPermissionRequests: true,
      pendingRequestObservedAt: Date.now(),
    });
    // The Session-list publisher admits both ordinary membership and the Bot-only summary input.
    getStorage().getState().applyServerScopedSessionListRows(serverId, [bot], { source: 'ordinary', mode: 'replace' });
    getStorage().getState().applyReady();
    const screen = await renderScreen(
      <BotsRosterRuntimeProvider>
        <InjectedAuthProvider credentials={connection.credentials}>
          <InboxSummaryProvider>
            <AppRailSurface entries={railWithPinnedBot({ serverId, bot: bot as unknown as ReturnType<typeof createSessionFixture> })} activeId={null} onOpen={() => {}}
              preferences={{ orderedIds: [], placements: { bots: 'pinned' } }}
              renderFooter={(item) => <View testID={item.id} />} />
          </InboxSummaryProvider>
        </InjectedAuthProvider>
      </BotsRosterRuntimeProvider>,
    );
    await act(async () => screen.findByTestId('app-rail')?.props.onLayout?.(layout(810)));
    const badge = screen.findByTestId('app-rail:bots-badge');
    expect(badge).not.toBeNull();
    expect(badge!.findAll((node) => typeof node.type === 'string' && node.props.children === '1')).toHaveLength(0);
    expect(screen.findHostByTestId('app-rail:bots')?.props.accessibilityLabel).toContain('bots.roster.needsYou');
    // A Bot that needs the person keeps its full colour on the rail.
    expect(railBotFaceOpacity(screen)).toBe(1);
  });

  it('stands each explicitly rail-pinned Bot right under the one Bots entry, which opens the roster from anywhere', async () => {
    let runtime: BotsRosterRuntime | null = null;
    const entries = railWithPinnedBot();
    const screen = await renderScreen(
      <BotsRosterRuntimeProvider>
        <InjectedAuthProvider credentials={null}>
        <RuntimeProbe
          onRuntime={(value) => {
            runtime = value;
          }}
        />
        <InboxSummaryProvider>
          <AppRailSurface
            entries={entries}
            activeId={null}
            onOpen={() => {}}
            preferences={{ orderedIds: [], placements: { bots: 'pinned' } }}
            renderFooter={(item) => <View testID={item.id} />}
          />
        </InboxSummaryProvider>
        </InjectedAuthProvider>
      </BotsRosterRuntimeProvider>,
    );
    await act(async () =>
      screen.findByTestId('app-rail')?.props.onLayout?.(layout(810)),
    );
    const pinId = `app-rail:${entries.bots[0]!.id}`;
    // Only the rail's own items, in rail order: the pin stands right under the one Bots entry.
    const itemIds = new Set([...entries.app.map((entry) => `app-rail:${entry.id}`), pinId]);
    const order = railTestIds(screen).filter((id) => itemIds.has(id));
    expect(order.slice(order.indexOf('app-rail:bots'))).toEqual(['app-rail:bots', pinId]);
    // An idle Bot keeps its colour but rests muted, so it does not pull the eye from the page.
    expect(railBotFaceOpacity(screen)).toBeLessThan(1);
    expect(
      screen.findHostByTestId('app-rail:bots')?.props['aria-disabled'],
    ).not.toBe(true);

    // The palette and the phone launcher open the same anchored roster through the runtime.
    expect(screen.findByTestId('app-rail:bots-popover')).toBeNull();
    await act(async () => {
      runtime!.open();
    });
    await flushHookEffects({ cycles: 2 });
    expect(screen.findByTestId('app-rail:bots-popover')).not.toBeNull();
    expect(screen.findByTestId('bots-roster')).not.toBeNull();
  });

  it('keeps a rail-pinned Bot reachable in More when the rail is too short', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const entries = railWithPinnedBot();
    const screen = await renderScreen(
      <BotsRosterRuntimeProvider>
        <InjectedAuthProvider credentials={null}>
        <InboxSummaryProvider>
          <AppRailSurface
            entries={entries}
            activeId={null}
            onOpen={() => {}}
            renderFooter={(item) => <View testID={item.id} />}
          />
        </InboxSummaryProvider>
        </InjectedAuthProvider>
      </BotsRosterRuntimeProvider>,
    );
    await act(async () =>
      screen.findByTestId('app-rail')?.props.onLayout?.(layout(140)),
    );
    const pinId = entries.bots[0]!.id;
    expect(screen.findByTestId(`app-rail:${pinId}`)).toBeNull();
    await screen.pressByTestIdAsync('app-rail-more.trigger');
    await flushHookEffects({ cycles: 1, advanceTimersMs: 0 });
    expect(screen.findByTestId(`app-rail-more:${pinId}`)).not.toBeNull();
  });

  it.each(['overflow', 'hidden'] as const)(
    'stands an explicit Bot pin in the rail while the Bots entry itself is %s',
    async (placement) => {
      const entries = railWithPinnedBot();
      const screen = await renderScreen(
        <BotsRosterRuntimeProvider>
          <InjectedAuthProvider credentials={null}>
            <InboxSummaryProvider>
              <AppRailSurface
                entries={entries}
                activeId={null}
                onOpen={() => {}}
                preferences={{ orderedIds: [], placements: { bots: placement } }}
                renderFooter={(item) => <View testID={item.id} />}
              />
            </InboxSummaryProvider>
          </InjectedAuthProvider>
        </BotsRosterRuntimeProvider>,
      );
      await act(async () =>
        screen.findByTestId('app-rail')?.props.onLayout?.(layout(810)),
      );
      const pinId = entries.bots[0]!.id;
      expect(screen.findByTestId(`app-rail:${pinId}`)).not.toBeNull();
      expect(screen.findByTestId('app-rail:bots')).toBeNull();
    },
  );

  it('keeps an explicit Bot pin reachable in More when the Bots entry is in overflow and the rail is short', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const entries = railWithPinnedBot();
    const screen = await renderScreen(
      <BotsRosterRuntimeProvider>
        <InjectedAuthProvider credentials={null}>
          <InboxSummaryProvider>
            <AppRailSurface
              entries={entries}
              activeId={null}
              onOpen={() => {}}
              preferences={{ orderedIds: [], placements: { bots: 'overflow' } }}
              renderFooter={(item) => <View testID={item.id} />}
            />
          </InboxSummaryProvider>
        </InjectedAuthProvider>
      </BotsRosterRuntimeProvider>,
    );
    await act(async () =>
      screen.findByTestId('app-rail')?.props.onLayout?.(layout(140)),
    );
    const pinId = entries.bots[0]!.id;
    expect(screen.findByTestId(`app-rail:${pinId}`)).toBeNull();
    await screen.pressByTestIdAsync('app-rail-more.trigger');
    await flushHookEffects({ cycles: 1, advanceTimersMs: 0 });
    expect(screen.findByTestId(`app-rail-more:${pinId}`)).not.toBeNull();
  });
});
