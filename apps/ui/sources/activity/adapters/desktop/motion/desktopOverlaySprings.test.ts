import { describe, expect, it } from 'vitest';

import {
    DESKTOP_OVERLAY_BOUNCE_SPRING,
    DESKTOP_OVERLAY_CLOSE_SPRING,
    DESKTOP_OVERLAY_CONTENT_SWAP,
    DESKTOP_OVERLAY_OPEN_SPRING,
    resolveDesktopOverlayMotionSpec,
} from './desktopOverlaySprings';

describe('desktopOverlaySprings', () => {
    it('defines distinct open, close, bounce, and content-swap motion specs', () => {
        expect(DESKTOP_OVERLAY_OPEN_SPRING).toMatchObject({ response: 0.42, dampingRatio: 0.8 });
        expect(DESKTOP_OVERLAY_CLOSE_SPRING).toMatchObject({ response: 0.45, dampingRatio: 1 });
        expect(DESKTOP_OVERLAY_BOUNCE_SPRING).toMatchObject({ response: 0.3, dampingRatio: 0.5, durationMs: 150 });
        expect(DESKTOP_OVERLAY_CONTENT_SWAP).toMatchObject({ initialScale: 0.8, durationMs: 350 });
    });

    it('aliases all motion to instant specs when reduced motion is enabled', () => {
        expect(resolveDesktopOverlayMotionSpec('open', true)).toEqual({
            kind: 'instant',
            durationMs: 0,
        });
        expect(resolveDesktopOverlayMotionSpec('content_swap', true)).toEqual({
            kind: 'instant',
            durationMs: 0,
        });
    });
});
