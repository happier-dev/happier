import { describe, expect, it } from 'vitest';

import { resolveFloatingTabBarBottomPadding } from './floatingTabBarBottomInset';

describe('resolveFloatingTabBarBottomPadding', () => {
    it('trims the over-reserved iOS home-indicator inset (unchanged iOS look)', () => {
        expect(resolveFloatingTabBarBottomPadding(34, true)).toBe(22); // 34 - 12 trim
        expect(resolveFloatingTabBarBottomPadding(0, true)).toBe(8); // home-button device (0 inset) → floor
    });

    it('floats the bar ABOVE the full system-nav inset on Android (never under it)', () => {
        // The reported bug: with edge-to-edge, insets.bottom is the solid nav region
        // (3-button ~48dp, gesture ~16dp). The bar must clear the WHOLE inset.
        expect(resolveFloatingTabBarBottomPadding(48, false)).toBe(56); // 48 + 8 gap → above the nav
        expect(resolveFloatingTabBarBottomPadding(16, false)).toBe(24);
        for (const inset of [16, 24, 48]) {
            expect(resolveFloatingTabBarBottomPadding(inset, false)).toBeGreaterThan(inset);
        }
    });

    it('falls back to the min gap with no inset (web / tablet, both platforms)', () => {
        expect(resolveFloatingTabBarBottomPadding(0, false)).toBe(8);
        expect(resolveFloatingTabBarBottomPadding(0, true)).toBe(8);
    });
});
