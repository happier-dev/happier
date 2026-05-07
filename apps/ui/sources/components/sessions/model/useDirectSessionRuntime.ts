import * as React from 'react';
import type { DirectSessionStatusGetResponse } from '@happier-dev/protocol';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { machineDirectSessionStatusGet } from '@/sync/ops/machineDirectSessions';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { sync } from '@/sync/sync';

export type DirectSessionRuntimeStatus = Extract<DirectSessionStatusGetResponse, { ok: true }>;

type UseDirectSessionRuntimeParams = Readonly<{
    sessionId: string;
    metadata: Metadata | null | undefined;
}>;

export type UseDirectSessionRuntimeResult = Readonly<{
    directSessionLink: ReturnType<typeof readDirectSessionLink>;
    status: DirectSessionRuntimeStatus | null;
    refreshNow: () => Promise<DirectSessionRuntimeStatus | null>;
}>;

function normalizeServerId(value: unknown): string | undefined {
    const serverId = String(value ?? '').trim();
    return serverId || undefined;
}

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

export function useDirectSessionRuntime(params: UseDirectSessionRuntimeParams): UseDirectSessionRuntimeResult {
    const directSessionLink = React.useMemo(
        () => readDirectSessionLink(params.metadata),
        [params.metadata],
    );
    const activeServerSnapshot = useActiveServerSnapshot();
    const [status, setStatus] = React.useState<DirectSessionRuntimeStatus | null>(null);
    const statusRef = React.useRef<DirectSessionRuntimeStatus | null>(null);
    const inFlightRefreshRef = React.useRef<Promise<DirectSessionRuntimeStatus | null> | null>(null);
    const generationRef = React.useRef(0);
    const previousServerIdRef = React.useRef<string | undefined>(undefined);
    const activeServerId = normalizeServerId(activeServerSnapshot.serverId);
    const sessionServerId = React.useMemo(
        () => resolvePreferredServerIdForSessionId(params.sessionId) ?? activeServerId,
        [activeServerId, params.sessionId],
    );

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

    const refreshNow = React.useCallback(async (): Promise<DirectSessionRuntimeStatus | null> => {
        if (!directSessionLink) {
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
            const targetServerId = resolvePreferredServerIdForSessionId(params.sessionId) ?? activeServerId;
            const statusPromise = machineDirectSessionStatusGet({
                machineId: directSessionLink.machineId,
                sessionId: params.sessionId,
                providerId: directSessionLink.providerId,
                remoteSessionId: directSessionLink.remoteSessionId,
                source: directSessionLink.source,
            }, { serverId: targetServerId })
                .then((response) => ({ ok: true as const, response }))
                .catch((error: unknown) => ({ ok: false as const, error }));

            await sync.refreshSessionMessages(params.sessionId).catch(() => {});

            const statusResult = await statusPromise;
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
    }, [activeServerId, directSessionLink, params.sessionId]);

    React.useEffect(() => {
        if (!directSessionLink) {
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
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
    }, [directSessionLink, refreshNow]);

    return {
        directSessionLink,
        status,
        refreshNow,
    };
}
