import * as React from 'react';

type PluginSurfaceFocusEligibility = Readonly<{
    effective: boolean;
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
    children: React.ReactNode;
}>): React.ReactElement {
    const parent = React.useContext(PluginSurfaceFocusEligibilityContext);
    const value = React.useMemo<PluginSurfaceFocusEligibility>(() => Object.freeze({
        effective: (parent?.effective ?? true) && props.active,
    }), [parent, props.active]);

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
