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
            return () => {
                listeners.delete(listener);
            };
        },
        subscriberCount() {
            return listeners.size;
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

export function useTranscriptNavigationVisibilitySnapshot(
    storeOrSessionId: NavigationVisibilityStore | string = transcriptNavigationVisibilityStore,
    options: Readonly<{ enabled?: boolean }> = {},
): NavigationVisibilitySnapshot {
    const enabled = options.enabled !== false;
    const store = typeof storeOrSessionId === 'string'
        ? getTranscriptNavigationVisibilityStore(storeOrSessionId)
        : storeOrSessionId;
    return React.useSyncExternalStore(
        enabled ? store.subscribe : noopSubscribe,
        enabled ? store.get : () => EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT,
        enabled ? store.get : () => EMPTY_TRANSCRIPT_NAVIGATION_VISIBILITY_SNAPSHOT,
    );
}
