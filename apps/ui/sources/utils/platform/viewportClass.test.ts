import { describe, expect, it } from 'vitest';

import {
    CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS,
    resolveViewportClass,
    resolveViewportMinEdgePx,
    VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX,
} from './viewportClass';

describe('viewportClass', () => {
    it('computes min edge from width/height', () => {
        expect(resolveViewportMinEdgePx({ width: 800, height: 600 })).toBe(600);
        expect(resolveViewportMinEdgePx({ width: 375, height: 812 })).toBe(375);
    });

    it('classifies based on min edge (so landscape phones stay compact)', () => {
        expect(resolveViewportClass({ width: 812, height: 375 })).toBe('compact');
        expect(resolveViewportClass({ width: 800, height: 600 })).toBe('medium');
        expect(resolveViewportClass({ width: 1200, height: 800 })).toBe('medium');
        expect(resolveViewportClass({ width: 1600, height: 900 })).toBe('expanded');
        expect(resolveViewportClass({ width: 2500, height: 1400 })).toBe('wide');
    });

    it('exposes breakpoint constants and constrained width mapping', () => {
        expect(VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin).toBe(600);
        expect(VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.expandedMin).toBe(840);
        expect(VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.wideMin).toBe(1200);

        expect(CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.compact).toBe(800);
        expect(CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.medium).toBe(960);
        expect(CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.expanded).toBe(1200);
        expect(CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.wide).toBe(1400);
    });
});
