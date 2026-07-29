import * as React from 'react';

import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { normalizeSessionListKeyParts } from './listing/sessionListKeyNormalization';
import { normalizeSessionId } from './normalizeSessionId';

export type SessionSurfaceVisibilitySnapshot = Readonly<{
    focusedSessionId: string | null;
    routeAnchorSessionId: string | null;
    visibleSessionIds: ReadonlyArray<string>;
}>;

type MutableSessionSurfaceVisibilityState = {
    listeners: Set<() => void>;
    resetListeners: Set<() => void>;
    resetVersion: number;
    visibleSessionRefCount: Map<string, number>;
    visibleSessionScopedRefCount: Map<string, number>;
    visibleScopedSessionKeysBySessionId: Map<string, Set<string>>;
    visibleScopedSessionServerIdsBySessionId: Map<string, Set<string>>;
    visibleScopedSessionServerIdBySessionKey: Map<string, string>;
    focusedSessionId: string | null;
    routeAnchorSessionId: string | null;
    snapshot: SessionSurfaceVisibilitySnapshot;
};

const sessionSurfaceVisibilityStateKey = '__HAPPIER_SESSION_SURFACE_VISIBILITY_STATE__';

function createSessionSurfaceVisibilityState(): MutableSessionSurfaceVisibilityState {
    return {
        listeners: new Set<() => void>(),
        resetListeners: new Set<() => void>(),
        resetVersion: 0,
        visibleSessionRefCount: new Map<string, number>(),
        visibleSessionScopedRefCount: new Map<string, number>(),
        visibleScopedSessionKeysBySessionId: new Map<string, Set<string>>(),
        visibleScopedSessionServerIdsBySessionId: new Map<string, Set<string>>(),
        visibleScopedSessionServerIdBySessionKey: new Map<string, string>(),
        focusedSessionId: null,
        routeAnchorSessionId: null,
        snapshot: {
            focusedSessionId: null,
            routeAnchorSessionId: null,
            visibleSessionIds: [],
        },
    };
}

function getSessionSurfaceVisibilityState(): MutableSessionSurfaceVisibilityState {
    const host = globalThis as typeof globalThis & { [sessionSurfaceVisibilityStateKey]?: MutableSessionSurfaceVisibilityState };
    host[sessionSurfaceVisibilityStateKey] ??= createSessionSurfaceVisibilityState();
    const state = host[sessionSurfaceVisibilityStateKey];
    state.resetListeners ??= new Set<() => void>();
    state.resetVersion ??= 0;
    return state;
}

const sessionSurfaceVisibilityState = getSessionSurfaceVisibilityState();
const listeners = sessionSurfaceVisibilityState.listeners;
const visibleSessionRefCount = sessionSurfaceVisibilityState.visibleSessionRefCount;
const visibleSessionScopedRefCount = sessionSurfaceVisibilityState.visibleSessionScopedRefCount;
const visibleScopedSessionKeysBySessionId = sessionSurfaceVisibilityState.visibleScopedSessionKeysBySessionId;
const visibleScopedSessionServerIdsBySessionId = sessionSurfaceVisibilityState.visibleScopedSessionServerIdsBySessionId;
const visibleScopedSessionServerIdBySessionKey = sessionSurfaceVisibilityState.visibleScopedSessionServerIdBySessionKey;

function normalizeNullableSessionId(sessionId: string | null | undefined): string | null {
    const normalized = normalizeSessionId(sessionId);
    return normalized.length > 0 ? normalized : null;
}

function normalizeNullableServerId(serverId: string | null | undefined): string | null {
    const normalized = String(serverId ?? '').trim();
    if (normalized.length === 0) return null;
    return resolveServerProfileScopeIdForIdentifier(normalized) || normalized;
}

function resolveVisibleSessionIdentity(sessionIdRaw: string | null | undefined, serverIdRaw?: string | null): Readonly<{
    sessionId: string | null;
    serverId: string | null;
    sessionKey: string | null;
}> {
    const sessionId = normalizeNullableSessionId(sessionIdRaw);
    if (!sessionId) {
        return { sessionId: null, serverId: null, sessionKey: null };
    }

    const serverId = normalizeNullableServerId(serverIdRaw) ?? resolveServerIdForSessionIdFromLocalCache(sessionId);
    const sessionKey = serverId ? normalizeSessionListKeyParts(serverId, sessionId).sessionKey : null;
    return { sessionId, serverId, sessionKey };
}

function addVisibleScopedSessionKey(sessionId: string, sessionKey: string, serverId: string): void {
    const current = visibleScopedSessionKeysBySessionId.get(sessionId) ?? new Set<string>();
    current.add(sessionKey);
    visibleScopedSessionKeysBySessionId.set(sessionId, current);

    const serverIds = visibleScopedSessionServerIdsBySessionId.get(sessionId) ?? new Set<string>();
    serverIds.add(serverId);
    visibleScopedSessionServerIdsBySessionId.set(sessionId, serverIds);
    visibleScopedSessionServerIdBySessionKey.set(sessionKey, serverId);
}

function removeVisibleScopedSessionKey(sessionId: string, sessionKey: string): void {
    const current = visibleScopedSessionKeysBySessionId.get(sessionId);
    const serverId = visibleScopedSessionServerIdBySessionKey.get(sessionKey) ?? null;
    if (current) {
        current.delete(sessionKey);
        if (current.size === 0) {
            visibleScopedSessionKeysBySessionId.delete(sessionId);
        } else {
            visibleScopedSessionKeysBySessionId.set(sessionId, current);
        }
    }

    visibleScopedSessionServerIdBySessionKey.delete(sessionKey);
    if (!serverId) return;
    const serverIds = visibleScopedSessionServerIdsBySessionId.get(sessionId);
    if (!serverIds) return;
    if (![...visibleScopedSessionServerIdBySessionKey.entries()].some(([key, value]) => (
        value === serverId && (visibleScopedSessionKeysBySessionId.get(sessionId)?.has(key) ?? false)
    ))) {
        serverIds.delete(serverId);
    }
    if (serverIds.size === 0) {
        visibleScopedSessionServerIdsBySessionId.delete(sessionId);
        return;
    }
    visibleScopedSessionServerIdsBySessionId.set(sessionId, serverIds);
}

function readVisibleScopedServerIds(sessionId: string): Set<string> {
    const serverIds = new Set(visibleScopedSessionServerIdsBySessionId.get(sessionId) ?? []);
    const sessionKeySuffix = `:${sessionId}`;
    for (const sessionKey of visibleScopedSessionKeysBySessionId.get(sessionId) ?? []) {
        if (!sessionKey.endsWith(sessionKeySuffix)) continue;
        const serverId = sessionKey.slice(0, -sessionKeySuffix.length).trim();
        if (serverId) serverIds.add(serverId);
    }
    return serverIds;
}

function hasEquivalentVisibleScopedServer(sessionId: string, serverId: string): boolean {
    const serverIds = readVisibleScopedServerIds(sessionId);
    if (serverIds.size === 0) return false;
    for (const visibleServerId of serverIds) {
        if (areServerProfileIdentifiersEquivalent(visibleServerId, serverId)) {
            return true;
        }
    }
    return false;
}

function emitChange(): void {
    for (const listener of listeners) {
        listener();
    }
}

function emitReset(): void {
    for (const listener of sessionSurfaceVisibilityState.resetListeners) {
        listener();
    }
}

function refreshSnapshot(): void {
    sessionSurfaceVisibilityState.snapshot = {
        focusedSessionId: sessionSurfaceVisibilityState.focusedSessionId,
        routeAnchorSessionId: sessionSurfaceVisibilityState.routeAnchorSessionId,
        visibleSessionIds: Array.from(visibleSessionRefCount.keys()),
    };
}

export function getSessionSurfaceVisibilitySnapshot(): SessionSurfaceVisibilitySnapshot {
    return sessionSurfaceVisibilityState.snapshot;
}

export function subscribeSessionSurfaceVisibility(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getSessionSurfaceVisibilityResetVersion(): number {
    return sessionSurfaceVisibilityState.resetVersion;
}

export function subscribeSessionSurfaceVisibilityReset(listener: () => void): () => void {
    sessionSurfaceVisibilityState.resetListeners.add(listener);
    return () => {
        sessionSurfaceVisibilityState.resetListeners.delete(listener);
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

export function markSessionSurfaceVisible(sessionId: string, serverId?: string | null): void {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    const normalizedSessionId = identity.sessionId;
    if (!normalizedSessionId) return;
    visibleSessionRefCount.set(normalizedSessionId, (visibleSessionRefCount.get(normalizedSessionId) ?? 0) + 1);
    if (identity.sessionKey) {
        visibleSessionScopedRefCount.set(
            identity.sessionKey,
            (visibleSessionScopedRefCount.get(identity.sessionKey) ?? 0) + 1,
        );
        if (identity.serverId) {
            addVisibleScopedSessionKey(normalizedSessionId, identity.sessionKey, identity.serverId);
        }
    }
    refreshSnapshot();
    emitChange();
}

function decrementVisibleScopedSession(identity: Readonly<{
    sessionId: string;
    sessionKey: string | null;
}>): void {
    const scopedSessionKey = identity.sessionKey
        ?? (
            visibleScopedSessionKeysBySessionId.get(identity.sessionId)?.size === 1
                ? Array.from(visibleScopedSessionKeysBySessionId.get(identity.sessionId) ?? [])[0] ?? null
                : null
        );
    if (!scopedSessionKey) return;

    const currentScoped = visibleSessionScopedRefCount.get(scopedSessionKey) ?? 0;
    if (currentScoped <= 1) {
        visibleSessionScopedRefCount.delete(scopedSessionKey);
        removeVisibleScopedSessionKey(identity.sessionId, scopedSessionKey);
        return;
    }
    visibleSessionScopedRefCount.set(scopedSessionKey, currentScoped - 1);
}

export function markSessionSurfaceHidden(sessionId: string, serverId?: string | null): void {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    const normalizedSessionId = identity.sessionId;
    if (!normalizedSessionId) return;
    const current = visibleSessionRefCount.get(normalizedSessionId) ?? 0;
    if (current <= 1) {
        visibleSessionRefCount.delete(normalizedSessionId);
    } else {
        visibleSessionRefCount.set(normalizedSessionId, current - 1);
    }
    decrementVisibleScopedSession({
        sessionId: normalizedSessionId,
        sessionKey: identity.sessionKey,
    });
    refreshSnapshot();
    emitChange();
}

export function setFocusedSessionId(sessionId: string | null): void {
    sessionSurfaceVisibilityState.focusedSessionId = normalizeNullableSessionId(sessionId);
    refreshSnapshot();
    emitChange();
}

export function clearFocusedSessionId(sessionId: string): void {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (sessionSurfaceVisibilityState.focusedSessionId === normalizedSessionId) {
        sessionSurfaceVisibilityState.focusedSessionId = null;
        refreshSnapshot();
        emitChange();
    }
}

export function getFocusedSessionId(): string | null {
    return sessionSurfaceVisibilityState.focusedSessionId;
}

export function setRouteAnchorSessionId(sessionId: string | null): void {
    sessionSurfaceVisibilityState.routeAnchorSessionId = normalizeNullableSessionId(sessionId);
    refreshSnapshot();
    emitChange();
}

export function clearRouteAnchorSessionId(sessionId: string): void {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (sessionSurfaceVisibilityState.routeAnchorSessionId === normalizedSessionId) {
        sessionSurfaceVisibilityState.routeAnchorSessionId = null;
        refreshSnapshot();
        emitChange();
    }
}

export function getRouteAnchorSessionId(): string | null {
    return sessionSurfaceVisibilityState.routeAnchorSessionId;
}

export function isSessionSurfaceVisible(sessionId: string, serverId?: string | null): boolean {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return false;
    const normalizedServerId = normalizeNullableServerId(serverId);
    if (normalizedServerId) {
        const identity = resolveVisibleSessionIdentity(normalizedSessionId, serverId);
        if (identity.sessionKey && visibleSessionScopedRefCount.has(identity.sessionKey)) {
            return true;
        }
        if ((visibleScopedSessionKeysBySessionId.get(normalizedSessionId)?.size ?? 0) > 0) {
            return hasEquivalentVisibleScopedServer(normalizedSessionId, identity.serverId ?? normalizedServerId);
        }
        return visibleSessionRefCount.has(normalizedSessionId);
    }
    return visibleSessionRefCount.has(normalizedSessionId);
}

function clearSessionSurfaceVisibility(options: Readonly<{ notifyMountedSurfaces: boolean }>): void {
    visibleSessionRefCount.clear();
    visibleSessionScopedRefCount.clear();
    visibleScopedSessionKeysBySessionId.clear();
    visibleScopedSessionServerIdsBySessionId.clear();
    visibleScopedSessionServerIdBySessionKey.clear();
    sessionSurfaceVisibilityState.focusedSessionId = null;
    sessionSurfaceVisibilityState.routeAnchorSessionId = null;
    refreshSnapshot();
    emitChange();
    if (options.notifyMountedSurfaces) {
        sessionSurfaceVisibilityState.resetVersion += 1;
        emitReset();
    }
}

export function clearSessionSurfaceVisibilityForServerScopeReset(): void {
    clearSessionSurfaceVisibility({ notifyMountedSurfaces: true });
}

function isSessionRoutePathname(pathname: string | null | undefined): boolean {
    if (typeof pathname !== 'string') return true;
    const route = pathname.trim().split('?')[0]?.replace(/\/+$/, '') ?? '';
    return /^\/session\/[^/]+(?:\/.*)?$/.test(route);
}

export function clearSessionSurfaceVisibilityForNonSessionRoute(pathname: string | null | undefined): boolean {
    if (isSessionRoutePathname(pathname)) return false;
    const hadVisibilityState = visibleSessionRefCount.size > 0
        || visibleSessionScopedRefCount.size > 0
        || visibleScopedSessionKeysBySessionId.size > 0
        || visibleScopedSessionServerIdsBySessionId.size > 0
        || visibleScopedSessionServerIdBySessionKey.size > 0
        || sessionSurfaceVisibilityState.focusedSessionId !== null
        || sessionSurfaceVisibilityState.routeAnchorSessionId !== null;
    if (!hadVisibilityState) return false;
    clearSessionSurfaceVisibility({ notifyMountedSurfaces: false });
    return true;
}

export function resetSessionSurfaceVisibilityForTests(): void {
    clearSessionSurfaceVisibilityForServerScopeReset();
}
