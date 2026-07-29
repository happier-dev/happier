// iOS over-reserves the thin home-indicator line in its bottom safe-area inset, so
// the floating bar trims that slack to sit a touch closer to it (the established look).
const IOS_HOME_INDICATOR_TRIM = 12;
// Minimum gap the bar floats above the bottom system region — the floor for platforms
// with no inset (web / tablet), and the float gap above the Android system nav.
const FLOATING_MIN_BOTTOM_GAP = 8;

/**
 * Resolves the bottom padding (px) that floats the tab bar clear of the system UI at
 * the screen bottom, from the raw safe-area bottom inset.
 *
 * - iOS: the safe-area inset over-reserves the thin home indicator, so trim that slack
 *   to sit the bar a touch closer (the floor covers home-button devices that report a
 *   0 inset).
 * - Everything else (Android edge-to-edge, …): the bottom inset is the FULL height of
 *   a solid system nav region (3-button bar / gesture area) with no such slack.
 *   Subtracting from it would push the floating bar UNDER the nav (the reported
 *   overlap), so the bar floats a small gap ABOVE the whole inset instead. Web/desktop
 *   report a 0 inset, so this collapses to just the gap.
 *
 * Single source of truth for `FloatingTabBarSurface` — shared by the main app tab bar
 * and the `CockpitTabBar`, so every bottom bar resolves its clearance the same way.
 */
export function resolveFloatingTabBarBottomPadding(bottomInset: number, isIos: boolean): number {
    if (isIos) {
        return Math.max(bottomInset - IOS_HOME_INDICATOR_TRIM, FLOATING_MIN_BOTTOM_GAP);
    }
    return bottomInset + FLOATING_MIN_BOTTOM_GAP;
}
