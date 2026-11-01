import { describe, expect, it } from 'vitest';

import {
    UNIVERSAL_SEARCH_PLANE_TOP_GAP_PX,
    resolveUniversalSearchPlaneMaxHeight,
} from './universalSearchNativeGeometry';

describe('universal Search native plane geometry', () => {
    it('never claims the bottom edge the frame reserves, keyboard up or down', () => {
        // The keyboard-aware frame reserves the WHOLE keyboard frame, while the settled keyboard
        // signal this host consumes has already deducted the bottom inset on iOS; with the keyboard
        // down the plane pads itself by that same inset. Either way the results region must stop
        // short of it, or a full list runs up under the status bar.
        const open = resolveUniversalSearchPlaneMaxHeight({
            windowHeight: 844,
            safeAreaTop: 59,
            safeAreaBottom: 34,
            keyboardHeight: 336,
            capsuleRowHeight: 46,
        });
        const closed = resolveUniversalSearchPlaneMaxHeight({
            windowHeight: 844,
            safeAreaTop: 59,
            safeAreaBottom: 34,
            keyboardHeight: 0,
            capsuleRowHeight: 46,
        });
        expect(open).toBe(357);
        expect(closed).toBe(693);
        // Retracting the keyboard gives back exactly the keyboard, never the inset twice.
        expect(closed - open).toBe(336);
    });

    // A short or rotated window can leave less plane than the minimum floor wants. The clamp may
    // shrink the results region, but the rendered plane must NEVER exceed the keyboard-aware
    // available frame — a taller claim runs the input and rows up under the status bar / offscreen.
    function expectBounded(params: {
        windowHeight: number;
        safeAreaTop: number;
        safeAreaBottom: number;
        keyboardHeight: number;
        capsuleRowHeight: number;
    }): void {
        const available = params.windowHeight
            - Math.max(0, params.safeAreaTop)
            - Math.max(0, params.safeAreaBottom)
            - Math.max(0, params.keyboardHeight)
            - Math.max(0, params.capsuleRowHeight)
            - UNIVERSAL_SEARCH_PLANE_TOP_GAP_PX;
        const resolved = resolveUniversalSearchPlaneMaxHeight(params);
        expect(resolved).toBeGreaterThanOrEqual(0);
        expect(resolved).toBeLessThanOrEqual(Math.max(0, available));
    }

    it('stays inside the frame on a short landscape window with the keyboard up', () => {
        // iPhone landscape with a tall keyboard: only a sliver is available, so the bounded
        // results region shrinks to the sliver instead of claiming the 180px minimum.
        expect(resolveUniversalSearchPlaneMaxHeight({
            windowHeight: 390,
            safeAreaTop: 0,
            safeAreaBottom: 0,
            keyboardHeight: 336,
            capsuleRowHeight: 46,
        })).toBe(0);
        expectBounded({
            windowHeight: 390,
            safeAreaTop: 0,
            safeAreaBottom: 0,
            keyboardHeight: 336,
            capsuleRowHeight: 46,
        });
    });

    it('stays inside the frame when a rotated window leaves less room than the minimum', () => {
        // Landscape tablet mid-rotation: a little room is available, but less than the minimum
        // plane wants — the floor must yield to the frame.
        expect(resolveUniversalSearchPlaneMaxHeight({
            windowHeight: 480,
            safeAreaTop: 24,
            safeAreaBottom: 20,
            keyboardHeight: 260,
            capsuleRowHeight: 46,
        })).toBe(480 - 24 - 20 - 260 - 46 - UNIVERSAL_SEARCH_PLANE_TOP_GAP_PX);
        expectBounded({
            windowHeight: 480,
            safeAreaTop: 24,
            safeAreaBottom: 20,
            keyboardHeight: 260,
            capsuleRowHeight: 46,
        });
    });

    it('uses the full bounded results region when the frame offers it', () => {
        expect(resolveUniversalSearchPlaneMaxHeight({
            windowHeight: 700,
            safeAreaTop: 0,
            safeAreaBottom: 0,
            keyboardHeight: 260,
            capsuleRowHeight: 46,
        })).toBe(700 - 260 - 46 - UNIVERSAL_SEARCH_PLANE_TOP_GAP_PX);
        expectBounded({
            windowHeight: 700,
            safeAreaTop: 0,
            safeAreaBottom: 0,
            keyboardHeight: 260,
            capsuleRowHeight: 46,
        });
    });
});
