import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async (_text: string) => {}),
}));

vi.mock('expo-clipboard', () => clipboardMocks);

vi.mock('react-native', () => ({
  View: (props: any) => React.createElement('View', props, props.children),
  Text: (props: any) => React.createElement('Text', props, props.children),
  Pressable: (props: any) => React.createElement('Pressable', props, props.children),
  ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
  Platform: { OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (styles: any) => {
      const theme = {
        colors: {
          text: '#000',
          textSecondary: '#666',
          divider: '#ddd',
          surfaceHighest: '#fff',
          status: { connected: '#0a0' },
        },
      };
      return typeof styles === 'function' ? styles(theme) : styles;
    },
  },
  useUnistyles: () => ({
    theme: {
      colors: {
        text: '#000',
        textSecondary: '#666',
        divider: '#ddd',
        surfaceHighest: '#fff',
        status: { connected: '#0a0' },
      },
    },
  }),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
    mono: () => ({}),
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => {
    if (key === 'components.emptyMainScreen.installCommand') return '$ npm i -g @happier-dev/cli';
    if (key === 'components.emptySessionsTablet.startNewSessionButton') return 'Start New Session';
    if (key === 'components.emptyMainScreen.openCamera') return 'Open Camera';
    if (key === 'connect.enterUrlManually') return 'Enter URL manually';
    return key;
  },
}));

vi.mock('@/modal', () => ({
  Modal: { prompt: vi.fn(), alert: vi.fn() },
}));

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

describe('SessionGettingStartedGuidanceView', () => {
  it('includes server profile setup when serverUrl is not cloud', async () => {
    const { SessionGettingStartedGuidanceView } = await import('./SessionGettingStartedGuidance');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
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
    });

    const textNodes = tree.root.findAllByType('Text' as any).map((n: any) => String(n.props.children ?? ''));
    expect(textNodes.some((t: string) => t.includes('happier server add'))).toBe(true);
    expect(textNodes.some((t: string) => t.includes('https://api.company.example'))).toBe(true);
    expect(textNodes.some((t: string) => t.trimStart().startsWith('$'))).toBe(false);
    expect(textNodes.some((t: string) => t.includes('happier daemon install'))).toBe(true);
    expect(textNodes.some((t: string) => t.includes('daemon service install'))).toBe(false);
    expect(textNodes.some((t: string) => t.includes('happier codex'))).toBe(true);
    expect(textNodes.some((t: string) => t.includes('happier opencode'))).toBe(true);

    expect(() => tree.root.findByProps({ testID: 'session-getting-started-copy-all' } as any)).toThrow();
    expect(() => tree.root.findByProps({ testID: 'session-getting-started-scroll' } as any)).not.toThrow();
    expect(() => tree.root.findByProps({ testID: 'session-getting-started-step-create_session' } as any)).not.toThrow();

    clipboardMocks.setStringAsync.mockClear();
    const copyLogin = tree.root.findByProps({ testID: 'session-getting-started-copy-auth_login' } as any);
    await act(async () => {
      await copyLogin.props.onPress?.();
    });
    expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('happier auth login');
  });
});
