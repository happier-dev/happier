import * as React from 'react';

/**
 * Whether the phone bar on screen is scrolling its items sideways.
 *
 * The bar owns the decision (its measured width against its Bar items and, for Session, the "Always
 * swipe between sessions" setting); the live `CockpitTabBar` publishes it for every bar. A scrolling bar
 * owns the horizontal axis, so the Session band's sideways swipe stays out of its way. One boolean,
 * published by the one bar on screen, read by the one band gesture.
 */
let scrolls = false;
const listeners = new Set<() => void>();

function publishCockpitBarScrolls(next: boolean): void {
    if (scrolls === next) return;
    scrolls = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

const read = () => scrolls;

/** The live bar says it scrolls while it does, and hands the axis back when it stops or leaves. */
export function usePublishCockpitBarScrolls(scrolling: boolean): void {
    React.useEffect(() => {
        if (!scrolling) return;
        publishCockpitBarScrolls(true);
        return () => publishCockpitBarScrolls(false);
    }, [scrolling]);
}

export function useCockpitBarScrolls(): boolean {
    return React.useSyncExternalStore(subscribe, read, read);
}
