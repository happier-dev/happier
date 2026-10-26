import { describe, expect, it } from 'vitest';

import {
    resolveFoldAlignedSidebarWidthPx,
    resolveSidebarDockMaxWidthPx,
    SIDEBAR_DOCK_MIN_WIDTH_PX,
} from './sidebarSizing';

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

describe('resolveFoldAlignedSidebarWidthPx', () => {
    const unfolded = (divisions: ReadonlyArray<{ x: number; y: number; width: number; height: number }>) => ({
        width: 669,
        height: 951,
        hasFoldDivision: divisions.length > 0,
        verticalBarEdge: null,
        divisions,
    });

    it('puts the sidebar/content seam on a single full-height vertical crease', () => {
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([{ x: 300, y: 0, width: 0, height: 951 }]),
            sidebarStartPx: 0,
        })).toBe(300);
    });

    it('measures from where the sidebar content starts in the window', () => {
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([{ x: 320, y: 0, width: 0, height: 951 }]),
            sidebarStartPx: 20,
        })).toBe(300);
    });

    it('keeps the user width when no single vertical full-height division exists', () => {
        expect(resolveFoldAlignedSidebarWidthPx({ foldMetrics: null, sidebarStartPx: 0 })).toBeNull();
        expect(resolveFoldAlignedSidebarWidthPx({ foldMetrics: unfolded([]), sidebarStartPx: 0 })).toBeNull();
        // Horizontal crease (book held landscape).
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([{ x: 0, y: 470, width: 669, height: 0 }]),
            sidebarStartPx: 0,
        })).toBeNull();
        // Partial-height vertical division.
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([{ x: 300, y: 100, width: 0, height: 851 }]),
            sidebarStartPx: 0,
        })).toBeNull();
        // Multiple divisions.
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([
                { x: 300, y: 0, width: 0, height: 951 },
                { x: 500, y: 0, width: 0, height: 951 },
            ]),
            sidebarStartPx: 0,
        })).toBeNull();
    });

    it('keeps the user width when the crease is outside the docked sidebar bounds', () => {
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([{ x: SIDEBAR_DOCK_MIN_WIDTH_PX - 1, y: 0, width: 0, height: 951 }]),
            sidebarStartPx: 0,
        })).toBeNull();
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([{ x: SIDEBAR_DOCK_MIN_WIDTH_PX, y: 0, width: 0, height: 951 }]),
            sidebarStartPx: 0,
        })).toBe(SIDEBAR_DOCK_MIN_WIDTH_PX);
        const maxPx = resolveSidebarDockMaxWidthPx(669);
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([{ x: maxPx, y: 0, width: 0, height: 951 }]),
            sidebarStartPx: 0,
        })).toBe(maxPx);
        expect(resolveFoldAlignedSidebarWidthPx({
            foldMetrics: unfolded([{ x: maxPx + 1, y: 0, width: 0, height: 951 }]),
            sidebarStartPx: 0,
        })).toBeNull();
    });
});
