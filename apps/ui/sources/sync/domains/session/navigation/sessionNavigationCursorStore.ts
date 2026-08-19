/**
 * Single-slot store for the frozen session-navigation cursor.
 *
 * Exactly one cursor is live at a time: the order the user last saw. Publishing a
 * cursor for a different source scope replaces the previous one rather than stacking,
 * so there is never a second answer to "what does next mean here". Module-level slot
 * plus `useSyncExternalStore`, matching `transcriptJumpHighlightStore`.
 */

import * as React from 'react';

import type { SessionNavigationCursor } from './sessionNavigationCursor';

let currentCursor: SessionNavigationCursor | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
    for (const listener of listeners) {
        listener();
    }
}

export function subscribeToSessionNavigationCursor(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function readSessionNavigationCursor(): SessionNavigationCursor | null {
    return currentCursor;
}

export function publishSessionNavigationCursor(cursor: SessionNavigationCursor): void {
    if (currentCursor === cursor) return;
    currentCursor = cursor;
    notifyListeners();
}

export function clearSessionNavigationCursor(): void {
    if (currentCursor === null) return;
    currentCursor = null;
    notifyListeners();
}

export function useSessionNavigationCursor(): SessionNavigationCursor | null {
    return React.useSyncExternalStore(
        subscribeToSessionNavigationCursor,
        readSessionNavigationCursor,
        readSessionNavigationCursor,
    );
}

export function resetSessionNavigationCursorForTests(): void {
    currentCursor = null;
    listeners.clear();
}
