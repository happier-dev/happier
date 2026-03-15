import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  Text: (props: any) => React.createElement('RNText', props, props.children),
  TextInput: (props: any) => React.createElement('RNTextInput', props, props.children),
}));

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

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Text>hello</Text>);
    });

    const rnText = tree.root.findByType('RNText' as any);
    expect(rnText.props.selectable).toBe(false);
  });

  it('defaults to selectable within a selectability scope', async () => {
    const { Text, TextSelectabilityScope } = await import('./Text');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TextSelectabilityScope selectable>
          <Text>hello</Text>
        </TextSelectabilityScope>
      );
    });

    const rnText = tree.root.findByType('RNText' as any);
    expect(rnText.props.selectable).toBe(true);
  });

  it('respects an explicit selectable={false} even within a scope', async () => {
    const { Text, TextSelectabilityScope } = await import('./Text');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TextSelectabilityScope selectable>
          <Text selectable={false}>hello</Text>
        </TextSelectabilityScope>
      );
    });

    const rnText = tree.root.findByType('RNText' as any);
    expect(rnText.props.selectable).toBe(false);
  });
});
