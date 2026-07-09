import * as React from 'react';

import type { TranscriptNavigationEntry, TranscriptNavigationEntryPressHandler } from './transcriptNavigationTypes';

export type TranscriptNavigationPaneSnapshot = Readonly<{
    sessionId: string;
    entries: readonly TranscriptNavigationEntry[];
    activeEntryId: string | null;
    onEntryPress: TranscriptNavigationEntryPressHandler | null;
}>;

export type TranscriptNavigationPaneStore = Readonly<{
    get: (sessionId: string) => TranscriptNavigationPaneSnapshot;
    set: (
        sessionId: string,
        next: Readonly<{
            entries: readonly TranscriptNavigationEntry[];
            activeEntryId: string | null;
            onEntryPress: TranscriptNavigationEntryPressHandler;
        }> | null,
    ) => void;
    subscribe: (sessionId: string, listener: () => void) => () => void;
    /** True while at least one pane consumer (e.g. the navigation panel) is mounted for the session. */
    hasSubscribers: (sessionId: string) => boolean;
    /** Notifies when the session's subscriber presence may have changed (panel opened/closed). */
    subscribeSubscriberPresence: (sessionId: string, listener: () => void) => () => void;
}>;

const EMPTY_ENTRIES: readonly TranscriptNavigationEntry[] = Object.freeze([]);
const emptySnapshotsBySessionId = new Map<string, TranscriptNavigationPaneSnapshot>();

function normalizeSessionId(sessionId: string): string {
    return sessionId.trim();
}

export function createEmptyTranscriptNavigationPaneSnapshot(sessionId: string): TranscriptNavigationPaneSnapshot {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const existing = emptySnapshotsBySessionId.get(normalizedSessionId);
    if (existing) return existing;
    const snapshot = {
        activeEntryId: null,
        entries: EMPTY_ENTRIES,
        onEntryPress: null,
        sessionId: normalizedSessionId,
    };
    emptySnapshotsBySessionId.set(normalizedSessionId, snapshot);
    return snapshot;
}

function normalizeSnapshot(
    sessionId: string,
    next: Parameters<TranscriptNavigationPaneStore['set']>[1],
): TranscriptNavigationPaneSnapshot {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!next) return createEmptyTranscriptNavigationPaneSnapshot(normalizedSessionId);
    return {
        activeEntryId: typeof next.activeEntryId === 'string' && next.activeEntryId.length > 0
            ? next.activeEntryId
            : null,
        entries: next.entries,
        onEntryPress: next.onEntryPress,
        sessionId: normalizedSessionId,
    };
}

function snapshotsEqual(left: TranscriptNavigationPaneSnapshot, right: TranscriptNavigationPaneSnapshot): boolean {
    return left.sessionId === right.sessionId
        && left.activeEntryId === right.activeEntryId
        && left.entries === right.entries
        && left.onEntryPress === right.onEntryPress;
}

export function createTranscriptNavigationPaneStore(): TranscriptNavigationPaneStore {
    const snapshotsBySessionId = new Map<string, TranscriptNavigationPaneSnapshot>();
    const listenersBySessionId = new Map<string, Set<() => void>>();
    const presenceListenersBySessionId = new Map<string, Set<() => void>>();

    function notify(sessionId: string) {
        for (const listener of listenersBySessionId.get(sessionId) ?? []) {
            listener();
        }
    }

    function notifyPresence(sessionId: string) {
        for (const listener of presenceListenersBySessionId.get(sessionId) ?? []) {
            listener();
        }
    }

    return {
        get(sessionId) {
            const normalizedSessionId = normalizeSessionId(sessionId);
            return snapshotsBySessionId.get(normalizedSessionId)
                ?? createEmptyTranscriptNavigationPaneSnapshot(normalizedSessionId);
        },
        set(sessionId, next) {
            const normalizedSessionId = normalizeSessionId(sessionId);
            const current = snapshotsBySessionId.get(normalizedSessionId)
                ?? createEmptyTranscriptNavigationPaneSnapshot(normalizedSessionId);
            const normalizedNext = normalizeSnapshot(normalizedSessionId, next);
            if (snapshotsEqual(current, normalizedNext)) return;
            if (!next) {
                snapshotsBySessionId.delete(normalizedSessionId);
            } else {
                snapshotsBySessionId.set(normalizedSessionId, normalizedNext);
            }
            notify(normalizedSessionId);
        },
        subscribe(sessionId, listener) {
            const normalizedSessionId = normalizeSessionId(sessionId);
            let listeners = listenersBySessionId.get(normalizedSessionId);
            if (!listeners) {
                listeners = new Set();
                listenersBySessionId.set(normalizedSessionId, listeners);
            }
            listeners.add(listener);
            notifyPresence(normalizedSessionId);
            return () => {
                const current = listenersBySessionId.get(normalizedSessionId);
                if (!current) return;
                current.delete(listener);
                if (current.size === 0) {
                    listenersBySessionId.delete(normalizedSessionId);
                }
                notifyPresence(normalizedSessionId);
            };
        },
        hasSubscribers(sessionId) {
            return (listenersBySessionId.get(normalizeSessionId(sessionId))?.size ?? 0) > 0;
        },
        subscribeSubscriberPresence(sessionId, listener) {
            const normalizedSessionId = normalizeSessionId(sessionId);
            let listeners = presenceListenersBySessionId.get(normalizedSessionId);
            if (!listeners) {
                listeners = new Set();
                presenceListenersBySessionId.set(normalizedSessionId, listeners);
            }
            listeners.add(listener);
            return () => {
                const current = presenceListenersBySessionId.get(normalizedSessionId);
                if (!current) return;
                current.delete(listener);
                if (current.size === 0) {
                    presenceListenersBySessionId.delete(normalizedSessionId);
                }
            };
        },
    };
}

export const transcriptNavigationPaneStore = createTranscriptNavigationPaneStore();

/**
 * True while the transcript navigation pane/panel is mounted for the session.
 * Lets hosts keep visibility observation alive in panel-only mode (rail hidden).
 */
export function useTranscriptNavigationPaneOpen(sessionId: string): boolean {
    return React.useSyncExternalStore(
        React.useCallback((listener) => transcriptNavigationPaneStore.subscribeSubscriberPresence(sessionId, listener), [sessionId]),
        React.useCallback(() => transcriptNavigationPaneStore.hasSubscribers(sessionId), [sessionId]),
        () => false,
    );
}

export function useTranscriptNavigationPaneSnapshot(sessionId: string): TranscriptNavigationPaneSnapshot {
    return React.useSyncExternalStore(
        React.useCallback((listener) => transcriptNavigationPaneStore.subscribe(sessionId, listener), [sessionId]),
        React.useCallback(() => transcriptNavigationPaneStore.get(sessionId), [sessionId]),
        React.useCallback(() => createEmptyTranscriptNavigationPaneSnapshot(sessionId), [sessionId]),
    );
}
