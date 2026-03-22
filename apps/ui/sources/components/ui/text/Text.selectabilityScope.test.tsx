import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Text: (props: any) => React.createElement('RNText', props, props.children),
                    TextInput: (props: any) => React.createElement('RNTextInput', props, props.children),
                }
    );
});

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/sync/store/hooks', () => ({
  useLocalSetting: () => 1,
}));

vi.mock('./uiFontScale', () => ({
  scaleTextStyle: (style: any) => style,
}));

describe('Text (selectability scope)', () => {
  it('defaults to non-selectable without a scope', async () => {
    const { Text } = await import('./Text');

    const screen = await renderScreen(<Text>hello</Text>);
    const rnText = screen.findByType('RNText' as any);
    expect(rnText.props.selectable).toBe(false);
  });

  it('defaults to selectable within a selectability scope', async () => {
    const { Text, TextSelectabilityScope } = await import('./Text');

    const screen = await renderScreen(
      <TextSelectabilityScope selectable>
        <Text>hello</Text>
      </TextSelectabilityScope>,
    );
    const rnText = screen.findByType('RNText' as any);
    expect(rnText.props.selectable).toBe(true);
  });

  it('respects an explicit selectable={false} even within a scope', async () => {
    const { Text, TextSelectabilityScope } = await import('./Text');

    const screen = await renderScreen(
      <TextSelectabilityScope selectable>
        <Text selectable={false}>hello</Text>
      </TextSelectabilityScope>,
    );
    const rnText = screen.findByType('RNText' as any);
    expect(rnText.props.selectable).toBe(false);
  });
});
