import * as React from 'react';
import { useGlobalSearchParams, usePathname, useSegments } from 'expo-router';
import { shallow } from 'zustand/shallow';
import { matchWorkspaceDestinationRoute } from './workspaceRoutes';

type RouteParams = Readonly<Record<string, string | string[] | undefined>>;
export type CurrentRouteLocation = Readonly<{ pathname: string; params: RouteParams }>;

/**
 * The workspace's current URL while Expo's mirror deliberately stays behind it (`/session/A` or `/machines`
 * while the browser shows `/session/B`). Null whenever Expo's location is current.
 */
type CurrentRouteLocationStore = Readonly<{ getSnapshot(): CurrentRouteLocation | null; subscribe(listener: () => void): () => void }>;
const CurrentRouteLocationStoreContext = React.createContext<CurrentRouteLocationStore | null>(null);

/**
 * The window's route owner for readers mounted above the workspace (app boot, root layout effects, shell
 * presentation): the mounted workspace publishes its location here, so they follow the same URL as readers
 * inside it. One workspace hosts a window's routes; with none mounted, Expo's location is current.
 */
const windowRouteLocation: { current: CurrentRouteLocation | null; owner: object | null; listeners: Set<() => void> } = {
    current: null, owner: null, listeners: new Set(),
};
const windowRouteLocationStore: CurrentRouteLocationStore = {
    getSnapshot: () => windowRouteLocation.current,
    subscribe(listener) {
        windowRouteLocation.listeners.add(listener);
        return () => { windowRouteLocation.listeners.delete(listener); };
    },
};
function publishWindowRouteLocation(owner: object | null, value: CurrentRouteLocation | null): void {
    windowRouteLocation.owner = owner;
    if (windowRouteLocation.current === value) return;
    windowRouteLocation.current = value;
    for (const listener of windowRouteLocation.listeners) listener();
}

/** Publishes the location both as a value and as a store that selectors subscribe to. */
export function CurrentRouteLocationProvider(props: React.PropsWithChildren<Readonly<{ value: CurrentRouteLocation | null }>>): React.ReactElement {
    const current = React.useRef(props.value);
    current.current = props.value;
    const [listeners] = React.useState(() => new Set<() => void>());
    const [store] = React.useState<CurrentRouteLocationStore>(() => ({
        getSnapshot: () => current.current,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }));
    React.useLayoutEffect(() => {
        for (const listener of listeners) listener();
        publishWindowRouteLocation(store, props.value);
    }, [listeners, props.value, store]);
    React.useLayoutEffect(() => () => {
        if (windowRouteLocation.owner === store) publishWindowRouteLocation(null, null);
    }, [store]);
    return <CurrentRouteLocationStoreContext.Provider value={store}>
        {props.children}
    </CurrentRouteLocationStoreContext.Provider>;
}

/** Expo's global params shape: the route's path params and query, repeated query keys as arrays. */
export function readCurrentRouteLocation(href: string, pathParams: Readonly<Record<string, string>>): CurrentRouteLocation {
    const url = new URL(href, 'https://route.invalid');
    // Expo publishes decoded segments; keep a malformed escape as written rather than failing the read.
    const pathname = url.pathname.split('/').map((segment) => {
        try { return decodeURIComponent(segment); } catch { return segment; }
    }).join('/');
    const params: Record<string, string | string[]> = { ...pathParams };
    for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        params[key] = values.length > 1 ? values : values[0]!;
    }
    return { pathname, params };
}

/** The current route's pathname: the workspace's URL when it leads Expo's mirror, else Expo's. */
export function useCurrentRoutePathname(): string {
    // The path alone: a query write (a Session side tab's `right=`) publishes a new location on the same path.
    // The workspace starting to lead Expo on the same path is not a change either.
    const store = React.useContext(CurrentRouteLocationStoreContext) ?? windowRouteLocationStore;
    const expoPathname = usePathname();
    const readPathname = React.useCallback(() => store.getSnapshot()?.pathname ?? expoPathname, [expoPathname, store]);
    return React.useSyncExternalStore(store.subscribe, readPathname, readPathname);
}

/** File-pattern segments from the same current location as the route params, never concrete path values. */
export function useCurrentRouteSegments(): readonly string[] {
    const store = React.useContext(CurrentRouteLocationStoreContext) ?? windowRouteLocationStore;
    const readPathname = React.useCallback(() => store.getSnapshot()?.pathname ?? null, [store]);
    const pathname = React.useSyncExternalStore(store.subscribe, readPathname, readPathname);
    const expoSegments = useSegments();
    return React.useMemo(() => {
        const route = pathname === null ? null : matchWorkspaceDestinationRoute(pathname);
        return route ? route.routeKey.split('/') : expoSegments;
    }, [expoSegments, pathname]);
}

/** The current route's path and query params, from the same owner as {@link useCurrentRoutePathname}. */
export function useCurrentRouteParams<T extends RouteParams = RouteParams>(): T {
    const store = React.useContext(CurrentRouteLocationStoreContext) ?? windowRouteLocationStore;
    const workspace = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const params: RouteParams = useGlobalSearchParams();
    // Expo's typed params are the same untyped record narrowed by the caller.
    return (workspace?.params ?? params) as T;
}

/**
 * One selected fact of the current route's params (same owner as `useCurrentRouteParams`). The reader
 * renders only when its selection changes (shallowly), not on another param's write. `select` must keep
 * its identity (a module-level function).
 */
export function useCurrentRouteParamsSelector<T>(select: (params: RouteParams) => T): T {
    const store = React.useContext(CurrentRouteLocationStoreContext) ?? windowRouteLocationStore;
    const getSnapshot = React.useMemo(() => {
        let previous: Readonly<{ value: T | typeof NO_LOCATION }> | undefined;
        return () => {
            const location = store.getSnapshot() ?? null;
            const next = location ? select(location.params) : NO_LOCATION;
            if (!previous || !shallow(previous.value, next)) previous = { value: next };
            return previous.value;
        };
    }, [select, store]);
    const selected = React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
    // Expo's own params move only on Expo navigation; they are current whenever the workspace leads nothing.
    const params = useGlobalSearchParams();
    const expoSelected = React.useMemo(() => select(params), [params, select]);
    return selected === NO_LOCATION ? expoSelected : selected as T;
}
const NO_LOCATION: unique symbol = Symbol('no workspace location');
