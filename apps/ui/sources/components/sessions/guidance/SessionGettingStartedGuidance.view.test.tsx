import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';

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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: (props: any) => React.createElement('View', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default ?? null,
            },
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
        }
    );
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => (
    mockEnv.iconsRenderAsText ? <>{'.'}</> : React.createElement('Ionicons', props, null)
  ),
}));

vi.mock('expo-image', () => ({
  Image: (props: any) => React.createElement('Image', props, null),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
      colors: {
        text: '#000',
        textSecondary: '#666',
        divider: '#ddd',
        surfaceHighest: '#fff',
        status: { connected: '#0a0' },
      },
    },
    });
});

vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
    mono: () => ({}),
  },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => {
    if (key === 'components.emptyMainScreen.installCommand') return '$ npm i -g @happier-dev/cli';
    if (key === 'components.emptySessionsTablet.startNewSessionButton') return 'Start New Session';
    if (key === 'components.emptyMainScreen.openCamera') return 'Open Camera';
    if (key === 'connect.enterUrlManually') return 'Enter URL manually';
    return key;
  } });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: vi.fn(),
            alert: vi.fn(),
        },
    }).module;
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
  it('includes server profile setup when serverUrl is not cloud', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    const screen = await renderScreen(
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

    const content = screen.getTextContent();
    expect(content).toContain('happier server add');
    expect(content).toContain('https://api.company.example');
    expect(content).not.toContain('$ npm i -g @happier-dev/cli');
    expect(content).toContain('curl -fsSL https://happier.dev/install | bash');
    expect(content).not.toContain('npm i -g @happier-dev/cli');
    expect(content).toContain('happier daemon install');
    expect(content).not.toContain('daemon service install');
    expect(content).toContain('happier codex');
    expect(content).toContain('happier opencode');

    expect(screen.findByTestId('session-getting-started-copy-all')).toBeNull();
    expect(screen.findByTestId('session-getting-started-scroll')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-logo')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-kind-connect_machine')).not.toBeNull();
    expect(screen.findByTestId('session-getting-started-step-create_session')).not.toBeNull();

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
});
