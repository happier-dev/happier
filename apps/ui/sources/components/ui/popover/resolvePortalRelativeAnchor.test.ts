import { describe, expect, it } from 'vitest';

import { resolvePortalRelativeAnchorRect } from './resolvePortalRelativeAnchor';
import type { PopoverWindowRect } from './_types';

const PORTAL_LAYOUT = { width: 411, height: 810 };

function withinPortalLayout(rect: PopoverWindowRect | null): boolean {
    if (!rect) return false;
    const tolerance = 16;
    if (rect.x < -tolerance) return false;
    if (rect.y < -tolerance) return false;
    if (rect.x + rect.width > PORTAL_LAYOUT.width + tolerance) return false;
    if (rect.y + rect.height > PORTAL_LAYOUT.height + tolerance) return false;
    return true;
}

describe('resolvePortalRelativeAnchorRect', () => {
    // Numbers captured from a real Android device probe (edge-to-edge new-session composer):
    //   measureInWindow(anchor)      -> y=760 (window space)
    //   measureInWindow(portalRoot)  -> y=56  (status-bar / top inset offset)
    //   deltaRect = 760 - 56         -> y=704 (CORRECT portal-relative anchor)
    //   measureLayout(anchor, portalRoot) -> y=752 (BROKEN: ~window, ignores the 56dp portal offset)
    const androidProbe = {
        deltaRect: { x: 26, y: 704, width: 120, height: 32 },
        layoutRect: { x: 26, y: 752, width: 120, height: 32 },
        anchorWindowRect: { x: 26, y: 760, width: 120, height: 32 },
        hasPortalLayout: true,
        withinPortalLayout,
        keyboardHeight: 0,
    } as const;

    it('uses the window-delta (portal-relative) anchor on Android even when measureLayout is unreliable', () => {
        // Regression: the iOS measureLayout arbiter must NOT pick the raw window rect on Android,
        // or the popover renders offset by the portal root's window inset and overlaps its anchor.
        const rect = resolvePortalRelativeAnchorRect({ ...androidProbe, platformOS: 'android' });
        expect(rect).toEqual(androidProbe.deltaRect);
        expect(rect?.y).toBe(704);
    });

    it('keeps the window-delta anchor on Android with the keyboard open', () => {
        const rect = resolvePortalRelativeAnchorRect({ ...androidProbe, keyboardHeight: 320, platformOS: 'android' });
        expect(rect).toEqual(androidProbe.deltaRect);
    });

    it('preserves the iOS contained-presentation arbiter (prefers the raw rect that matches measureLayout)', () => {
        // iOS quirk: measureInWindow already reports ~portal-relative coords, so subtracting the
        // portal-root origin double-offsets (deltaRect too high). measureLayout is the reliable
        // reference, and the raw window rect matches it — iOS must keep preferring the raw rect.
        const iosQuirk = {
            deltaRect: { x: 26, y: 648, width: 120, height: 32 },
            layoutRect: { x: 26, y: 752, width: 120, height: 32 },
            anchorWindowRect: { x: 26, y: 760, width: 120, height: 32 },
            hasPortalLayout: true,
            withinPortalLayout,
            keyboardHeight: 0,
        } as const;
        const rect = resolvePortalRelativeAnchorRect({ ...iosQuirk, platformOS: 'ios' });
        expect(rect).toEqual(iosQuirk.anchorWindowRect);
    });

    it('prefers the window-delta anchor on iOS when it agrees with measureLayout (normal case)', () => {
        const iosNormal = {
            deltaRect: { x: 26, y: 704, width: 120, height: 32 },
            layoutRect: { x: 26, y: 704, width: 120, height: 32 },
            anchorWindowRect: { x: 26, y: 760, width: 120, height: 32 },
            hasPortalLayout: true,
            withinPortalLayout,
            keyboardHeight: 0,
        } as const;
        const rect = resolvePortalRelativeAnchorRect({ ...iosNormal, platformOS: 'ios' });
        expect(rect).toEqual(iosNormal.deltaRect);
    });

    it('falls back to layoutRect when the window-delta is implausible, else returns whichever exists', () => {
        const rect = resolvePortalRelativeAnchorRect({
            deltaRect: null,
            layoutRect: { x: 10, y: 20, width: 30, height: 40 },
            anchorWindowRect: null,
            hasPortalLayout: true,
            withinPortalLayout,
            keyboardHeight: 0,
            platformOS: 'android',
        });
        expect(rect).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    });
});
