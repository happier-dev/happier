import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('DrillDownChevron', () => {
    it('renders a tappable surface that fires onPress', async () => {
        const onPress = vi.fn();
        const { DrillDownChevron } = await import('../../accessories/DrillDownChevron');
        const screen = await renderScreen(<DrillDownChevron onPress={onPress} testID="chev" />);
        screen.pressByTestId('chev');
        expect(onPress).toHaveBeenCalled();
    });

    it('extends the tap target to ≥ 40×40 effective via hitSlop', async () => {
        const { DrillDownChevron } = await import('../../accessories/DrillDownChevron');
        const screen = await renderScreen(<DrillDownChevron onPress={() => {}} testID="chev2" />);
        const node = screen.findByTestId('chev2');
        const hitSlop = node?.props.hitSlop;
        // Visual is 20×20; need ≥ 40×40 effective → ≥ 10px on each side.
        expect(hitSlop).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
    });

    it('exposes button accessibility role', async () => {
        const { DrillDownChevron } = await import('../../accessories/DrillDownChevron');
        const screen = await renderScreen(<DrillDownChevron onPress={() => {}} testID="chev3" accessibilityLabel="drill in" />);
        const node = screen.findByTestId('chev3');
        expect(node?.props.accessibilityRole).toBe('button');
        expect(node?.props.accessibilityLabel).toBe('drill in');
    });
});
