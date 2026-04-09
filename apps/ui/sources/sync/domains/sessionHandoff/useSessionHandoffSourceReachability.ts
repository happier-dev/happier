import * as React from 'react';

import {
    readCachedMachineRpcDirectRoute,
    subscribeCachedMachineRpcDirectRoute,
} from '@/sync/domains/transfers/runtime/transferRouteCache';

import {
    probeSessionHandoffSourceReachability,
    type SessionHandoffSourceReachability,
} from './probeSessionHandoffSourceReachability';
import { resolveSessionHandoffRuntimeConfig } from './sessionHandoffRuntimeConfig';

export type SessionHandoffRuntimeAvailability = 'unknown' | SessionHandoffSourceReachability;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readSessionHandoffDirectProof(input: Readonly<{
    serverId?: string | null;
    sourceMachineId?: string | null;
}>): SessionHandoffRuntimeAvailability {
    const serverId = normalizeNonEmptyString(input.serverId);
    const sourceMachineId = normalizeNonEmptyString(input.sourceMachineId);
    if (!serverId || !sourceMachineId) {
        return 'unknown';
    }

    const cached = readCachedMachineRpcDirectRoute({
        serverId,
        remoteMachineId: sourceMachineId,
    });
    if (cached.status === 'viable') {
        return 'reachable';
    }
    if (cached.status === 'unavailable') {
        return 'unavailable';
    }
    return 'unknown';
}

export function useSessionHandoffSourceReachability(input: Readonly<{
    serverId?: string | null;
    sourceMachineId?: string | null;
}>): SessionHandoffRuntimeAvailability {
    const serverId = normalizeNonEmptyString(input.serverId);
    const sourceMachineId = normalizeNonEmptyString(input.sourceMachineId);
    const runtimeConfig = React.useMemo(() => resolveSessionHandoffRuntimeConfig(), []);
    const probeWindowStartedAtRef = React.useRef<number | null>(null);
    const [probeRevision, bumpProbeRevision] = React.useReducer((v: number) => v + 1, 0);
    const scopeKey = `${serverId ?? '__default__'}::${sourceMachineId ?? '__missing__'}`;

    const getSnapshot = React.useCallback((): SessionHandoffRuntimeAvailability => {
        return readSessionHandoffDirectProof({
            serverId,
            sourceMachineId,
        });
    }, [serverId, sourceMachineId]);

    const [availability, setAvailability] = React.useState<SessionHandoffRuntimeAvailability>(() => getSnapshot());

    React.useEffect(() => {
        probeWindowStartedAtRef.current = null;
    }, [scopeKey]);

    React.useLayoutEffect(() => {
        setAvailability(getSnapshot());

        if (!serverId || !sourceMachineId) {
            return undefined;
        }

        return subscribeCachedMachineRpcDirectRoute({
            serverId,
            remoteMachineId: sourceMachineId,
        }, () => {
            setAvailability(getSnapshot());
        });
    }, [getSnapshot, serverId, sourceMachineId]);

    React.useEffect(() => {
        if (!serverId || !sourceMachineId) {
            probeWindowStartedAtRef.current = null;
            return undefined;
        }

        const directProof = getSnapshot();
        if (directProof === 'reachable') {
            probeWindowStartedAtRef.current = null;
            return undefined;
        }
        if (directProof === 'unavailable') {
            probeWindowStartedAtRef.current = null;
            return undefined;
        }

        if (availability === 'reachable') {
            probeWindowStartedAtRef.current = null;
            return undefined;
        }

        const now = Date.now();
        if (probeWindowStartedAtRef.current === null) {
            probeWindowStartedAtRef.current = now;
        }
        if ((now - probeWindowStartedAtRef.current) >= runtimeConfig.sourceReachabilityRetryWindowMs) {
            return undefined;
        }

        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const runProbe = async () => {
            const nextAvailability = await probeSessionHandoffSourceReachability({
                serverId,
                sourceMachineId,
            });
            if (cancelled) return;
            setAvailability((current) => (current === 'reachable' ? current : nextAvailability));
            if (nextAvailability !== 'reachable') {
                bumpProbeRevision();
            }
        };

        if (availability === 'unknown') {
            void Promise.resolve().then(runProbe);
        } else {
            retryTimer = setTimeout(() => {
                void runProbe();
            }, runtimeConfig.sourceReachabilityRetryDelayMs);
        }

        return () => {
            cancelled = true;
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
        };
    }, [availability, getSnapshot, probeRevision, runtimeConfig.sourceReachabilityRetryDelayMs, runtimeConfig.sourceReachabilityRetryWindowMs, serverId, sourceMachineId]);

    return availability;
}
