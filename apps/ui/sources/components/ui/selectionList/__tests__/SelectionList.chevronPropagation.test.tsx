import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * RV-2 / F3 — DrillDownChevron must stop the row press from bubbling, so
 * pressing the chevron drills WITHOUT committing the row's `onSelect`. The
 * favorite toggle (PathFavoriteToggleButton) is the canonical reference for
 * the cross-platform stopPropagation + stopImmediatePropagation pattern.
 *
 * Contract changes (F3):
 *   - DrillDownChevron's `onPress` now optionally accepts a press event so the
 *     callback can call stopPropagation in a single place.
 *   - The Pressable's onPress wraps the user-supplied onPress and stops
 *     propagation on both `event.stopPropagation` and
 *     `event.nativeEvent.stopImmediatePropagation` when present.
 */
describe('DrillDownChevron stops row press propagation (F3)', () => {
    it('stops propagation on the press event before invoking the user onPress', async () => {
        const { DrillDownChevron } = await import('../accessories/DrillDownChevron');

        const onPress = vi.fn();
        const screen = await renderScreen(
            <DrillDownChevron onPress={onPress} testID="chev" />,
        );
        const node = screen.findByTestId('chev');
        expect(node).not.toBeNull();

        const stopPropagation = vi.fn();
        const stopImmediatePropagation = vi.fn();
        const fakeEvent = {
            stopPropagation,
            nativeEvent: { stopImmediatePropagation },
        };

        node!.props.onPress(fakeEvent);

        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(onPress).toHaveBeenCalledTimes(1);
        // The wrapper forwards the event so callers can introspect it if they
        // need the gesture for further behavior.
        expect(onPress).toHaveBeenCalledWith(fakeEvent);
    });

    it('does not throw when invoked without a press event (defensive)', async () => {
        const { DrillDownChevron } = await import('../accessories/DrillDownChevron');

        const onPress = vi.fn();
        const screen = await renderScreen(
            <DrillDownChevron onPress={onPress} testID="chev2" />,
        );
        const node = screen.findByTestId('chev2');

        expect(() => node!.props.onPress()).not.toThrow();
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the press event lacks stop methods (legacy callers)', async () => {
        const { DrillDownChevron } = await import('../accessories/DrillDownChevron');

        const onPress = vi.fn();
        const screen = await renderScreen(
            <DrillDownChevron onPress={onPress} testID="chev3" />,
        );
        const node = screen.findByTestId('chev3');

        expect(() => node!.props.onPress({})).not.toThrow();
        expect(() => node!.props.onPress({ nativeEvent: {} })).not.toThrow();
        expect(onPress).toHaveBeenCalledTimes(2);
    });
});
