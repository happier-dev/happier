import * as React from 'react';
import {
    readExternalAgentObservationSessionState,
    type ExternalAgentObservationSnapshotV1,
} from '@happier-dev/agents';
import type { ExternalSessionStatusGetResponse } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { AppState, Platform } from 'react-native';
import { allSignals, followSignal, useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Metadata } from '@happier-dev/session-core/state';
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

type UseExternalSessionRuntimeParams = Readonly<{
    sessionId: string;
    metadata: Metadata | null | undefined;
    /** Exact Home owning the Session when the caller already has a qualified address. */
    serverId?: string | null;
    enabled?: boolean;
    /**
     * The host surface's own demand (its focus), followed by subscription together with layout
     * presentation and the app being in the foreground: while it is off the runtime holds no lease and
     * no status demand, keeps the status it last showed, and renders nothing for the change.
     */
    active?: Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;
}>;

export type UseExternalSessionRuntimeResult = Readonly<{
    externalSessionLink: ReturnType<typeof readExternalSessionLink>;
    externalAgent: ExternalAgentObservationSnapshotV1 | null;
    sessionServerId: string | null;
    status: ExternalSessionRuntimeStatus | null;
    refreshNow: () => Promise<ExternalSessionRuntimeStatus | null>;
}>;

type ExternalSessionTarget = Readonly<{
    machineId: string;
    agentId: NonNullable<ReturnType<typeof readExternalSessionLink>>['agentId'];
    remoteSessionId: string;
    source: NonNullable<ReturnType<typeof readExternalSessionLink>>['source'];
}>;

const noopSubscribe = () => () => {};

const ALWAYS_ACTIVE = Object.freeze({ get: () => true, subscribe: () => () => {} });

/** The app in the foreground (and its web document visible), as a subscription. */
const RUNTIME_ACTIVE_SIGNAL = Object.freeze({
    get: isRuntimeActive,
    subscribe: (listener: () => void) => {
        const appStateSubscription = AppState.addEventListener('change', listener);
        const webDocument = Platform.OS === 'web' && typeof document !== 'undefined' ? document : null;
        webDocument?.addEventListener('visibilitychange', listener);
        return () => {
            appStateSubscription?.remove?.();
            webDocument?.removeEventListener('visibilitychange', listener);
        };
    },
});

export function useExternalSessionRuntime(params: UseExternalSessionRuntimeParams): UseExternalSessionRuntimeResult {
    const runtimeEnabled = params.enabled !== false && !isDemoModeActive();
    const presentation = useLayoutPresentationSignal();
    const hostActive = params.active ?? ALWAYS_ACTIVE;
    const activity = React.useMemo(() => allSignals(hostActive, presentation, RUNTIME_ACTIVE_SIGNAL),
        [hostActive, presentation]);
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
    const refreshControllerRef = React.useRef<AbortController | null>(null);
    const currentLeaseIdRef = React.useRef<string | null>(null);
    const acceptedTailCursor = React.useSyncExternalStore(
        React.useCallback(
            (listener) => runtimeEnabled
                ? followSignal(activity, (active) => {
                    if (!active) return;
                    // Catch up with a cursor accepted while inactive, then follow it.
                    listener();
                    return sync.subscribeAcceptedExternalSessionTailCursor(normalizedSessionId, listener);
                })
                : noopSubscribe(),
            [activity, normalizedSessionId, runtimeEnabled],
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
    const explicitServerId = typeof params.serverId === 'string' && params.serverId.trim().length > 0
        ? params.serverId.trim()
        : null;
    const preferredSessionServerId = usePreferredServerIdForSession(
        { serverId: explicitServerId, sessionId: normalizedSessionId },
        runtimeEnabled,
    );
    // An explicit, exact Session address needs no lookup: it stays the same while the surface is hidden,
    // so a hide/show keeps this runtime's identity. Only the legacy bare-id lookup follows `runtimeEnabled`.
    const sessionServerId = explicitServerId !== null && normalizedSessionId
        ? normalizeSessionAddress(explicitServerId, normalizedSessionId)?.serverId ?? preferredSessionServerId
        : preferredSessionServerId;
    React.useEffect(() => {
        const abortRefresh = () => {
            generationRef.current += 1;
            refreshControllerRef.current?.abort();
            refreshControllerRef.current = null;
            inFlightRefreshRef.current = null;
        };
        // Going inactive ends an in-flight read, as a scope change does.
        const unfollow = runtimeEnabled ? followSignal(activity, (active) => active ? undefined : abortRefresh()) : null;
        return () => { unfollow?.(); abortRefresh(); };
    }, [activity, externalSessionTargetKey, normalizedSessionId, runtimeEnabled, sessionServerId]);
    const statusDemandViewportId = React.useId();
    const statusDemandEntry = React.useMemo(() => {
        const linkGeneration = externalSessionLink?.linkedAtMs;
        if (
            !runtimeEnabled
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
        return followSignal(activity, (active) => {
            replaceExternalSessionStatusDemandViewport(statusDemandViewportId, active ? [statusDemandEntry] : []);
            return active ? () => { replaceExternalSessionStatusDemandViewport(statusDemandViewportId, []); } : undefined;
        });
    }, [
        activity,
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

    // Commands read the current gate when they run, so a hide/show keeps `refreshNow`'s identity.
    const runtimeEnabledRef = React.useRef(runtimeEnabled);
    runtimeEnabledRef.current = runtimeEnabled;
    const refreshNow = React.useCallback(async (): Promise<ExternalSessionRuntimeStatus | null> => {
        if (!runtimeEnabledRef.current) {
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
            return null;
        }
        // An inactive surface reads nothing; it keeps the status it last showed.
        if (!activity.get()) return null;

        if (!externalSessionTarget) {
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
            return null;
        }

        if (inFlightRefreshRef.current) {
            return inFlightRefreshRef.current;
        }

        const currentGeneration = generationRef.current;
        // Status is Account-scoped: it is read from Account A's machine with
        // Account A's credentials. A switch to Account B mid-read must not
        // publish or return Account A's runtime state into Account B's scope.
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        const controller = new AbortController();
        refreshControllerRef.current = controller;
        const retirement = accountCurrentness.onRetire(() => controller.abort());
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
            }, { serverId: sessionServerId ?? undefined, signal: controller.signal })
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
            retirement.dispose();
            if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
            if (inFlightRefreshRef.current === refreshPromise) {
                inFlightRefreshRef.current = null;
            }
        });

        inFlightRefreshRef.current = refreshPromise;
        return refreshPromise;
    }, [activity, externalSessionTarget, normalizedSessionId, sessionServerId]);

    React.useEffect(() => {
        if (!externalSessionTarget || !runtimeEnabled) {
            currentLeaseIdRef.current = null;
            return;
        }
        // The lease follows activity by subscription: an inactive surface releases it without rendering.
        const target = externalSessionTarget;
        const startLease = (): (() => void) => {
            let cancelled = false;
            let renewTimeoutId: ReturnType<typeof setTimeout> | null = null;
            let leaseExpiresAtMs: number | null = null;
            let attachInFlight = false;
            let attachPending = false;
            // Attach/detach are Account-scoped durable operations against Account A's
            // machine. Once that Account retires, this viewer must stop emitting: the
            // lease is reclaimed by its TTL rather than released under Account B.
            const accountCurrentness = captureActiveServerAccountScopeCurrentness();
            const controller = new AbortController();
            const retirement = accountCurrentness.onRetire(() => controller.abort());

            const detachLease = (leaseId: string) => {
                if (!accountCurrentness.isCurrent()) return;
                // Lease release outlives the mounted viewer, but only within its Account.
                const release = new AbortController();
                const releaseRetirement = accountCurrentness.onRetire(() => release.abort());
                void machineExternalSessionDetach({
                    machineId: target.machineId,
                    sessionId: normalizedSessionId,
                    leaseId,
                }, { serverId: sessionServerId ?? undefined, signal: release.signal })
                    .catch(() => {}).finally(() => releaseRetirement.dispose());
            };

            const clearRenewTimeout = () => {
                if (renewTimeoutId) {
                    clearTimeout(renewTimeoutId);
                    renewTimeoutId = null;
                }
            };

            const scheduleRenew = () => {
                if (leaseExpiresAtMs === null) return;
                const remainingMs = leaseExpiresAtMs - Date.now();
                if (remainingMs <= 0) return;
                // The daemon owns expiry. Renewal and failed-renewal recovery use
                // its remaining lifetime, rounded only to the clock's resolution.
                const delayMs = Math.ceil(remainingMs / 2);
                renewTimeoutId = setTimeout(() => {
                    renewTimeoutId = null;
                    if (leaseExpiresAtMs !== null && Date.now() < leaseExpiresAtMs) {
                        requestLeaseEnsure();
                    }
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
                                machineId: target.machineId,
                                sessionId: normalizedSessionId,
                                agentId: target.agentId,
                                remoteSessionId: target.remoteSessionId,
                                source: target.source,
                                ...(currentLeaseIdRef.current
                                    ? { leaseId: currentLeaseIdRef.current }
                                    : {}),
                                ...(requestedTailCursor
                                    ? { acceptedTailCursor: requestedTailCursor }
                                    : {}),
                            }, { serverId: sessionServerId ?? undefined, signal: controller.signal });
                            if (cancelled) {
                                // The lease outlived its viewer: nothing will renew
                                // or release it, so it would idle until its TTL.
                                if (response.ok) detachLease(response.leaseId);
                                return;
                            }
                            if (!response.ok) {
                                clearRenewTimeout();
                                // A daemon that classified the failure as terminal
                                // will answer the same way forever; released daemons
                                // omit the field and remain eligible for recovery
                                // within an acquired lease's remaining lifetime.
                                if (response.retryable === false) {
                                    return;
                                }
                                scheduleRenew();
                                return;
                            }
                            currentLeaseIdRef.current = response.leaseId;
                            leaseExpiresAtMs = response.expiresAtMs;
                            clearRenewTimeout();
                            scheduleRenew();
                        } catch {
                            if (cancelled) return;
                            clearRenewTimeout();
                            scheduleRenew();
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
                clearRenewTimeout();
                attachPending = true;
                if (!attachInFlight) {
                    void pumpLeaseEnsure();
                }
            };

            requestLeaseEnsureRef.current = requestLeaseEnsure;
            requestLeaseEnsure();

            return () => {
                cancelled = true;
                controller.abort();
                retirement.dispose();
                requestLeaseEnsureRef.current = null;
                clearRenewTimeout();
                const leaseId = currentLeaseIdRef.current;
                currentLeaseIdRef.current = null;
                if (!leaseId) return;
                detachLease(leaseId);
            };
        };
        return followSignal(activity, (active) => active ? startLease() : undefined);
    }, [activity, externalSessionTarget, normalizedSessionId, runtimeEnabled, sessionServerId]);

    React.useEffect(() => {
        if (lastDemandedTailCursorRef.current === acceptedTailCursor) return;
        requestLeaseEnsureRef.current?.();
    }, [acceptedTailCursor]);

    return React.useMemo(() => ({
        externalSessionLink,
        externalAgent,
        sessionServerId,
        status,
        refreshNow,
    }), [externalSessionLink, externalAgent, sessionServerId, status, refreshNow]);
}
