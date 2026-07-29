import * as React from 'react';

import type { SessionMobileSurface } from './sessionCockpitState';

export type SessionCockpitChromeRegistration = Readonly<{
    sessionId: string;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    switchSurface: (surface: SessionMobileSurface) => void;
}>;

type SessionCockpitChromeRegister = (registration: SessionCockpitChromeRegistration) => () => void;
type SessionCockpitBottomChromeHeightSetter = (height: number) => void;

/**
 * Lets the session screen flag that its cockpit is dismissing (gesture/native
 * back), before `usePathname()` commits the destination route. The chrome host
 * uses it to cross-fade to the main bar — and dissolve the reserved band — at the
 * **start** of the slide instead of the end. It drives visuals only (opacity +
 * which bar is rendered); the in-flow reservation is keyed off the route, so a
 * cancelled gesture (`closing:false`) self-corrects and the composer never moves.
 */
export type SessionCockpitDismissController = Readonly<{
    markDismissing: (sessionId: string) => void;
    clearDismissing: (sessionId: string) => void;
}>;

const NOOP_REGISTER: SessionCockpitChromeRegister = () => () => {};
const NOOP_SET_BOTTOM_CHROME_HEIGHT: SessionCockpitBottomChromeHeightSetter = () => {};
const NOOP_DISMISS_CONTROLLER: SessionCockpitDismissController = {
    markDismissing: () => {},
    clearDismissing: () => {},
};

const SessionCockpitChromeRegistrationContext = React.createContext<SessionCockpitChromeRegistration | null>(null);
const SessionCockpitChromeRegisterContext = React.createContext<SessionCockpitChromeRegister>(NOOP_REGISTER);
// Exported so a screen-level surface that already reserves the bottom-chrome
// height (e.g. `SessionCockpitFullscreenSurface`) can provide `0` to its subtree,
// preventing nested scroll content (`ItemList`) from reserving it a second time.
export const SessionCockpitBottomChromeHeightContext = React.createContext(0);
const SessionCockpitBottomChromeHeightSetterContext = React.createContext<SessionCockpitBottomChromeHeightSetter>(NOOP_SET_BOTTOM_CHROME_HEIGHT);
const SessionCockpitDismissingSessionIdContext = React.createContext<string | null>(null);
const SessionCockpitDismissControllerContext = React.createContext<SessionCockpitDismissController>(NOOP_DISMISS_CONTROLLER);

export function SessionCockpitChromeRegistryProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [bottomChromeHeight, setBottomChromeHeightState] = React.useState(0);
    const [registration, setRegistration] = React.useState<SessionCockpitChromeRegistration | null>(null);
    const [dismissingSessionId, setDismissingSessionId] = React.useState<string | null>(null);
    const latestRegistrationRef = React.useRef<SessionCockpitChromeRegistration | null>(null);
    const latestRegistrationTokenRef = React.useRef(0);
    const mountedRef = React.useRef(true);

    React.useEffect(() => () => {
        mountedRef.current = false;
    }, []);

    const register = React.useCallback((nextRegistration: SessionCockpitChromeRegistration) => {
        const registrationToken = latestRegistrationTokenRef.current + 1;
        latestRegistrationTokenRef.current = registrationToken;
        latestRegistrationRef.current = nextRegistration;

        setRegistration((currentRegistration) => {
            if (
                currentRegistration?.sessionId === nextRegistration.sessionId
                && currentRegistration.activeSurface === nextRegistration.activeSurface
                && currentRegistration.terminalTabAvailable === nextRegistration.terminalTabAvailable
                && currentRegistration.openDetailsTabCount === nextRegistration.openDetailsTabCount
            ) {
                return currentRegistration;
            }

            return {
                sessionId: nextRegistration.sessionId,
                activeSurface: nextRegistration.activeSurface,
                terminalTabAvailable: nextRegistration.terminalTabAvailable,
                openDetailsTabCount: nextRegistration.openDetailsTabCount,
                switchSurface: (surface) => {
                    latestRegistrationRef.current?.switchSurface(surface);
                },
            };
        });

        return () => {
            queueMicrotask(() => {
                if (!mountedRef.current) return;
                if (latestRegistrationTokenRef.current !== registrationToken) return;

                latestRegistrationRef.current = null;
                setRegistration((currentRegistration) => (
                    currentRegistration?.sessionId === nextRegistration.sessionId
                        ? null
                        : currentRegistration
                ));
            });
        };
    }, []);

    const setBottomChromeHeight = React.useCallback((height: number) => {
        const nextHeight = Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
        setBottomChromeHeightState((currentHeight) => (
            currentHeight === nextHeight ? currentHeight : nextHeight
        ));
    }, []);

    const dismissController = React.useMemo<SessionCockpitDismissController>(() => ({
        markDismissing: (sessionId) => {
            setDismissingSessionId((current) => (current === sessionId ? current : sessionId));
        },
        // Clearing is scoped to the matching session so a stale clear from a
        // previous screen can't drop the active dismiss flag.
        clearDismissing: (sessionId) => {
            setDismissingSessionId((current) => (current === sessionId ? null : current));
        },
    }), []);

    return (
        <SessionCockpitChromeRegisterContext.Provider value={register}>
            <SessionCockpitBottomChromeHeightSetterContext.Provider value={setBottomChromeHeight}>
                <SessionCockpitBottomChromeHeightContext.Provider value={bottomChromeHeight}>
                    <SessionCockpitDismissControllerContext.Provider value={dismissController}>
                        <SessionCockpitDismissingSessionIdContext.Provider value={dismissingSessionId}>
                            <SessionCockpitChromeRegistrationContext.Provider value={registration}>
                                {props.children}
                            </SessionCockpitChromeRegistrationContext.Provider>
                        </SessionCockpitDismissingSessionIdContext.Provider>
                    </SessionCockpitDismissControllerContext.Provider>
                </SessionCockpitBottomChromeHeightContext.Provider>
            </SessionCockpitBottomChromeHeightSetterContext.Provider>
        </SessionCockpitChromeRegisterContext.Provider>
    );
}

export function useSessionCockpitChromeRegistration(): SessionCockpitChromeRegistration | null {
    return React.useContext(SessionCockpitChromeRegistrationContext);
}

export function useSessionCockpitChromeRegister(): ((registration: SessionCockpitChromeRegistration) => () => void) {
    return React.useContext(SessionCockpitChromeRegisterContext);
}

export function useSessionCockpitBottomChromeHeight(): number {
    return React.useContext(SessionCockpitBottomChromeHeightContext);
}

export function useSessionCockpitBottomChromeHeightSetter(): (height: number) => void {
    return React.useContext(SessionCockpitBottomChromeHeightSetterContext);
}

export function useSessionCockpitDismissController(): SessionCockpitDismissController {
    return React.useContext(SessionCockpitDismissControllerContext);
}

export function useSessionCockpitDismissingSessionId(): string | null {
    return React.useContext(SessionCockpitDismissingSessionIdContext);
}
