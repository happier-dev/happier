import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * R16d (Fix 2): the loading skeleton row must be hidden from assistive tech on
 * EVERY platform. Previously the row passed only `accessibilityHidden` (a
 * non-standard prop) plus `aria-hidden`. The web `aria-hidden` works on web,
 * but native iOS/Android need their own dedicated props:
 *
 * - iOS: `accessibilityElementsHidden={true}`
 * - Android: `importantForAccessibility="no-hide-descendants"`
 *
 * React Native silently ignores unknown props per platform, so passing all
 * three keeps the cross-platform contract explicit.
 */
describe('SelectionListSkeletonRow — R16d a11y', () => {
    it('hides the skeleton row from assistive tech on web, iOS, and Android', async () => {
        const { SelectionListSkeletonRow } = await import('../SelectionListSkeletonRow');

        const screen = await renderScreen(
            <SelectionListSkeletonRow index={0} testID="sk" />,
        );
        const row = screen.findByTestId('sk');
        expect(row).not.toBeNull();
        const props = row!.props as Record<string, unknown>;
        expect(props['aria-hidden']).toBe(true);
        expect(props.accessibilityElementsHidden).toBe(true);
        expect(props.importantForAccessibility).toBe('no-hide-descendants');
    });
});
