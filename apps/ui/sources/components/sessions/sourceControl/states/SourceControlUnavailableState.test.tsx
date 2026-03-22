import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({
  Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock({
    theme: {
      colors: {
        textSecondary: '#aaa',
      },
    },
  });
});

vi.mock('@/components/ui/buttons/RoundButton', () => ({
  RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: (props: any) => React.createElement('Text', props, props.children),
  TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

describe('SourceControlUnavailableState', () => {
  it('hides method-unavailable details (non-actionable)', async () => {
    const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');
    const screen = await renderScreen(
      <SourceControlUnavailableState details={RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE} />
    );

    const textNodes = screen.findAllByType('Text');
    expect(textNodes.some((node) => node.props.children === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE)).toBe(false);
    expect(textNodes.some((node) => node.props.children === 'errors.daemonUnavailableBody')).toBe(true);
  });

  it('hides method-not-found details (non-actionable)', async () => {
    const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');
    const screen = await renderScreen(
      <SourceControlUnavailableState details={RPC_ERROR_MESSAGES.METHOD_NOT_FOUND} />
    );

    const textNodes = screen.findAllByType('Text');
    expect(textNodes.some((node) => node.props.children === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND)).toBe(false);
  });
});
