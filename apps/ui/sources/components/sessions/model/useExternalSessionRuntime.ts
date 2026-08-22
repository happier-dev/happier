import * as React from 'react';
import {
    readExternalAgentObservationSessionState,
    type ExternalAgentObservationSnapshotV1,
} from '@happier-dev/agents';
import type { ExternalSessionStatusGetResponse } from '@happier-dev/protocol';
import { AppState, Platform } from 'react-native';

import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    machineExternalSessionAttach,
    machineExternalSessionDetach,
    machineExternalSessionStatusGet,
} from '@/sync/ops/machineExternalSessions';
import { isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import {
    replaceExternalSessionStatusDemandViewport,
} from '@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';
import { sync } from '@/sync/sync';
import {
    createExternalSessionTranscriptLeaseScopeKeyFromLink,
} from '@/sync/runtime/external/externalSessionTranscriptAuthority';

export type ExternalSessionRuntimeStatus = Extract<ExternalSessionStatusGetResponse, { ok: true }>;

export type ExternalSessionRuntimeRefreshOptions = Readonly<{
    takeoverReadiness?: 'fresh';
}>;

type UseExternalSessionRuntimeParams = Readonly<{
    sessionId: string;
    metadata: Metadata | null | undefined;
    enabled?: boolean;
}>;

export type UseExternalSessionRuntimeResult = Readonly<{
    externalSessionLink: ReturnType<typeof readExternalSessionLink>;
    externalAgent: ExternalAgentObservationSnapshotV1 | null;
    sessionServerId: string | null;
    status: ExternalSessionRuntimeStatus | null;
    refreshNow: (options?: ExternalSessionRuntimeRefreshOptions) => Promise<ExternalSessionRuntimeStatus | null>;
}>;

type ExternalSessionTarget = Readonly<{
    machineId: string;
    agentId: NonNullable<ReturnType<typeof readExternalSessionLink>>['agentId'];
    remoteSessionId: string;
    source: NonNullable<ReturnType<typeof readExternalSessionLink>>['source'];
}>;

function readAttachLeaseTtlMsFromEnv(): number {
    const raw = Number.parseInt(String(process.env.EXPO_PUBLIC_HAPPIER_EXTERNAL_SESSIONS_ATTACH_LEASE_TTL_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 30_000;
    return Math.max(1_000, Math.min(15 * 60_000, configured));
}

function readAttachRenewLeadMsFromEnv(): number {
    const raw = Number.parseInt(String(process.env.EXPO_PUBLIC_HAPPIER_EXTERNAL_SESSIONS_ATTACH_RENEW_LEAD_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10_000;
    return Math.max(500, Math.min(60_000, configured));
}

function readAttachRetryMsFromEnv(): number {
    const raw = Number.parseInt(String(process.env.EXPO_PUBLIC_HAPPIER_EXTERNAL_SESSIONS_ATTACH_RETRY_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 5_000;
    return Math.max(1_000, Math.min(60_000, configured));
}

const noopSubscribe = () => () => {};

function useRuntimeActive(enabled: boolean): boolean {
    const [runtimeActive, setRuntimeActive] = React.useState(() => enabled && isRuntimeActive());

    React.useEffect(() => {
        if (!enabled) {
            setRuntimeActive(false);
            return;
        }

        const update = () => {
            setRuntimeActive(isRuntimeActive());
        };

        update();

        const appStateSubscription = AppState.addEventListener('change', update);
        let removeVisibilityListener: (() => void) | null = null;
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', update);
            removeVisibilityListener = () => {
                document.removeEventListener('visibilitychange', update);
            };
        }

        return () => {
            appStateSubscription?.remove?.();
            removeVisibilityListener?.();
        };
    }, [enabled]);

    return runtimeActive;
}

export function useExternalSessionRuntime(params: UseExternalSessionRuntimeParams): UseExternalSessionRuntimeResult {
    const runtimeEnabled = params.enabled !== false && !isDemoModeActive();
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);
    const externalSessionLink = React.useMemo(
        () => readExternalSessionLink(params.metadata),
        [params.metadata],
    );
    const externalAgent = React.useMemo(
        () => readExternalAgentObservationSessionState(params.metadata ?? {}).value,
        [params.metadata],
    );
    const externalSessionTargetKey = React.useMemo(() => {
        if (!externalSessionLink) return null;
        return createExternalSessionTranscriptLeaseScopeKeyFromLink(externalSessionLink);
    }, [externalSessionLink]);
    const externalSessionTarget = React.useMemo<ExternalSessionTarget | null>(() => {
        if (!externalSessionLink) return null;
        return {
            machineId: externalSessionLink.machineId,
            agentId: externalSessionLink.agentId,
            remoteSessionId: externalSessionLink.remoteSessionId,
            source: externalSessionLink.source,
        };
    }, [externalSessionTargetKey]);
    const [status, setStatus] = React.useState<ExternalSessionRuntimeStatus | null>(null);
    const statusRef = React.useRef<ExternalSessionRuntimeStatus | null>(null);
    const inFlightRefreshRef = React.useRef<Promise<ExternalSessionRuntimeStatus | null> | null>(null);
    const currentLeaseIdRef = React.useRef<string | null>(null);
    const acceptedTailCursor = React.useSyncExternalStore(
        React.useCallback(
            (listener) => runtimeEnabled
                ? sync.subscribeAcceptedExternalSessionTailCursor(
                    normalizedSessionId,
                    listener,
                )
                : noopSubscribe(),
            [normalizedSessionId, runtimeEnabled],
        ),
        React.useCallback(
            () => runtimeEnabled
                ? sync.getAcceptedExternalSessionTailCursor(normalizedSessionId)
                : null,
            [normalizedSessionId, runtimeEnabled],
        ),
        () => null,
    );
    const acceptedTailCursorRef = React.useRef<string | null>(acceptedTailCursor);
    acceptedTailCursorRef.current = acceptedTailCursor;
    const lastDemandedTailCursorRef = React.useRef<string | null | undefined>(undefined);
    const requestLeaseEnsureRef = React.useRef<(() => void) | null>(null);
    const generationRef = React.useRef(0);
    const previousServerIdRef = React.useRef<string | null | undefined>(undefined);
    const previousRuntimeScopeRef = React.useRef<string | null>(null);
    const runtimeActive = useRuntimeActive(runtimeEnabled);
    const sessionServerId = usePreferredServerIdForSession(
        normalizedSessionId,
        undefined,
        runtimeEnabled,
    );
    const statusDemandViewportId = React.useId();
    const statusDemandEntry = React.useMemo(() => {
        const linkGeneration = externalSessionLink?.linkedAtMs;
        if (
            !runtimeEnabled
            || !runtimeActive
            || !externalSessionLink
            || typeof linkGeneration !== 'number'
            || !Number.isFinite(linkGeneration)
        ) {
            return null;
        }
        const serverId = String(
            sessionServerId ?? getActiveServerSnapshot().serverId,
        ).trim();
        if (!serverId) {
            return null;
        }
        return {
            serverId,
            sessionId: normalizedSessionId,
            machineId: externalSessionLink.machineId,
            linkGeneration: String(linkGeneration),
            demand: 'open' as const,
        };
    }, [
        externalSessionLink?.linkedAtMs,
        externalSessionLink?.machineId,
        normalizedSessionId,
        runtimeActive,
        runtimeEnabled,
        sessionServerId,
    ]);

    React.useEffect(() => {
        statusRef.current = status;
    }, [status]);

    React.useEffect(() => {
        if (previousServerIdRef.current === sessionServerId) {
            return;
        }
        if (previousServerIdRef.current !== undefined) {
            inFlightRefreshRef.current = null;
            generationRef.current += 1;
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
        }
        previousServerIdRef.current = sessionServerId;
    }, [sessionServerId]);

    React.useEffect(() => {
        if (!runtimeEnabled) {
            return;
        }
        if (!statusDemandEntry) {
            replaceExternalSessionStatusDemandViewport(statusDemandViewportId, []);
            return;
        }
        replaceExternalSessionStatusDemandViewport(statusDemandViewportId, [statusDemandEntry]);
        return () => {
            replaceExternalSessionStatusDemandViewport(statusDemandViewportId, []);
        };
    }, [
        runtimeEnabled,
        statusDemandEntry,
        statusDemandViewportId,
    ]);

    React.useEffect(() => {
        const nextRuntimeScope = runtimeEnabled && externalSessionTargetKey
            ? `${normalizedSessionId}:${externalSessionTargetKey}`
            : null;

        if (previousRuntimeScopeRef.current === nextRuntimeScope) {
            return;
        }

        if (previousRuntimeScopeRef.current !== null) {
            inFlightRefreshRef.current = null;
            generationRef.current += 1;
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
        }

        previousRuntimeScopeRef.current = nextRuntimeScope;
    }, [externalSessionTargetKey, normalizedSessionId, runtimeEnabled]);

    const refreshNow = React.useCallback(async (
        options?: ExternalSessionRuntimeRefreshOptions,
    ): Promise<ExternalSessionRuntimeStatus | null> => {
        if (!runtimeEnabled) {
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
            return null;
        }

        if (!externalSessionTarget) {
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
            return null;
        }

        const requiresFreshTakeoverReadiness = options?.takeoverReadiness === 'fresh';
        if (inFlightRefreshRef.current && !requiresFreshTakeoverReadiness) {
            return inFlightRefreshRef.current;
        }
        if (inFlightRefreshRef.current) {
            inFlightRefreshRef.current = null;
            generationRef.current += 1;
        }

        const currentGeneration = generationRef.current;
        // Status is Account-scoped: it is read from Account A's machine with
        // Account A's credentials. A switch to Account B mid-read must not
        // publish or return Account A's runtime state into Account B's scope.
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        let refreshPromise: Promise<ExternalSessionRuntimeStatus | null> | null = null;
        refreshPromise = (async () => {
            if (!accountCurrentness.isCurrent()) {
                return null;
            }
            const statusResult = await machineExternalSessionStatusGet({
                machineId: externalSessionTarget.machineId,
                sessionId: normalizedSessionId,
                agentId: externalSessionTarget.agentId,
                remoteSessionId: externalSessionTarget.remoteSessionId,
                source: externalSessionTarget.source,
                ...(requiresFreshTakeoverReadiness
                    ? { takeoverReadiness: 'fresh' as const }
                    : {}),
            }, { serverId: sessionServerId ?? undefined })
                .then((response) => ({ ok: true as const, response }))
                .catch((error: unknown) => ({ ok: false as const, error }));
            if (!statusResult.ok) {
                if (isTerminalAuthError(statusResult.error)) {
                    throw statusResult.error;
                }
                return null;
            }
            const response = statusResult.response;
            if (!response.ok) {
                return null;
            }

            if (
                generationRef.current !== currentGeneration
                || !accountCurrentness.isCurrent()
            ) {
                return null;
            }

            statusRef.current = response;
            setStatus(response);
            return response;
        })().finally(() => {
            if (inFlightRefreshRef.current === refreshPromise) {
                inFlightRefreshRef.current = null;
            }
        });

        inFlightRefreshRef.current = refreshPromise;
        return refreshPromise;
    }, [externalSessionTarget, normalizedSessionId, runtimeEnabled, sessionServerId]);

    React.useEffect(() => {
        if (!externalSessionTarget || !runtimeActive || !runtimeEnabled) {
            currentLeaseIdRef.current = null;
            return;
        }

        let cancelled = false;
        let renewTimeoutId: ReturnType<typeof setTimeout> | null = null;
        let attachInFlight = false;
        let attachPending = false;
        // Attach/detach are Account-scoped durable operations against Account A's
        // machine. Once that Account retires, this viewer must stop emitting: the
        // lease is reclaimed by its TTL rather than released under Account B.
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();

        const detachLease = (leaseId: string) => {
            if (!accountCurrentness.isCurrent()) return;
            void machineExternalSessionDetach({
                machineId: externalSessionTarget.machineId,
                sessionId: normalizedSessionId,
                leaseId,
            }, { serverId: sessionServerId ?? undefined }).catch(() => {});
        };

        const clearRenewTimeout = () => {
            if (renewTimeoutId) {
                clearTimeout(renewTimeoutId);
                renewTimeoutId = null;
            }
        };

        const scheduleRenew = (expiresAtMs: number) => {
            const renewLeadMs = readAttachRenewLeadMsFromEnv();
            const delayMs = Math.max(1_000, expiresAtMs - Date.now() - renewLeadMs);
            renewTimeoutId = setTimeout(() => {
                requestLeaseEnsure();
            }, delayMs);
        };

        const scheduleRetry = () => {
            const delayMs = readAttachRetryMsFromEnv();
            renewTimeoutId = setTimeout(() => {
                requestLeaseEnsure();
            }, delayMs);
        };

        const pumpLeaseEnsure = async () => {
            attachInFlight = true;
            try {
                do {
                    if (!accountCurrentness.isCurrent()) return;
                    attachPending = false;
                    const requestedTailCursor = acceptedTailCursorRef.current;
                    lastDemandedTailCursorRef.current = requestedTailCursor;
                    try {
                        const response = await machineExternalSessionAttach({
                            machineId: externalSessionTarget.machineId,
                            sessionId: normalizedSessionId,
                            agentId: externalSessionTarget.agentId,
                            remoteSessionId: externalSessionTarget.remoteSessionId,
                            source: externalSessionTarget.source,
                            ...(currentLeaseIdRef.current
                                ? { leaseId: currentLeaseIdRef.current }
                                : {}),
                            ...(requestedTailCursor
                                ? { acceptedTailCursor: requestedTailCursor }
                                : {}),
                            ttlMs: readAttachLeaseTtlMsFromEnv(),
                        }, { serverId: sessionServerId ?? undefined });
                        if (cancelled) {
                            // The lease outlived its viewer: nothing will renew
                            // or release it, so it would idle until its TTL.
                            if (response.ok) detachLease(response.leaseId);
                            return;
                        }
                        if (!response.ok) {
                            clearRenewTimeout();
                            if (
                                response.errorCode === 'agent_unavailable'
                                && response.error === 'background_follow_not_supported'
                            ) {
                                return;
                            }
                            // A daemon that classified the failure as terminal
                            // will answer the same way forever; released daemons
                            // omit the field and stay on the retry path.
                            if (response.retryable === false) {
                                return;
                            }
                            scheduleRetry();
                            return;
                        }
                        currentLeaseIdRef.current = response.leaseId;
                        clearRenewTimeout();
                        scheduleRenew(response.expiresAtMs);
                    } catch {
                        if (cancelled) return;
                        clearRenewTimeout();
                        scheduleRetry();
                        return;
                    }
                    if (acceptedTailCursorRef.current !== requestedTailCursor) {
                        attachPending = true;
                    }
                } while (attachPending && !cancelled && accountCurrentness.isCurrent());
            } finally {
                attachInFlight = false;
                if (attachPending && !cancelled && accountCurrentness.isCurrent()) {
                    void pumpLeaseEnsure();
                }
            }
        };

        const requestLeaseEnsure = () => {
            attachPending = true;
            if (!attachInFlight) {
                void pumpLeaseEnsure();
            }
        };

        requestLeaseEnsureRef.current = requestLeaseEnsure;
        requestLeaseEnsure();

        return () => {
            cancelled = true;
            requestLeaseEnsureRef.current = null;
            clearRenewTimeout();
            const leaseId = currentLeaseIdRef.current;
            currentLeaseIdRef.current = null;
            if (!leaseId) return;
            detachLease(leaseId);
        };
    }, [externalSessionTarget, normalizedSessionId, runtimeActive, runtimeEnabled, sessionServerId]);

    React.useEffect(() => {
        if (lastDemandedTailCursorRef.current === acceptedTailCursor) return;
        requestLeaseEnsureRef.current?.();
    }, [acceptedTailCursor]);

    return {
        externalSessionLink,
        externalAgent,
        sessionServerId,
        status,
        refreshNow,
    };
}
