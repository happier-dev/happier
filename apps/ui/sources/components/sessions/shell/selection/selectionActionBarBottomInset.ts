// Gap (px) the selection action bar floats above the bottom chrome (the floating tab
// bar) — or, with no chrome, above the safe-area inset.
const ACTION_BAR_BOTTOM_GAP = 12;
// Web's bottom chrome (the "Start New Session" bar) is not measured by the cockpit
// chrome registry, so clear it with this known height instead.
const ACTION_BAR_WEB_BOTTOM_INSET = 84;

/**
 * Resolves the selection action bar's absolute bottom offset (px).
 *
 * The bar is absolutely positioned inside a full-height list container that extends
 * UNDER the floating tab bar, so it must add the MEASURED bottom-chrome height to
 * clear it — otherwise the tab bar overlaps its actions (the reported bug).
 *
 * - native with a measured bottom chrome (the floating tab bar): float a gap ABOVE
 *   the full measured height, so it adapts to the tab-bar size + Android nav clearance.
 * - native with no chrome: clear the safe-area inset.
 * - web: the "Start New Session" bottom bar isn't measured by the registry, so use its
 *   known clearance.
 */
export function resolveSelectionActionBarBottomInset(params: Readonly<{
    bottomChromeHeight: number;
    safeAreaBottom: number;
    isWeb: boolean;
}>): number {
    if (params.isWeb) {
        return params.safeAreaBottom + ACTION_BAR_WEB_BOTTOM_INSET;
    }
    return params.bottomChromeHeight > 0
        ? params.bottomChromeHeight + ACTION_BAR_BOTTOM_GAP
        : params.safeAreaBottom + ACTION_BAR_BOTTOM_GAP;
}
