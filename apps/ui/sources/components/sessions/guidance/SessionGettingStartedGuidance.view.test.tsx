import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { installSessionGuidanceCommonModuleMocks } from './sessionGuidanceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async (_text: string) => {}),
}));
const mockEnv = vi.hoisted(() => ({
  iconsRenderAsText: false,
}));
const modalMocks = vi.hoisted(() => ({
  alert: vi.fn(),
}));
const centeredInfoTileMockState = vi.hoisted(() => ({
  renderCount: 0,
}));

vi.mock('expo-clipboard', () => clipboardMocks);

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

vi.mock('@/components/ui/lists/CenteredInfoTile', () => ({
  CenteredInfoTile: (props: any) => {
    centeredInfoTileMockState.renderCount += 1;
    return React.createElement('CenteredInfoTile', props, props.icon ?? null);
  },
}));

vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
    mono: () => ({}),
  },
}));

installSessionGuidanceCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: modalMocks,
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

vi.mock('@/config', () => ({
  config: { variant: 'production', cliNpmDistTag: undefined },
}));

describe('SessionGettingStartedGuidanceView', () => {
  it('uses one target-bound guided setup instead of a parallel server/auth/service recipe', async () => {
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
    expect(screen.findByTestId('session-getting-started-show-manual')).not.toBeNull();
    expect(content).not.toContain('happier server add');
    expect(content).not.toContain('happier daemon install');

    expect(screen.findByTestId('session-getting-started-copy-all')).toBeNull();
    expect(screen.findByTestId('session-getting-started-scroll')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-logo')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-kind-connect_machine')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-open-setup')).not.toBeNull();

    await screen.pressByTestIdAsync('session-getting-started-open-setup');
    expect(onOpenSetup).toHaveBeenCalledTimes(1);

    await screen.pressByTestIdAsync('session-getting-started-show-manual');

    const expandedContent = screen.getTextContent();
    expect(screen.findByTestId('session-getting-started-cli-follow-up')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-step-server_setup')).toBeNull();
    expect(screen.findByTestId('session-getting-started-step-auth_login')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-step-daemon_install')).toBeNull();
    expect(screen.findByTestId('session-getting-started-step-create_session')).not.toBeNull();
    expect(expandedContent).not.toContain('happier server add');
    expect(expandedContent).toContain('https://api.company.example');
    expect(expandedContent).not.toContain('$ npm i -g @happier-dev/cli');
    expect(expandedContent).toContain('curl -fsSL https://happier.dev/install | bash -s -- --yes');
    expect(expandedContent).not.toContain('npm i -g @happier-dev/cli');
    expect(expandedContent).not.toContain('happier service install');
    expect(expandedContent).toContain('happier setup --relay "https://api.company.example"');
    expect(expandedContent).not.toContain('happier daemon install');
    expect(expandedContent).toContain('happier codex');
    expect(expandedContent).toContain('happier opencode');

    clipboardMocks.setStringAsync.mockClear();
    modalMocks.alert.mockClear();
    await screen.pressByTestIdAsync('session-getting-started-copy-auth_login');
    expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('happier setup --relay "https://api.company.example"');
    expect(modalMocks.alert).not.toHaveBeenCalledWith('common.copied', 'items.copiedToClipboard');
    expect(screen.findByTestId('session-getting-started-copy-auth_login-copied')).not.toBeNull();
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

      expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    } finally {
      mockEnv.iconsRenderAsText = false;
      act(() => {
        screen?.tree.unmount();
      });
    }
  });

  it('keeps the phone manual terminal action available while deferring CLI follow-up until interactions settle', async () => {
    vi.useFakeTimers();
    try {
      const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
      const onConnectTerminal = vi.fn();
      const onEnterUrlManually = vi.fn();

      const screen = await renderScreen(
        <SessionGettingStartedGuidanceView
          variant="phone"
          model={{
            kind: 'connect_machine',
            targetLabel: 'Company',
            serverUrl: 'https://api.company.example',
            serverName: 'company',
            showServerSetup: true,
            onConnectTerminal,
            onEnterUrlManually,
          }}
        />,
      );

      expect(screen.findByTestId('session-getting-started-kind-connect_machine')).not.toBeNull();
      expect(screen.findByTestId('session-getting-started-cli-follow-up')).toBeNull();
      expect(screen.findAllByType('RoundButton' as any)).toHaveLength(1);

      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(screen.findByTestId('session-getting-started-cli-follow-up')).not.toBeNull();
      expect(screen.findByTestId('session-getting-started-step-install_cli')).not.toBeNull();
      expect(screen.findByTestId('session-getting-started-step-auth_login')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers new-session blocking CLI follow-up while keeping the blocking header visible', async () => {
    vi.useFakeTimers();
    try {
      const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');

      const screen = await renderScreen(
        <SessionGettingStartedGuidanceView
          variant="newSessionBlocking"
          model={{
            kind: 'connect_machine',
            targetLabel: 'Company',
            serverUrl: 'https://api.company.example',
            serverName: 'company',
            showServerSetup: true,
          }}
        />,
      );

      expect(screen.findByTestId('session-getting-started-logo')).not.toBeNull();
      expect(screen.findByTestId('session-getting-started-kind-connect_machine')).not.toBeNull();
      expect(screen.findByTestId('session-getting-started-cli-follow-up')).toBeNull();

      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(screen.findByTestId('session-getting-started-cli-follow-up')).not.toBeNull();
      expect(screen.findByTestId('session-getting-started-step-server_setup')).toBeNull();
      expect(screen.findByTestId('session-getting-started-step-auth_login')).not.toBeNull();
    } finally {
      vi.useRealTimers();
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

  it('shows canonical background-service commands in the manual daemon setup flow', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    const screen = await renderScreen(
      <SessionGettingStartedGuidanceView
        variant="primaryPane"
        model={{
          kind: 'start_daemon',
          targetLabel: 'Company',
          serverUrl: 'https://api.company.example',
          serverName: 'company',
          showServerSetup: false,
        }}
      />,
    );

    const content = screen.getTextContent();
    expect(content).toContain('happier service install');
    expect(content).toContain('happier service start');
    expect(content).not.toContain('happier daemon install');
    expect(content).not.toContain('happier daemon start');
  });

  it('skips rerendering the guidance view when props are equal by value', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    centeredInfoTileMockState.renderCount = 0;
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
    expect(centeredInfoTileMockState.renderCount).toBe(1);

    act(() => {
      screen.tree.update(createElement());
    });

    expect(centeredInfoTileMockState.renderCount).toBe(1);
  });

  it('renders select-session as a centered icon empty state in the primary pane', async () => {
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

    expect(screen.findByTestId('session-empty-state-card')).toBeNull();
    expect(screen.findByTestId('session-empty-state-summary')).not.toBeNull();
    expect(screen.findByTestId('session-empty-state-icon')).not.toBeNull();
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
