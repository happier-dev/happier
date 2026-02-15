import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  connectTerminal: vi.fn(),
  connectWithUrl: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: (props: any) => React.createElement('View', props, props.children),
  Text: (props: any) => React.createElement('Text', props, props.children),
  Platform: { OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
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
          surfaceHigh: '#fff',
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
        surfaceHigh: '#fff',
        status: { connected: '#0a0' },
      },
    },
  }),
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
  useConnectTerminal: () => ({
    connectTerminal: mocks.connectTerminal,
    connectWithUrl: mocks.connectWithUrl,
    isLoading: false,
  }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
  RoundButton: (props: any) => React.createElement('RoundButton', props, null),
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: (...args: any[]) => mocks.prompt(...args),
  },
}));

function findButtonByTitle(tree: renderer.ReactTestRenderer, title: string) {
  const buttons = tree.root.findAllByType('RoundButton' as any);
  const found = buttons.find((b) => b.props?.title === title);
  expect(found).toBeTruthy();
  return found!;
}

describe('EmptyMainScreen (web URL entry)', () => {
  it('shows manual URL entry on web and connects with trimmed value', async () => {
    mocks.prompt.mockResolvedValue('  http://localhost:1234  ');

    const { EmptyMainScreen } = await import('./EmptyMainScreen');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<EmptyMainScreen />);
    });

    const button = findButtonByTitle(tree, 'connect.enterUrlManually');

    await act(async () => {
      await button.props.onPress();
    });

    expect(mocks.connectWithUrl).toHaveBeenCalledWith('http://localhost:1234');
  });
});

