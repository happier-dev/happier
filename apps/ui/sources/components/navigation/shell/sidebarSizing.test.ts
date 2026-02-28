import { describe, expect, it } from 'vitest';

import { resolveSidebarDockMaxWidthPx } from './sidebarSizing';

describe('resolveSidebarDockMaxWidthPx', () => {
    it('falls back to a safe max width when windowWidthPx is invalid', () => {
        expect(resolveSidebarDockMaxWidthPx(NaN)).toBeGreaterThanOrEqual(480);
        expect(resolveSidebarDockMaxWidthPx(0)).toBeGreaterThanOrEqual(480);
        expect(resolveSidebarDockMaxWidthPx(-10)).toBeGreaterThanOrEqual(480);
    });

    it('scales up max width on larger windows with a cap', () => {
        expect(resolveSidebarDockMaxWidthPx(800)).toBe(480);
        expect(resolveSidebarDockMaxWidthPx(1200)).toBe(600);
        expect(resolveSidebarDockMaxWidthPx(2000)).toBe(720);
    });
});
