import * as React from 'react';
import type { SessionAddress } from './sessionAddress';

import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { normalizeSessionListKeyParts } from './listing/sessionListKeyNormalization';
import { normalizeSessionId } from './normalizeSessionId';
import { rememberSessionVisit } from './navigation/recentSessions';

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
    focusedSessionAddress: SessionAddress | null;
    routeAnchorSessionId: string | null;
    routeAnchorSessionAddress: SessionAddress | null;
    snapshot: SessionSurfaceVisibilitySnapshot;
    visibleSurfaces: readonly SessionAddress[];
    visibleListRows: Map<string, { address: SessionAddress; count: number }>;
    visibleListSurfaces: readonly SessionAddress[];
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
        focusedSessionAddress: null,
        routeAnchorSessionId: null,
        routeAnchorSessionAddress: null,
        visibleSurfaces: [],
        visibleListRows: new Map(),
        visibleListSurfaces: [],
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
    state.focusedSessionAddress ??= null;
    state.visibleListRows ??= new Map();
    state.visibleListSurfaces ??= [];
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
    return new Set(visibleScopedSessionServerIdsBySessionId.get(sessionId) ?? []);
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

// Address readers share this snapshot subscription; a same-id Home change must publish too.
function refreshSnapshot(addressChanged = false): void {
    const surfaces: SessionAddress[] = [];
    for (const [sessionId, keys] of visibleScopedSessionKeysBySessionId) {
        for (const key of keys) {
            const serverId = visibleScopedSessionServerIdBySessionKey.get(key);
            if (serverId) surfaces.push({ serverId, sessionId });
        }
    }
    surfaces.sort((a, b) => a.serverId.localeCompare(b.serverId) || a.sessionId.localeCompare(b.sessionId));
    const previous = sessionSurfaceVisibilityState.visibleSurfaces;
    const surfacesChanged = !previous || previous.length !== surfaces.length || surfaces.some((value, index) => (
        value.serverId !== previous[index].serverId || value.sessionId !== previous[index].sessionId
    ));
    if (surfacesChanged) sessionSurfaceVisibilityState.visibleSurfaces = surfaces;

    const previousSnapshot = sessionSurfaceVisibilityState.snapshot;
    const visibleSessionIds = Array.from(visibleSessionRefCount.keys());
    const visibleIdsChanged = visibleSessionIds.length !== previousSnapshot.visibleSessionIds.length
        || visibleSessionIds.some((sessionId, index) => sessionId !== previousSnapshot.visibleSessionIds[index]);
    if (!surfacesChanged && !visibleIdsChanged && !addressChanged
        && previousSnapshot.focusedSessionId === sessionSurfaceVisibilityState.focusedSessionId
        && previousSnapshot.routeAnchorSessionId === sessionSurfaceVisibilityState.routeAnchorSessionId) return;
    sessionSurfaceVisibilityState.snapshot = {
        focusedSessionId: sessionSurfaceVisibilityState.focusedSessionId,
        routeAnchorSessionId: sessionSurfaceVisibilityState.routeAnchorSessionId,
        visibleSessionIds: visibleIdsChanged ? visibleSessionIds : previousSnapshot.visibleSessionIds,
    };
    emitChange();
}

/** Only exact, actually rendered Home-qualified surfaces; no focus/subscription inference. */
export function getVisibleSessionSurfaces(): readonly SessionAddress[] {
    return sessionSurfaceVisibilityState.visibleSurfaces ?? [];
}

/** Visible list rows demand metadata hydration, never transcript consumption or human presence. */
export function getVisibleSessionListSurfaces(): readonly SessionAddress[] {
    return sessionSurfaceVisibilityState.visibleListSurfaces;
}

function refreshVisibleSessionListSurfaces(): void {
    const next = Array.from(sessionSurfaceVisibilityState.visibleListRows.values(), value => value.address)
        .sort((a, b) => a.serverId.localeCompare(b.serverId) || a.sessionId.localeCompare(b.sessionId));
    const previous = sessionSurfaceVisibilityState.visibleListSurfaces;
    if (next.length === previous.length && next.every((address, index) => (
        address.serverId === previous[index].serverId && address.sessionId === previous[index].sessionId
    ))) return;
    sessionSurfaceVisibilityState.visibleListSurfaces = next;
    emitChange();
}

/** Each mounted pane retains its own viewport; releasing one pane cannot hide another's rows. */
export function retainVisibleSessionListSurfaces(addresses: readonly SessionAddress[]): () => void {
    const keys = new Set<string>();
    for (const address of addresses) {
        const identity = resolveVisibleSessionIdentity(address.sessionId, address.serverId);
        if (!identity.serverId || !identity.sessionId || !identity.sessionKey || keys.has(identity.sessionKey)) continue;
        keys.add(identity.sessionKey);
        const current = sessionSurfaceVisibilityState.visibleListRows.get(identity.sessionKey);
        sessionSurfaceVisibilityState.visibleListRows.set(identity.sessionKey, {
            address: current?.address ?? { serverId: identity.serverId, sessionId: identity.sessionId },
            count: (current?.count ?? 0) + 1,
        });
    }
    refreshVisibleSessionListSurfaces();
    const resetVersion = sessionSurfaceVisibilityState.resetVersion;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (resetVersion !== sessionSurfaceVisibilityState.resetVersion) return;
        for (const key of keys) {
            const current = sessionSurfaceVisibilityState.visibleListRows.get(key);
            if (!current || current.count <= 1) sessionSurfaceVisibilityState.visibleListRows.delete(key);
            else sessionSurfaceVisibilityState.visibleListRows.set(key, { ...current, count: current.count - 1 });
        }
        refreshVisibleSessionListSurfaces();
    };
}

export function isSessionListRowVisible(sessionId: string, serverId?: string | null): boolean {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return false;
    const normalizedServerId = normalizeNullableServerId(serverId);
    return getVisibleSessionListSurfaces().some(address => address.sessionId === normalizedSessionId && (
        !normalizedServerId || areServerProfileIdentifiersEquivalent(address.serverId, normalizedServerId)
    ));
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

export function getFocusedSessionAddress(): SessionAddress | null {
    return sessionSurfaceVisibilityState.focusedSessionAddress;
}

export function useFocusedSessionAddress(): SessionAddress | null {
    useSessionSurfaceVisibilitySnapshot();
    return sessionSurfaceVisibilityState.focusedSessionAddress;
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
}

export function setFocusedSessionId(sessionId: string | null, serverId?: string | null): void {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    const address = identity.serverId && identity.sessionId
        ? { serverId: identity.serverId, sessionId: identity.sessionId } : null;
    const previousAddress = sessionSurfaceVisibilityState.focusedSessionAddress;
    const addressChanged = previousAddress?.serverId !== address?.serverId || previousAddress?.sessionId !== address?.sessionId;
    sessionSurfaceVisibilityState.focusedSessionId = identity.sessionId;
    if (addressChanged) sessionSurfaceVisibilityState.focusedSessionAddress = address;
    // Every real activation converges here, including retained tabs and routed opens.
    // Visibility alone (for example an unfocused split pane) is not a recent visit.
    if (identity.sessionKey) rememberSessionVisit(identity.sessionKey);
    refreshSnapshot(addressChanged);
}

export function clearFocusedSessionId(sessionId: string, serverId?: string | null): void {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    const normalizedSessionId = identity.sessionId;
    if (!normalizedSessionId) return;
    const focusedAddress = sessionSurfaceVisibilityState.focusedSessionAddress;
    const clearsExactFocus = !identity.serverId
        || !focusedAddress
        || areServerProfileIdentifiersEquivalent(focusedAddress.serverId, identity.serverId);
    if (sessionSurfaceVisibilityState.focusedSessionId === normalizedSessionId && clearsExactFocus) {
        sessionSurfaceVisibilityState.focusedSessionId = null;
        sessionSurfaceVisibilityState.focusedSessionAddress = null;
        refreshSnapshot();
    }
}

export function getFocusedSessionId(): string | null {
    return sessionSurfaceVisibilityState.focusedSessionId;
}

export function setRouteAnchorSessionId(sessionId: string | null, serverId?: string | null): void {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    const address = serverId !== null && identity.serverId && identity.sessionId
        ? { serverId: identity.serverId, sessionId: identity.sessionId } : null;
    const previousAddress = sessionSurfaceVisibilityState.routeAnchorSessionAddress;
    const addressChanged = previousAddress?.serverId !== address?.serverId || previousAddress?.sessionId !== address?.sessionId;
    sessionSurfaceVisibilityState.routeAnchorSessionId = identity.sessionId;
    if (addressChanged) sessionSurfaceVisibilityState.routeAnchorSessionAddress = address;
    refreshSnapshot(addressChanged);
}

export function clearRouteAnchorSessionId(sessionId: string): void {
    const normalizedSessionId = normalizeNullableSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (sessionSurfaceVisibilityState.routeAnchorSessionId === normalizedSessionId) {
        sessionSurfaceVisibilityState.routeAnchorSessionId = null;
        sessionSurfaceVisibilityState.routeAnchorSessionAddress = null;
        refreshSnapshot();
    }
}

export function getRouteAnchorSessionId(): string | null {
    return sessionSurfaceVisibilityState.routeAnchorSessionId;
}

export function getRouteAnchorSessionAddress(): SessionAddress | null {
    return sessionSurfaceVisibilityState.routeAnchorSessionAddress ?? null;
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
    sessionSurfaceVisibilityState.focusedSessionAddress = null;
    sessionSurfaceVisibilityState.routeAnchorSessionId = null;
    sessionSurfaceVisibilityState.routeAnchorSessionAddress = null;
    refreshSnapshot();
    if (options.notifyMountedSurfaces) {
        sessionSurfaceVisibilityState.resetVersion += 1;
        emitReset();
    }
}

export function clearSessionSurfaceVisibilityForServerScopeReset(): void {
    sessionSurfaceVisibilityState.visibleListRows.clear();
    refreshVisibleSessionListSurfaces();
    clearSessionSurfaceVisibility({ notifyMountedSurfaces: true });
}

function getSessionRouteSegments(pathname: string): string[] {
    const segments = pathname.trim().split(/[?#]/)[0].split('/')
        .map((segment) => segment.trim()).filter(Boolean);
    return segments[0] === 'embed' ? segments.slice(1) : segments;
}

function decodeRouteSegment(segment: string): string {
    try { return decodeURIComponent(segment); } catch { return segment; }
}

export function isSessionRoutePathActive(pathname: string, sessionId: string): boolean {
    const segments = getSessionRouteSegments(pathname);
    return segments[0] === 'session' && Boolean(segments[1])
        && decodeRouteSegment(segments[1]) === String(sessionId ?? '').trim();
}

export function isSessionRootRoutePathActive(pathname: string, sessionId: string): boolean {
    return getSessionRouteSegments(pathname).length === 2 && isSessionRoutePathActive(pathname, sessionId);
}

function isSessionRoutePathname(pathname: string | null | undefined): boolean {
    if (typeof pathname !== 'string') return true;
    const segments = getSessionRouteSegments(pathname);
    return segments[0] === 'session' && Boolean(segments[1]);
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
