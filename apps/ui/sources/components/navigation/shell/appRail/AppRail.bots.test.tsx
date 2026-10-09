import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSessionFixture,
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

import { AppRailSurface } from './AppRail';
import { buildAppRailEntries } from './appRailModel';

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
// Portal measurement is a platform boundary; the popover owner, the rail and the roster stay real.
vi.mock('@/components/ui/popover', () => ({
  Popover: (props: {
    children: (layout: {
      maxHeight: number;
      maxWidth: number;
    }) => React.ReactNode;
  }) => <>{props.children({ maxHeight: 600, maxWidth: 400 })}</>,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const initialStorageState = getStorage().getState();
afterEach(() => {
  standardCleanup();
  vi.useRealTimers();
  getStorage().setState(initialStorageState, true);
});

const layout = (height: number): LayoutChangeEvent =>
  ({
    nativeEvent: { layout: { x: 0, y: 0, width: 56, height } },
  }) as LayoutChangeEvent;

function railWithPinnedBot() {
  const serverId = 'home-a';
  const bot = createSessionFixture({
    id: 'release-captain',
    metadata: { path: '/repo', host: 'host', bot: { kind: 'bot' } },
  });
  const organization = buildSessionOrganizationProjection(
    {
      schemaVersionByServerId: {},
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

describe('AppRail Bots', () => {
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
});
