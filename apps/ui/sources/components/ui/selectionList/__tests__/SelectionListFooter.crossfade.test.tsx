import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * R6 — Premium UI design polish (Fix 4): the footer hint set must cross-fade
 * when the visible step swaps in a different `hints` array, instead of
 * snapping via React mount/unmount.
 *
 * Implementation contract:
 *  - The hints row is wrapped in an animated container exposed under a stable
 *    testID `<footer>:hints-animator` carrying an opacity style entry.
 *  - When the hints array identity changes, the animator's opacity value is
 *    re-driven via `withTiming` (mocked here to pass-through the target
 *    value) — covered indirectly by asserting the wrapper exists and exposes
 *    an opacity style.
 */
describe('SelectionListFooter hint cross-fade (R6 Fix 4)', () => {
    it('renders the hints inside an animated container with an opacity style', async () => {
        const { SelectionListFooter } = await import('../SelectionListFooter');
        const screen = await renderScreen(
            <SelectionListFooter
                hints={[
                    { id: 'navigate', label: '↑↓', description: 'navigate' },
                    { id: 'enter', label: '↵', description: 'select' },
                ]}
                hardwareKeyboardAvailable
                testID="footer"
            />,
        );
        const animator = screen.findByTestId('footer:hints-animator');
        expect(animator).not.toBeNull();
        const styles = Array.isArray(animator!.props.style)
            ? animator!.props.style.flat(Infinity)
            : [animator!.props.style];
        const merged = Object.assign({}, ...styles.filter(Boolean));
        expect(typeof merged.opacity).toBe('number');
        // Steady-state opacity at rest is 1.
        expect(merged.opacity).toBeCloseTo(1, 5);
    });

    it('keeps the animator wrapper mounted across a hints identity swap (no remount flicker)', async () => {
        const { SelectionListFooter } = await import('../SelectionListFooter');
        const screen = await renderScreen(
            <SelectionListFooter
                hints={[
                    { id: 'navigate', label: '↑↓', description: 'navigate' },
                ]}
                hardwareKeyboardAvailable
                testID="footer"
            />,
        );
        const before = screen.findByTestId('footer:hints-animator');
        expect(before).not.toBeNull();
        await screen.update(
            <SelectionListFooter
                hints={[
                    { id: 'enter', label: '↵', description: 'select' },
                    { id: 'tab', label: 'Tab', description: 'autocomplete' },
                ]}
                hardwareKeyboardAvailable
                testID="footer"
            />,
        );
        // The animator wrapper persists across the swap so opacity can animate
        // rather than React mounting/unmounting hint subtrees instantly.
        const after = screen.findByTestId('footer:hints-animator');
        expect(after).not.toBeNull();
    });
});
