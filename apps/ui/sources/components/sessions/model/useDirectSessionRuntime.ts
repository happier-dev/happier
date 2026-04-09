import * as React from 'react';
import type { DirectSessionStatusGetResponse } from '@happier-dev/protocol';
import { AppState, Platform } from 'react-native';

import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    machineDirectSessionAttach,
    machineDirectSessionDetach,
    machineDirectSessionStatusGet,
} from '@/sync/ops/machineDirectSessions';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';

export type DirectSessionRuntimeStatus = Extract<DirectSessionStatusGetResponse, { ok: true }>;

type UseDirectSessionRuntimeParams = Readonly<{
    sessionId: string;
    metadata: Metadata | null | undefined;
    enabled?: boolean;
}>;

export type UseDirectSessionRuntimeResult = Readonly<{
    directSessionLink: ReturnType<typeof readDirectSessionLink>;
    sessionServerId: string | null;
    status: DirectSessionRuntimeStatus | null;
    refreshNow: () => Promise<DirectSessionRuntimeStatus | null>;
}>;

type DirectSessionTarget = Readonly<{
    machineId: string;
    providerId: NonNullable<ReturnType<typeof readDirectSessionLink>>['providerId'];
    remoteSessionId: string;
    source: NonNullable<ReturnType<typeof readDirectSessionLink>>['source'];
}>;

function readActivePollMsFromEnv(): number {
    const raw = Number.parseInt(String(process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_TAIL_POLL_MS_ACTIVE ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 250;
    return Math.max(50, Math.min(60_000, configured));
}

function readIdlePollMsFromEnv(): number {
    const raw = Number.parseInt(String(process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_TAIL_POLL_MS_IDLE ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 2_000;
    return Math.max(100, Math.min(120_000, configured));
}

function resolvePollDelayMs(status: DirectSessionRuntimeStatus | null): number {
    if (status?.machineOnline === false) return readIdlePollMsFromEnv();
    if (status?.activity === 'running' || status?.activity === 'active_recently') {
        return readActivePollMsFromEnv();
    }
    return readIdlePollMsFromEnv();
}

function readAttachLeaseTtlMsFromEnv(): number {
    const raw = Number.parseInt(String(process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_ATTACH_LEASE_TTL_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 30_000;
    return Math.max(1_000, Math.min(15 * 60_000, configured));
}

function readAttachRenewLeadMsFromEnv(): number {
    const raw = Number.parseInt(String(process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_ATTACH_RENEW_LEAD_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 10_000;
    return Math.max(500, Math.min(60_000, configured));
}

function readAttachRetryMsFromEnv(): number {
    const raw = Number.parseInt(String(process.env.EXPO_PUBLIC_HAPPIER_DIRECT_SESSIONS_ATTACH_RETRY_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 5_000;
    return Math.max(1_000, Math.min(60_000, configured));
}

function useRuntimeActive(): boolean {
    const [runtimeActive, setRuntimeActive] = React.useState(() => isRuntimeActive());

    React.useEffect(() => {
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
    }, []);

    return runtimeActive;
}

export function useDirectSessionRuntime(params: UseDirectSessionRuntimeParams): UseDirectSessionRuntimeResult {
    const runtimeEnabled = params.enabled !== false;
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);
    const directSessionLink = React.useMemo(
        () => readDirectSessionLink(params.metadata),
        [params.metadata],
    );
    const directSessionTargetKey = React.useMemo(() => {
        if (!directSessionLink) return null;
        return JSON.stringify([
            directSessionLink.machineId,
            directSessionLink.providerId,
            directSessionLink.remoteSessionId,
            directSessionLink.source,
        ]);
    }, [directSessionLink]);
    const directSessionTarget = React.useMemo<DirectSessionTarget | null>(() => {
        if (!directSessionLink) return null;
        return {
            machineId: directSessionLink.machineId,
            providerId: directSessionLink.providerId,
            remoteSessionId: directSessionLink.remoteSessionId,
            source: directSessionLink.source,
        };
    }, [directSessionTargetKey]);
    const [status, setStatus] = React.useState<DirectSessionRuntimeStatus | null>(null);
    const statusRef = React.useRef<DirectSessionRuntimeStatus | null>(null);
    const inFlightRefreshRef = React.useRef<Promise<DirectSessionRuntimeStatus | null> | null>(null);
    const currentLeaseIdRef = React.useRef<string | null>(null);
    const generationRef = React.useRef(0);
    const previousServerIdRef = React.useRef<string | null | undefined>(undefined);
    const previousRuntimeScopeRef = React.useRef<string | null>(null);
    const runtimeActive = useRuntimeActive();
    const sessionServerId = usePreferredServerIdForSession(normalizedSessionId);

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
        const nextRuntimeScope = runtimeEnabled && directSessionTargetKey
            ? `${normalizedSessionId}:${directSessionTargetKey}`
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
    }, [directSessionTargetKey, normalizedSessionId, runtimeEnabled]);

    const refreshNow = React.useCallback(async (): Promise<DirectSessionRuntimeStatus | null> => {
        if (!runtimeEnabled) {
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
            return null;
        }

        if (!directSessionTarget) {
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
        let refreshPromise: Promise<DirectSessionRuntimeStatus | null> | null = null;
        refreshPromise = (async () => {
            const statusResult = await machineDirectSessionStatusGet({
                machineId: directSessionTarget.machineId,
                sessionId: normalizedSessionId,
                providerId: directSessionTarget.providerId,
                remoteSessionId: directSessionTarget.remoteSessionId,
                source: directSessionTarget.source,
            }, { serverId: sessionServerId ?? undefined })
                .then((response) => ({ ok: true as const, response }))
                .catch((error: unknown) => ({ ok: false as const, error }));
            if (!statusResult.ok) {
                return statusRef.current;
            }
            const response = statusResult.response;
            if (!response.ok) {
                return statusRef.current;
            }

            if (generationRef.current !== currentGeneration) {
                return statusRef.current;
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
    }, [directSessionTarget, normalizedSessionId, runtimeEnabled, sessionServerId]);

    React.useEffect(() => {
        if (!directSessionTarget || !runtimeEnabled) {
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
            return;
        }
        if (!runtimeActive) {
            return;
        }

        let cancelled = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const scheduleNext = (nextStatus: DirectSessionRuntimeStatus | null) => {
            if (cancelled) return;
            timeoutId = setTimeout(() => {
                void runPoll();
            }, resolvePollDelayMs(nextStatus));
        };

        const runPoll = async () => {
            const nextStatus = await refreshNow().catch(() => statusRef.current);
            if (cancelled) return;
            scheduleNext(nextStatus);
        };

        void runPoll();

        return () => {
            cancelled = true;
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        };
    }, [directSessionTarget, refreshNow, runtimeActive, runtimeEnabled]);

    React.useEffect(() => {
        if (!directSessionTarget || !runtimeActive || !runtimeEnabled) {
            currentLeaseIdRef.current = null;
            return;
        }

        let cancelled = false;
        let renewTimeoutId: ReturnType<typeof setTimeout> | null = null;

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
                void ensureLease();
            }, delayMs);
        };

        const scheduleRetry = () => {
            const delayMs = readAttachRetryMsFromEnv();
            renewTimeoutId = setTimeout(() => {
                void ensureLease();
            }, delayMs);
        };

        const ensureLease = async () => {
            try {
                const response = await machineDirectSessionAttach({
                    machineId: directSessionTarget.machineId,
                    sessionId: normalizedSessionId,
                    providerId: directSessionTarget.providerId,
                    remoteSessionId: directSessionTarget.remoteSessionId,
                    source: directSessionTarget.source,
                    ...(currentLeaseIdRef.current ? { leaseId: currentLeaseIdRef.current } : {}),
                    ttlMs: readAttachLeaseTtlMsFromEnv(),
                }, { serverId: sessionServerId ?? undefined });
                if (cancelled) return;
                if (!response.ok) {
                    clearRenewTimeout();
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
            }
        };

        void ensureLease();

        return () => {
            cancelled = true;
            clearRenewTimeout();
            const leaseId = currentLeaseIdRef.current;
            currentLeaseIdRef.current = null;
            if (!leaseId) return;
            void machineDirectSessionDetach({
                machineId: directSessionTarget.machineId,
                sessionId: normalizedSessionId,
                leaseId,
            }, { serverId: sessionServerId ?? undefined }).catch(() => {});
        };
    }, [directSessionTarget, normalizedSessionId, runtimeActive, runtimeEnabled, sessionServerId]);

    return {
        directSessionLink,
        sessionServerId,
        status,
        refreshNow,
    };
}
