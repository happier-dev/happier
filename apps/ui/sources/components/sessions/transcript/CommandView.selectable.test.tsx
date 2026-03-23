import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            Platform: {
                                OS: 'ios',
                                select: (values: any) => values?.ios ?? values?.default,
                            },
                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
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
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('CommandView (selection)', () => {
  it('renders command + output text as selectable', async () => {
    const { CommandView } = await import('./CommandView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<CommandView
          command="echo hi"
          stdout={'hello\nworld'}
          stderr={'warn'}
          error={'oops'}
        />)).tree;

    const texts = tree.findAllByType('Text' as any);
    expect(texts.length).toBeGreaterThan(0);
    for (const node of texts) {
      expect(node.props.selectable).toBe(true);
    }
  });

  it('renders legacy output text as selectable', async () => {
    const { CommandView } = await import('./CommandView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<CommandView
          command="echo legacy"
          // Legacy path: `output` used when stdout/stderr/error are all undefined.
          output={'legacy output'}
        />)).tree;

    const texts = tree.findAllByType('Text' as any);
    expect(texts.length).toBeGreaterThan(0);
    for (const node of texts) {
      expect(node.props.selectable).toBe(true);
    }
  });
});

