import * as React from 'react';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { shallow } from 'zustand/shallow';

type RouteParams = Readonly<Record<string, string | string[] | undefined>>;
export type CurrentRouteLocation = Readonly<{ pathname: string; params: RouteParams }>;

/**
 * The workspace's current URL while Expo's mirror deliberately stays on the same route pattern
 * (`/session/A` while the browser shows `/session/B`). Null whenever Expo's location is current.
 */
const CurrentRouteLocationContext = React.createContext<CurrentRouteLocation | null>(null);
type CurrentRouteLocationStore = Readonly<{ getSnapshot(): CurrentRouteLocation | null; subscribe(listener: () => void): () => void }>;
const CurrentRouteLocationStoreContext = React.createContext<CurrentRouteLocationStore | null>(null);

/** Publishes the location both as a value and as a store that selectors subscribe to. */
export function CurrentRouteLocationProvider(props: React.PropsWithChildren<Readonly<{ value: CurrentRouteLocation | null }>>): React.ReactElement {
    const current = React.useRef(props.value);
    current.current = props.value;
    const [listeners] = React.useState(() => new Set<() => void>());
    const [store] = React.useState<CurrentRouteLocationStore>(() => ({
        getSnapshot: () => current.current,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }));
    React.useLayoutEffect(() => { for (const listener of listeners) listener(); }, [listeners, props.value]);
    return <CurrentRouteLocationStoreContext.Provider value={store}>
        <CurrentRouteLocationContext.Provider value={props.value}>{props.children}</CurrentRouteLocationContext.Provider>
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
    const workspace = React.useContext(CurrentRouteLocationContext);
    const pathname = usePathname();
    return workspace?.pathname ?? pathname;
}

/** The current route's path and query params, from the same owner as {@link useCurrentRoutePathname}. */
export function useCurrentRouteParams<T extends RouteParams = RouteParams>(): T {
    const workspace = React.useContext(CurrentRouteLocationContext);
    const params: RouteParams = useGlobalSearchParams();
    // Expo's typed params are the same untyped record narrowed by the caller.
    return (workspace?.params ?? params) as T;
}

const subscribeNoLocation = () => () => {};
/**
 * One selected fact of the current route's params (same owner as `useCurrentRouteParams`). The reader
 * renders only when its selection changes (shallowly), not on another param's write. `select` must keep
 * its identity (a module-level function).
 */
export function useCurrentRouteParamsSelector<T>(select: (params: RouteParams) => T): T {
    const store = React.useContext(CurrentRouteLocationStoreContext);
    const getSnapshot = React.useMemo(() => {
        let previous: Readonly<{ value: T | typeof NO_LOCATION }> | undefined;
        return () => {
            const location = store?.getSnapshot() ?? null;
            const next = location ? select(location.params) : NO_LOCATION;
            if (!previous || !shallow(previous.value, next)) previous = { value: next };
            return previous.value;
        };
    }, [select, store]);
    const selected = React.useSyncExternalStore(store?.subscribe ?? subscribeNoLocation, getSnapshot, getSnapshot);
    // Expo's own params move only on Expo navigation; they are current whenever the workspace leads nothing.
    const params = useGlobalSearchParams();
    const expoSelected = React.useMemo(() => select(params), [params, select]);
    return selected === NO_LOCATION ? expoSelected : selected as T;
}
const NO_LOCATION: unique symbol = Symbol('no workspace location');
