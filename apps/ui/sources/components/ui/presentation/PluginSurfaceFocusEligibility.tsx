import * as React from 'react';

type PluginSurfaceFocusEligibility = Readonly<{
    effective: boolean;
    currentUiContextEffective: boolean;
}>;

// The absence of a provider means there is no proven presentation owner for a
// mounted plugin surface. A provider root starts from the neutral `true` so
// every nested owner can contribute its own active fact, while consumers still
// fail closed when no owner supplied any fact at all.
const PluginSurfaceFocusEligibilityContext = React.createContext<PluginSurfaceFocusEligibility | null>(null);

/**
 * App-private composition boundary for layout and route activity. It is not
 * navigation state and does not cross the Plugin UI SDK seam.
 */
export function PluginSurfaceFocusEligibilityProvider(props: Readonly<{
    active: boolean;
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
        // A root must name its semantic-current owner explicitly. Nested
        // providers inherit only an already-proven owner and can still fence
        // themselves with `false`; this never turns simultaneous panes into a
        // last-publisher-wins selection mechanism.
        const currentUiContextEffective = effective && (parent === null
            ? props.currentUiContextActive === true
            : parent.currentUiContextEffective && (props.currentUiContextActive ?? true));
        return Object.freeze({ effective, currentUiContextEffective });
    }, [parent, props.active, props.currentUiContextActive]);

    return (
        <PluginSurfaceFocusEligibilityContext.Provider value={value}>
            {props.children}
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
