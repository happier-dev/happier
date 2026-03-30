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

vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
    mono: () => ({}),
  },
}));

installSessionGuidanceCommonModuleMocks();

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
  it('keeps manual terminal follow-up focused on auth and daemon setup when setup is available', async () => {
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
    expect(screen.findByTestId('session-getting-started-step-server_setup')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-step-auth_login')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-step-daemon_install')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-step-create_session')).not.toBeNull();
    expect(expandedContent).toContain('happier server add');
    expect(expandedContent).toContain('https://api.company.example');
    expect(expandedContent).not.toContain('$ npm i -g @happier-dev/cli');
    expect(expandedContent).toContain('curl -fsSL https://happier.dev/install | bash');
    expect(expandedContent).not.toContain('npm i -g @happier-dev/cli');
    expect(expandedContent).toContain('happier daemon install');
    expect(expandedContent).not.toContain('daemon service install');
    expect(expandedContent).toContain('happier codex');
    expect(expandedContent).toContain('happier opencode');

    clipboardMocks.setStringAsync.mockClear();
    await screen.pressByTestIdAsync('session-getting-started-copy-auth_login');
    expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('happier auth login');
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
});
