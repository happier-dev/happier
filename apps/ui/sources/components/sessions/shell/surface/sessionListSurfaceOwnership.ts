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

export function resolvePhoneRootSessionListSurfaceDataActive(pathname: string): boolean {
    return pathname === '/';
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
