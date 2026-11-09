import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, 'start', 'end'] as const)('draws a coarse-pointer browser toolbar button at its design height and reaches the touch target with the hit frame (joined edge: %s)', async joinedEdge => {
    // The primary pointer is a browser boundary; the real target policy and button stay mounted.
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const { ToolbarButton } = await import('./ToolbarButton');
    const screen = await renderScreen(<ToolbarButton label="Stop" size="md" joinedEdge={joinedEdge} testID="touch-toolbar" />);
    const button = () => screen.findByTestId('touch-toolbar')!;
    const raw = typeof button().props.style === 'function'
        ? button().props.style({ hovered: false, pressed: false, focused: false })
        : button().props.style;
    const style = Object.assign({}, ...[raw].flat(Infinity).filter(Boolean));
    // A touch target is a hit area, not a drawn size (DESIGN.md): the md toolbar button stays 34 high.
    expect(style.minHeight).toBe(34);
    const hitArea = await layoutHitArea(button, { width: 72, height: 34 });
    expect(hitArea.height).toBeGreaterThanOrEqual(44);
});
