import * as React from 'react';

type PluginSurfaceFocusEligibility = Readonly<{
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

function useProvidedPresentationSignal(presented: boolean): LayoutPresentationSignal {
    const [signal] = React.useState(() => {
        let current = presented;
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
    React.useLayoutEffect(() => signal.set(presented), [presented, signal]);
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
    const signal = useProvidedPresentationSignal(value?.presentationEffective ?? true);
    return <PluginSurfaceFocusEligibilityContext.Provider value={value}>
        <LayoutPresentationSignalContext.Provider value={signal}>{props.children}</LayoutPresentationSignalContext.Provider>
    </PluginSurfaceFocusEligibilityContext.Provider>;
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

    const signal = useProvidedPresentationSignal(value.presentationEffective);
    return (
        <PluginSurfaceFocusEligibilityContext.Provider value={value}>
            <LayoutPresentationSignalContext.Provider value={signal}>{props.children}</LayoutPresentationSignalContext.Provider>
        </PluginSurfaceFocusEligibilityContext.Provider>
    );
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

/** {@link useLayoutPresentationActive} as a subscription: a hide or show does not render the reader. */
export function useLayoutPresentationSignal(): LayoutPresentationSignal {
    return React.useContext(LayoutPresentationSignalContext);
}

/**
 * `value` as this subtree last presented it. While a retained surface is hidden its consumers keep what
 * they last showed (built bodies, measured props), so a hide does no teardown and a show rebuilds
 * nothing; the current value flows in on the render that presents the surface again. Live demand still
 * withdraws through `useLayoutPresentationActive`, which this does not touch.
 */
export function usePresentedValue<T>(value: T): T {
    const presented = useLayoutPresentationActive();
    const presentedValue = React.useRef(value);
    if (presented) presentedValue.current = value;
    return presentedValue.current;
}
