import * as React from 'react';

export type NavigationVisibilitySnapshot = Readonly<{
    currentAnchorId: string | null;
    visibleAnchorIds: readonly string[];
}>;

export type NavigationVisibilityStore = Readonly<{
    get: () => NavigationVisibilitySnapshot;
    hasSubscribers: () => boolean;
    set: (next: NavigationVisibilitySnapshot | null) => void;
    subscribe: (listener: () => void) => () => void;
    subscriberCount: () => number;
    /**
     * Notifies when consumer presence may have changed (a rail/pane mounted or
     * unmounted). Publication is subscriber-gated, so the arrival of the FIRST
     * consumer is itself a publish trigger: without it the store stays empty
     * until the next scroll/layout/content-size change and a reader who opens
     * the navigation surface sees no current position at all.
     *
     * Presence watchers are deliberately NOT data subscribers: watching must not
     * make `hasSubscribers()` true, or the gate would never close.
     */
    subscribeSubscriberPresence: (listener: () => void) => () => void;
}>;

export const EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT: NavigationVisibilitySnapshot = Object.freeze({
    currentAnchorId: null,
    visibleAnchorIds: Object.freeze([]),
});

function normalizeAnchorId(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeVisibleAnchorIds(values: readonly unknown[]): readonly string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const id = normalizeAnchorId(value);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function normalizeSnapshot(snapshot: NavigationVisibilitySnapshot | null): NavigationVisibilitySnapshot {
    if (!snapshot) return EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT;
    const visibleAnchorIds = normalizeVisibleAnchorIds(snapshot.visibleAnchorIds);
    const currentAnchorId = normalizeAnchorId(snapshot.currentAnchorId);
    if (!currentAnchorId && visibleAnchorIds.length === 0) {
        return EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT;
    }
    return {
        currentAnchorId,
        visibleAnchorIds,
    };
}

function areSnapshotsEqual(left: NavigationVisibilitySnapshot, right: NavigationVisibilitySnapshot): boolean {
    if (left.currentAnchorId !== right.currentAnchorId) return false;
    if (left.visibleAnchorIds.length !== right.visibleAnchorIds.length) return false;
    for (let index = 0; index < left.visibleAnchorIds.length; index += 1) {
        if (left.visibleAnchorIds[index] !== right.visibleAnchorIds[index]) return false;
    }
    return true;
}

export function createTranscriptNavigationVisibilityStore(
    initialSnapshot: NavigationVisibilitySnapshot | null = null,
): NavigationVisibilityStore {
    let snapshot = normalizeSnapshot(initialSnapshot);
    const listeners = new Set<() => void>();
    const presenceListeners = new Set<() => void>();

    function notifyPresence() {
        for (const listener of presenceListeners) {
            listener();
        }
    }

    return {
        get() {
            return snapshot;
        },
        hasSubscribers() {
            return listeners.size > 0;
        },
        set(next) {
            const normalizedNext = normalizeSnapshot(next);
            if (areSnapshotsEqual(snapshot, normalizedNext)) return;
            snapshot = normalizedNext;
            for (const listener of listeners) {
                listener();
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            notifyPresence();
            return () => {
                if (!listeners.delete(listener)) return;
                notifyPresence();
            };
        },
        subscriberCount() {
            return listeners.size;
        },
        subscribeSubscriberPresence(listener) {
            presenceListeners.add(listener);
            return () => {
                presenceListeners.delete(listener);
            };
        },
    };
}

const transcriptNavigationVisibilityStoresBySessionId = new Map<string, NavigationVisibilityStore>();

function normalizeSessionId(sessionId: unknown): string | null {
    return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
}

export function getTranscriptNavigationVisibilityStore(sessionId: string): NavigationVisibilityStore {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return transcriptNavigationVisibilityStore;
    let store = transcriptNavigationVisibilityStoresBySessionId.get(normalizedSessionId);
    if (!store) {
        store = createTranscriptNavigationVisibilityStore();
        transcriptNavigationVisibilityStoresBySessionId.set(normalizedSessionId, store);
    }
    return store;
}

export function clearTranscriptNavigationVisibilityStore(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return;
    const store = transcriptNavigationVisibilityStoresBySessionId.get(normalizedSessionId);
    if (store) {
        store.set(null);
    }
    transcriptNavigationVisibilityStoresBySessionId.delete(normalizedSessionId);
}

export const transcriptNavigationVisibilityStore = createTranscriptNavigationVisibilityStore();

const noopSubscribe = () => () => {};

function resolveStore(
    storeOrSessionId: NavigationVisibilityStore | string,
): NavigationVisibilityStore {
    return typeof storeOrSessionId === 'string'
        ? getTranscriptNavigationVisibilityStore(storeOrSessionId)
        : storeOrSessionId;
}

export function useTranscriptNavigationVisibilitySnapshot(
    storeOrSessionId: NavigationVisibilityStore | string = transcriptNavigationVisibilityStore,
    options: Readonly<{ enabled?: boolean }> = {},
): NavigationVisibilitySnapshot {
    const enabled = options.enabled !== false;
    const store = resolveStore(storeOrSessionId);
    return React.useSyncExternalStore(
        enabled ? store.subscribe : noopSubscribe,
        enabled ? store.get : () => EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT,
        enabled ? store.get : () => EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT,
    );
}

/**
 * Reactive consumer presence for the session's visibility store.
 *
 * The host owns publication but must not own the anchor: it needs to know only
 * WHETHER a navigation surface is listening, which changes at mount/unmount
 * rate. Reading `hasSubscribers()` during render instead leaves the host blind
 * to a consumer that arrives later — the store then stays empty until the next
 * scroll, so opening the navigation panel shows no current position.
 */
export function useTranscriptNavigationVisibilityHasSubscribers(
    storeOrSessionId: NavigationVisibilityStore | string,
): boolean {
    const store = resolveStore(storeOrSessionId);
    const subscribe = React.useCallback(
        (listener: () => void) => store.subscribeSubscriberPresence(listener),
        [store],
    );
    const read = React.useCallback(() => store.hasSubscribers(), [store]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * Turn-boundary-rate subscription: a primitive, so a consumer only re-renders
 * when the reader actually crosses into another anchor — not on every frame
 * that merely re-derives the same current turn.
 *
 * This and {@link useTranscriptNavigationVisibleAnchorIds} are the navigation
 * surfaces' own subscription point — the rail and the pane both read the
 * current anchor here, never from a host-published snapshot.
 */
export function useTranscriptNavigationCurrentAnchorId(
    storeOrSessionId: NavigationVisibilityStore | string,
    options: Readonly<{ enabled?: boolean }> = {},
): string | null {
    const enabled = options.enabled !== false;
    const store = resolveStore(storeOrSessionId);
    const read = React.useCallback(
        () => (enabled ? store.get().currentAnchorId : null),
        [enabled, store],
    );
    return React.useSyncExternalStore(enabled ? store.subscribe : noopSubscribe, read, read);
}

/**
 * Frame-rate subscription: the visible set changes as rows enter and leave the
 * renderer window. The store only notifies when the id list actually differs, so
 * the returned array identity is stable between real changes.
 */
export function useTranscriptNavigationVisibleAnchorIds(
    storeOrSessionId: NavigationVisibilityStore | string,
    options: Readonly<{ enabled?: boolean }> = {},
): readonly string[] {
    const enabled = options.enabled !== false;
    const store = resolveStore(storeOrSessionId);
    const read = React.useCallback(
        () => (enabled
            ? store.get().visibleAnchorIds
            : EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT.visibleAnchorIds),
        [enabled, store],
    );
    return React.useSyncExternalStore(enabled ? store.subscribe : noopSubscribe, read, read);
}
