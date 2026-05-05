import { describe, expect, it } from 'vitest';

import {
    DESKTOP_OVERLAY_CLOSED_CORNERS,
    DESKTOP_OVERLAY_OPEN_CORNERS,
    interpolateDesktopOverlayCorners,
} from './desktopOverlayCornerInterpolation';

describe('desktopOverlayCornerInterpolation', () => {
    it('interpolates closed and opened notch corner radii', () => {
        expect(DESKTOP_OVERLAY_CLOSED_CORNERS).toEqual({ topRadius: 6, bottomRadius: 14 });
        expect(DESKTOP_OVERLAY_OPEN_CORNERS).toEqual({ topRadius: 19, bottomRadius: 24 });
        expect(interpolateDesktopOverlayCorners(0)).toEqual(DESKTOP_OVERLAY_CLOSED_CORNERS);
        expect(interpolateDesktopOverlayCorners(1)).toEqual(DESKTOP_OVERLAY_OPEN_CORNERS);
        expect(interpolateDesktopOverlayCorners(0.5)).toEqual({ topRadius: 12.5, bottomRadius: 19 });
    });

    it('clamps interpolation progress for interrupted transitions', () => {
        expect(interpolateDesktopOverlayCorners(-1)).toEqual(DESKTOP_OVERLAY_CLOSED_CORNERS);
        expect(interpolateDesktopOverlayCorners(2)).toEqual(DESKTOP_OVERLAY_OPEN_CORNERS);
    });
});
