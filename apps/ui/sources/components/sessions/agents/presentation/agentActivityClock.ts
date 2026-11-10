import * as React from 'react';
import {
    formatRelativeTime,
    formatShortRelativeTimeAt,
    readRelativeTimeShortRefreshAtMs,
    readShortRelativeTimeRefreshAtMs,
} from '@/utils/time/formatShortRelativeTime';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

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
    const presented = useLayoutPresentationActive();
    const viewed = useHostActivelyViewed();
    const active = presented && viewed;
    const subscribeWhileActive = React.useCallback((listener: () => void) =>
        active ? subscribe(listener) : () => {}, [active]);
    return React.useSyncExternalStore(subscribeWhileActive, getSnapshot, getSnapshot);
}

/** The clock a relative leaf reads: it wakes only at the label's next change, and never while hidden or fixed. */
function useRelativeLabelClockMs(
    timestamp: number,
    readNextChangeAtMs: (atMs: number, nowMs: number) => number | null,
    fixedNowMs?: number,
): number {
    const readNextRefresh = React.useCallback((clockMs: number) => readNextChangeAtMs(timestamp, clockMs), [readNextChangeAtMs, timestamp]);
    const activelyViewed = useHostActivelyViewed();
    const presented = useLayoutPresentationActive();
    const clockMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, presented && activelyViewed && fixedNowMs === undefined);
    return fixedNowMs ?? clockMs;
}

/** Relative leaves request only their next displayed age; hidden/fixed snapshots request nothing. */
export function useWorkRelativeTime(timestamp: number, fixedNowMs?: number): string {
    return formatShortRelativeTimeAt(timestamp, useRelativeLabelClockMs(timestamp, readShortRelativeTimeRefreshAtMs, fixedNowMs));
}

/** The full feed age ("just now", "5 minutes ago") on the same minute/hour/day deadlines. */
export function useRelativeTime(timestamp: number): string {
    return formatRelativeTime(timestamp, useRelativeLabelClockMs(timestamp, readRelativeTimeShortRefreshAtMs));
}
