import { describe, expect, it } from 'vitest';

import { resolveSelectionActionBarBottomInset } from './selectionActionBarBottomInset';

describe('resolveSelectionActionBarBottomInset', () => {
    it('floats above the measured bottom chrome on native (clears the tab bar)', () => {
        // 80px tab bar + 12 gap → the bar sits above the whole tab-bar footprint.
        expect(resolveSelectionActionBarBottomInset({ bottomChromeHeight: 80, safeAreaBottom: 34, isWeb: false })).toBe(92);
        // Invariant: the bar always clears the WHOLE measured chrome (no overlap).
        for (const h of [56, 64, 80]) {
            expect(resolveSelectionActionBarBottomInset({ bottomChromeHeight: h, safeAreaBottom: 34, isWeb: false })).toBeGreaterThan(h);
        }
    });

    it('clears the safe-area inset on native when no bottom chrome is present', () => {
        expect(resolveSelectionActionBarBottomInset({ bottomChromeHeight: 0, safeAreaBottom: 34, isWeb: false })).toBe(46); // 34 + 12
    });

    it('uses the web bottom-chrome clearance on web (unchanged)', () => {
        expect(resolveSelectionActionBarBottomInset({ bottomChromeHeight: 0, safeAreaBottom: 0, isWeb: true })).toBe(84);
        expect(resolveSelectionActionBarBottomInset({ bottomChromeHeight: 80, safeAreaBottom: 10, isWeb: true })).toBe(94); // 10 + 84
    });
});
