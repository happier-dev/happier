/**
 * Module-scoped tracker for the session the user is currently viewing.
 *
 * The notification handler (`Notifications.setNotificationHandler`) runs outside
 * the React component tree so it cannot use hooks. This singleton provides a
 * synchronous way to check which session is on-screen, enabling same-session
 * notification suppression.
 */

import { normalizeSessionListKeyParts } from './listing/sessionListKeyNormalization';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';

type ActiveViewingSessionEntry = Readonly<{
    sessionId: string;
    activationId: number | null;
    serverId: string | null;
}>;

type ActiveViewingSessionState = {
    activeViewingSessionEntries: ActiveViewingSessionEntry[];
    visibleSessionRefCounts: Map<string, number>;
    visibleSessionScopedRefCounts: Map<string, number>;
    visibleScopedSessionKeysBySessionId: Map<string, Set<string>>;
    visibleScopedSessionServerIdsBySessionId: Map<string, Set<string>>;
    visibleScopedSessionServerIdBySessionKey: Map<string, string>;
};

type ActiveViewingSessionResetState = {
    version: number;
    listeners: Set<() => void>;
};

const activeViewingSessionStateKey = '__HAPPIER_ACTIVE_VIEWING_SESSION_STATE__';
const activeViewingSessionResetStateKey = '__HAPPIER_ACTIVE_VIEWING_SESSION_RESET_STATE__';

function createActiveViewingSessionState(): ActiveViewingSessionState {
    return {
        activeViewingSessionEntries: [],
        visibleSessionRefCounts: new Map<string, number>(),
        visibleSessionScopedRefCounts: new Map<string, number>(),
        visibleScopedSessionKeysBySessionId: new Map<string, Set<string>>(),
        visibleScopedSessionServerIdsBySessionId: new Map<string, Set<string>>(),
        visibleScopedSessionServerIdBySessionKey: new Map<string, string>(),
    };
}

function getActiveViewingSessionState(): ActiveViewingSessionState {
    const host = globalThis as typeof globalThis & { [activeViewingSessionStateKey]?: ActiveViewingSessionState };
    host[activeViewingSessionStateKey] ??= createActiveViewingSessionState();
    return host[activeViewingSessionStateKey];
}

function getActiveViewingSessionResetState(): ActiveViewingSessionResetState {
    const host = globalThis as typeof globalThis & {
        [activeViewingSessionResetStateKey]?: ActiveViewingSessionResetState;
    };
    host[activeViewingSessionResetStateKey] ??= {
        version: 0,
        listeners: new Set<() => void>(),
    };
    return host[activeViewingSessionResetStateKey];
}

const activeViewingSessionState = getActiveViewingSessionState();
const visibleSessionRefCounts = activeViewingSessionState.visibleSessionRefCounts;
const visibleSessionScopedRefCounts = activeViewingSessionState.visibleSessionScopedRefCounts;
const visibleScopedSessionKeysBySessionId = activeViewingSessionState.visibleScopedSessionKeysBySessionId;
const visibleScopedSessionServerIdsBySessionId = activeViewingSessionState.visibleScopedSessionServerIdsBySessionId;
const visibleScopedSessionServerIdBySessionKey = activeViewingSessionState.visibleScopedSessionServerIdBySessionKey;
const activeViewingSessionResetState = getActiveViewingSessionResetState();

export function subscribeActiveViewingSessionReset(listener: () => void): () => void {
    activeViewingSessionResetState.listeners.add(listener);
    return () => {
        activeViewingSessionResetState.listeners.delete(listener);
    };
}

export function getActiveViewingSessionResetVersion(): number {
    return activeViewingSessionResetState.version;
}

function normalizeText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeSessionId(value: unknown): string {
    return normalizeText(value);
}

function normalizeServerId(value: unknown): string {
    const serverId = normalizeText(value);
    return serverId ? resolveServerProfileScopeIdForIdentifier(serverId) || serverId : '';
}

function resolveVisibleSessionIdentity(sessionIdRaw: unknown, serverIdRaw?: unknown): Readonly<{
    sessionId: string;
    serverId: string | null;
    sessionKey: string | null;
}> {
    const sessionId = normalizeSessionId(sessionIdRaw);
    const explicitServerId = normalizeServerId(serverIdRaw);
    if (!sessionId) {
        return { sessionId: '', serverId: null, sessionKey: null };
    }

    const serverId = explicitServerId || resolveServerIdForSessionIdFromLocalCache(sessionId) || '';
    const sessionKey = normalizeSessionListKeyParts(serverId, sessionId).sessionKey;
    return {
        sessionId,
        serverId: serverId || null,
        sessionKey,
    };
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

function getCurrentActiveViewingSessionEntry(): ActiveViewingSessionEntry | null {
    const entries = activeViewingSessionState.activeViewingSessionEntries;
    return entries[entries.length - 1] ?? null;
}

function removeActiveViewingSessionEntryAt(index: number): void {
    const entries = activeViewingSessionState.activeViewingSessionEntries;
    activeViewingSessionState.activeViewingSessionEntries = [
        ...entries.slice(0, index),
        ...entries.slice(index + 1),
    ];
}

export const getActiveViewingSessionId = (): string | null => getCurrentActiveViewingSessionEntry()?.sessionId ?? null;
export const getActiveViewingSessionActivationId = (): number | null => getCurrentActiveViewingSessionEntry()?.activationId ?? null;

export const setActiveViewingSessionId = (
    sessionId: string,
    activationId: number | null = null,
    serverId?: string | null,
): void => {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    if (!identity.sessionId) return;
    activeViewingSessionState.activeViewingSessionEntries = [
        ...activeViewingSessionState.activeViewingSessionEntries,
        { sessionId: identity.sessionId, activationId, serverId: identity.serverId },
    ];
};

export const clearActiveViewingSessionId = (
    sessionId: string,
    activationId?: number | null,
    serverId?: string | null,
): void => {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    if (!identity.sessionId) return;

    if (activationId !== undefined) {
        const index = activeViewingSessionState.activeViewingSessionEntries.findIndex(
            (entry) => (
                entry.sessionId === identity.sessionId
                && entry.activationId === activationId
                && (
                    identity.serverId == null
                    || entry.serverId == null
                    || entry.serverId === identity.serverId
                )
            ),
        );
        if (index >= 0) {
            removeActiveViewingSessionEntryAt(index);
        }
        return;
    }

    const index = activeViewingSessionState.activeViewingSessionEntries.findIndex((entry) => (
        entry.sessionId === identity.sessionId
        && (
            identity.serverId == null
            || entry.serverId == null
            || entry.serverId === identity.serverId
        )
    ));
    if (index >= 0) {
        removeActiveViewingSessionEntryAt(index);
    }
};

function clearActiveViewingSessions(options: Readonly<{ notifyMountedSurfaces: boolean }>): void {
    activeViewingSessionState.activeViewingSessionEntries = [];
    visibleSessionRefCounts.clear();
    visibleSessionScopedRefCounts.clear();
    visibleScopedSessionKeysBySessionId.clear();
    visibleScopedSessionServerIdsBySessionId.clear();
    visibleScopedSessionServerIdBySessionKey.clear();
    if (!options.notifyMountedSurfaces) return;
    activeViewingSessionResetState.version += 1;
    for (const listener of activeViewingSessionResetState.listeners) {
        listener();
    }
}

export const clearActiveViewingSessionsForServerScopeReset = (): void => {
    clearActiveViewingSessions({ notifyMountedSurfaces: true });
};

function isSessionRoutePathname(pathname: string | null | undefined): boolean {
    if (typeof pathname !== 'string') return true;
    const route = pathname.trim().split('?')[0]?.replace(/\/+$/, '') ?? '';
    return /^\/session\/[^/]+(?:\/.*)?$/.test(route);
}

export const clearActiveViewingSessionsForNonSessionRoute = (pathname: string | null | undefined): boolean => {
    if (isSessionRoutePathname(pathname)) return false;
    const hadViewingState = activeViewingSessionState.activeViewingSessionEntries.length > 0
        || visibleSessionRefCounts.size > 0
        || visibleSessionScopedRefCounts.size > 0
        || visibleScopedSessionKeysBySessionId.size > 0
        || visibleScopedSessionServerIdsBySessionId.size > 0
        || visibleScopedSessionServerIdBySessionKey.size > 0;
    if (!hadViewingState) return false;
    clearActiveViewingSessions({ notifyMountedSurfaces: false });
    return true;
};

export const markSessionVisible = (sessionId: string, serverId?: string | null): void => {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    if (!identity.sessionId) return;

    visibleSessionRefCounts.set(identity.sessionId, (visibleSessionRefCounts.get(identity.sessionId) ?? 0) + 1);
    if (!identity.sessionKey) return;

    visibleSessionScopedRefCounts.set(
        identity.sessionKey,
        (visibleSessionScopedRefCounts.get(identity.sessionKey) ?? 0) + 1,
    );
    if (identity.serverId) {
        addVisibleScopedSessionKey(identity.sessionId, identity.sessionKey, identity.serverId);
    }
};

export const registerSessionVisibleSurface = (sessionId: string, serverId?: string | null): (() => void) => {
    const resetVersion = activeViewingSessionResetState.version;
    markSessionVisible(sessionId, serverId);
    return () => {
        // A server-scope reset already released every hold from the prior generation.
        // Its delayed React cleanup must not consume a newly registered hold.
        if (activeViewingSessionResetState.version !== resetVersion) return;
        markSessionHidden(sessionId, serverId);
    };
};

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

    const currentScoped = visibleSessionScopedRefCounts.get(scopedSessionKey) ?? 0;
    if (currentScoped <= 1) {
        visibleSessionScopedRefCounts.delete(scopedSessionKey);
        removeVisibleScopedSessionKey(identity.sessionId, scopedSessionKey);
        return;
    }
    visibleSessionScopedRefCounts.set(scopedSessionKey, currentScoped - 1);
}

export const markSessionHidden = (sessionId: string, serverId?: string | null): void => {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    if (!identity.sessionId) return;
    const current = visibleSessionRefCounts.get(identity.sessionId) ?? 0;
    if (current <= 1) {
        visibleSessionRefCounts.delete(identity.sessionId);
    } else {
        visibleSessionRefCounts.set(identity.sessionId, current - 1);
    }
    decrementVisibleScopedSession(identity);
};

export const getVisibleSessionIds = (): string[] => Array.from(new Set([
    ...visibleSessionRefCounts.keys(),
    ...visibleScopedSessionKeysBySessionId.keys(),
]));

export const isSessionVisible = (sessionId: string, serverId?: string | null): boolean => {
    const identity = resolveVisibleSessionIdentity(sessionId, serverId);
    if (!identity.sessionId) return false;
    if (identity.sessionKey && visibleSessionScopedRefCounts.has(identity.sessionKey)) {
        return true;
    }

    const hasScopedVisibility = (visibleScopedSessionKeysBySessionId.get(identity.sessionId)?.size ?? 0) > 0;
    if (identity.serverId && hasScopedVisibility) {
        return hasEquivalentVisibleScopedServer(identity.sessionId, identity.serverId);
    }

    return visibleSessionRefCounts.has(identity.sessionId);
};
