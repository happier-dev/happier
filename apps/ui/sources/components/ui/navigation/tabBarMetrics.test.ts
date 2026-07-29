import { describe, expect, it } from 'vitest';

import { resolveTabBarMetrics } from './tabBarMetrics';

describe('resolveTabBarMetrics', () => {
    it('scales the icon with size', () => {
        expect(resolveTabBarMetrics('compact', true).iconSize).toBe(20);
        expect(resolveTabBarMetrics('regular', true).iconSize).toBe(24);
        expect(resolveTabBarMetrics('large', true).iconSize).toBe(28);
    });

    it('adds vertical padding in icon-only mode for a balanced height', () => {
        expect(resolveTabBarMetrics('regular', false).tabPaddingVertical)
            .toBeGreaterThan(resolveTabBarMetrics('regular', true).tabPaddingVertical);
    });

    it('aligns horizontal padding to the vertical (base) padding', () => {
        for (const size of ['compact', 'regular', 'large'] as const) {
            const labeled = resolveTabBarMetrics(size, true);
            expect(labeled.tabPaddingHorizontal).toBe(labeled.tabPaddingVertical);
        }
        expect(resolveTabBarMetrics('compact', true).tabPaddingHorizontal).toBe(4);
        expect(resolveTabBarMetrics('regular', true).tabPaddingHorizontal).toBe(6);
        expect(resolveTabBarMetrics('large', true).tabPaddingHorizontal).toBe(8);
    });

    it('rounds the active pill more when labels are shown (taller tab)', () => {
        expect(resolveTabBarMetrics('regular', true).activePillRadius)
            .toBeGreaterThan(resolveTabBarMetrics('regular', false).activePillRadius);
        expect(resolveTabBarMetrics('large', false).activePillRadius)
            .toBeGreaterThan(resolveTabBarMetrics('compact', false).activePillRadius);
    });

    it('passes showLabels through', () => {
        expect(resolveTabBarMetrics('regular', true).showLabels).toBe(true);
        expect(resolveTabBarMetrics('regular', false).showLabels).toBe(false);
    });

    it('falls back to regular for an unknown size', () => {
        expect(resolveTabBarMetrics('huge' as never, true).iconSize).toBe(24);
    });
});
