/**
 * Horizontal safe-area ownership for the app shell.
 *
 * Side insets (iPhone landscape notch, the iPhone Duo's system vertical bar, Android side navigation
 * bars) must keep content and touch targets inside the safe area while backgrounds reach the window
 * edge. The app root pads everything by default; navigators reclaim that padding so native and
 * custom headers paint edge to edge; each screen frame pads its content back inside the safe area.
 *
 * `left`/`right` are the window-edge insets at the current subtree's edges. `padded` says whether an
 * ancestor already applies them as padding (true) or the subtree reaches the window edge and must
 * keep its own content inside them (false).
 */
export type HorizontalSafeArea = Readonly<{ left: number; right: number; padded: boolean }>;
export type HorizontalEdges = Readonly<{ left: number; right: number }>;

type Resolved<K extends string> = Readonly<Record<K, HorizontalEdges> & { child: HorizontalSafeArea }>;

const NO_EDGES: HorizontalEdges = { left: 0, right: 0 };

function negate(value: number): number {
    return value ? -value : 0;
}

export function resolveHorizontalSafeAreaRoot(windowInsets: HorizontalEdges): Resolved<'padding'> {
    const left = Math.max(0, windowInsets.left);
    const right = Math.max(0, windowInsets.right);
    return { padding: { left, right }, child: { left, right, padded: true } };
}

/** A navigator container: reclaims the padding around it so its chrome reaches the window edge. */
export function resolveNavigatorBleed(area: HorizontalSafeArea): Resolved<'margin'> {
    if (!area.padded) return { margin: NO_EDGES, child: area };
    return {
        margin: { left: negate(area.left), right: negate(area.right) },
        child: { left: area.left, right: area.right, padded: false },
    };
}

/**
 * A navigator screen: pads its content inside the edges its navigator reclaimed. A screen presented
 * outside the navigator's view (an iOS native modal or sheet) never sat under those insets.
 */
export function resolveScreenFrameInsets(
    area: HorizontalSafeArea,
    placement: Readonly<{ presentedOutsideNavigator: boolean }>,
): Resolved<'padding'> {
    if (placement.presentedOutsideNavigator) {
        return { padding: NO_EDGES, child: { left: 0, right: 0, padded: true } };
    }
    if (area.padded) return { padding: NO_EDGES, child: area };
    return { padding: { left: area.left, right: area.right }, child: { ...area, padded: true } };
}

/** A docked sidebar owns the window's leading edge: its background bleeds there, its content stays safe. */
export function resolveSidebarInsetSplit(
    area: HorizontalSafeArea,
    layout: Readonly<{ sidebarShown: boolean }>,
): Readonly<{ sidebar: Readonly<{ margin: number; padding: number }>; content: HorizontalSafeArea }> {
    if (!layout.sidebarShown) return { sidebar: { margin: 0, padding: 0 }, content: area };
    return {
        sidebar: { margin: area.padded ? negate(area.left) : 0, padding: area.left },
        content: { left: 0, right: area.right, padded: area.padded },
    };
}
