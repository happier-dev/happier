import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * R13 — Premium UI gaps round 2 (Fix 5): the R6 skeleton row only painted a
 * 16px shimmer bar with 12px vertical margin (≈40px total), but the resolved
 * option row (Item with comfortable density + subtitle) is materially taller
 * (~56px on web). When the resolver returns, the layout shifts down by that
 * delta — visible as a "settle" frame in the popover.
 *
 * Fix: pin the skeleton row container's outer height to the same final row
 * height the rendered row will use, so loading→ready does not shift.
 */
describe('SelectionListSkeletonRow — R13 row geometry', () => {
    it('renders a container with a fixed height matching the option row final geometry', async () => {
        const { SelectionListSkeletonRow } = await import('../SelectionListSkeletonRow');
        const { SELECTION_LIST_SKELETON_ROW_HEIGHT_PX } = await import('../_constants');

        // Sanity: the constant must be defined and positive (drives both the
        // skeleton container and the option-row min-height invariant).
        expect(typeof SELECTION_LIST_SKELETON_ROW_HEIGHT_PX).toBe('number');
        expect(SELECTION_LIST_SKELETON_ROW_HEIGHT_PX).toBeGreaterThan(0);

        const screen = await renderScreen(
            <SelectionListSkeletonRow index={0} testID="sk" />,
        );
        const row = screen.findByTestId('sk');
        expect(row).not.toBeNull();
        const styles = row!.props.style;
        const flat = (Array.isArray(styles) ? styles.flat(Infinity) : [styles]).filter(Boolean);
        const merged = Object.assign({}, ...flat);
        // The OUTER container reserves the row geometry; the inner shimmer can
        // still be a smaller bar within it.
        expect(merged.height).toBe(SELECTION_LIST_SKELETON_ROW_HEIGHT_PX);
    });
});
