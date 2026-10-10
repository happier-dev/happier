import * as React from 'react';
import * as ReactNavigationNative from '@react-navigation/native';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';

/**
 * A route's stack-header actions (`headerLeft`/`headerRight`) while its stack header is not drawn:
 * inside the desktop app shell a page draws no stack header (`createHeader`), so the actions a route
 * put there move into the page's own header (`PageHeader`) instead of being lost. The header publishes
 * them by route key; the page's header claims and renders them. A page with no page header keeps a
 * slim actions-only bar from the stack header, so no route loses an action.
 *
 * A pane that would otherwise draw a bar of its own above what it shows (a Details group showing one
 * tab, the Inbox's detail) lends its controls the same way through a {@link HeaderActionsScope}: the
 * shown content's header (`PageHeader`, `DetailsTabHeader`) claims and draws them, and the pane keeps
 * its own bar only while nothing claimed them (lab `session-D`, `inbox-I1`).
 */
/** `claimants` in claim order: the first draws the actions, so two headers never both draw them. */
type Entry = Readonly<{ render: () => React.ReactNode; claimants: readonly object[] }>;

type RouteIdentity = Readonly<{ key?: string }> | undefined;
const NO_ROUTE_CONTEXT = React.createContext<RouteIdentity>(undefined);
/**
 * The screen's route (React Navigation's own route context). A navigation boundary stub without it
 * leaves pages unkeyed, so they claim nothing.
 */
const RouteContext: React.Context<RouteIdentity> = (() => {
    try {
        return (ReactNavigationNative as unknown as { NavigationRouteContext?: React.Context<RouteIdentity> }).NavigationRouteContext
            ?? NO_ROUTE_CONTEXT;
    } catch {
        return NO_ROUTE_CONTEXT;
    }
})();

const entries = new Map<string, Entry>();
const NO_ACTIONS = () => null;
const listeners = new Set<() => void>();
function emit() {
    for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Publishes the actions of the route whose stack header is hidden; `null` withdraws them. */
export function useStackHeaderActionsPublisher(routeKey: string, render: (() => React.ReactNode) | null) {
    // A scope resolves before paint, so its pane never shows a bar that the content then takes over.
    useClaimEffect(() => {
        if (!render) return undefined;
        entries.set(routeKey, { render, claimants: entries.get(routeKey)?.claimants ?? [] });
        emit();
        return () => {
            const current = entries.get(routeKey);
            if (current?.render === render) {
                if (current.claimants.length > 0) entries.set(routeKey, { render: NO_ACTIONS, claimants: current.claimants });
                else entries.delete(routeKey);
                emit();
            }
        };
    }, [render, routeKey]);
}

/** Whether a page header on this route has taken its actions (the stack header then draws nothing). */
export function useStackHeaderActionsClaimed(routeKey: string): boolean {
    return React.useSyncExternalStore(subscribe, () => (entries.get(routeKey)?.claimants.length ?? 0) > 0, () => false);
}

const useClaimEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

/**
 * `undefined`: no pane lends actions here, so a page header falls back to its route. `null`: a pane
 * is in charge and lends nothing (several tabs share its strip). A string: the pane's claim key.
 */
const HeaderActionsScopeContext = React.createContext<string | null | undefined>(undefined);

/** A pane that lends its controls to the header of what it shows; pair it with the publisher hooks above. */
export function HeaderActionsScope(props: Readonly<{ scopeKey: string | null; children: React.ReactNode }>) {
    return <HeaderActionsScopeContext.Provider value={props.scopeKey}>{props.children}</HeaderActionsScopeContext.Provider>;
}

/**
 * The page header's side: claims the route's stack-header actions, or the enclosing pane's lent
 * controls, and returns them to render. `scopeOnly` headers (a Details tab's) never take a route's.
 */
export function useClaimedStackHeaderActions(options?: Readonly<{ scopeOnly?: boolean }>): React.ReactNode {
    const route = React.useContext(RouteContext);
    const scopeKey = React.useContext(HeaderActionsScopeContext);
    const hosted = useDestinationInstanceKey() !== null;
    // Hosted pages own their actions; the inherited Expo context belongs to a retained route.
    const routeKey = scopeKey !== undefined
        ? scopeKey
        : hosted || options?.scopeOnly ? null : route?.key ?? null;
    const [claimant] = React.useState(() => ({}));
    useClaimEffect(() => {
        if (!routeKey) return undefined;
        const current = entries.get(routeKey);
        entries.set(routeKey, { render: current?.render ?? NO_ACTIONS, claimants: [...(current?.claimants ?? []), claimant] });
        emit();
        return () => {
            const latest = entries.get(routeKey);
            if (!latest) return;
            const claimants = latest.claimants.filter((entry) => entry !== claimant);
            if (claimants.length === 0 && latest.render === NO_ACTIONS) entries.delete(routeKey);
            else entries.set(routeKey, { render: latest.render, claimants });
            emit();
        };
    }, [claimant, routeKey]);
    const render = React.useSyncExternalStore(
        subscribe,
        () => {
            const entry = routeKey ? entries.get(routeKey) : undefined;
            return entry && entry.claimants[0] === claimant ? entry.render : null;
        },
        () => null,
    );
    return render ? render() : null;
}
