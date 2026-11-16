import * as React from 'react';

export type PluginSurfaceFocusEligibility = Readonly<{
    effective: boolean;
    currentUiContextEffective: boolean;
    presentationEffective: boolean;
}>;

// The absence of a provider means there is no proven presentation owner for a
// mounted plugin surface. A provider root starts from the neutral `true` so
// every nested owner can contribute its own active fact, while consumers still
// fail closed when no owner supplied any fact at all.
const PluginSurfaceFocusEligibilityContext = React.createContext<PluginSurfaceFocusEligibility | null>(null);

/**
 * The same presentation fact as a stable subscription, for work that only starts or stops with it (a
 * listener, a watch) and draws nothing from it: reading it never renders the reader when a retained
 * surface hides or shows. Each provider publishes its own `presentationEffective` here after commit.
 */
export type LayoutPresentationSignal = Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;
const ALWAYS_PRESENTED: LayoutPresentationSignal = Object.freeze({ get: () => true, subscribe: () => () => {} });
const LayoutPresentationSignalContext = React.createContext<LayoutPresentationSignal>(ALWAYS_PRESENTED);
/**
 * The facts as the nearest provider last committed them: read when acting, or followed by subscription
 * (it notifies after the provider commits new facts). Reading it never renders the reader.
 */
type FocusEligibilityStore = Readonly<{
    read: () => PluginSurfaceFocusEligibility | null;
    subscribe: (listener: () => void) => () => void;
}>;
const NO_ELIGIBILITY_OWNER: FocusEligibilityStore = Object.freeze({ read: () => null, subscribe: () => () => {} });
const FocusEligibilityStoreContext = React.createContext<FocusEligibilityStore>(NO_ELIGIBILITY_OWNER);

function useProvidedEligibilityStore(value: PluginSurfaceFocusEligibility | null): FocusEligibilityStore {
    const [store] = React.useState(() => {
        let current = value;
        const listeners = new Set<() => void>();
        return {
            read: () => current,
            subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            set: (next: PluginSurfaceFocusEligibility | null) => {
                if (next === current) return;
                current = next;
                for (const listener of [...listeners]) listener();
            },
        };
    });
    React.useLayoutEffect(() => store.set(value), [store, value]);
    return store;
}

/** One provider's facts: the value, its presentation signal and its call-time reader (hooks run in the provider). */
function useEligibilityProviders(value: PluginSurfaceFocusEligibility | null, presented: boolean, children: React.ReactNode): React.ReactElement {
    const signal = useBooleanSignal(presented);
    const store = useProvidedEligibilityStore(value);
    return <PluginSurfaceFocusEligibilityContext.Provider value={value}>
        <LayoutPresentationSignalContext.Provider value={signal}>
            <FocusEligibilityStoreContext.Provider value={store}>{children}</FocusEligibilityStoreContext.Provider>
        </LayoutPresentationSignalContext.Provider>
    </PluginSurfaceFocusEligibilityContext.Provider>;
}

/**
 * A stable signal that follows `value` after each commit. Its owner renders with the value; readers of the
 * signal do not.
 */
export function useBooleanSignal(value: boolean): LayoutPresentationSignal {
    const [signal] = React.useState(() => {
        let current = value;
        const listeners = new Set<() => void>();
        return {
            get: () => current,
            subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            set: (next: boolean) => {
                if (next === current) return;
                current = next;
                for (const listener of [...listeners]) listener();
            },
        };
    });
    React.useLayoutEffect(() => signal.set(value), [value, signal]);
    return signal;
}

function RetainedFocusEligibility(props: Readonly<{
    captured: PluginSurfaceFocusEligibility | null;
    children: React.ReactNode;
}>): React.ReactElement {
    const slot = React.useContext(PluginSurfaceFocusEligibilityContext);
    const presented = slot?.presentationEffective ?? true;
    const value = React.useMemo(() => props.captured ? Object.freeze({
        effective: props.captured.effective && presented,
        presentationEffective: props.captured.presentationEffective && presented,
        currentUiContextEffective: props.captured.currentUiContextEffective && presented,
    }) : slot, [presented, props.captured, slot]);
    return useEligibilityProviders(value, value?.presentationEffective ?? true, props.children);
}

/** A shell's facts as its subtree reads them, for a body rendered away from that shell. */
export function useCapturedPluginSurfaceFocusEligibility(): PluginSurfaceFocusEligibility | null {
    return React.useContext(PluginSurfaceFocusEligibilityContext);
}

/**
 * A body its page keeps mounted while it moves between shells (a docked pane, the phone's dialog). It is
 * focused where its current shell lets it be, but it is presented as long as its page is: the shell it
 * leaves withdraws before the next one mounts, and that hand-off must not read as the page going away
 * (it would close the body's open popovers and operations).
 */
export function PluginSurfaceFocusEligibilityTransfer(props: Readonly<{
    captured: PluginSurfaceFocusEligibility | null;
    children: React.ReactNode;
}>): React.ReactElement {
    const page = React.useContext(PluginSurfaceFocusEligibilityContext);
    const presented = page?.presentationEffective ?? true;
    const value = React.useMemo(() => props.captured ? Object.freeze({
        effective: props.captured.effective && presented,
        currentUiContextEffective: props.captured.currentUiContextEffective && presented,
        presentationEffective: presented,
    }) : page, [page, presented, props.captured]);
    return useEligibilityProviders(value, presented, props.children);
}

/**
 * {@link useRetainedPluginSurfaceFocusNode} for a node built when acting (opening a dialog): it reads the
 * facts at that moment, so a host that only opens such nodes does not render when they change.
 */
export function useRetainedPluginSurfaceFocusNodeFactory(): (children: React.ReactNode) => React.ReactElement {
    const store = React.useContext(FocusEligibilityStoreContext);
    return React.useCallback((children: React.ReactNode) => <RetainedFocusEligibility captured={store.read()}>{children}</RetainedFocusEligibility>,
        [store]);
}

/** Transfer the existing layout's facts into its portal; parking can only withdraw them. */
export function useRetainedPluginSurfaceFocusNode(children: React.ReactNode): React.ReactElement {
    const captured = React.useContext(PluginSurfaceFocusEligibilityContext);
    return React.useMemo(() => <RetainedFocusEligibility captured={captured}>{children}</RetainedFocusEligibility>,
        [captured, children]);
}

/**
 * App-private composition boundary for layout and route activity. It is not
 * navigation state and does not cross the Plugin UI SDK seam.
 */
export function PluginSurfaceFocusEligibilityProvider(props: Readonly<{
    active: boolean;
    /** Visible panes may keep presentation work active without owning keyboard focus. */
    presentationActive?: boolean;
    /**
     * A named layout or route owner may opt this subtree into semantic current
     * context. Presentation focus alone is not enough: several pane surfaces
     * can be visible at once and must not compete for one current record.
     */
    currentUiContextActive?: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const parent = React.useContext(PluginSurfaceFocusEligibilityContext);
    const value = React.useMemo<PluginSurfaceFocusEligibility>(() => {
        const effective = (parent?.effective ?? true) && props.active;
        const presentationEffective = (parent?.presentationEffective ?? true) && (props.presentationActive ?? props.active);
        // A presented page can remain the semantic owner while its own details
        // overlay takes input. Only an explicit semantic fact separates those
        // roles; unnamed roots and withdrawn ancestors still withhold context.
        const currentUiContextEffective = presentationEffective && (parent === null
            ? props.currentUiContextActive === true
            : parent.currentUiContextEffective && (props.currentUiContextActive ?? props.active));
        return Object.freeze({ effective, currentUiContextEffective, presentationEffective });
    }, [parent, props.active, props.currentUiContextActive, props.presentationActive]);

    return useEligibilityProviders(value, value.presentationEffective, props.children);
}

/** A plugin surface may receive focus only when an existing owner supplied it. */
export function usePluginSurfaceFocusEligibility(): boolean {
    return React.useContext(PluginSurfaceFocusEligibilityContext)?.effective === true;
}

/**
 * A semantic current-context publisher may contribute only when the existing
 * layout hierarchy names this subtree as its one current owner.
 */
export function usePluginSurfaceCurrentUiContextEligibility(): boolean {
    return React.useContext(PluginSurfaceFocusEligibilityContext)?.currentUiContextEffective === true;
}

/**
 * Whether this subtree is being presented right now, for presentation-only work (status pulses,
 * countdown ticks). A retained pane that is hidden says `false` through its provider; a subtree with
 * no layout owner is presented as far as anyone knows, so this reads `true` there. Motion must not
 * freeze app-wide for want of a provider, which is why it does not fail closed like focus does.
 */
export function useLayoutPresentationActive(): boolean {
    return React.useContext(PluginSurfaceFocusEligibilityContext)?.presentationEffective ?? true;
}

/**
 * {@link usePluginSurfaceFocusEligibility} as a subscription, for work that only starts or stops with focus
 * eligibility (a registration, a seed hand-off): a tab switch or a pane focus move does not render the reader.
 */
export function usePluginSurfaceFocusEligibilitySignal(): LayoutPresentationSignal {
    const store = React.useContext(FocusEligibilityStoreContext);
    // Fails closed like `usePluginSurfaceFocusEligibility`: no provider, no proven owner.
    return React.useMemo(() => ({ get: () => store.read()?.effective === true, subscribe: store.subscribe }), [store]);
}

/**
 * The layout's facts as a subscription (`read` when acting, `subscribe` to follow them): for work that
 * registers or gates on a fact other than focus (semantic current context) without rendering on a change.
 */
export function usePluginSurfaceFocusEligibilityStore(): FocusEligibilityStore {
    return React.useContext(FocusEligibilityStoreContext);
}

/** {@link useLayoutPresentationActive} as a subscription: a hide or show does not render the reader. */
export function useLayoutPresentationSignal(): LayoutPresentationSignal {
    return React.useContext(LayoutPresentationSignalContext);
}

type BooleanSignal = Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;

/**
 * True while every signal is; it notifies on any of their changes (followSignal ignores repeats). Its
 * listeners share one subscription to each source, held only while someone listens.
 */
export function allSignals(...signals: readonly BooleanSignal[]): BooleanSignal {
    const listeners = new Set<() => void>();
    let unsubscribeSources: (() => void) | null = null;
    const notify = () => { for (const listener of [...listeners]) listener(); };
    return {
        get: () => signals.every(signal => signal.get()),
        subscribe: (listener) => {
            listeners.add(listener);
            if (!unsubscribeSources) {
                const unsubscribes = signals.map(signal => signal.subscribe(notify));
                unsubscribeSources = () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
            }
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0 && unsubscribeSources) {
                    unsubscribeSources();
                    unsubscribeSources = null;
                }
            };
        },
    };
}

/**
 * Runs `start` with the signal's value now and again each time the value changes, ending the previous
 * run first; returns the cleanup. Call it from an effect so work follows presentation or focus without
 * rendering its owner.
 */
export function followSignal<T>(
    signal: Readonly<{ get: () => T; subscribe: (listener: () => void) => () => void }>,
    start: (value: T) => void | (() => void),
): () => void {
    let current = signal.get();
    let stop = start(current);
    const unsubscribe = signal.subscribe(() => {
        const next = signal.get();
        if (Object.is(next, current)) return;
        current = next;
        stop?.();
        stop = start(next);
    });
    return () => { unsubscribe(); stop?.(); };
}

/**
 * `value` as this subtree last presented it. While a retained surface is hidden its consumers keep what
 * they last showed (built bodies, measured props), so a hide does no teardown and a show rebuilds
 * nothing; the current value flows in on the render that presents the surface again. Live demand still
 * withdraws through `useLayoutPresentationActive`, which this does not touch.
 */
export function usePresentedValue<T>(value: T): T {
    // Presentation is read by subscription: a hide, or a show with nothing new to present, renders nothing
    // here. Only a value that changed while hidden asks for the render that presents it.
    const presentation = useLayoutPresentationSignal();
    const presentedValue = React.useRef(value);
    if (presentation.get()) presentedValue.current = value;
    const pending = presentedValue.current !== value;
    const [, presentPending] = React.useReducer((count: number) => count + 1, 0);
    React.useEffect(() => {
        if (!pending) return undefined;
        const unsubscribe = presentation.subscribe(() => { if (presentation.get()) presentPending(); });
        if (presentation.get()) presentPending();
        return unsubscribe;
    }, [pending, presentation]);
    return presentedValue.current;
}
