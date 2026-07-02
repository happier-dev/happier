import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { installSessionGuidanceCommonModuleMocks } from './sessionGuidanceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

const mockEnv = vi.hoisted(() => ({
  iconsRenderAsText: false,
}));
const summaryMockState = vi.hoisted(() => ({
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

vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
    mono: () => ({}),
  },
}));

vi.mock('./SessionGettingStartedSummary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SessionGettingStartedSummary')>();
  return {
    ...actual,
    SessionGettingStartedSummary: (props: any) => {
      summaryMockState.renderCount += 1;
      return React.createElement(actual.SessionGettingStartedSummary, props);
    },
  };
});

installSessionGuidanceCommonModuleMocks({
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

vi.mock('@/components/ui/buttons/RoundButton', () => ({
  RoundButton: (props: any) => React.createElement('RoundButton', props, null),
}));

const mockAppConfig = vi.hoisted(() => ({
  variant: 'production' as string,
  cliNpmDistTag: undefined as unknown,
}));

vi.mock('@/config', () => ({
  config: mockAppConfig,
}));

describe('SessionGettingStartedGuidanceView', () => {
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
    expect(screen.findAllByType('RoundButton' as any)).toHaveLength(1);
  });

  it('skips rerendering the guidance view when props are equal by value', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    summaryMockState.renderCount = 0;
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
    expect(summaryMockState.renderCount).toBe(1);

    act(() => {
      screen.tree.update(createElement());
    });

    expect(summaryMockState.renderCount).toBe(1);
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
    expect(content).not.toContain('happier server add');
    expect(content).not.toContain('happier daemon install');
    expect(screen.findByTestId('session-getting-started-scroll')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-logo')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-kind-connect_machine')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-open-setup')).not.toBeNull();
    expect(screen.findAllByType('RoundButton' as any)).toHaveLength(1);

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
      expect(screen.findAllByType('RoundButton' as any)).toHaveLength(1);
      routerPushSpy.mockClear();
      await screen.pressByTestIdAsync('session-getting-started-open-setup');
      expect(routerPushSpy).toHaveBeenCalledWith('/setup/wizard?action=local&step=setup_this_computer&scope=machine');
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
