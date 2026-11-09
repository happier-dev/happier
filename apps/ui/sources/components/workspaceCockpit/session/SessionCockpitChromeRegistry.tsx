import * as React from 'react';
import type { ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { makeMutable, type SharedValue } from 'react-native-reanimated';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';

import type { SessionCockpitMobileCatalogEntry } from './sessionCockpitMobileCatalog';
import type { SessionMobileSurface } from './sessionCockpitState';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { ResolveRightSidebarTabsInput } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';

export type SessionCockpitChromeRegistration = Readonly<{
    sessionId: string;
    serverId?: string | null;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    readColumn: (column: 'main' | 'side') => ShellColumnActionOwner;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    /** The mounted Session's detail-list inputs, for Customize's other-device list. */
    detailInput?: ResolveRightSidebarTabsInput;
    /** `ownTab`: a phone opened the pane's Details page as its own rail tab, so the Session tab stays where it is. */
    switchSurface: (surface: SessionMobileSurface) => 'ownTab' | void;
}>;

type SessionCockpitChromeRegister = (registration: SessionCockpitChromeRegistration) => () => void;
type SessionCockpitBottomChromeHeightSetter = (height: number) => void;
type SessionCockpitComposerChromeMeasurement = Readonly<{ height: number; topFromBottom: number }>;
type SessionCockpitComposerChromeReporter = (id: string, measurement: SessionCockpitComposerChromeMeasurement | null) => void;

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
// The shell's floating band above the bar (the phone Voice Island, a docked New Session), measured independently of the
// bar: each producer reports its own height and the band is the tallest, since they float over the same edge.
type SessionCockpitFloatingBottomChromeReporter = (producer: string, height: number) => void;
const SessionCockpitFloatingBottomChromeHeightContext = React.createContext(0);
// The shell's own bar, which no subtree rebases: zero means this window has no bar (a desktop), so a page
// clears the floating band itself; under a bar a rebased subtree's screen already lifts content past the band.
const SessionCockpitShellBarHeightContext = React.createContext(0);
const SessionCockpitFloatingBottomChromeReporterContext = React.createContext<SessionCockpitFloatingBottomChromeReporter>(() => {});
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
/** Where that band starts: its measured top edge as a distance up from the window's bottom edge. */
const SessionCockpitComposerChromeTopContext = React.createContext(0);
const SessionCockpitComposerChromeReporterContext = React.createContext<SessionCockpitComposerChromeReporter>(NOOP_REPORT_COMPOSER_CHROME);
const SessionCockpitDismissingSessionIdContext = React.createContext<string | null>(null);
const SessionCockpitDismissControllerContext = React.createContext<SessionCockpitDismissController>(NOOP_DISMISS_CONTROLLER);

/** One mounted lifetime of a reporter; its identity retires that lifetime's late measurements. */
type MeasuredRectBinding = Readonly<Record<never, never>>;
type MountedMeasuredRect = Readonly<{ binding: MeasuredRectBinding; rect: FrameRect | null }>;
type MeasuredRectReporter = Readonly<{
    mount: (binding: MeasuredRectBinding) => () => void;
    report: (binding: MeasuredRectBinding, rect: FrameRect | null) => void;
}>;
const NOOP_MEASURED_RECT_REPORTER: MeasuredRectReporter = { mount: () => () => {}, report: () => {} };
const SessionCockpitPetRectContext = React.createContext<FrameRect | null>(null);
const SessionCockpitPetRectReporterContext = React.createContext(NOOP_MEASURED_RECT_REPORTER);
const SessionCockpitActionRailRectContext = React.createContext<FrameRect | null>(null);
const SessionCockpitActionRailRectReporterContext = React.createContext(NOOP_MEASURED_RECT_REPORTER);

/** A named mounted shell fact; the in-app pet and the pane action rail each have one slot. */
function useMountedMeasuredRect(): Readonly<{ rect: FrameRect | null; reporter: MeasuredRectReporter }> {
    const [mounted, setMounted] = React.useState<MountedMeasuredRect | null>(null);
    const mount = React.useCallback((binding: MeasuredRectBinding) => {
        setMounted((current) => current?.binding === binding ? current : { binding, rect: null });
        return () => {
            setMounted((current) => current?.binding === binding ? null : current);
        };
    }, []);
    const report = React.useCallback((binding: MeasuredRectBinding, rect: FrameRect | null) => {
        setMounted((current) => {
            if (current?.binding !== binding) return current;
            const previous = current.rect;
            if (previous === rect || (previous !== null && rect !== null
                && previous.x === rect.x && previous.y === rect.y && previous.width === rect.width && previous.height === rect.height)) return current;
            return { ...current, rect };
        });
    }, []);
    const reporter = React.useMemo(() => ({ mount, report }), [mount, report]);
    return { rect: mounted?.rect ?? null, reporter };
}

function useMountedMeasuredRectReporter(reporter: MeasuredRectReporter, enabled: boolean) {
    // The callback captures this mounted lifetime, rather than reading a latest ref: reopening
    // the same component must not give its retired asynchronous measurements authority again.
    const binding = React.useMemo<MeasuredRectBinding | null>(() => enabled ? {} : null, [enabled]);
    React.useEffect(() => {
        if (binding) return reporter.mount(binding);
    }, [binding, reporter]);
    return React.useCallback((rect: FrameRect | null) => {
        if (binding) reporter.report(binding, rect);
    }, [binding, reporter]);
}

function roundedNonNegative(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function SessionCockpitChromeRegistryProvider(props: Readonly<{ children: React.ReactNode }>) {
    const pet = useMountedMeasuredRect();
    const actionRail = useMountedMeasuredRect();
    const [bottomChromeHeight, setBottomChromeHeightState] = React.useState(0);
    const [floatingBottomChromeById, setFloatingBottomChromeById] = React.useState<Readonly<Record<string, number>>>({});
    const reportFloatingBottomChrome = React.useCallback<SessionCockpitFloatingBottomChromeReporter>((producer, height) => {
        setFloatingBottomChromeById((current) => {
            if ((current[producer] ?? 0) === height) return current;
            const next = { ...current };
            if (height > 0) next[producer] = height;
            else delete next[producer];
            return next;
        });
    }, []);
    const floatingBottomChromeHeight = React.useMemo(() => Math.max(0, ...Object.values(floatingBottomChromeById)), [floatingBottomChromeById]);
    const [composerChromeById, setComposerChromeById] = React.useState<Readonly<Record<string, SessionCockpitComposerChromeMeasurement>>>({});
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
                && currentRegistration.catalog === nextRegistration.catalog
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
                catalog: nextRegistration.catalog,
                readColumn: column => {
                    const latest = latestRegistrationRef.current;
                    return latest?.sessionId === nextRegistration.sessionId && latest.serverId === nextRegistration.serverId
                        ? latest.readColumn(column)
                        : { present: false, visible: false, available: false, setVisible: () => {} };
                },
                switchSurface: (surface) => {
                    const latest = latestRegistrationRef.current;
                    if (latest?.sessionId !== nextRegistration.sessionId || latest.serverId !== nextRegistration.serverId) return;
                    return latest.switchSurface(surface);
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
    const reportComposerChromeHeight = React.useCallback((id: string, measurement: SessionCockpitComposerChromeMeasurement | null) => {
        setComposerChromeById((current) => {
            if (measurement === null) {
                if (!(id in current)) return current;
                const next = { ...current };
                delete next[id];
                return next;
            }
            const height = roundedNonNegative(measurement.height);
            const topFromBottom = roundedNonNegative(measurement.topFromBottom);
            const previous = current[id];
            if (previous?.height === height && previous.topFromBottom === topFromBottom) return current;
            return { ...current, [id]: { height, topFromBottom } };
        });
    }, []);

    const composerChromeHeight = React.useMemo(() => {
        let tallest = 0;
        for (const { height } of Object.values(composerChromeById)) {
            if (height > tallest) tallest = height;
        }
        return tallest;
    }, [composerChromeById]);
    const composerChromeTop = React.useMemo(() => {
        let highest = 0;
        for (const { topFromBottom } of Object.values(composerChromeById)) {
            if (topFromBottom > highest) highest = topFromBottom;
        }
        return highest;
    }, [composerChromeById]);

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
                    <SessionCockpitFloatingBottomChromeReporterContext.Provider value={reportFloatingBottomChrome}>
                        <SessionCockpitFloatingBottomChromeHeightContext.Provider value={floatingBottomChromeHeight}>
                        <SessionCockpitShellBarHeightContext.Provider value={bottomChromeHeight}>
                            <SessionCockpitComposerChromeReporterContext.Provider value={reportComposerChromeHeight}>
                                <SessionCockpitComposerChromeHeightContext.Provider value={composerChromeHeight}>
                                <SessionCockpitComposerChromeTopContext.Provider value={composerChromeTop}>
                                    <SessionCockpitDismissControllerContext.Provider value={dismissController}>
                                        <SessionCockpitDismissingSessionIdContext.Provider value={dismissingSessionId}>
                                            <SessionCockpitChromeRegistrationContext.Provider value={registration}>
                                                <SessionCockpitPetRectReporterContext.Provider value={pet.reporter}>
                                                    <SessionCockpitPetRectContext.Provider value={pet.rect}>
                                                        <SessionCockpitActionRailRectReporterContext.Provider value={actionRail.reporter}>
                                                            <SessionCockpitActionRailRectContext.Provider value={actionRail.rect}>
                                                                {props.children}
                                                            </SessionCockpitActionRailRectContext.Provider>
                                                        </SessionCockpitActionRailRectReporterContext.Provider>
                                                    </SessionCockpitPetRectContext.Provider>
                                                </SessionCockpitPetRectReporterContext.Provider>
                                            </SessionCockpitChromeRegistrationContext.Provider>
                                        </SessionCockpitDismissingSessionIdContext.Provider>
                                    </SessionCockpitDismissControllerContext.Provider>
                                </SessionCockpitComposerChromeTopContext.Provider>
                                </SessionCockpitComposerChromeHeightContext.Provider>
                            </SessionCockpitComposerChromeReporterContext.Provider>
                        </SessionCockpitShellBarHeightContext.Provider>
                        </SessionCockpitFloatingBottomChromeHeightContext.Provider>
                    </SessionCockpitFloatingBottomChromeReporterContext.Provider>
                </SessionCockpitBottomChromeHeightContext.Provider>
            </SessionCockpitBottomChromeHeightSetterContext.Provider>
        </SessionCockpitChromeRegisterContext.Provider>
    );
}

/** In-app pet geometry only; an external desktop mascot window is a separate surface. */
export function useSessionCockpitPetRect(): FrameRect | null {
    return React.useContext(SessionCockpitPetRectContext);
}

export function useReportSessionCockpitPetRect(enabled: boolean): (rect: FrameRect | null) => void {
    return useMountedMeasuredRectReporter(React.useContext(SessionCockpitPetRectReporterContext), enabled);
}

/** The pane action rail's window rectangle (the session's tool rail): a floating companion keeps clear of it. */
export function useSessionCockpitActionRailRect(): FrameRect | null {
    return React.useContext(SessionCockpitActionRailRectContext);
}

export function useReportSessionCockpitActionRailRect(enabled: boolean): (rect: FrameRect | null) => void {
    return useMountedMeasuredRectReporter(React.useContext(SessionCockpitActionRailRectReporterContext), enabled);
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

/**
 * How far the shell's floating bottom chrome covers a scrolling page: the tab bar plus the docked
 * floating band above it (the phone Voice Island). Both float over content and reserve nothing
 * themselves, so a page clears them here. A subtree whose screen already rebased the bar to zero
 * (the session screen lifts its own composer by the band) clears nothing, so the band is never
 * reserved twice.
 */
export function useSessionCockpitPageBottomClearance(): number {
    const bar = useSessionCockpitBottomChromeHeight();
    const floating = React.useContext(SessionCockpitFloatingBottomChromeHeightContext);
    const shellBar = React.useContext(SessionCockpitShellBarHeightContext);
    if (bar > 0) return bar + floating;
    return shellBar === 0 ? floating : 0;
}

/** The shell withdraws its measured floating band on suppression, container change or unmount. */
export function useReportSessionCockpitFloatingBottomChromeHeight(enabled: boolean): (height: number) => void {
    const report = React.useContext(SessionCockpitFloatingBottomChromeReporterContext);
    const producer = React.useId();
    React.useEffect(() => {
        if (!enabled) report(producer, 0);
        return () => report(producer, 0);
    }, [enabled, producer, report]);
    return React.useCallback((height: number) => {
        if (enabled) report(producer, Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0);
    }, [enabled, producer, report]);
}

/**
 * Height of the tallest composer band currently floating above the bottom chrome, for overlays that
 * live outside the session screen and therefore cannot see it any other way.
 */
export function useSessionCockpitComposerChromeHeight(): number {
    return React.useContext(SessionCockpitComposerChromeHeightContext);
}

/**
 * Where the highest composer band starts, as a distance up from the window's bottom edge (0 when
 * none reported one). Window-space overlays need it: on desktop the workspace frame lifts the band
 * off the window edge, so its height alone does not say where it is.
 */
export function useSessionCockpitComposerChromeTop(): number {
    return React.useContext(SessionCockpitComposerChromeTopContext);
}

/**
 * Publishes one composer's measured band to the shell — its height and, when the composer can
 * measure it, its top edge up from the window's bottom — and withdraws it on unmount.
 *
 * `enabled` is the caller's own answer to "is this a bottom-anchored app-shell composer": a composer
 * inside a modal is covered by the modal itself and must not push shell overlays around.
 */
export function useReportSessionCockpitComposerChromeHeight(enabled: boolean): (height: number | null, topFromBottom?: number) => void {
    const id = React.useId();
    const report = React.useContext(SessionCockpitComposerChromeReporterContext);

    React.useEffect(() => {
        if (enabled) return;
        report(id, null);
    }, [enabled, id, report]);

    React.useEffect(() => () => {
        report(id, null);
    }, [id, report]);

    // `null` withdraws a composer that is mounted but not rendered (a hidden workspace screen).
    return React.useCallback((height: number | null, topFromBottom?: number) => {
        if (!enabled) return;
        report(id, height === null ? null : { height, topFromBottom: topFromBottom ?? 0 });
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
