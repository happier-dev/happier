import { isOverlaySurfaceRoutePathname } from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';

export type SessionListSurfaceOwnership = Readonly<{
    ownerKey: string;
    visible: boolean;
    interactive: boolean;
    dataActive: boolean;
}>;

export const SESSION_LIST_SURFACE_OWNER_DEFAULT = 'default';
export const SESSION_LIST_SURFACE_OWNER_PHONE_ROOT = 'phone-root';
export const SESSION_LIST_SURFACE_OWNER_SIDEBAR = 'sidebar';

const ACTIVE_SESSION_LIST_SURFACE_OWNERSHIP: SessionListSurfaceOwnership = Object.freeze({
    ownerKey: SESSION_LIST_SURFACE_OWNER_DEFAULT,
    visible: true,
    interactive: true,
    dataActive: true,
});

const INACTIVE_SESSION_LIST_SURFACE_OWNERSHIP: SessionListSurfaceOwnership = Object.freeze({
    ownerKey: SESSION_LIST_SURFACE_OWNER_DEFAULT,
    visible: false,
    interactive: false,
    dataActive: false,
});

/**
 * Whether the phone root list should keep computing its own data.
 *
 * The anchor decides whether this list is the surface at all — it is the route BEHIND any overlay,
 * so it stays `/` while `/new` is open. Focus then decides whether that surface is live, with one
 * exception: an overlay route blurs this screen while leaving the list fully visible behind it, and
 * blur alone must not deactivate it.
 *
 * That exception is load-bearing. Deactivating swaps the live pane state for a retained snapshot —
 * a point-in-time reference the live state has moved past — and the list remounts all 25 visible
 * rows for an overlay that changed nothing about them. Measured at ~112–172ms of render work on
 * every composer open.
 *
 * Same doctrine `resolveSidebarSessionListSurfaceInteractive` states for the sidebar: under an
 * overlay the list stays visible and data-active, and only interaction is withheld.
 */
export function resolvePhoneRootSessionListSurfaceDataActive(params: Readonly<{
    surfaceRoutePathname: string;
    routePathname: string;
    isFocused: boolean;
}>): boolean {
    if (params.surfaceRoutePathname !== '/') return false;
    if (isOverlaySurfaceRoutePathname(params.routePathname)) return true;
    return params.isFocused;
}

/**
 * An overlay route blocks what is behind it, so the sidebar list must stop taking clicks while one
 * is open. It stays visible and data-active — only interaction is withheld.
 */
export function resolveSidebarSessionListSurfaceInteractive(pathname: string): boolean {
    return !isOverlaySurfaceRoutePathname(pathname);
}

export function normalizeSessionListSurfaceOwnership(
    ownership: Partial<SessionListSurfaceOwnership> | null | undefined,
): SessionListSurfaceOwnership {
    if (!ownership) return ACTIVE_SESSION_LIST_SURFACE_OWNERSHIP;
    const ownerKey = ownership.ownerKey ?? SESSION_LIST_SURFACE_OWNER_DEFAULT;
    const visible = ownership.visible !== false;
    const dataActive = visible && ownership.dataActive !== false;
    const interactive = visible && dataActive && ownership.interactive !== false;
    if (ownerKey === SESSION_LIST_SURFACE_OWNER_DEFAULT && visible && interactive && dataActive) {
        return ACTIVE_SESSION_LIST_SURFACE_OWNERSHIP;
    }
    if (ownerKey === SESSION_LIST_SURFACE_OWNER_DEFAULT && !visible && !interactive && !dataActive) {
        return INACTIVE_SESSION_LIST_SURFACE_OWNERSHIP;
    }
    return { ownerKey, visible, interactive, dataActive };
}

export function resolveSessionListSurfaceOwnership(input: Readonly<{
    ownerKey: string;
    visible: boolean;
    interactiveOwnerKey?: string | null;
    dataActive?: boolean;
    interactive?: boolean;
}>): SessionListSurfaceOwnership {
    const visible = input.visible;
    const dataActive = visible && input.dataActive !== false;
    const ownsInteraction = !input.interactiveOwnerKey || input.interactiveOwnerKey === input.ownerKey;
    return {
        ownerKey: input.ownerKey,
        visible,
        interactive: visible && dataActive && ownsInteraction && input.interactive !== false,
        dataActive,
    };
}

export function resolveFocusedSessionListSurfaceOwnership(isFocused: boolean): SessionListSurfaceOwnership {
    return resolveSessionListSurfaceOwnership({
        ownerKey: SESSION_LIST_SURFACE_OWNER_DEFAULT,
        interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_DEFAULT,
        visible: isFocused,
    });
}
