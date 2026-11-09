import * as React from 'react';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

import {
    readCachedMachineRpcDirectRoute,
    subscribeCachedMachineRpcDirectRoute,
} from '@/sync/domains/transfers/runtime/transferRouteCache';

import type { SessionHandoffSourceReachability } from './probeSessionHandoffSourceReachability';

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
    const presence = useMachinePresenceSummary(serverId, sourceMachineId);

    const getSnapshot = React.useCallback((): SessionHandoffRuntimeAvailability => {
        return readSessionHandoffDirectProof({
            serverId,
            sourceMachineId,
        });
    }, [serverId, sourceMachineId]);

    const subscribe = React.useCallback((listener: () => void) => {
        if (!serverId || !sourceMachineId) {
            return () => {};
        }

        return subscribeCachedMachineRpcDirectRoute({
            serverId,
            remoteMachineId: sourceMachineId,
        }, listener);
    }, [serverId, sourceMachineId]);
    const directProof = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (directProof === 'reachable' || presence.reachability === 'reachable') return 'reachable';
    if (directProof === 'unavailable' || presence.reachability === 'unreachable') return 'unavailable';
    return 'unknown';
}
