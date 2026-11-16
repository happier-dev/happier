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

/**
 * {@link SessionSurfacePresence} as a stable subscription, for work that only starts or stops with it or
 * checks it when it acts: a tab switch renders none of its readers. Listeners run after the surface commits.
 */
export type SessionSurfacePresenceSignal = Readonly<{
    get: () => SessionSurfacePresence;
    subscribe: (listener: () => void) => () => void;
}>;
const SessionSurfacePresenceSignalContext = React.createContext<SessionSurfacePresenceSignal | null>(null);

/** A presence that never changes, for a composer hosted outside a Session view (tests, previews). */
export function createConstantSessionSurfacePresenceSignal(presence: SessionSurfacePresence): SessionSurfacePresenceSignal {
    return Object.freeze({ get: () => presence, subscribe: () => () => {} });
}

export function SessionSurfacePresenceProvider(props: Readonly<SessionSurfaceHostPresence & { children: React.ReactNode }>): React.ReactElement {
    const { sessionId, focusedOverride, visibleOverride, sceneActive, routeAnchorOverride, presentedWhileVisible } = props;
    const value = React.useMemo<SessionSurfaceHostPresence>(() => ({
        sessionId, focusedOverride, visibleOverride, sceneActive, routeAnchorOverride, presentedWhileVisible,
    }), [focusedOverride, presentedWhileVisible, routeAnchorOverride, sceneActive, sessionId, visibleOverride]);
    // The provider follows presence itself and publishes it; its children element is unchanged, so a
    // switch renders only this provider and the readers of useSessionSurfacePresence.
    const presence = useResolvedSessionSurfacePresence(value);
    const [signal] = React.useState(() => {
        let current = presence;
        const listeners = new Set<() => void>();
        return {
            get: () => current,
            subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            set: (next: SessionSurfacePresence) => {
                if (next === current) return;
                current = next;
                for (const listener of [...listeners]) listener();
            },
        };
    });
    React.useLayoutEffect(() => signal.set(presence), [presence, signal]);
    return <SessionSurfaceHostPresenceContext.Provider value={value}>
        <SessionSurfacePresenceSignalContext.Provider value={signal}>{props.children}</SessionSurfacePresenceSignalContext.Provider>
    </SessionSurfaceHostPresenceContext.Provider>;
}

/**
 * This Session surface's focus, visibility, route anchor and presentation: the destination owner's
 * facts with the host's contribution applied. Read it in the leaf that acts on it.
 */
export function useSessionSurfacePresence(): SessionSurfacePresence {
    const host = React.useContext(SessionSurfaceHostPresenceContext);
    if (!host) throw new Error('useSessionSurfacePresence requires a SessionView');
    return useResolvedSessionSurfacePresence(host);
}

/** The same presence by subscription. */
export function useSessionSurfacePresenceSignal(): SessionSurfacePresenceSignal {
    const signal = React.useContext(SessionSurfacePresenceSignalContext);
    if (!signal) throw new Error('useSessionSurfacePresenceSignal requires a SessionView');
    return signal;
}

function useResolvedSessionSurfacePresence(host: SessionSurfaceHostPresence): SessionSurfacePresence {
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
