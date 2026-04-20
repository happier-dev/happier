import * as React from 'react';

import { normalizeSessionId } from './normalizeSessionId';

export type SessionSurfaceVisibilitySnapshot = Readonly<{
    focusedSessionId: string | null;
    routeAnchorSessionId: string | null;
    visibleSessionIds: ReadonlyArray<string>;
}>;

const listeners = new Set<() => void>();
const visibleSessionRefCount = new Map<string, number>();

let focusedSessionId: string | null = null;
let routeAnchorSessionId: string | null = null;
let snapshot: SessionSurfaceVisibilitySnapshot = {
    focusedSessionId: null,
    routeAnchorSessionId: null,
    visibleSessionIds: [],
};

function normalizeNullableSessionId(sessionId: string | null | undefined): string | null {
    const normalized = normalizeSessionId(sessionId);
    return normalized.length > 0 ? normalized : null;
}

function emitChange(): void {
    for (const listener of listeners) {
        listener();
    }
}

function refreshSnapshot(): void {
    snapshot = {
        focusedSessionId,
        routeAnchorSessionId,
        visibleSessionIds: Array.from(visibleSessionRefCount.keys()),
    };
}

export function getSessionSurfaceVisibilitySnapshot(): SessionSurfaceVisibilitySnapshot {
    return snapshot;
}

export function subscribeSessionSurfaceVisibility(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useSessionSurfaceVisibilitySnapshot(): SessionSurfaceVisibilitySnapshot {
    return React.useSyncExternalStore(
        subscribeSessionSurfaceVisibility,
        getSessionSurfaceVisibilitySnapshot,
        getSessionSurfaceVisibilitySnapshot,
    );
}

export function useFocusedSessionId(): string | null {
    return useSessionSurfaceVisibilitySnapshot().focusedSessionId;
}

export function markSessionSurfaceVisible(sessionId: string): void {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return;
    visibleSessionRefCount.set(normalizedSessionId, (visibleSessionRefCount.get(normalizedSessionId) ?? 0) + 1);
    refreshSnapshot();
    emitChange();
}

export function markSessionSurfaceHidden(sessionId: string): void {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return;
    const current = visibleSessionRefCount.get(normalizedSessionId) ?? 0;
    if (current <= 1) {
        visibleSessionRefCount.delete(normalizedSessionId);
    } else {
        visibleSessionRefCount.set(normalizedSessionId, current - 1);
    }
    refreshSnapshot();
    emitChange();
}

export function setFocusedSessionId(sessionId: string | null): void {
    focusedSessionId = normalizeNullableSessionId(sessionId);
    refreshSnapshot();
    emitChange();
}

export function clearFocusedSessionId(sessionId: string): void {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (focusedSessionId === normalizedSessionId) {
        focusedSessionId = null;
        refreshSnapshot();
        emitChange();
    }
}

export function getFocusedSessionId(): string | null {
    return focusedSessionId;
}

export function setRouteAnchorSessionId(sessionId: string | null): void {
    routeAnchorSessionId = normalizeNullableSessionId(sessionId);
    refreshSnapshot();
    emitChange();
}

export function clearRouteAnchorSessionId(sessionId: string): void {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (routeAnchorSessionId === normalizedSessionId) {
        routeAnchorSessionId = null;
        refreshSnapshot();
        emitChange();
    }
}

export function getRouteAnchorSessionId(): string | null {
    return routeAnchorSessionId;
}

export function isSessionSurfaceVisible(sessionId: string): boolean {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return false;
    return visibleSessionRefCount.has(normalizedSessionId);
}

export function resetSessionSurfaceVisibilityForTests(): void {
    visibleSessionRefCount.clear();
    focusedSessionId = null;
    routeAnchorSessionId = null;
    refreshSnapshot();
    emitChange();
}
