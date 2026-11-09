import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { collectUnexpectedRawTextNodes, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionGuidanceCommonModuleMocks } from './sessionGuidanceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

const mockEnv = vi.hoisted(() => ({
  iconsRenderAsText: false,
}));
const guidanceNativeRenders = vi.hoisted(() => ({
  renderCount: 0,
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async (_text: string) => {}),
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: null, manifest: null },
}));

vi.mock('expo-updates', () => ({
  channel: null,
  releaseChannel: null,
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => (
    mockEnv.iconsRenderAsText ? <>{'.'}</> : React.createElement('Ionicons', props, null)
  ),
}));

vi.mock('expo-image', () => ({
  Image: (props: any) => React.createElement('Image', props, null),
}));

installSessionGuidanceCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      // Observe this View's native port, not its separately memoized Summary child.
      ScrollView: React.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
        if (props.testID === 'session-getting-started-scroll') guidanceNativeRenders.renderCount += 1;
        return React.createElement('ScrollView', { ...props, ref });
      }),
    });
  },
  storage: () => vi.importActual('@/sync/domains/state/storage'),
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: { push: routerPushSpy },
    }).module;
  },
});

vi.mock('@/hooks/session/useConnectTerminal', () => ({
  useConnectTerminal: () => ({
    connectTerminal: () => {},
    connectWithUrl: () => {},
    isLoading: false,
  }),
}));

const mockAppConfig = vi.hoisted(() => ({
  variant: 'production' as string,
  cliNpmDistTag: undefined as unknown,
}));

vi.mock('@/config', () => ({
  config: mockAppConfig,
}));

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Install the common platform ports before loading Sync's UI dependency graph.
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const initialStorage = storage.getState();

describe('SessionGettingStartedGuidanceView', () => {
  beforeEach(async () => {
    await homes.reset();
    const serverId = await homes.addHome({ name: 'Company', serverUrl: 'https://company.example.test', accountId: 'guidance-account' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    publishAppliedActiveServerRuntimeAvailability(true);
    storage.setState({ machineListStatusByServerId: { [serverId]: 'idle' }, endpointStatus: 'online', socketStatus: 'connected', endpointReason: null, syncError: null });
  });
  afterEach(async () => {
    standardCleanup();
    await homes.reset();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(initialStorage, true);
  });
  // An unreachable Home never blocks: the "Loading… Fetching your machines and sessions" state
  // settles into the reachability owner's "Can't reach {Home} · Retry" on every surface.
  it.each(['sidebar', 'primaryPane'] as const)(
    'settles its loading state through the Home reachability owner (%s)',
    async (variant) => {
      storage.setState({ endpointStatus: 'offline', socketStatus: 'disconnected' });
      const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
      const screen = await renderScreen(
        <SessionGettingStartedGuidanceView
          variant={variant}
          model={{ kind: 'loading', targetLabel: 'Company', serverUrl: '', serverName: 'company', showServerSetup: false }}
        />,
      );
      expect(screen.findByTestId('home-unreachable')).not.toBeNull();
      expect(screen.findByTestId('home-unreachable-retry')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('sessionGettingStarted.subtitle.loading');
    },
  );

  it('renders only the setup wizard CTA for connect_machine on phone surfaces', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    const screen = await renderScreen(
      <SessionGettingStartedGuidanceView
        variant="phone"
        model={{
          kind: 'connect_machine',
          targetLabel: 'Company',
          serverUrl: 'https://api.company.example',
          serverName: 'company',
          showServerSetup: true,
          onConnectTerminal: () => {},
          onEnterUrlManually: () => {},
        }}
      />,
    );

    expect(screen.findByTestId('session-getting-started-open-setup')).not.toBeNull();
    expect(screen.findAllByType(RoundButton)).toHaveLength(1);
  });

  it('skips rerendering the guidance view when props are equal by value', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    guidanceNativeRenders.renderCount = 0;
    const createElement = () => (
      <SessionGettingStartedGuidanceView
        variant="primaryPane"
        model={{
          kind: 'select_session',
          targetLabel: 'Company',
          serverUrl: 'https://api.company.example',
          serverName: 'company',
          showServerSetup: false,
        }}
      />
    );

    const screen = await renderScreen(createElement());
    expect(guidanceNativeRenders.renderCount).toBeGreaterThan(0);
    const mountedRenderCount = guidanceNativeRenders.renderCount;

    await screen.update(createElement());

    expect(guidanceNativeRenders.renderCount).toBe(mountedRenderCount);
  });

  it('hides terminal follow-up when setup is available', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    const onOpenSetup = vi.fn();
    const screen = await renderScreen(
      <SessionGettingStartedGuidanceView
        variant="primaryPane"
        model={{
          kind: 'connect_machine',
          targetLabel: 'Company',
          serverUrl: 'https://api.company.example',
          serverName: 'company',
          showServerSetup: true,
          onOpenSetup,
        }}
      />,
    );

    const content = screen.getTextContent();
    expect(screen.findByTestId('session-getting-started-setup-primary-card')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-cli-follow-up')).toBeNull();
    expect(screen.findByTestId('session-getting-started-show-manual')).toBeNull();
    expect(content).not.toMatch(/\bh(?:appier|prev|dev) server add\b/);
    expect(content).not.toContain('happier daemon install');
    expect(screen.findByTestId('session-getting-started-scroll')).not.toBeNull();
    // The pane is the first thing a new Account sees: the Daybreak "no machines" scene, not the logo.
    expect(screen.findByTestId('session-getting-started-logo')).toBeNull();
    expect(screen.findByTestId('session-getting-started-connect-machine-scene')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-kind-connect_machine')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-open-setup')).not.toBeNull();
    expect(screen.findAllByType(RoundButton)).toHaveLength(1);

    await screen.pressByTestIdAsync('session-getting-started-open-setup');
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });

  it('does not emit raw text nodes under View when copy icons render as text on web', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    mockEnv.iconsRenderAsText = true;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(
        <SessionGettingStartedGuidanceView
          variant="primaryPane"
          model={{
            kind: 'connect_machine',
            targetLabel: 'Company',
            serverUrl: 'https://api.company.example',
            serverName: 'company',
            showServerSetup: true,
          }}
        />,
      );

      expect(screen.findByTestId('session-getting-started-setup-primary-card')).not.toBeNull();
      expect(screen.findByTestId('session-getting-started-cli-follow-up')).toBeNull();
      expect(screen.findByTestId('session-getting-started-open-setup')).not.toBeNull();
      expect(screen.findAllByType(RoundButton)).toHaveLength(1);
      routerPushSpy.mockClear();
      await screen.pressByTestIdAsync('session-getting-started-open-setup');
      expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines/add?path=thisComputer');
      expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    } finally {
      mockEnv.iconsRenderAsText = false;
      act(() => {
        screen?.tree.unmount();
      });
    }
  });

  it('offers the desktop setup CTA when machines exist but the daemon still needs attention', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    const onOpenSetup = vi.fn();
    const screen = await renderScreen(
      <SessionGettingStartedGuidanceView
        variant="primaryPane"
        model={{
          kind: 'start_daemon',
          targetLabel: 'Company',
          serverUrl: 'https://api.company.example',
          serverName: 'company',
          showServerSetup: true,
          onOpenSetup,
        }}
      />,
    );

    expect(screen.findByTestId('session-getting-started-setup-primary-card')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-open-setup')).not.toBeNull();
    await screen.pressByTestIdAsync('session-getting-started-open-setup');
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });

  it('renders dev lane CLI commands using the hdev shim', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    mockAppConfig.variant = 'publicdev';
    const screen = await renderScreen(
      <SessionGettingStartedGuidanceView
        variant="primaryPane"
        model={{
          kind: 'create_session',
          targetLabel: 'Company',
          serverUrl: 'https://api.company.example',
          serverName: 'company',
          showServerSetup: false,
        }}
      />,
    );

    expect(screen.findByTestId('session-getting-started-summary')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-summary-title')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-summary-description')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-cli-follow-up')).toBeNull();
    expect(screen.getTextContent()).toContain('hdev');
    mockAppConfig.variant = 'production';
  });

  it('renders select-session as a centered shared summary in the primary pane', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    const screen = await renderScreen(
      <SessionGettingStartedGuidanceView
        variant="primaryPane"
        model={{
          kind: 'select_session',
          targetLabel: 'Company',
          serverUrl: 'https://api.company.example',
          serverName: 'company',
          showServerSetup: false,
        }}
      />,
    );

    expect(screen.findByTestId('session-getting-started-summary')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-summary-title')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-summary-description')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-logo')).toBeNull();
    const scrollView = screen.findByTestId('session-getting-started-scroll');
    expect(scrollView).not.toBeNull();
    const contentContainerStyle = scrollView!.props.contentContainerStyle;
    const flattenedContentContainerStyle = Array.isArray(contentContainerStyle)
      ? Object.assign({}, ...contentContainerStyle.filter(Boolean))
      : contentContainerStyle;
    expect(flattenedContentContainerStyle.justifyContent).toBe('center');
  });
});
