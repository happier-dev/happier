import { describe, expect, it } from 'vitest';

import { resolveDesktopOverlayPlacement } from './resolveDesktopOverlayPlacement';

describe('resolveDesktopOverlayPlacement', () => {
    it('places top-center anchors at the top middle with offsets', () => {
        const rect = resolveDesktopOverlayPlacement({
            monitor: { x: 0, y: 0, width: 1440, height: 900 },
            overlaySize: { width: 360, height: 72 },
            anchor: 'top_center',
            offsetX: 8,
            offsetY: 12,
            padding: 10,
        });

        expect(rect.x).toBe(548);
        expect(rect.y).toBe(22);
        expect(rect.width).toBe(360);
        expect(rect.height).toBe(72);
    });

    it('clamps overlay inside monitor bounds when offsets push it outside', () => {
        const rect = resolveDesktopOverlayPlacement({
            monitor: { x: 100, y: 40, width: 800, height: 600 },
            overlaySize: { width: 500, height: 200 },
            anchor: 'bottom_right',
            offsetX: 1200,
            offsetY: 1200,
            padding: 16,
        });

        expect(rect.x).toBe(384);
        expect(rect.y).toBe(424);
        expect(rect.width).toBe(500);
        expect(rect.height).toBe(200);
    });
});
