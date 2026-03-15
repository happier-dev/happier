import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default },
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        success: '#0a0',
        text: '#111',
        textSecondary: '#555',
        warning: '#bb0',
        warningCritical: '#a00',
        textDestructive: '#a00',
      },
    },
  }),
  StyleSheet: {
    create: (input: any) => {
      const theme = {
        colors: {
          success: '#0a0',
          text: '#111',
          textSecondary: '#555',
          warning: '#bb0',
          warningCritical: '#a00',
          textDestructive: '#a00',
        },
      };
      return typeof input === 'function' ? input(theme, {}) : input;
    },
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('CommandView (selection)', () => {
  it('renders command + output text as selectable', async () => {
    const { CommandView } = await import('./CommandView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <CommandView
          command="echo hi"
          stdout={'hello\nworld'}
          stderr={'warn'}
          error={'oops'}
        />
      );
    });

    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.length).toBeGreaterThan(0);
    for (const node of texts) {
      expect(node.props.selectable).toBe(true);
    }
  });

  it('renders legacy output text as selectable', async () => {
    const { CommandView } = await import('./CommandView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <CommandView
          command="echo legacy"
          // Legacy path: `output` used when stdout/stderr/error are all undefined.
          output={'legacy output'}
        />
      );
    });

    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.length).toBeGreaterThan(0);
    for (const node of texts) {
      expect(node.props.selectable).toBe(true);
    }
  });
});

