import * as React from 'react';

import { useDestinationFocus, useDestinationPathname, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { isSessionRootRoutePathActive, isSessionRoutePathActive } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useSurfaceAnchorPathname } from './surface/sessionSurfaceAnchorPathname';

/**
 * What a Session view's host adds to the destination's focus and visibility. A workspace tab switch
 * changes none of it, so a switch reaches only the readers of {@link useSessionSurfacePresence}, never
 * the Session view that hosts them.
 */
export type SessionSurfaceHostPresence = Readonly<{
    sessionId: string;
    /** A host's own facts replace the destination's (an embedded Session, a pane, the onboarding stage). */
    focusedOverride: boolean | null;
    visibleOverride: boolean | null;
    /** A cockpit scene's own activity, narrowing the destination's focus and visibility. */
    sceneActive: boolean | null;
    /** `surface`: this surface anchors the route while it is focused and visible (a hosted classic tab). */
    routeAnchorOverride: boolean | 'surface' | null;
    /** An embedded Session, or a host that supplies visibility or a scene, is presented while visible. */
    presentedWhileVisible: boolean;
}>;

export type SessionSurfacePresence = Readonly<{
    focused: boolean;
    visible: boolean;
    routeAnchor: boolean;
    /** This surface owns the Session pane URL (it is focused, visible and on the Session's root route). */
    paneUrlSyncRouteActive: boolean;
    presented: boolean;
}>;

const SessionSurfaceHostPresenceContext = React.createContext<SessionSurfaceHostPresence | null>(null);

export function SessionSurfacePresenceProvider(props: Readonly<SessionSurfaceHostPresence & { children: React.ReactNode }>): React.ReactElement {
    const { sessionId, focusedOverride, visibleOverride, sceneActive, routeAnchorOverride, presentedWhileVisible } = props;
    const value = React.useMemo<SessionSurfaceHostPresence>(() => ({
        sessionId, focusedOverride, visibleOverride, sceneActive, routeAnchorOverride, presentedWhileVisible,
    }), [focusedOverride, presentedWhileVisible, routeAnchorOverride, sceneActive, sessionId, visibleOverride]);
    return <SessionSurfaceHostPresenceContext.Provider value={value}>{props.children}</SessionSurfaceHostPresenceContext.Provider>;
}

/**
 * This Session surface's focus, visibility, route anchor and presentation: the destination owner's
 * facts with the host's contribution applied. Read it in the leaf that acts on it.
 */
export function useSessionSurfacePresence(): SessionSurfacePresence {
    const host = React.useContext(SessionSurfaceHostPresenceContext);
    if (!host) throw new Error('useSessionSurfacePresence requires a SessionView');
    const destinationFocused = useDestinationFocus();
    const destinationVisible = useDestinationVisibility();
    const pathname = useDestinationPathname();
    const anchorPathname = useSurfaceAnchorPathname(pathname);
    const scene = host.sceneActive ?? true;
    const focused = host.focusedOverride ?? (destinationFocused && scene);
    const visible = host.visibleOverride ?? (destinationVisible && scene);
    const routeAnchor = host.routeAnchorOverride === 'surface'
        ? focused && visible
        : host.routeAnchorOverride ?? isSessionRoutePathActive(anchorPathname, host.sessionId);
    const paneUrlSyncRouteActive = focused && visible && (host.routeAnchorOverride === null
        ? isSessionRootRoutePathActive(pathname, host.sessionId)
        : routeAnchor);
    const presented = host.presentedWhileVisible ? visible : (focused || routeAnchor) && visible;
    return React.useMemo(() => ({ focused, visible, routeAnchor, paneUrlSyncRouteActive, presented }),
        [focused, paneUrlSyncRouteActive, presented, routeAnchor, visible]);
}
