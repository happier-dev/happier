import * as React from 'react';

/**
 * Which rows the list currently shows (viewable) and keeps live (row-store subscriptions). Rows read
 * their own membership here, so a scroll step redraws only the rows that entered or left the viewport,
 * instead of every mounted cell through the list's shared `extraData`. The list's viewability callback
 * publishes straight into this owner, so a scroll step does not re-render the pane that owns the list:
 * readers that derive something from the viewport select it (`useSessionListRowViewportSelection`).
 */
export type SessionListRowViewport = Readonly<{
    subscribe: (listener: () => void) => () => void;
    /** `null` membership means every rendered row is subscribed. */
    isSubscribed: (rowScopeKey: string) => boolean;
    /** `null` viewability (not yet reported) means every row counts as viewable. */
    isViewable: (nodeId: string) => boolean;
    /** The viewable row keys last reported by the list; `null` until the first report. */
    getViewableKeys: () => ReadonlySet<string> | null;
}>;

export type SessionListRowViewportOwner = Readonly<{
    viewport: SessionListRowViewport;
    /** The list's viewability callback; notifies readers without rendering the list owner. */
    publishViewableKeys: (keys: ReadonlySet<string>) => void;
    /** Row-store subscriptions the list owner derived; see `useSessionListRowViewportSubscriptions`. */
    assignSubscribedKeys: (keys: ReadonlySet<string> | null) => void;
    notify: () => void;
}>;

export function useSessionListRowViewport(): SessionListRowViewportOwner {
    const [owner] = React.useState((): SessionListRowViewportOwner => {
        let subscribedKeys: ReadonlySet<string> | null = null;
        let viewableKeys: ReadonlySet<string> | null = null;
        const listeners = new Set<() => void>();
        const notify = () => { for (const listener of listeners) listener(); };
        return {
            viewport: {
                subscribe: (listener) => {
                    listeners.add(listener);
                    return () => { listeners.delete(listener); };
                },
                isSubscribed: (key) => subscribedKeys === null || subscribedKeys.has(key),
                isViewable: (key) => viewableKeys === null || viewableKeys.has(key),
                getViewableKeys: () => viewableKeys,
            },
            publishViewableKeys: (keys) => {
                if (viewableKeys === keys) return;
                viewableKeys = keys;
                notify();
            },
            assignSubscribedKeys: (keys) => { subscribedKeys = keys; },
            notify,
        };
    });
    return owner;
}

/**
 * Rows rendered in this pass read the current subscriptions; mounted rows hear about them after commit.
 * A surface without data demand withdraws every subscription without telling its rows: they keep what
 * they show until the surface returns, and only then compare.
 */
export function useSessionListRowViewportSubscriptions(
    owner: SessionListRowViewportOwner,
    subscribedKeys: ReadonlySet<string> | null,
    surfaceDataActive = true,
): void {
    owner.assignSubscribedKeys(subscribedKeys);
    React.useLayoutEffect(() => { if (surfaceDataActive) owner.notify(); }, [owner, subscribedKeys, surfaceDataActive]);
}

/** A reader's derivation of the viewport. `select` must return the same value for an unchanged answer. */
export function useSessionListRowViewportSelection<T>(
    viewport: SessionListRowViewport,
    select: (viewableKeys: ReadonlySet<string> | null) => T,
): T {
    const getSnapshot = () => select(viewport.getViewableKeys());
    return React.useSyncExternalStore(viewport.subscribe, getSnapshot, getSnapshot);
}

/** One row's own membership: it re-renders only when that answer changes. */
export function useSessionListRowViewportFact(
    viewport: SessionListRowViewport | undefined,
    read: 'subscribed' | 'viewable',
    key: string,
): boolean {
    const subscribe = viewport?.subscribe ?? noSubscribe;
    const getSnapshot = () => !viewport || (read === 'subscribed' ? viewport.isSubscribed(key) : viewport.isViewable(key));
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const noSubscribe = () => () => {};
