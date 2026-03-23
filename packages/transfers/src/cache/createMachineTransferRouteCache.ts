import type { TransferEndpointCandidate } from '@happier-dev/protocol';

import {
    createTransferRouteViabilityCache,
    type TransferRouteViabilityRecord,
} from './createTransferRouteViabilityCache.js';
import { fingerprintTransferEndpoints } from './fingerprintTransferEndpoints.js';

export const DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS = 30_000;
export const DEFAULT_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS = 5_000;

type DirectPeerRouteInput = Readonly<{
    remoteMachineId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
}>;

type MachineRpcDirectRouteInput = Readonly<{
    remoteMachineId: string;
}>;

export type MachineTransferRouteCache = Readonly<{
    readDirectPeerRoute: (input: DirectPeerRouteInput) => TransferRouteViabilityRecord;
    recordDirectPeerRouteViable: (input: DirectPeerRouteInput) => void;
    recordDirectPeerRouteUnavailable: (input: DirectPeerRouteInput, failureReason: string) => void;
    invalidateDirectPeerRoutesForMachine: (remoteMachineId: string) => void;
    readMachineRpcDirectRoute: (input: MachineRpcDirectRouteInput) => TransferRouteViabilityRecord;
    recordMachineRpcDirectRouteViable: (input: MachineRpcDirectRouteInput) => void;
    recordMachineRpcDirectRouteUnavailable: (input: MachineRpcDirectRouteInput, failureReason: string) => void;
}>;

export function createMachineTransferRouteCache(params: Readonly<{
    serverId: string;
    now?: () => number;
    positiveTtlMs: number;
    negativeTtlMs: number;
}>): MachineTransferRouteCache {
    const cache = createTransferRouteViabilityCache({
        now: params.now ?? Date.now,
        positiveTtlMs: params.positiveTtlMs,
        negativeTtlMs: params.negativeTtlMs,
    });

    function buildDirectPeerCacheKey(input: DirectPeerRouteInput) {
        const endpointFingerprint = fingerprintTransferEndpoints(input.endpointCandidates);
        return {
            serverId: params.serverId,
            targetMachineId: input.remoteMachineId,
            routeKind: 'direct_peer' as const,
            ...(endpointFingerprint ? { endpointFingerprint } : {}),
        };
    }

    function buildMachineRpcDirectCacheKey(input: MachineRpcDirectRouteInput) {
        return {
            serverId: params.serverId,
            targetMachineId: input.remoteMachineId,
            routeKind: 'machine_rpc_direct' as const,
        };
    }

    return {
        readDirectPeerRoute(input) {
            return cache.read(buildDirectPeerCacheKey(input));
        },
        recordDirectPeerRouteViable(input) {
            cache.recordViable(buildDirectPeerCacheKey(input));
        },
        recordDirectPeerRouteUnavailable(input, failureReason) {
            cache.recordUnavailable(buildDirectPeerCacheKey(input), failureReason);
        },
        invalidateDirectPeerRoutesForMachine(remoteMachineId) {
            cache.invalidate({
                serverId: params.serverId,
                targetMachineId: remoteMachineId,
                routeKind: 'direct_peer',
            });
        },
        readMachineRpcDirectRoute(input) {
            return cache.read(buildMachineRpcDirectCacheKey(input));
        },
        recordMachineRpcDirectRouteViable(input) {
            cache.recordViable(buildMachineRpcDirectCacheKey(input));
        },
        recordMachineRpcDirectRouteUnavailable(input, failureReason) {
            cache.recordUnavailable(buildMachineRpcDirectCacheKey(input), failureReason);
        },
    };
}
