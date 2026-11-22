import * as React from 'react';

import { AppPaneContext, type AppPaneContextSubscription } from '@/components/appShell/panes/AppPaneContext';
import { findSelectedPaneSlot, isSelectedPaneDestinationTabKey } from '@/components/appShell/panes/model/selectedPaneDestination';
import { useRetainedPresentationEntryRetirement } from '@/components/ui/presentation/retainedPresentationEntryLifetime';

type DetailsTabBinding = Readonly<{
    pane: AppPaneContextSubscription;
    scopeId: string;
    tabKey: string | null;
}>;

const DetailsTabLifetimeContext = React.createContext<DetailsTabBinding | null>(null);
const subscribeToNothing = () => () => {};

export function detailsTabNavigationKey(scopeId: string, tabKey: string): string {
    return JSON.stringify(['details', scopeId, tabKey]);
}

/** The mounted tab supplies the exact pane identity to its existing departure guard. */
export function useDetailsTabNavigationKey(fallbackTabKey: string): string {
    const binding = React.useContext(DetailsTabLifetimeContext);
    return binding?.tabKey ? detailsTabNavigationKey(binding.scopeId, binding.tabKey) : fallbackTabKey;
}

/** The tab's canonical membership survives a temporary presentation/route unmount. */
export function DetailsTabLifetimeScope(props: React.PropsWithChildren<Readonly<{
    scopeId: string;
    tabKey: string;
}>>): React.ReactElement {
    const pane = React.useContext(AppPaneContext);
    const binding = React.useMemo(() => pane ? { pane, scopeId: props.scopeId, tabKey: props.tabKey } : null,
        [pane, props.scopeId, props.tabKey]);
    return <DetailsTabLifetimeContext.Provider value={binding}>{props.children}</DetailsTabLifetimeContext.Provider>;
}

/** A surface always carries membership, including presenters without the workspace chrome.
 * Controlled destinations retain their incumbent selected-slot membership. */
export function DetailsSurfaceTabLifetimeScope(props: React.PropsWithChildren<Readonly<{
    scopeId: string;
    tabKey: string | null;
}>>): React.ReactElement {
    const incumbent = React.useContext(DetailsTabLifetimeContext);
    const pane = React.useContext(AppPaneContext);
    const binding = React.useMemo(() => incumbent ?? (pane ? { pane, scopeId: props.scopeId, tabKey: props.tabKey } : null),
        [incumbent, pane, props.scopeId, props.tabKey]);
    return <DetailsTabLifetimeContext.Provider value={binding}>{props.children}</DetailsTabLifetimeContext.Provider>;
}

function RetainedDetailsTab(props: React.PropsWithChildren<Readonly<{
    binding: DetailsTabBinding | null;
}>>): React.ReactElement {
    const { binding } = props;
    const retire = useRetainedPresentationEntryRetirement();
    const readMembership = React.useCallback(() => {
        if (!binding) return true;
        const scopes = binding.pane.getSnapshot().state.scopes;
        const scope = Object.hasOwn(scopes, binding.scopeId) ? scopes[binding.scopeId] : undefined;
        // An empty-group presentation has no stored tab. Its lifetime ends when the
        // first real tab replaces it, rather than immediately on its initial absence.
        if (binding.tabKey === null) return !scope || Object.keys(scope.details.tabsByKey).length === 0;
        return scope !== undefined && (isSelectedPaneDestinationTabKey(binding.tabKey)
            ? findSelectedPaneSlot(scope, binding.tabKey) !== null
            : Object.hasOwn(scope.details.tabsByKey, binding.tabKey));
    }, [binding]);
    // Subscribe to one boolean from the existing pane owner, not all tab state. Hide, focus,
    // group moves and route handoff do not remove membership; tab/group removal does.
    const present = React.useSyncExternalStore(binding?.pane.subscribe ?? subscribeToNothing, readMembership, readMembership);
    React.useLayoutEffect(() => {
        if (!present) retire?.();
    }, [present, retire]);
    return <DetailsTabLifetimeContext.Provider value={binding}>
        {props.children}
    </DetailsTabLifetimeContext.Provider>;
}

/** Carry the incumbent Details lifetime into the existing retained portal, without another registry. */
export function useRetainedDetailsTabNode(
    node: React.ReactNode,
): React.ReactNode {
    const binding = React.useContext(DetailsTabLifetimeContext);
    // Keep the same component topology when a source moves between Details and another presenter.
    return React.useMemo(() => <RetainedDetailsTab binding={binding}>{node}</RetainedDetailsTab>, [binding, node]);
}
