import * as React from 'react';

/**
 * Canonical owner of "which route is a surface anchored to".
 *
 * Overlay routes (`/new`, the external/direct browse sheets, the zen modals, and their sub-routes)
 * are presented *over* the current screen rather than replacing it: on web expo-router's modal stack
 * filters them out of the state handed to the stack view and renders them as a scaled drawer
 * overlay, so the previous screen stays mounted **and visible**; on native they are
 * `modal`/`containedModal` presentations that likewise leave the previous screen on screen.
 *
 * A surface that decides "am I the route being shown" from the raw pathname therefore deactivates
 * itself the moment an overlay opens — while the user can still see it. The anchor pathname is the
 * pathname of the route the user is actually looking at: the current pathname when it is a normal
 * route, otherwise the last non-overlay pathname observed. Surfaces key their visibility decisions
 * off the anchor, and their *interactivity* and URL ownership off the raw pathname (an overlay must
 * still block clicks on what is behind it, and it owns the address bar while it is open).
 */
const OVERLAY_ROUTE_PATHNAMES: readonly string[] = [
    '/new',
    '/external/browse',
    '/direct/browse',
    '/zen/new',
    '/zen/view',
];

export function normalizeSurfaceRoutePathname(pathname: string | null | undefined): string {
    if (typeof pathname !== 'string') return '/';
    const withoutQuery = pathname.trim().split('?')[0] ?? '';
    const withoutHash = withoutQuery.split('#')[0] ?? '';
    const trimmed = withoutHash.replace(/\/+$/, '');
    return trimmed || '/';
}

export function isOverlaySurfaceRoutePathname(pathname: string | null | undefined): boolean {
    const routePathname = normalizeSurfaceRoutePathname(pathname);
    return OVERLAY_ROUTE_PATHNAMES.some(
        (overlayPathname) => routePathname === overlayPathname || routePathname.startsWith(`${overlayPathname}/`),
    );
}

/**
 * Pure anchor resolution. Returns the raw (un-normalized) pathname so callers keep their own
 * route parsing; `previousAnchorPathname` is only consulted while an overlay route is open.
 */
export function resolveSurfaceAnchorPathname(
    pathname: string | null | undefined,
    previousAnchorPathname: string | null | undefined,
): string {
    const currentPathname = typeof pathname === 'string' ? pathname : '/';
    if (!isOverlaySurfaceRoutePathname(currentPathname)) return currentPathname;
    return typeof previousAnchorPathname === 'string' ? previousAnchorPathname : currentPathname;
}

/**
 * Holds the last non-overlay pathname for the lifetime of the consuming surface.
 *
 * The ref is written during render, but only ever with the pathname of that same render and only
 * for non-overlay routes, so the write is idempotent and a discarded render cannot leave a value
 * the next render would not write itself.
 *
 * A surface that mounts *while* an overlay is already open has no observed anchor and falls back to
 * the overlay pathname — correct, because in that case there is no background route it was showing.
 */
export function useSurfaceAnchorPathname(pathname: string): string {
    const anchorPathnameRef = React.useRef<string | null>(null);
    if (!isOverlaySurfaceRoutePathname(pathname)) {
        anchorPathnameRef.current = pathname;
    }
    return resolveSurfaceAnchorPathname(pathname, anchorPathnameRef.current);
}
