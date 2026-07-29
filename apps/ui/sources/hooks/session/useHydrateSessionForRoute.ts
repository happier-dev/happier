import * as React from 'react';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import type {
    EnsureSessionVisibleForRouteResult,
    SessionRouteHydrationState,
} from '@/sync/domains/session/sessionRouteHydrationState';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { hasAuthoritativeSessionRouteData } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';

type SessionRouteHydrationStateRecord = Readonly<{
    routeKey: string;
    state: SessionRouteHydrationState;
}>;

function normalizeRouteId(value: unknown): string {
    return String(value ?? '').trim();
}

function areRouteServerIdsEqual(leftRaw: unknown, rightRaw: unknown): boolean {
    const left = normalizeRouteId(leftRaw);
    const right = normalizeRouteId(rightRaw);
    if (!left || !right) return left === right;
    return areServerProfileIdentifiersEquivalent(left, right);
}

function hasAuthoritativeHydratedSessionForRoute(sessionId: string, serverId?: string | null): boolean {
    const session = storage.getState().sessions[sessionId] ?? null;
    if (!session || !hasAuthoritativeSessionRouteData(session)) {
        return false;
    }
    if (serverId && !areRouteServerIdsEqual(String(session.serverId ?? '').trim(), serverId)) {
        return false;
    }
    if (session.encryptionMode === 'plain') {
        return true;
    }
    try {
        return Boolean(sync.encryption?.getSessionEncryption?.(sessionId));
    } catch {
        return false;
    }
}

function createLoadingState(
    sessionId: string,
    serverId: string | undefined,
    reason: Extract<SessionRouteHydrationState, { kind: 'loading' }>['reason'],
): SessionRouteHydrationState {
    return {
        kind: 'loading',
        sessionId,
        ...(serverId ? { serverId } : {}),
        reason,
    };
}

function createAvailableState(sessionId: string, serverId?: string): SessionRouteHydrationState {
    return {
        kind: 'available',
        sessionId,
        ...(serverId ? { serverId } : {}),
    };
}

function createRetryingState(
    sessionId: string,
    serverId: string | undefined,
    cause: Extract<SessionRouteHydrationState, { kind: 'retrying' }>['cause'],
): SessionRouteHydrationState {
    return {
        kind: 'retrying',
        sessionId,
        ...(serverId ? { serverId } : {}),
        cause,
    };
}

function createMissingState(
    sessionId: string,
    serverId: string | undefined,
    cause: Extract<SessionRouteHydrationState, { kind: 'missing' }>['cause'],
): SessionRouteHydrationState {
    return {
        kind: 'missing',
        sessionId,
        ...(serverId ? { serverId } : {}),
        cause,
    };
}

function readHydratedRouteServerId(sessionId: string, serverId?: string): string | undefined | null {
    if (hasAuthoritativeHydratedSessionForRoute(sessionId, serverId ?? null)) {
        return serverId;
    }

    if (!serverId) return null;
    const sessionServerId = normalizeRouteId(storage.getState().sessions[sessionId]?.serverId);
    const activeServerId = normalizeRouteId(getActiveServerSnapshot().serverId);
    if (!sessionServerId || !activeServerId) return null;
    if (!areRouteServerIdsEqual(sessionServerId, activeServerId)) return null;
    return hasAuthoritativeHydratedSessionForRoute(sessionId, sessionServerId) ? sessionServerId : null;
}

function readHydratedRouteSnapshot(sessionId: string, serverId?: string): boolean {
    return readHydratedRouteServerId(sessionId, serverId) !== null;
}

function uniqueRouteServerIds(...serverIds: readonly unknown[]): string[] {
    const result: string[] = [];
    for (const rawServerId of serverIds) {
        const serverId = normalizeRouteId(rawServerId);
        if (!serverId) continue;
        if (result.some((existing) => areRouteServerIdsEqual(existing, serverId))) continue;
        result.push(serverId);
    }
    return result;
}

function resolveHydratedServerIdForRouteResult(
    sessionId: string,
    routeServerId: string | undefined,
    resultServerId: string | null | undefined,
): string | undefined | null {
    for (const candidateServerId of uniqueRouteServerIds(routeServerId, resultServerId)) {
        if (readHydratedRouteSnapshot(sessionId, candidateServerId)) {
            return candidateServerId;
        }
    }
    if (!routeServerId && readHydratedRouteSnapshot(sessionId, undefined)) {
        return undefined;
    }
    return null;
}

/**
 * Best-effort hydration for deep links / hard refreshes.
 *
 * Some session sub-routes (e.g. fullscreen sidebar/details screens on mobile) can be opened directly
 * without mounting the main `SessionView`, which normally ensures the session exists in storage and
 * initializes its encryption state. Without this, any session-scoped RPC will fail with
 * "Session encryption not found".
 *
 * On failure, this hook retries with exponential backoff to handle transient errors
 * (server switch in flight, temporary RPC failure, stale encryption state, etc.).
 */
export function useHydrateSessionForRoute(
    sessionId: string,
    tag: string,
    options?: Readonly<{ serverId?: string; forceRefresh?: boolean }>,
): SessionRouteHydrationState {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedServerId = String(options?.serverId ?? '').trim();
    const routeServerId = normalizedServerId || undefined;
    const routeKey = `${routeServerId ?? ''}\n${normalizedSessionId}`;
    const forceRefresh = options?.forceRefresh === true;
    const hasHydratedSession = React.useSyncExternalStore(
        storage.subscribe,
        () => readHydratedRouteSnapshot(normalizedSessionId, routeServerId),
        () => readHydratedRouteSnapshot(normalizedSessionId, routeServerId),
    );
    const [routeStateRecord, setRouteStateRecord] = React.useState<SessionRouteHydrationStateRecord>(() => ({
        routeKey,
        state: !normalizedSessionId
            ? createMissingState('', routeServerId, 'not_found')
            : !forceRefresh && readHydratedRouteSnapshot(normalizedSessionId, routeServerId)
                ? createAvailableState(normalizedSessionId, routeServerId)
                : createLoadingState(normalizedSessionId, routeServerId, forceRefresh ? 'refreshing' : 'cold'),
    }));

    React.useEffect(() => {
        let canceled = false;
        let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let attemptCount = 0;

        if (!normalizedSessionId) {
            setRouteStateRecord({ routeKey, state: createMissingState('', routeServerId, 'not_found') });
            return;
        }
        if (!forceRefresh && hasHydratedSession) {
            setRouteStateRecord({ routeKey, state: createAvailableState(normalizedSessionId, routeServerId) });
            return;
        }
        setRouteStateRecord({
            routeKey,
            state: createLoadingState(normalizedSessionId, routeServerId, forceRefresh ? 'refreshing' : 'store-miss'),
        });

        const attemptHydration = () => {
            if (canceled) return;

            attemptCount++;
            const hydrationOptions = {
                ...(forceRefresh ? { forceRefresh: true } : {}),
                ...(routeServerId ? { serverId: routeServerId } : {}),
            };
            const promise = (sync.ensureSessionVisibleForMessageRoute as (
                sessionId: string,
                options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>,
            ) => Promise<EnsureSessionVisibleForRouteResult>)(normalizedSessionId, Object.keys(hydrationOptions).length > 0 ? hydrationOptions : undefined);
            fireAndForget(promise, { tag });

            void promise
                .then((result) => {
                    if (canceled) return;
                    if (result.kind === 'missing') {
                        setRouteStateRecord({
                            routeKey,
                            state: createMissingState(
                                normalizedSessionId,
                                normalizeRouteId(result.serverId) || routeServerId,
                                result.cause,
                            ),
                        });
                        return;
                    }
                    if (result.kind === 'available') {
                        const hydratedServerId = resolveHydratedServerIdForRouteResult(
                            normalizedSessionId,
                            routeServerId,
                            result.serverId,
                        );
                        if (hydratedServerId !== null) {
                            setRouteStateRecord({
                                routeKey,
                                state: createAvailableState(normalizedSessionId, hydratedServerId),
                            });
                            return;
                        }
                    }
                    setRouteStateRecord({
                        routeKey,
                        state: createRetryingState(
                            normalizedSessionId,
                            routeServerId,
                            result.kind === 'retryable_failure' ? result.cause : 'decrypting',
                        ),
                    });
                    // Retry with exponential backoff: 2s, 4s, 8s, 16s, max 30s
                    const retryDelayMs = Math.min(2000 * Math.pow(2, attemptCount - 1), 30000);
                    retryTimeoutId = setTimeout(() => {
                        if (!canceled) {
                            attemptHydration();
                        }
                    }, retryDelayMs);
                })
                .catch(() => {
                    if (canceled) return;
                    setRouteStateRecord({
                        routeKey,
                        state: createRetryingState(normalizedSessionId, routeServerId, 'unknown'),
                    });
                    // Retry with exponential backoff: 2s, 4s, 8s, 16s, max 30s
                    const retryDelayMs = Math.min(2000 * Math.pow(2, attemptCount - 1), 30000);
                    retryTimeoutId = setTimeout(() => {
                        if (!canceled) {
                            attemptHydration();
                        }
                    }, retryDelayMs);
                });
        };

        attemptHydration();

        return () => {
            canceled = true;
            if (retryTimeoutId !== null) {
                clearTimeout(retryTimeoutId);
            }
        };
    }, [forceRefresh, hasHydratedSession, normalizedSessionId, routeKey, routeServerId, tag]);

    const routeState = routeStateRecord.routeKey === routeKey
        ? routeStateRecord.state
        : createLoadingState(normalizedSessionId, routeServerId, 'server-switch');

    const hydratedAvailableServerId = normalizedSessionId && hasHydratedSession && routeState.kind !== 'missing'
        ? readHydratedRouteServerId(normalizedSessionId, routeServerId) ?? routeServerId
        : null;
    const hydratedAvailableState = React.useMemo<SessionRouteHydrationState | null>(() => {
        if (hydratedAvailableServerId === null) return null;
        return createAvailableState(normalizedSessionId, hydratedAvailableServerId);
    }, [hydratedAvailableServerId, normalizedSessionId]);

    return hydratedAvailableState ?? routeState;
}
