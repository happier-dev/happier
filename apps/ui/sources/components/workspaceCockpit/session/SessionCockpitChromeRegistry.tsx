import * as React from 'react';
import { makeMutable, type SharedValue } from 'react-native-reanimated';

import type { SessionMobileSurface } from './sessionCockpitState';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';

export type SessionCockpitChromeRegistration = Readonly<{
    sessionId: string;
    serverId?: string | null;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    projectionGeneration?: number | null;
    switchSurface: (surface: SessionMobileSurface) => void;
}>;

type SessionCockpitChromeRegister = (registration: SessionCockpitChromeRegistration) => () => void;
type SessionCockpitBottomChromeHeightSetter = (height: number) => void;
type SessionCockpitComposerChromeReporter = (id: string, height: number | null) => void;

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
const NOOP_REPORT_COMPOSER_CHROME: SessionCockpitComposerChromeReporter = () => {};
const NOOP_DISMISS_CONTROLLER: SessionCockpitDismissController = {
    markDismissing: () => {},
    clearDismissing: () => {},
};

const SessionCockpitChromeRegistrationContext = React.createContext<SessionCockpitChromeRegistration | null>(null);
const SessionCockpitChromeRegisterContext = React.createContext<SessionCockpitChromeRegister>(NOOP_REGISTER);

/**
 * The live state of the phone's session switcher, published as shared values so every reader
 * animates on the UI thread and no frame of the gesture reaches React.
 *
 * It lives on this registry because the registry already spans the band and the session screen:
 * the bar's gesture is mounted in the bottom chrome (outside the navigator) while the session
 * content that recedes behind the switcher lives inside it. Nothing here navigates: scrubbing
 * only moves the selection, because a session switch remounts a transcript and that cost is paid
 * once, on release. The decisions are `sessionSwitcherGesture`'s.
 */
export type SessionSwitcherSharedState = Readonly<{
    /** 0 = closed, 1 = open. Drives the session recede, the scrim and the panel's presence. */
    open: SharedValue<number>;
    /** 0..1 of the ghost's way to the lock; 1 once locked, sideways or docked. */
    ghost: SharedValue<number>;
    /** How far the bar has risen with the finger, in points. */
    lift: SharedValue<number>;
    /** The selected row, nearest first; -1 = stay where you are. */
    index: SharedValue<number>;
    /** How far the panel's list has scrolled to show further rows, in points. */
    scroll: SharedValue<number>;
}>;

/**
 * There is exactly one bottom band and one session screen on a phone, so the state is a process
 * singleton rather than provider state: a per-provider instance would buy no isolation the single
 * band does not already have, and would put a `useSharedValue` call in a provider mounted on
 * EVERY route.
 *
 * Built on FIRST USE rather than at module evaluation: `makeMutable` reaches into the animation
 * runtime, so constructing it eagerly made merely IMPORTING this registry touch Reanimated
 * (`motionSprings.ts` records the same lesson). Identity is stable, so it is safe in dependency arrays.
 */
let sessionSwitcherState: SessionSwitcherSharedState | null = null;

function getSessionSwitcherState(): SessionSwitcherSharedState {
    sessionSwitcherState ??= {
        open: makeMutable(0),
        ghost: makeMutable(0),
        lift: makeMutable(0),
        index: makeMutable(-1),
        scroll: makeMutable(0),
    };
    return sessionSwitcherState;
}

/** Drops the singleton so one suite's gesture state cannot leak into the next. */
export function resetSessionSwitcherStateForTests(): void {
    sessionSwitcherState = null;
}

// Exported so a screen-level surface that already reserves the bottom-chrome
// height (e.g. `SessionCockpitFullscreenSurface`) can provide `0` to its subtree,
// preventing nested scroll content (`ItemList`) from reserving it a second time.
export const SessionCockpitBottomChromeHeightContext = React.createContext(0);
const SessionCockpitBottomChromeHeightSetterContext = React.createContext<SessionCockpitBottomChromeHeightSetter>(NOOP_SET_BOTTOM_CHROME_HEIGHT);
// One shell-owned floating band (the phone Voice Island), measured independently of the bar.
const SessionCockpitFloatingBottomChromeHeightContext = React.createContext(0);
const SessionCockpitFloatingBottomChromeReporterContext = React.createContext<SessionCockpitBottomChromeHeightSetter>(NOOP_SET_BOTTOM_CHROME_HEIGHT);
/**
 * The composer band that floats **above** the bottom chrome, published separately from it.
 *
 * The tab bar and the composer are two different obstacles: the bar reserves nothing and each
 * surface clears it itself, while the composer is lifted above the bar inside the session screen.
 * A floating app-shell companion (the Voice orb) is outside both and can only see them if they are
 * published here, so this stays a distinct value — folding it into `bottomChromeHeight` would make
 * every existing consumer reserve the composer's height a second time.
 */
const SessionCockpitComposerChromeHeightContext = React.createContext(0);
const SessionCockpitComposerChromeReporterContext = React.createContext<SessionCockpitComposerChromeReporter>(NOOP_REPORT_COMPOSER_CHROME);
const SessionCockpitDismissingSessionIdContext = React.createContext<string | null>(null);
const SessionCockpitDismissControllerContext = React.createContext<SessionCockpitDismissController>(NOOP_DISMISS_CONTROLLER);

export function SessionCockpitChromeRegistryProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [bottomChromeHeight, setBottomChromeHeightState] = React.useState(0);
    const [floatingBottomChromeHeight, setFloatingBottomChromeHeight] = React.useState(0);
    const [composerChromeHeightById, setComposerChromeHeightById] = React.useState<Readonly<Record<string, number>>>({});
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
                && currentRegistration.serverId === nextRegistration.serverId
                && currentRegistration.activeSurface === nextRegistration.activeSurface
                && currentRegistration.terminalTabAvailable === nextRegistration.terminalTabAvailable
                && currentRegistration.openDetailsTabCount === nextRegistration.openDetailsTabCount
                && currentRegistration.pluginPlacements === nextRegistration.pluginPlacements
                && currentRegistration.projectionGeneration === nextRegistration.projectionGeneration
            ) {
                return currentRegistration;
            }

            return {
                sessionId: nextRegistration.sessionId,
                serverId: nextRegistration.serverId,
                activeSurface: nextRegistration.activeSurface,
                terminalTabAvailable: nextRegistration.terminalTabAvailable,
                openDetailsTabCount: nextRegistration.openDetailsTabCount,
                pluginPlacements: nextRegistration.pluginPlacements,
                projectionGeneration: nextRegistration.projectionGeneration,
                switchSurface: (surface) => {
                    const latest = latestRegistrationRef.current;
                    if (latest?.sessionId !== nextRegistration.sessionId || latest.serverId !== nextRegistration.serverId) return;
                    latest.switchSurface(surface);
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

    // Keyed by reporter, not a single slot: two composers are mounted at once while one session
    // slides out and the next slides in, and a single slot would let the outgoing screen's unmount
    // publish `0` over the incoming screen's real height.
    const reportComposerChromeHeight = React.useCallback((id: string, height: number | null) => {
        setComposerChromeHeightById((current) => {
            if (height === null) {
                if (!(id in current)) return current;
                const next = { ...current };
                delete next[id];
                return next;
            }
            const nextHeight = Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
            if (current[id] === nextHeight) return current;
            return { ...current, [id]: nextHeight };
        });
    }, []);

    const composerChromeHeight = React.useMemo(() => {
        let tallest = 0;
        for (const height of Object.values(composerChromeHeightById)) {
            if (height > tallest) tallest = height;
        }
        return tallest;
    }, [composerChromeHeightById]);

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
                    <SessionCockpitFloatingBottomChromeReporterContext.Provider value={setFloatingBottomChromeHeight}>
                        <SessionCockpitFloatingBottomChromeHeightContext.Provider value={floatingBottomChromeHeight}>
                            <SessionCockpitComposerChromeReporterContext.Provider value={reportComposerChromeHeight}>
                                <SessionCockpitComposerChromeHeightContext.Provider value={composerChromeHeight}>
                                    <SessionCockpitDismissControllerContext.Provider value={dismissController}>
                                        <SessionCockpitDismissingSessionIdContext.Provider value={dismissingSessionId}>
                                            <SessionCockpitChromeRegistrationContext.Provider value={registration}>
                                                {props.children}
                                            </SessionCockpitChromeRegistrationContext.Provider>
                                        </SessionCockpitDismissingSessionIdContext.Provider>
                                    </SessionCockpitDismissControllerContext.Provider>
                                </SessionCockpitComposerChromeHeightContext.Provider>
                            </SessionCockpitComposerChromeReporterContext.Provider>
                        </SessionCockpitFloatingBottomChromeHeightContext.Provider>
                    </SessionCockpitFloatingBottomChromeReporterContext.Provider>
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

/** Composer reservation; content lists still consume the bar alone. */
export function useSessionCockpitComposerBottomChromeHeight(): number {
    return useSessionCockpitBottomChromeHeight() + React.useContext(SessionCockpitFloatingBottomChromeHeightContext);
}

/** The shell withdraws its measured floating band on suppression, container change or unmount. */
export function useReportSessionCockpitFloatingBottomChromeHeight(enabled: boolean): (height: number) => void {
    const report = React.useContext(SessionCockpitFloatingBottomChromeReporterContext);
    React.useEffect(() => {
        if (!enabled) report(0);
        return () => report(0);
    }, [enabled, report]);
    return React.useCallback((height: number) => {
        if (enabled) report(Number.isFinite(height) ? Math.max(0, height) : 0);
    }, [enabled, report]);
}

/**
 * Height of the tallest composer band currently floating above the bottom chrome, for overlays that
 * live outside the session screen and therefore cannot see it any other way.
 */
export function useSessionCockpitComposerChromeHeight(): number {
    return React.useContext(SessionCockpitComposerChromeHeightContext);
}

/**
 * Publishes one composer's measured band height to the shell, and withdraws it on unmount.
 *
 * `enabled` is the caller's own answer to "is this a bottom-anchored app-shell composer": a composer
 * inside a modal is covered by the modal itself and must not push shell overlays around.
 */
export function useReportSessionCockpitComposerChromeHeight(enabled: boolean): (height: number) => void {
    const id = React.useId();
    const report = React.useContext(SessionCockpitComposerChromeReporterContext);

    React.useEffect(() => {
        if (enabled) return;
        report(id, null);
    }, [enabled, id, report]);

    React.useEffect(() => () => {
        report(id, null);
    }, [id, report]);

    return React.useCallback((height: number) => {
        if (!enabled) return;
        report(id, height);
    }, [enabled, id, report]);
}

export function useSessionCockpitDismissController(): SessionCockpitDismissController {
    return React.useContext(SessionCockpitDismissControllerContext);
}

export function useSessionCockpitDismissingSessionId(): string | null {
    return React.useContext(SessionCockpitDismissingSessionIdContext);
}

/** The live switcher shared values. The bar's gesture writes them; the panel and the session content read them. */
export function useSessionSwitcherState(): SessionSwitcherSharedState {
    return getSessionSwitcherState();
}
