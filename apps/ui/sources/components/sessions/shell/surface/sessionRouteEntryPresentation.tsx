import * as React from 'react';
import { usePathname } from 'expo-router';
import { Platform } from 'react-native';

import { useSessionScreenIsFocused } from '@/components/sessions/shell/useSessionScreenIsFocused';
import { useSurfaceAnchorPathname } from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';

/**
 * Canonical owner of "is this session route entry presented".
 *
 * Web and desktop keep every session visit in the router stack for Back/Forward (#764), so one
 * stack can hold an entry per earlier visit. An entry is presented when it is focused, or when it is
 * the anchor under an overlay or under its own sub-route. Any other entry is only history.
 */

export function isOwnedSessionRootPathname(pathname: string | null | undefined, sessionId: string): boolean {
    const normalizedPathname = typeof pathname === 'string' ? pathname.trim() : '';
    if (!normalizedPathname) {
        return false;
    }

    const match = /^\/session\/([^/]+)\/?$/.exec(normalizedPathname);
    if (!match) {
        return false;
    }

    try {
        return decodeURIComponent(match[1] ?? '') === sessionId;
    } catch {
        return false;
    }
}

export function isOwnedSessionRoutePathname(pathname: string | null | undefined, sessionId: string): boolean {
    const normalizedPathname = typeof pathname === 'string' ? pathname.trim().split('?')[0] ?? '' : '';
    if (!normalizedPathname) {
        return false;
    }

    const match = /^\/session\/([^/]+)(?:\/.*)?$/.exec(normalizedPathname);
    if (!match) {
        return false;
    }

    try {
        return decodeURIComponent(match[1] ?? '') === sessionId;
    } catch {
        return false;
    }
}

export type SessionRouteEntryPresentation = Readonly<{
    surfaceFocused: boolean;
    presented: boolean;
}>;

export function useSessionRouteEntryPresentation(
    sessionId: string,
    overrides?: Readonly<{
        surfaceFocused?: boolean | null;
        routeAnchor?: boolean | null;
    }>,
): SessionRouteEntryPresentation {
    const pathname = usePathname();
    const routeFocused = useSessionScreenIsFocused();
    const anchorPathname = useSurfaceAnchorPathname(pathname);
    const surfaceFocused = typeof overrides?.surfaceFocused === 'boolean'
        ? overrides.surfaceFocused
        : routeFocused;
    const isRouteAnchor = typeof overrides?.routeAnchor === 'boolean'
        ? overrides.routeAnchor
        : isOwnedSessionRoutePathname(anchorPathname, sessionId)
            && (surfaceFocused || !isOwnedSessionRootPathname(pathname, sessionId));
    return { surfaceFocused, presented: surfaceFocused || isRouteAnchor };
}

/**
 * Mounts a session route's content only while its entry is presented. A history entry keeps no
 * session subtree mounted: every mounted session view subscribes to the store, so keeping one per
 * earlier visit made each streamed update cost more the longer the app ran. Back remounts the entry
 * from the in-memory store. Native keeps its single session screen, so it always renders.
 */
export function SessionRouteEntryGate(props: Readonly<{
    sessionId: string;
    children: React.ReactNode;
}>): React.ReactElement | null {
    if (Platform.OS !== 'web') {
        return <>{props.children}</>;
    }
    return <WebSessionRouteEntryGate sessionId={props.sessionId}>{props.children}</WebSessionRouteEntryGate>;
}

function WebSessionRouteEntryGate(props: Readonly<{
    sessionId: string;
    children: React.ReactNode;
}>): React.ReactElement | null {
    const { presented } = useSessionRouteEntryPresentation(props.sessionId);
    return presented ? <>{props.children}</> : null;
}
