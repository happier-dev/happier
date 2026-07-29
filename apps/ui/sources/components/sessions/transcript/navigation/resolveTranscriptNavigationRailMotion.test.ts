import { describe, expect, it } from 'vitest';

import {
    resolveTranscriptNavigationRailMarkerMotion,
    resolveTranscriptNavigationRailMarkerTransitionStyle,
    transcriptNavigationRailMarkerMotionEquals,
} from './resolveTranscriptNavigationRailMotion';

describe('resolveTranscriptNavigationRailMarkerMotion', () => {
    it('uses a smooth symmetric falloff around the focused marker', () => {
        const focused = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 10,
            reducedMotion: false,
            visible: false,
        });
        const neighbor = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 11,
            reducedMotion: false,
            visible: false,
        });
        const symmetricNeighbor = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 9,
            reducedMotion: false,
            visible: false,
        });
        const far = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 10,
            markerIndex: 18,
            reducedMotion: false,
            visible: false,
        });

        expect(focused.widthPx).toBeGreaterThan(neighbor.widthPx);
        expect(neighbor.widthPx).toBeGreaterThan(far.widthPx);
        expect(neighbor.widthPx).toBeCloseTo(symmetricNeighbor.widthPx, 3);
        // Markers beyond the update window rest exactly, so focus changes only
        // restyle the bounded falloff window (no all-marker churn).
        expect(far.widthPx).toBe(3);
        expect(far.translateYPx).toBe(0);
    });

    it('keeps active and visible marker opacity above their floors', () => {
        expect(resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: 3,
            focusIndex: null,
            markerIndex: 3,
            reducedMotion: false,
            visible: false,
        }).opacity).toBeGreaterThanOrEqual(0.86);
        expect(resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: null,
            markerIndex: 3,
            reducedMotion: false,
            visible: true,
        }).opacity).toBeGreaterThanOrEqual(0.54);
    });

    it('uses static width and translation for reduced motion while preserving visibility opacity', () => {
        const focused = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 3,
            markerIndex: 3,
            reducedMotion: true,
            visible: true,
        });
        const far = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: null,
            focusIndex: 3,
            markerIndex: 12,
            reducedMotion: true,
            visible: false,
        });

        expect(focused.widthPx).toBe(far.widthPx);
        expect(focused.translateYPx).toBe(0);
        expect(focused.opacity).toBeGreaterThan(far.opacity);
    });

    it('returns finite safe styles for invalid input', () => {
        const style = resolveTranscriptNavigationRailMarkerMotion({
            activeIndex: Number.NaN,
            focusIndex: Number.POSITIVE_INFINITY,
            markerIndex: Number.NaN,
            reducedMotion: false,
            visible: false,
        });

        expect(Number.isFinite(style.widthPx)).toBe(true);
        expect(Number.isFinite(style.opacity)).toBe(true);
        expect(Number.isFinite(style.translateYPx)).toBe(true);
    });

    // The bounded update window is a property of the RESOLVER: every marker past
    // the falloff radius resolves to an identical rest motion, so a focus change
    // leaves the memo comparison equal and those markers do not re-render. The
    // imperative rAF writer that used to enforce this is gone.
    it('resolves an identical rest motion for every marker outside the falloff window', () => {
        const restInput = { activeIndex: null, markerIndex: 500, reducedMotion: false, visible: false } as const;
        const before = resolveTranscriptNavigationRailMarkerMotion({ ...restInput, focusIndex: 100 });
        const after = resolveTranscriptNavigationRailMarkerMotion({ ...restInput, focusIndex: 105 });

        expect(transcriptNavigationRailMarkerMotionEquals(before, after)).toBe(true);
        expect(transcriptNavigationRailMarkerMotionEquals(
            before,
            resolveTranscriptNavigationRailMarkerMotion({ ...restInput, focusIndex: null }),
        )).toBe(true);
    });

    it('collapses the marker transition duration to zero under reduced motion', () => {
        const motion = resolveTranscriptNavigationRailMarkerTransitionStyle(false);
        const reduced = resolveTranscriptNavigationRailMarkerTransitionStyle(true);

        // Native never renders the rail, so it declares no transition at all.
        if (motion === null) {
            expect(reduced).toBeNull();
            return;
        }
        expect((motion as Record<string, unknown>).transitionDuration).toBe('160ms');
        expect((reduced as Record<string, unknown>)?.transitionDuration).toBe('0ms');
    });
});
