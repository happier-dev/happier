import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@expo/vector-icons', () => ({
  Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        textSecondary: '#aaa',
      },
    },
  }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
  RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/StyledText', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

describe('SourceControlUnavailableState', () => {
  it('hides method-unavailable details (non-actionable)', async () => {
    const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SourceControlUnavailableState details={RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE} />
      );
    });

    const textNodes = tree.root.findAllByType('Text');
    expect(textNodes.some((node) => node.props.children === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE)).toBe(false);
  });

  it('hides method-not-found details (non-actionable)', async () => {
    const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <SourceControlUnavailableState details={RPC_ERROR_MESSAGES.METHOD_NOT_FOUND} />
      );
    });

    const textNodes = tree.root.findAllByType('Text');
    expect(textNodes.some((node) => node.props.children === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND)).toBe(false);
  });
});
