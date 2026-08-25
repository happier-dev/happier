import * as React from 'react';
import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';

import { resolveViewportClass } from '@/utils/platform/viewportClass';

/**
 * How much room the browser chrome actually has.
 *
 * This is a CONTAINER fact, not a viewport fact, and that distinction is the whole reason the hook
 * exists: the same shell renders into a ~380px session side panel and a 2560px window on the very
 * same device, so `resolveViewportClass` alone cannot answer it. The window class still
 * participates — it is what separates a narrow pane inside a large window from a phone, where the
 * surface owns the whole screen and its safe areas.
 *
 * - `phone` — narrow, and the device itself is compact. Collapsed chrome, full-bleed content.
 * - `pane`  — narrow, embedded in a larger window. Collapsed chrome, constrained content.
 * - `wide`  — the full toolbar fits.
 */
export type BrowserChromeDensity = 'phone' | 'pane' | 'wide';

/**
 * The one width at which the toolbar stops collapsing.
 *
 * Derived, not picked: at `wide` the row carries navigation (3 × 34 + 2 × 6 = 114), the address
 * field at its usable floor (`BROWSER_CHROME_WIDTH.addressFloor`), the security/origin chip
 * (`BROWSER_CHROME_WIDTH.chip`) and the overflow button (34), plus four 8px gaps and 20px of
 * horizontal padding — 114 + 240 + 220 + 34 + 32 + 20 = 660. Below that something has to leave the
 * row, so below that the chrome collapses.
 */
const BROWSER_CHROME_WIDE_MIN_PX = 660;

/**
 * The chrome's width scale.
 *
 * Replaces eight unrelated `maxWidth` literals (160/180/220/240/320/360/400/520) that had no shared
 * rhythm, so two chips sitting side by side truncated at different widths for no reason a reader
 * could recover. Steps are the address field's own 4pt grid at ×20.
 */
export const BROWSER_CHROME_WIDTH = Object.freeze({
    /** A compact status pill (automation state, recording elapsed). */
    pill: 160,
    /** A labelled chip that must stay readable (security origin, automation summary). */
    chip: 220,
    /** The address field's usable floor before the row wraps. */
    addressFloor: 240,
    /** A dense popover/menu column. */
    panel: 360,
    /** A centred terminal card inside the frame. */
    card: 520,
});

/**
 * The drawer's share of the surface when the chrome is collapsed. A fixed pixel height cannot be
 * right on both a 667pt phone and a 1440pt window; a fraction can.
 */
export const BROWSER_DRAWER_MAX_HEIGHT_FRACTION = 0.45;

export function resolveBrowserChromeDensity(input: Readonly<{
    containerWidthPx: number;
    windowWidthPx: number;
    windowHeightPx: number;
}>): BrowserChromeDensity {
    const width = Number.isFinite(input.containerWidthPx) && input.containerWidthPx > 0
        ? input.containerWidthPx
        // Before the first layout pass, assume the container gets the window. A shell that starts
        // `wide` and collapses on measure is a visible reflow; starting collapsed and expanding is
        // the same reflow in the other direction, so neither default is free — this one at least
        // matches the common full-window case.
        : input.windowWidthPx;
    if (width >= BROWSER_CHROME_WIDE_MIN_PX) {
        return 'wide';
    }
    return resolveViewportClass({ width: input.windowWidthPx, height: input.windowHeightPx }) === 'compact'
        ? 'phone'
        : 'pane';
}

export type BrowserChromeDensityHandle = Readonly<{
    density: BrowserChromeDensity;
    /** Width the chrome last measured, or `null` before the first layout pass. */
    containerWidthPx: number | null;
    /** Height the chrome last measured, or `null` before the first layout pass. */
    containerHeightPx: number | null;
    /** Attach to the chrome's outermost view. */
    onLayout: (event: LayoutChangeEvent) => void;
    /** Convenience: `phone` or `pane`. */
    collapsed: boolean;
}>;

export function useBrowserChromeDensity(): BrowserChromeDensityHandle {
    const window = useWindowDimensions();
    const [size, setSize] = React.useState<Readonly<{ width: number; height: number }> | null>(null);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        const height = Math.round(event.nativeEvent.layout.height);
        setSize((current) => (
            current && current.width === width && current.height === height
                ? current
                : { width, height }
        ));
    }, []);

    const density = resolveBrowserChromeDensity({
        containerWidthPx: size?.width ?? 0,
        windowWidthPx: window.width,
        windowHeightPx: window.height,
    });

    return React.useMemo(() => ({
        density,
        containerWidthPx: size?.width ?? null,
        containerHeightPx: size?.height ?? null,
        onLayout,
        collapsed: density !== 'wide',
    }), [density, onLayout, size]);
}
