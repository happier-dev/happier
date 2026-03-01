export type PaneLayoutKind = 'single' | 'overlayStack' | 'twoPane' | 'threePane';
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
    mainMinPx?: number;
    mainMinPxThreePane?: number;
    rightMinPx?: number;
    detailsMinPx?: number;
    rightPreferredPx?: number;
    detailsPreferredPx?: number;
}>;

const DEFAULT_MAIN_MIN_PX = 420;
const DEFAULT_RIGHT_MIN_PX = 260;
const DEFAULT_DETAILS_MIN_PX = 320;

export function resolvePaneLayout(input: ResolvePaneLayoutInput): ResolvedPaneLayout {
    const mainMinPx = input.mainMinPx ?? DEFAULT_MAIN_MIN_PX;
    const mainMinPxThreePane = input.mainMinPxThreePane ?? mainMinPx;
    const rightMinPx = input.rightMinPx ?? DEFAULT_RIGHT_MIN_PX;
    const detailsMinPx = input.detailsMinPx ?? DEFAULT_DETAILS_MIN_PX;
    const rightPreferredPx = Math.max(rightMinPx, input.rightPreferredPx ?? rightMinPx);
    const detailsPreferredPx = Math.max(detailsMinPx, input.detailsPreferredPx ?? detailsMinPx);

    if (!input.multiPaneEnabled) return { kind: 'single', right: 'hidden', details: 'hidden' };
    if (input.deviceType === 'phone') return { kind: 'single', right: 'hidden', details: 'hidden' };

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
