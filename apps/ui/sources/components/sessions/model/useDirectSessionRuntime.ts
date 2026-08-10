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
    enabled?: boolean;
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

function buildDirectSessionLinkCacheKey(metadata: Metadata | null | undefined): string {
    if (!metadata || typeof metadata !== 'object') return 'none';
    const directSessionV1 = (metadata as { directSessionV1?: unknown }).directSessionV1;
    if (directSessionV1 == null) return 'none';
    try {
        return JSON.stringify(directSessionV1) ?? 'none';
    } catch {
        return 'unserializable';
    }
}

function readDirectSessionLinkFromCacheKey(cacheKey: string): ReturnType<typeof readDirectSessionLink> {
    if (cacheKey === 'none' || cacheKey === 'unserializable') return null;
    try {
        return readDirectSessionLink({ directSessionV1: JSON.parse(cacheKey) });
    } catch {
        return null;
    }
}

export function areDirectSessionRuntimeStatusesEqual(
    left: DirectSessionRuntimeStatus | null,
    right: DirectSessionRuntimeStatus | null,
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    const leftKeys = Object.keys(left) as Array<keyof DirectSessionRuntimeStatus>;
    const rightKeys = Object.keys(right) as Array<keyof DirectSessionRuntimeStatus>;
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!Object.is(left[key], right[key])) return false;
    }
    return true;
}

export function useDirectSessionRuntime(params: UseDirectSessionRuntimeParams): UseDirectSessionRuntimeResult {
    const enabled = params.enabled !== false;
    const directSessionLinkCacheKey = React.useMemo(
        () => buildDirectSessionLinkCacheKey(params.metadata),
        [params.metadata],
    );
    const directSessionLink = React.useMemo(
        () => enabled ? readDirectSessionLinkFromCacheKey(directSessionLinkCacheKey) : null,
        [directSessionLinkCacheKey, enabled],
    );
    const activeServerSnapshot = useActiveServerSnapshot();
    const [status, setStatus] = React.useState<DirectSessionRuntimeStatus | null>(null);
    const statusRef = React.useRef<DirectSessionRuntimeStatus | null>(null);
    const inFlightRefreshRef = React.useRef<Promise<DirectSessionRuntimeStatus | null> | null>(null);
    const generationRef = React.useRef(0);
    const previousServerIdRef = React.useRef<string | undefined>(undefined);
    const activeServerId = normalizeServerId(activeServerSnapshot.serverId);
    // A disabled runtime resolves nothing. Every other branch below already short-circuits on
    // `enabled`, but this one used to reach into the session/server cache on every render of every
    // caller that had already been handed a runtime by its parent — work whose result is then thrown
    // away, and a global store read that a caller with no direct session has no reason to make.
    const sessionServerId = React.useMemo(
        () => (enabled ? resolvePreferredServerIdForSessionId(params.sessionId) ?? activeServerId : undefined),
        [activeServerId, enabled, params.sessionId],
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
        if (!enabled) {
            return null;
        }
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

            if (!areDirectSessionRuntimeStatusesEqual(statusRef.current, response)) {
                statusRef.current = response;
                setStatus(response);
            }
            return statusRef.current;
        })().finally(() => {
            if (inFlightRefreshRef.current === refreshPromise) {
                inFlightRefreshRef.current = null;
            }
        });

        inFlightRefreshRef.current = refreshPromise;
        return refreshPromise;
    }, [activeServerId, directSessionLink, enabled, params.sessionId]);

    React.useEffect(() => {
        if (!enabled) {
            if (statusRef.current !== null) {
                statusRef.current = null;
                setStatus(null);
            }
            return;
        }
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
    }, [directSessionLink, enabled, refreshNow]);

    return React.useMemo(() => ({
        directSessionLink,
        status,
        refreshNow,
    }), [directSessionLink, refreshNow, status]);
}
