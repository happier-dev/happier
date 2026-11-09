import { describe, expect, it } from 'vitest';

import { resolveBrowserChromeControlMetrics } from './browserChromeDensity';

describe('resolveBrowserChromeControlMetrics', () => {
    it('draws the chrome at the lab desktop scale under a precise pointer, with no touch floor', () => {
        const wide = resolveBrowserChromeControlMetrics('wide', { touch: false });
        // Lab `browser` Q: 28 px controls beside a 30 px address field in a 44 px row.
        expect(wide).toMatchObject({ size: 28, addressDensity: 'toolbarPrecise' });
        expect(wide.size + wide.rowPaddingVerticalPx * 2).toBeLessThanOrEqual(44);
        expect(resolveBrowserChromeControlMetrics('pane', { touch: false }).size).toBe(28);
    });

    it('draws touch chrome at its design step: a finger reaches the target through the hit area, never a larger control', () => {
        const touchPane = resolveBrowserChromeControlMetrics('pane', { touch: true });
        expect(touchPane.size).toBeGreaterThan(28);
        expect(touchPane.addressDensity).toBe('toolbar');
        const phone = resolveBrowserChromeControlMetrics('phone', { touch: true });
        expect(phone.addressDensity).toBe('capsule');
        // The thumb bar is no taller than the tablet chrome: the 44/48 target is a hit area, not a drawn size.
        expect(phone.size).toBeLessThanOrEqual(touchPane.size);
        expect(Object.keys(phone)).not.toContain('touchTargetFloorPx');
    });
});
