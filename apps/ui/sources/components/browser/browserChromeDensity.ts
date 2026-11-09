import * as React from 'react';
import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';

import { ICON_SIZE } from '@/components/ui/icons/Icon';
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
 * - `phone` — narrow, and the device itself is compact. The chrome RECOMPOSES rather than shrinks
 *   (H-UX §5, lab `browser` Qp): the address is one tappable capsule at the top that names the host,
 *   and back · forward · reload · Mark up · Attach page · `⋯` move to a bottom bar in thumb reach.
 * - `pane`  — narrow, embedded in a larger window. One collapsed row (Attach page as its glyph).
 * - `wide`  — the full row fits, with the labelled Attach page.
 */
export type BrowserChromeDensity = 'phone' | 'pane' | 'wide';

/**
 * The one width at which the toolbar stops collapsing.
 *
 * Derived, not picked: at `wide` the row carries navigation (3 × 34 + 2 × 2 = 106), the address
 * field at its usable floor (`BROWSER_CHROME_WIDTH.addressFloor`), Mark up (34), the labelled small
 * Attach page button (≈ 120 at the body size) and the overflow button (34), plus five 4px gaps, the
 * field's 8px margins and 16px of row padding — 106 + 240 + 34 + 120 + 34 + 20 + 8 + 16 = 578,
 * rounded up to 600 for a longer translated label. That is the Details column's own width (lab W),
 * so the labelled button shows there. Below it Attach page folds to its glyph.
 */
const BROWSER_CHROME_WIDE_MIN_PX = 600;

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

export type BrowserChromeControlMetrics = Readonly<{
    /** The drawn size of a chrome icon control. */
    size: number;
    iconSize: number;
    /** The address field's geometry (`BrowserUrlField` density). */
    addressDensity: 'toolbar' | 'toolbarPrecise' | 'capsule';
    /** The chrome row's vertical padding around its 28/34 px controls. */
    rowPaddingVerticalPx: number;
}>;

/**
 * The browser chrome's one metric owner, reconciling the lab's desktop-dense scale with touch.
 *
 * - Precise pointer (desktop web, Tauri), any non-phone density: the lab `browser` Q scale — 28 px
 *   controls with 16 px glyphs beside a 30 px address field, in a 44 px row.
 * - Touch pointer, `pane`/`wide` (a tablet): 34 px controls beside the 34 px field.
 * - `phone`: the bottom bar keeps those 34 px controls with the standard header glyph.
 *
 * No density draws a control larger to reach the platform touch target: a finger reaches it through
 * the shared hit area (DESIGN.md → touch targets are hit areas, not drawn sizes).
 *
 * Callers pass the shared pointer hook's fact, as configuration-page rows do for their metrics.
 */
export function resolveBrowserChromeControlMetrics(
    density: BrowserChromeDensity,
    options: Readonly<{ touch: boolean }>,
): BrowserChromeControlMetrics {
    const touch = options.touch;
    if (density === 'phone') return { size: TOUCH_CHROME_CONTROL_PX, iconSize: ICON_SIZE.md, addressDensity: 'capsule', rowPaddingVerticalPx: 6 };
    if (!touch) return PRECISE_CHROME_METRICS;
    return { size: TOUCH_CHROME_CONTROL_PX, iconSize: ICON_SIZE.sm, addressDensity: 'toolbar', rowPaddingVerticalPx: 6 };
}

/** The touch chrome's control: the 34 px chrome row's own step, the same on a tablet and a phone. */
const TOUCH_CHROME_CONTROL_PX = 34;

const PRECISE_CHROME_METRICS: BrowserChromeControlMetrics = Object.freeze({
    size: 28,
    iconSize: ICON_SIZE.sm,
    addressDensity: 'toolbarPrecise',
    rowPaddingVerticalPx: 7,
});

/**
 * The drawer's share of the surface when the chrome is collapsed. A fixed pixel height cannot be
 * right on both a 667pt phone and a 1440pt window; a fraction can.
 */
export const BROWSER_DRAWER_MAX_HEIGHT_FRACTION = 0.45;

/**
 * The page's flex basis: the share of the surface the expanded drawer leaves it. On a short pane
 * the page then yields in proportion with the drawer body and plugin panels rather than alone.
 */
export const BROWSER_PAGE_BASIS = `${Math.round((1 - BROWSER_DRAWER_MAX_HEIGHT_FRACTION) * 100)}%` as const;

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
    /** Convenience: `phone` or `pane` (Attach page folds to its glyph). */
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
