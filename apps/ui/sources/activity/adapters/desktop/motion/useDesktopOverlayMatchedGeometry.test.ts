import { describe, expect, it } from 'vitest';

import { resolveDesktopOverlayMatchedGeometryStyle } from './useDesktopOverlayMatchedGeometry';

describe('resolveDesktopOverlayMatchedGeometryStyle', () => {
    it('resolves persistent icon geometry between collapsed and expanded positions', () => {
        expect(resolveDesktopOverlayMatchedGeometryStyle({
            progress: 0.5,
            collapsed: { x: 8, y: 4, scale: 0.8 },
            expanded: { x: 24, y: 18, scale: 1 },
        })).toEqual({
            transform: [
                { translateX: 16 },
                { translateY: 11 },
                { scale: 0.9 },
            ],
        });
    });

    it('returns the target geometry immediately for reduced motion', () => {
        expect(resolveDesktopOverlayMatchedGeometryStyle({
            progress: 0,
            reducedMotion: true,
            collapsed: { x: 8, y: 4, scale: 0.8 },
            expanded: { x: 24, y: 18, scale: 1 },
        })).toEqual({
            transform: [
                { translateX: 24 },
                { translateY: 18 },
                { scale: 1 },
            ],
        });
    });
});
