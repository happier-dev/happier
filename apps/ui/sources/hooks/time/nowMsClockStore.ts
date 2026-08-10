import { startRuntimeActiveGatedInterval } from '@/utils/runtime/isRuntimeActive';

/**
 * One process-wide clock per cadence, not one timer per component.
 *
 * A relative-time or elapsed-time display needs a `nowMs` that advances, and the obvious shape —
 * a `setInterval` inside the hook — costs one timer, one state update and one render per mounted
 * consumer. A roster of ten running agents on a one-second cadence would wake the JS thread ten
 * times a second to compute the same instant ten times.
 *
 * Consumers asking for the same cadence therefore share a bucket: one timer, one instant, one
 * notification fan-out. The instant is shared deliberately — two rows must never render elapsed
 * times a second apart because they mounted a few hundred milliseconds apart.
 *
 * Ticking is gated on the runtime being active (foreground app, visible document) by the canonical
 * owner of that rule, `startRuntimeActiveGatedInterval`, which also delivers one catch-up tick when
 * the runtime returns from hidden/background with the cadence overdue. A bucket with no
 * subscribers owns no timer at all.
 */

export const DEFAULT_NOW_MS_INTERVAL_MS = 60_000;

type NowMsBucket = {
    nowMs: number;
    readonly listeners: Set<() => void>;
    stop: (() => void) | null;
};

const buckets = new Map<number, NowMsBucket>();

export function normalizeNowMsIntervalMs(intervalMs: number): number {
    if (!Number.isFinite(intervalMs)) return DEFAULT_NOW_MS_INTERVAL_MS;
    return Math.max(1, Math.trunc(intervalMs));
}

function ensureBucket(intervalMs: number): NowMsBucket {
    const existing = buckets.get(intervalMs);
    if (existing) return existing;
    const created: NowMsBucket = { nowMs: Date.now(), listeners: new Set(), stop: null };
    buckets.set(intervalMs, created);
    return created;
}

function tick(intervalMs: number): void {
    const bucket = buckets.get(intervalMs);
    if (!bucket) return;
    const nowMs = Date.now();
    if (nowMs === bucket.nowMs) return;
    bucket.nowMs = nowMs;
    for (const listener of [...bucket.listeners]) {
        listener();
    }
}

/**
 * The current shared instant for a cadence. Stable between ticks so it can back a
 * `useSyncExternalStore` snapshot directly.
 */
export function readNowMs(intervalMs: number): number {
    return ensureBucket(normalizeNowMsIntervalMs(intervalMs)).nowMs;
}

export function subscribeToNowMs(intervalMs: number, listener: () => void): () => void {
    const key = normalizeNowMsIntervalMs(intervalMs);
    const bucket = ensureBucket(key);
    const wasIdle = bucket.listeners.size === 0;
    bucket.listeners.add(listener);

    if (wasIdle) {
        // A bucket can be created by a snapshot read on a render that never commits, so an idle
        // bucket's instant may predate this subscription by any amount. Refresh it before the
        // first reader can observe a stale one.
        const nowMs = Date.now();
        if (nowMs - bucket.nowMs >= key) {
            bucket.nowMs = nowMs;
        }
        bucket.stop = startRuntimeActiveGatedInterval(() => tick(key), key);
    }

    let subscribed = true;
    return () => {
        if (!subscribed) return;
        subscribed = false;
        bucket.listeners.delete(listener);
        if (bucket.listeners.size > 0) return;
        bucket.stop?.();
        bucket.stop = null;
        buckets.delete(key);
    };
}
