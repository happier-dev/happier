import * as React from 'react';

import {
    readCachedMachineRpcDirectRoute,
    subscribeCachedMachineRpcDirectRoute,
} from '@/sync/domains/transfers/runtime/transferRouteCache';

import {
    probeSessionHandoffSourceReachability,
    type SessionHandoffSourceReachability,
} from './probeSessionHandoffSourceReachability';

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
    return cached.status === 'viable' ? 'reachable' : 'unknown';
}

export function useSessionHandoffSourceReachability(input: Readonly<{
    serverId?: string | null;
    sourceMachineId?: string | null;
}>): SessionHandoffRuntimeAvailability {
    const serverId = normalizeNonEmptyString(input.serverId);
    const sourceMachineId = normalizeNonEmptyString(input.sourceMachineId);

    const getSnapshot = React.useCallback((): SessionHandoffRuntimeAvailability => {
        return readSessionHandoffDirectProof({
            serverId,
            sourceMachineId,
        });
    }, [serverId, sourceMachineId]);

    const [availability, setAvailability] = React.useState<SessionHandoffRuntimeAvailability>(() => getSnapshot());

    React.useLayoutEffect(() => {
        setAvailability(getSnapshot());

        if (!serverId || !sourceMachineId) {
            return undefined;
        }

        return subscribeCachedMachineRpcDirectRoute({
            serverId,
            remoteMachineId: sourceMachineId,
        }, () => {
            const next = getSnapshot();
            if (next === 'reachable') {
                setAvailability('reachable');
            }
        });
    }, [getSnapshot, serverId, sourceMachineId]);

    React.useEffect(() => {
        if (!serverId || !sourceMachineId || availability !== 'unknown') {
            return undefined;
        }

        let cancelled = false;

        void probeSessionHandoffSourceReachability({
            serverId,
            sourceMachineId,
        }).then((nextAvailability) => {
            if (cancelled) return;
            setAvailability((current) => (current === 'unknown' ? nextAvailability : current));
        });

        return () => {
            cancelled = true;
        };
    }, [availability, serverId, sourceMachineId]);

    return availability;
}
