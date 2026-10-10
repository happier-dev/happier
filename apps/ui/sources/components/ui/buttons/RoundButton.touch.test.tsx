import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(() => vi.unstubAllGlobals());

it('keeps coarse web button targets separate without depending on overlapping hit slop', async () => {
    // The primary pointer is a browser boundary; the real target policy and button stay mounted.
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const { RoundButton } = await import('./RoundButton');
    const { resolveMinimumInteractiveTargetSize } = await import('../interactiveTargetSize');
    const screen = await renderScreen(<RoundButton size="normal" title="Go" testID="touch-button" />);
    const button = screen.findByTestId('touch-button')!;
    const style = Object.assign({}, ...[button.props.style].flat().filter(Boolean));
    expect(style.minHeight).toBeGreaterThanOrEqual(resolveMinimumInteractiveTargetSize('web'));
    expect(style.minWidth).toBeGreaterThanOrEqual(resolveMinimumInteractiveTargetSize('web'));
    expect(button.props.hitSlop ?? 0).toBe(0);
});
