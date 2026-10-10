import * as React from 'react';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';

/**
 * One shared one-second tick for every running agent clock on screen.
 *
 * A roster can show several live rows at once; each subscribing to its own interval would wake the JS
 * thread once per row per second. Here one interval serves every subscriber, starts with the first
 * and stops with the last, so an Agents pane with nothing live keeps no timer at all.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let nowMs = Date.now();

function tick(): void {
    nowMs = Date.now();
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (timer === null) {
        nowMs = Date.now();
        timer = setInterval(tick, 1000);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    };
}

function getSnapshot(): number {
    return nowMs;
}

/** The current second, re-rendering only the component that reads it. */
export function useAgentActivityClockNow(): number {
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const subscribeFrozen = () => () => {};

/** One shared clock; a leaf subscribes to its displayed snapshot, not every elapsed second. */
export function useWorkClockSnapshot<T extends string | number | null>(snapshotAt: (nowMs: number) => T, fixedNowMs?: number): T {
    const snapshot = React.useCallback(() => snapshotAt(fixedNowMs ?? nowMs), [fixedNowMs, snapshotAt]);
    return React.useSyncExternalStore(fixedNowMs === undefined ? subscribe : subscribeFrozen, snapshot, snapshot);
}

/** Relative dates share the live clock, but repaint only when their displayed words change. */
export function useWorkRelativeTime(timestamp: number, fixedNowMs?: number): string {
    const snapshotAt = React.useCallback((clockMs: number) => formatShortRelativeTimeAt(timestamp, clockMs), [timestamp]);
    return useWorkClockSnapshot(snapshotAt, fixedNowMs);
}
