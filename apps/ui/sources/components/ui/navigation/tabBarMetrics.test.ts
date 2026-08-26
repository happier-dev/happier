import { describe, expect, it } from 'vitest';

import { resolveTabBarMetrics } from './tabBarMetrics';

describe('resolveTabBarMetrics', () => {
    it('scales the icon with size', () => {
        expect(resolveTabBarMetrics('compact', true, 'ios').iconSize).toBe(18);
        expect(resolveTabBarMetrics('regular', true, 'ios').iconSize).toBe(22);
        expect(resolveTabBarMetrics('large', true, 'ios').iconSize).toBe(26);
    });

    it('makes compact tabs narrower than regular tabs without shrinking platform touch targets', () => {
        const compactIos = resolveTabBarMetrics('compact', false, 'ios');
        const regularIos = resolveTabBarMetrics('regular', false, 'ios');
        const compactAndroid = resolveTabBarMetrics('compact', false, 'android');

        expect(compactIos.tabMinWidth).toBe(44);
        expect(compactIos.tabMinWidth).toBeLessThan(regularIos.tabMinWidth);
        expect(compactIos.tabMinHeight).toBe(44);
        expect(compactAndroid.tabMinWidth).toBe(48);
        expect(compactAndroid.tabMinHeight).toBe(48);
    });

    it('adds vertical padding in icon-only mode for a balanced height', () => {
        expect(resolveTabBarMetrics('regular', false, 'ios').tabPaddingVertical)
            .toBeGreaterThan(resolveTabBarMetrics('regular', true, 'ios').tabPaddingVertical);
    });

    it('aligns horizontal padding to the vertical (base) padding', () => {
        for (const size of ['compact', 'regular', 'large'] as const) {
            const labeled = resolveTabBarMetrics(size, true, 'ios');
            expect(labeled.tabPaddingHorizontal).toBe(labeled.tabPaddingVertical);
        }
        expect(resolveTabBarMetrics('compact', true, 'ios').tabPaddingHorizontal).toBe(3);
        expect(resolveTabBarMetrics('regular', true, 'ios').tabPaddingHorizontal).toBe(5);
        expect(resolveTabBarMetrics('large', true, 'ios').tabPaddingHorizontal).toBe(7);
    });

    it('rounds the active pill more when labels are shown (taller tab)', () => {
        expect(resolveTabBarMetrics('regular', true, 'ios').activePillRadius)
            .toBeGreaterThan(resolveTabBarMetrics('regular', false, 'ios').activePillRadius);
        expect(resolveTabBarMetrics('large', false, 'ios').activePillRadius)
            .toBeGreaterThan(resolveTabBarMetrics('compact', false, 'ios').activePillRadius);
    });

    it('passes showLabels through', () => {
        expect(resolveTabBarMetrics('regular', true, 'ios').showLabels).toBe(true);
        expect(resolveTabBarMetrics('regular', false, 'ios').showLabels).toBe(false);
    });

    it('falls back to regular for an unknown size', () => {
        expect(resolveTabBarMetrics('huge' as never, true, 'ios').iconSize).toBe(22);
    });
});
