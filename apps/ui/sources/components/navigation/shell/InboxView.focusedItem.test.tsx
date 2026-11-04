import * as React from 'react';
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The window size and the router are platform boundaries; the Inbox model and store stay real.
const routerMock = vi.hoisted(() => ({
  width: 390,
  current: null as ReturnType<typeof import('@/dev/testkit/mocks/router').createExpoRouterMock> | null,
}));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({
      width: routerMock.width,
      height: 844,
      scale: 1,
      fontScale: 1,
    }),
  }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('expo-router', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/router')
  ).createExpoRouterMock();
  routerMock.current = mock;
  return mock.module;
});
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
  }),
);
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('@/track/tracking', () => ({ tracking: null }));

const initialState = storage.getState();

describe('InboxView focused item on a phone', () => {
  let previousServerId = '';
  let homeId = '';
  beforeEach(async () => {
    // The Inbox belongs to a signed-in Home; a build without a default Home has none until one is added.
    previousServerId = getActiveServerSnapshot().serverId;
    homeId = (await upsertAndActivateServer({ serverUrl: 'https://inbox-focused-item.test' })).id;
    routerMock.width = 390;
    routerMock.current?.spies.replace.mockClear();
    routerMock.current?.resetParams();
    storage.setState(initialState, true);
    storage.setState({
      isDataReady: true,
      artifacts: {},
      profileScope: {
        serverId: getActiveServerSnapshot().serverId,
        accountId: 'account-a',
      },
    });
  });
  afterEach(async () => {
    standardCleanup();
    storage.setState(initialState, true);
    if (previousServerId) await setActiveServerId(previousServerId);
    await removeServerProfile(homeId);
  });

  it('opens a linked item on its own page, as a phone row does, instead of stopping at the list', async () => {
    const { InboxView } = await import('./InboxView');
    await renderScreen(
      <InboxView
        focusedItem={{ kind: 'approval', serverId: 'home-1', id: 'approval-1' }}
      />,
    );

    expect(
      routerMock.current?.spies.replace.mock.calls.map(([href]) => href),
    ).toContain('/inbox/approvals/approval-1?serverId=home-1');
  });

  it('leaves the phone Inbox on its list when nothing is linked', async () => {
    const { InboxView } = await import('./InboxView');
    await renderScreen(<InboxView />);

    expect(routerMock.current?.spies.replace.mock.calls).toHaveLength(0);
  });

  it('opens the full Inbox from its popover through the real workspace route body and renders its tabs', async () => {
    routerMock.width = 1200;
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    const { primeServerFeaturesSnapshot, deleteServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { registerWorkspaceRouteContext } = await import('@/components/appShell/workspace/workspaceRouteContext');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { WorkspaceDestinationBody } = await import('@/components/appShell/workspace/WorkspaceDestinationBody');
    const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { InboxPopoverContent } = await import('@/components/inbox/InboxPopover');
    // Expo's module loader is the boundary; the exported page, feature admission,
    // destination params, model and list/detail composition all remain real.
    let loadedPage: Promise<typeof import('@/app/(app)/inbox/index')> | undefined;
    registerWorkspaceRouteContext(() => loadedPage ??= import('@/app/(app)/inbox/index'));
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
      features: { inbox: { global: { enabled: true } }, actions: { approvals: { enabled: true } } }, capabilities: {},
    }) } });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
      externalSessions: false, inbox: true, discussions: true, workflows: false, friends: false,
    } });
    const target = resolveDestinationRefFromHref(catalog, '/inbox')!;
    function OpenInboxJourney() {
      const [opened, setOpened] = React.useState(false);
      return opened ? <DestinationInstanceHost tabId="full-inbox" ref={target} pathname="/inbox" focused visible
        navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
        <WorkspaceDestinationBody target={target} pathname="/inbox" renderSession={() => null} renderSessionDetails={() => null} />
      </DestinationInstanceHost> : <InboxPopoverContent close={() => {}} onOpenInbox={() => setOpened(true)} />;
    }
    try {
      const screen = await renderScreen(<OpenInboxJourney />);
      await screen.pressByTestIdAsync('inbox.popover.open');
      await act(async () => { await loadedPage; });
      expect(screen.findByTestId('inbox.screen')).not.toBeNull();
      expect(screen.findHostByTestId('inbox.view:needs_you')).not.toBeNull();
      expect(screen.findHostByTestId('inbox.view:mentions')).not.toBeNull();
    } finally {
      standardCleanup();
      deleteServerFeaturesSnapshot();
    }
  });

  it('restores Mentions when a hosted phone Inbox remounts after opening a Discussion and Back', async () => {
    const { InboxView } = await import('./InboxView');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
    const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
    const { resolveHref } = await import('expo-router/build/link/href');
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
      externalSessions: false, inbox: true, discussions: true, workflows: false, friends: false,
    } });
    let state = createWorkspaceState({ id: 'inbox-phone', target: resolveDestinationRefFromHref(catalog, '/inbox')!, pinned: false, preview: false });
    let publish = () => {};
    let nextId = 0;
    const adapter = createWorkspaceNavigationAdapter({
      getState: () => state, getCatalog: () => catalog,
      dispatch: action => { state = reduceWorkspaceState(state, action); },
      transport: { commit: () => {} }, createId: () => `destination-${++nextId}`, onChange: () => publish(),
    });
    adapter.initialize('/inbox');
    const navigation = {
      push: (next: Parameters<typeof resolveHref>[0]) => { adapter.openHref(resolveHref(next), { tabId: 'inbox-phone' }); },
      replace: (next: Parameters<typeof resolveHref>[0]) => { adapter.openHref(resolveHref(next), { tabId: 'inbox-phone', replace: true }); },
      setParams: (params: Record<string, unknown>) => adapter.setParams('inbox-phone', params),
      back: () => adapter.step(-1),
    };
    function PhoneDestination() {
      const [, refresh] = React.useReducer(count => count + 1, 0);
      publish = refresh;
      const target = state.tabs[state.groups[state.focusedGroupId].activeTabId].target;
      return <DestinationInstanceHost tabId="inbox-phone" ref={target} pathname={target.kind === 'inbox' ? '/inbox' : '/discussions/discussion-1'}
        navigation={navigation} focused visible>
        {target.kind === 'inbox' ? <InboxView /> : <React.Fragment />}
      </DestinationInstanceHost>;
    }
    const screen = await renderScreen(<PhoneDestination />);
    await screen.pressByTestIdAsync('inbox.view:mentions');
    expect(screen.findHostByTestId('inbox.view:mentions')?.props.accessibilityState.selected).toBe(true);
    await act(async () => navigation.push('/discussions/discussion-1?serverId=home-1'));
    expect(screen.findHostByTestId('inbox.view:mentions')).toBeNull();
    await act(async () => navigation.back());
    expect(screen.findHostByTestId('inbox.view:mentions')?.props.accessibilityState.selected).toBe(true);
  });

  it('restores the Inbox rail width when a wide page opens an item', async () => {
    routerMock.width = 1200;
    storage.getState().applyLocalSettings({ collectionRailWidthsV1: { inbox: 430 } });
    const { InboxView } = await import('./InboxView');
    const screen = await renderScreen(<InboxView focusedItem={{ kind: 'approval', serverId: 'home-1', id: 'approval-1' }} />);
    const layout = screen.findHostByTestId('inbox.layout');
    expect(layout).not.toBeNull();
    await act(async () => layout!.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 800 } } }));
    expect(screen.findHostByTestId('inbox.layout-resize-handle')?.props['aria-valuenow']).toBe(430);
  });

  it('classifies a linked notice into Updates and retains that view when its owner resolves it', async () => {
    routerMock.width = 1200;
    // A generic notice: an open usage notice has no row to classify, and its links open its own page.
    const { createAccountNoticeArtifactFixture } = await import('@/dev/testkit/fixtures/usageNoticeFixtures');
    const notice = createAccountNoticeArtifactFixture();
    storage.setState({ artifacts: { [notice.id]: notice } });
    const { InboxView } = await import('./InboxView');
    const screen = await renderScreen(<InboxView focusedItem={{ kind: 'notice', serverId: getActiveServerSnapshot().serverId, id: notice.id }} />);
    expect(screen.findHostByTestId('inbox.view:updates')?.props.accessibilityState.selected).toBe(true);
    await act(async () => storage.setState({ artifacts: {} }));
    expect(screen.findHostByTestId('inbox.view:updates')?.props.accessibilityState.selected).toBe(true);
    await screen.update(<InboxView key="remounted" focusedItem={{ kind: 'notice', serverId: getActiveServerSnapshot().serverId, id: notice.id }} />);
    expect(screen.findHostByTestId('inbox.view:updates')?.props.accessibilityState.selected).toBe(true);
  });
});
