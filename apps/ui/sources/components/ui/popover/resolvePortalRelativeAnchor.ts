import type { PopoverWindowRect } from './_types';

export type PopoverPlatformOS = 'ios' | 'android' | 'windows' | 'macos' | 'web';

export type ResolvePortalRelativeAnchorInput = Readonly<{
    /**
     * Portal-relative anchor derived from window measurements:
     * `measureInWindow(anchor) − measureInWindow(portalRoot)`. This is coordinate-consistent
     * on every platform where `measureInWindow` reports true window coordinates.
     */
    deltaRect: PopoverWindowRect | null;
    /**
     * Portal-relative anchor from `measureLayout(anchor, portalRoot)`. Reliable on iOS — and
     * required to resolve contained react-native-screens presentations — but UNRELIABLE on
     * Android: under edge-to-edge it can ignore the portal root's window offset and report
     * ~window coordinates.
     */
    layoutRect: PopoverWindowRect | null;
    /** Raw `measureInWindow(anchor)` (window space). */
    anchorWindowRect: PopoverWindowRect | null;
    /** Whether a non-zero portal layout (width/height) is known, enabling plausibility checks. */
    hasPortalLayout: boolean;
    /** Plausibility predicate: is the rect within the portal layout (with tolerance)? */
    withinPortalLayout: (rect: PopoverWindowRect | null) => boolean;
    /** Live keyboard height; the iOS arbiter only prefers the raw rect when the keyboard is hidden. */
    keyboardHeight: number;
    /** Current platform. Explicit (not read from `Platform`) so this stays a pure, unit-testable helper. */
    platformOS: PopoverPlatformOS;
}>;

/**
 * Resolves the portal-root-relative anchor rect for a native-portal popover.
 *
 * `deltaRect` (`measureInWindow(anchor) − measureInWindow(portalRoot)`) is the authoritative
 * portal-relative anchor on every platform where `measureInWindow` reports true window
 * coordinates (Android, web-native). On iOS, contained react-native-screens presentations can
 * report `measureInWindow` coordinates that are ALREADY portal-relative (so the delta
 * double-offsets); there `measureLayout` is reliable and is used as an arbiter to prefer the raw
 * window rect when it matches the layout-based measurement better.
 *
 * That arbiter must run on iOS only: on Android `measureLayout(anchor, portalRoot)` is unreliable
 * under edge-to-edge (it can ignore the portal root's window offset and report ~window
 * coordinates), which would fool the arbiter into selecting the raw window rect — rendering the
 * popover offset by the portal root's window inset and overlapping its own anchor.
 */
export function resolvePortalRelativeAnchorRect(
    input: ResolvePortalRelativeAnchorInput,
): PopoverWindowRect | null {
    const { deltaRect, layoutRect, anchorWindowRect, hasPortalLayout, withinPortalLayout, keyboardHeight } = input;

    // The `measureLayout`-based arbiter exists solely to correct the iOS/react-native-screens
    // contained-presentation quirk (measureInWindow already returns portal-relative coords). It
    // must run on iOS only: on Android `measureLayout` is unreliable (it can ignore the portal
    // root's window offset), so trusting it here would select the raw window rect and offset the
    // popover by that inset. Off iOS, the window-delta `deltaRect` is authoritative.
    const useMeasureLayoutArbiter = input.platformOS === 'ios';

    if (useMeasureLayoutArbiter && !layoutRect && hasPortalLayout && deltaRect && anchorWindowRect) {
        const tolerance = 16;
        const deltaLooksDoubleOffset = deltaRect.x < -tolerance || deltaRect.y < -tolerance;
        if (deltaLooksDoubleOffset && withinPortalLayout(anchorWindowRect)) {
            return anchorWindowRect;
        }
    }
    if (deltaRect && withinPortalLayout(deltaRect)) {
        if (useMeasureLayoutArbiter && layoutRect && withinPortalLayout(layoutRect) && anchorWindowRect && withinPortalLayout(anchorWindowRect)) {
            const errDelta = Math.abs(deltaRect.x - layoutRect.x) + Math.abs(deltaRect.y - layoutRect.y);
            const errRaw = Math.abs(anchorWindowRect.x - layoutRect.x) + Math.abs(anchorWindowRect.y - layoutRect.y);
            if (keyboardHeight <= 0 && errRaw + 8 < errDelta) return anchorWindowRect;
        }
        return deltaRect;
    }
    if (layoutRect && withinPortalLayout(layoutRect)) return layoutRect;
    return deltaRect ?? layoutRect;
}
