import * as React from 'react';

/**
 * Which rows the list currently shows (viewable) and keeps live (row-store subscriptions). Rows read
 * their own membership here, so a scroll step redraws only the rows that entered or left the viewport,
 * instead of every mounted cell through the list's shared `extraData`.
 */
export type SessionListRowViewport = Readonly<{
    subscribe: (listener: () => void) => () => void;
    /** `null` membership means every rendered row is subscribed. */
    isSubscribed: (rowScopeKey: string) => boolean;
    /** `null` viewability (not yet reported) means every row counts as viewable. */
    isViewable: (nodeId: string) => boolean;
}>;

type ViewportState = {
    subscribedKeys: ReadonlySet<string> | null;
    viewableKeys: ReadonlySet<string> | null;
};

export function useSessionListRowViewport(
    subscribedKeys: ReadonlySet<string> | null,
    viewableKeys: ReadonlySet<string> | null,
): SessionListRowViewport {
    const [owner] = React.useState(() => {
        const state: ViewportState = { subscribedKeys, viewableKeys };
        const listeners = new Set<() => void>();
        const viewport: SessionListRowViewport = {
            subscribe: (listener) => {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            isSubscribed: (key) => state.subscribedKeys === null || state.subscribedKeys.has(key),
            isViewable: (key) => state.viewableKeys === null || state.viewableKeys.has(key),
        };
        return { state, listeners, viewport, notified: { subscribedKeys, viewableKeys } as ViewportState };
    });
    // Rows rendered in this pass read the current membership; mounted rows hear about it after commit.
    owner.state.subscribedKeys = subscribedKeys;
    owner.state.viewableKeys = viewableKeys;
    React.useLayoutEffect(() => {
        const notified = owner.notified;
        if (notified.subscribedKeys === subscribedKeys && notified.viewableKeys === viewableKeys) return;
        notified.subscribedKeys = subscribedKeys;
        notified.viewableKeys = viewableKeys;
        for (const listener of owner.listeners) listener();
    }, [owner, subscribedKeys, viewableKeys]);
    return owner.viewport;
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
