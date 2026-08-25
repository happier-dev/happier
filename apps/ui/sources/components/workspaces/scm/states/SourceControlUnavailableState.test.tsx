import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
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
  it('exposes the retry control under a caller-scoped testID', async () => {
    // The card's Retry could only be reached by its visible text, and a text locator hits the
    // hidden twin rendered by the other git surface, so the prescribed `F-UI-2` verification could
    // not be run at all for three sessions. The state card already derives `${testID}-action` for
    // its primary action; this state just never passed one down.
    const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');
    const onRetry = vi.fn();
    const screen = await renderScreen(
      <SourceControlUnavailableState
        testID="session-git-unavailable"
        details="boom"
        onRetry={onRetry}
      />
    );

    expect(screen.findByTestId('session-git-unavailable-action')).not.toBeNull();
    screen.pressByTestId('session-git-unavailable-action');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides method-unavailable details (non-actionable)', async () => {
    const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');
    const screen = await renderScreen(
      <SourceControlUnavailableState details={RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE} />
    );

    const textNodes = screen.findAllByType('Text');
    expect(textNodes.some((node) => node.props.children === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE)).toBe(false);
    // No errorCode → legacy fallback path renders daemon-unavailable body
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

  it('renders session-scoped body when errorCode is BACKEND_UNAVAILABLE', async () => {
    const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');
    const screen = await renderScreen(
      <SourceControlUnavailableState
        details={RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE}
        errorCode={SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE}
      />
    );

    const textNodes = screen.findAllByType('Text');
    // Must NOT misleadingly say the daemon is unavailable when the real cause is a missing session→machine binding.
    expect(textNodes.some((node) => node.props.children === 'errors.daemonUnavailableBody')).toBe(false);
    expect(textNodes.some((node) => node.props.children === 'errors.sourceControlUnavailableForSession')).toBe(true);
  });

  it('falls back to try-again body when no errorCode and no recognizable details', async () => {
    const { SourceControlUnavailableState } = await import('./SourceControlUnavailableState');
    const screen = await renderScreen(<SourceControlUnavailableState details="something else" />);

    const textNodes = screen.findAllByType('Text');
    expect(textNodes.some((node) => node.props.children === 'errors.tryAgain')).toBe(true);
    expect(textNodes.some((node) => node.props.children === 'errors.daemonUnavailableBody')).toBe(false);
  });
});
