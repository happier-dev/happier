import * as React from 'react';
import * as ReactNavigationNative from '@react-navigation/native';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/destinationInstanceContext';
import type { IconName } from '@/components/ui/icons/Icon';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';

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
 *
 * A pane can lend menu rows with them: what its own bar offered that has no control of its own (a phone
 * Details group's other pages, pin, close). The header that draws the lent controls draws those rows in a
 * `⋯`, unless it has a `⋯` of its own and puts them there (`drawsMenuRows`, {@link useLentHeaderMenuRows}).
 */
/** One row a pane lends to the header of what it shows, drawn in that header's `⋯`. */
export type LentHeaderMenuRow = Readonly<{ id: string; title: string; testID: string; iconName: IconName; disabled?: boolean; onSelect: () => void }>;

/**
 * A hosted page's primary, lent to the header above it as data: the header draws it as its own `+`, named by
 * `title`, pressing `onPress` or opening `menu` when the action needs one choice first (Run workflow).
 */
export type LentHeaderPrimary = Readonly<{ title: string; disabled?: boolean } & (
    | { onPress: () => void; menu?: undefined }
    | { menu: readonly LentHeaderMenuRow[]; onPress?: undefined }
)>;

/** `claimants` in claim order: the first draws the actions, so two headers never both draw them. */
type Entry = Readonly<{ render: () => React.ReactNode; menuRows: readonly LentHeaderMenuRow[] | null;
    primary?: LentHeaderPrimary | null; claimants: readonly object[] }>;

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

/** Publishes the actions of the route whose stack header is hidden (and a pane's lent menu rows); `null` withdraws them. */
export function useStackHeaderActionsPublisher(routeKey: string, render: (() => React.ReactNode) | null,
    menuRows: readonly LentHeaderMenuRow[] | null = null, primary: LentHeaderPrimary | null = null) {
    // A scope resolves before paint, so its pane never shows a bar that the content then takes over.
    useClaimEffect(() => {
        if (!render) return undefined;
        const published = { render, menuRows, primary };
        entries.set(routeKey, { ...published, claimants: entries.get(routeKey)?.claimants ?? [] });
        emit();
        return () => {
            const current = entries.get(routeKey);
            if (current?.render === render && current.menuRows === menuRows && (current.primary ?? null) === primary) {
                if (current.claimants.length > 0) entries.set(routeKey, { render: NO_ACTIONS, menuRows: null, claimants: current.claimants });
                else entries.delete(routeKey);
                emit();
            }
        };
    }, [menuRows, primary, render, routeKey]);
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

/**
 * The scope an enclosing pane lends its controls through (`undefined` when none does). A destination
 * hosted inside such a pane passes it on when its route has no actions of its own, so the page's header
 * still draws the pane's controls rather than leaving them on a bar above it.
 */
export function useEnclosingHeaderActionsScope(): string | null | undefined {
    return React.useContext(HeaderActionsScopeContext);
}

/** The menu rows the enclosing pane lends with its controls, for a header that draws them in its own `⋯`; null when none. */
export function useLentHeaderMenuRows(options?: Readonly<{ claimKey: string | null }>): readonly LentHeaderMenuRow[] | null {
    const contextKey = React.useContext(HeaderActionsScopeContext);
    const scopeKey = options === undefined ? contextKey : options.claimKey;
    return React.useSyncExternalStore(subscribe, () => (scopeKey ? entries.get(scopeKey)?.menuRows ?? null : null), () => null);
}

/**
 * The other direction: a header that stands above the pages it hosts (a Project's header over its plugin
 * tab) claims what the shown page lends, its primary and its `⋯` rows, so the page draws neither in its own
 * row and the header has one `+` and one `⋯`. The header claims by this key (`claimKey`); the page lends
 * through `usePageActionsLendKey`. A page with no claiming header draws its actions where it always did.
 */
const PageActionsLendContext = React.createContext<string | null>(null);

export function PageActionsLendScope(props: Readonly<{ scopeKey: string; children: React.ReactNode }>) {
    return <PageActionsLendContext.Provider value={props.scopeKey}>{props.children}</PageActionsLendContext.Provider>;
}

/** The key the enclosing header claims a hosted page's actions under; null where no header does. */
export function usePageActionsLendKey(): string | null {
    return React.useContext(PageActionsLendContext);
}

/** The primary the shown page lends to the header claiming `claimKey` (`PageActionsLendScope`); null when none. */
export function useLentHeaderPrimary(options: Readonly<{ claimKey: string | null }>): LentHeaderPrimary | null {
    const key = options.claimKey;
    return React.useSyncExternalStore(subscribe, () => (key ? entries.get(key)?.primary ?? null : null), () => null);
}

/** A pane that lends its controls to the header of what it shows; pair it with the publisher hooks above. */
export function HeaderActionsScope(props: Readonly<{ scopeKey: string | null; children: React.ReactNode }>) {
    return <HeaderActionsScopeContext.Provider value={props.scopeKey}>{props.children}</HeaderActionsScopeContext.Provider>;
}

/**
 * The page header's side: claims the route's stack-header actions, or the enclosing pane's lent
 * controls, and returns them to render. `scopeOnly` headers (a Details tab's) never take a route's.
 * `release` gives them back while the header cannot use them (it sits in a read-only snapshot), so
 * the route's own actions bar draws them instead. Lent menu rows come in a `⋯` after the controls, unless
 * the header puts them in its own `⋯` (`drawsMenuRows`), so a page never shows two.
 */
export function useClaimedStackHeaderActions(options?: Readonly<{ scopeOnly?: boolean; release?: boolean; drawsMenuRows?: boolean;
    /** Claim exactly this key (a header over its hosted pages, `PageActionsLendScope`); `null` claims nothing. */
    claimKey?: string | null }>): React.ReactNode {
    const route = React.useContext(RouteContext);
    const scopeKey = React.useContext(HeaderActionsScopeContext);
    const hosted = useDestinationInstanceKey() !== null;
    // Hosted pages own their actions; the inherited Expo context belongs to a retained route.
    const routeKey = options?.release ? null : options?.claimKey !== undefined ? options.claimKey : scopeKey !== undefined
        ? scopeKey
        : hosted || options?.scopeOnly ? null : route?.key ?? null;
    const [claimant] = React.useState(() => ({}));
    useClaimEffect(() => {
        if (!routeKey) return undefined;
        const current = entries.get(routeKey);
        entries.set(routeKey, { render: current?.render ?? NO_ACTIONS, menuRows: current?.menuRows ?? null, primary: current?.primary ?? null,
            claimants: [...(current?.claimants ?? []), claimant] });
        emit();
        return () => {
            const latest = entries.get(routeKey);
            if (!latest) return;
            const claimants = latest.claimants.filter((entry) => entry !== claimant);
            if (claimants.length === 0 && latest.render === NO_ACTIONS) entries.delete(routeKey);
            else entries.set(routeKey, { ...latest, claimants });
            emit();
        };
    }, [claimant, routeKey]);
    const entry = React.useSyncExternalStore(
        subscribe,
        () => {
            const current = routeKey ? entries.get(routeKey) : undefined;
            return current && current.claimants[0] === claimant ? current : null;
        },
        () => null,
    );
    if (!entry) return null;
    const actions = entry.render();
    const menuRows = options?.drawsMenuRows ? null : entry.menuRows;
    if (!menuRows || menuRows.length === 0) return actions;
    return <>{actions}<PageHeaderMenu testID="lent-header-menu" actions={menuRows} /></>;
}
