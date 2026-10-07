export type PaneLayoutKind = 'single' | 'overlayStack' | 'twoPane' | 'threePane';
/**
 * The region Details was opened from: the main content (a tool line in the transcript, the rail)
 * or the side column's own list (Files, Changes, history). Details never covers what it was
 * opened from (details lab 2, Q1).
 */
export type DetailsOpenerRegion = 'main' | 'side';
export type PanePresentation = 'hidden' | 'docked' | 'overlay';

export type ResolvedPaneLayout = Readonly<{
    kind: PaneLayoutKind;
    right: PanePresentation;
    details: PanePresentation;
}>;

export type ResolvePaneLayoutInput = Readonly<{
    containerWidthPx: number;
    deviceType: 'phone' | 'tablet';
    multiPaneEnabled: boolean;
    rightOpen: boolean;
    detailsOpen: boolean;
    /** A selected destination detail is content, not an optional auxiliary side panel. */
    destinationOwnsDetails?: boolean;
    /**
     * When only the right pane is open and main+right mins fit, we normally dock and clamp
     * sizing later. Callers can opt into overlay presentation when the preferred width
     * would not fit, which is primarily used while the user is actively resizing a pane
     * wider than the docked budget allows.
     */
    rightPreferOverlayWhenPreferredDoesNotFit?: boolean;
    /**
     * Same as `rightPreferOverlayWhenPreferredDoesNotFit`, but for the details pane.
     */
    detailsPreferOverlayWhenPreferredDoesNotFit?: boolean;
    /** Where Details was opened from, when both side columns are open and cannot all dock. */
    detailsOpenedFrom?: DetailsOpenerRegion | null;
    mainMinPx?: number;
    mainMinPxThreePane?: number;
    rightMinPx?: number;
    detailsMinPx?: number;
    rightPreferredPx?: number;
    detailsPreferredPx?: number;
}>;

/**
 * The canonical minimum width the main region keeps. Exported so surfaces that
 * reserve space inside main (Session Companion's rail) budget against the same
 * number instead of guessing a second Chat minimum.
 */
export const DEFAULT_MAIN_MIN_PX = 420;
/** The narrowest docked right sidebar and details pane. `PANE_SIZING_DEFAULTS` re-exports these. */
export const DEFAULT_RIGHT_MIN_PX = 260;
export const DEFAULT_DETAILS_MIN_PX = 320;

export function resolvePaneLayout(input: ResolvePaneLayoutInput): ResolvedPaneLayout {
    const mainMinPx = input.mainMinPx ?? DEFAULT_MAIN_MIN_PX;
    const mainMinPxThreePane = input.mainMinPxThreePane ?? mainMinPx;
    const rightMinPx = input.rightMinPx ?? DEFAULT_RIGHT_MIN_PX;
    const detailsMinPx = input.detailsMinPx ?? DEFAULT_DETAILS_MIN_PX;
    const rightPreferredPx = Math.max(rightMinPx, input.rightPreferredPx ?? rightMinPx);
    const detailsPreferredPx = Math.max(detailsMinPx, input.detailsPreferredPx ?? detailsMinPx);

    if (!input.multiPaneEnabled || input.deviceType === 'phone') {
        return {
            kind: 'single',
            right: 'hidden',
            details: input.destinationOwnsDetails === true && input.detailsOpen
                && Number.isFinite(input.containerWidthPx) && input.containerWidthPx > 0
                ? 'overlay' : 'hidden',
        };
    }

    const width = input.containerWidthPx;
    if (!Number.isFinite(width) || width <= 0) return { kind: 'single', right: 'hidden', details: 'hidden' };

    const rightOpen = input.rightOpen;
    const detailsOpen = input.detailsOpen;

    const fitsMainPlusRight = width >= mainMinPx + rightMinPx;
    const fitsMainPlusDetails = width >= mainMinPx + detailsMinPx;
    const fitsThreeDocked = width >= mainMinPxThreePane + rightMinPx + detailsMinPx;

    const fitsMainPlusRightPreferred = width >= mainMinPx + rightPreferredPx;
    const fitsMainPlusDetailsPreferred = width >= mainMinPx + detailsPreferredPx;
    const fitsThreeDockedPreferred = width >= mainMinPxThreePane + rightPreferredPx + detailsPreferredPx;

    if (rightOpen && detailsOpen) {
        if (fitsThreeDockedPreferred) return { kind: 'threePane', right: 'docked', details: 'docked' };
        // Opened from the transcript: the side column folds to its rail (it stays open, only
        // hidden, so closing Details brings it back) and Details docks beside what was clicked.
        if (input.detailsOpenedFrom === 'main' && fitsMainPlusDetails) {
            return { kind: 'twoPane', right: 'hidden', details: 'docked' };
        }
        // Opened from the side column's list: the list stays and Details is a drawer over main.
        if (input.detailsOpenedFrom === 'side' && fitsMainPlusRight) {
            return { kind: 'twoPane', right: 'docked', details: 'overlay' };
        }
        // If the user has expressed a preference that cannot fit with three docked panes, prefer
        // keeping one pane docked while presenting the other as an overlay. This avoids forcing
        // the main region into an overly narrow three-pane layout when the user is actively
        // resizing panels to be wider.
        if (fitsMainPlusRightPreferred) return { kind: 'twoPane', right: 'docked', details: 'overlay' };
        if (fitsMainPlusDetailsPreferred) return { kind: 'twoPane', right: 'overlay', details: 'docked' };
        // If preferred widths do not fit, still keep both panes usable by docking at the minimums
        // whenever possible. Actual widths will be clamped by dock sizing logic.
        if (fitsThreeDocked) return { kind: 'threePane', right: 'docked', details: 'docked' };
        if (fitsMainPlusRight) return { kind: 'twoPane', right: 'docked', details: 'overlay' };
        if (fitsMainPlusDetails) return { kind: 'twoPane', right: 'overlay', details: 'docked' };
        return { kind: 'overlayStack', right: 'hidden', details: 'overlay' };
    }

    if (rightOpen) {
        // For a single auxiliary pane, prefer a docked presentation whenever the minimum widths fit.
        // The dock sizing logic will clamp the pane width to preserve the main region's minimum.
        if (fitsMainPlusRight) {
            if (input.rightPreferOverlayWhenPreferredDoesNotFit === true && !fitsMainPlusRightPreferred) {
                return { kind: 'overlayStack', right: 'overlay', details: 'hidden' };
            }
            return { kind: 'twoPane', right: 'docked', details: 'hidden' };
        }
        return { kind: 'overlayStack', right: 'overlay', details: 'hidden' };
    }

    if (detailsOpen) {
        // Same as the right pane: dock whenever minimum widths fit, clamp later.
        if (fitsMainPlusDetails) {
            if (input.detailsPreferOverlayWhenPreferredDoesNotFit === true && !fitsMainPlusDetailsPreferred) {
                return { kind: 'overlayStack', right: 'hidden', details: 'overlay' };
            }
            return { kind: 'twoPane', right: 'hidden', details: 'docked' };
        }
        return { kind: 'overlayStack', right: 'hidden', details: 'overlay' };
    }

    return { kind: 'single', right: 'hidden', details: 'hidden' };
}
