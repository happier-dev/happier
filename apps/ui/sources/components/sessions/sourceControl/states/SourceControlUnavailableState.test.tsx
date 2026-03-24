import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { installSourceControlStateCommonModuleMocks } from './sourceControlStateTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSourceControlStateCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
  Octicons: 'Octicons',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
  RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

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
