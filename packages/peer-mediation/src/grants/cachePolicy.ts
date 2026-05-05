import {
    DIRECT_ROUTE_GRANT_TTL_MS,
    clampDirectRouteGrantTtlMs,
} from '@happier-dev/protocol';

import type { PeerFlowKind, PeerRouteKind } from '../route/types.js';

export type ResolveDirectRouteGrantCachePolicyInput = Readonly<{
    flowKind: PeerFlowKind;
    routeKind: PeerRouteKind;
    scopeMode?: 'single' | 'scope';
    requestedTtlMs?: number;
}>;

export type DirectRouteGrantCachePolicy = Readonly<{
    ttlMs: number;
    renewable: boolean;
}>;

export function resolveDirectRouteGrantCachePolicy(
    input: ResolveDirectRouteGrantCachePolicyInput,
): DirectRouteGrantCachePolicy {
    if (input.flowKind === 'bounded_transfer') {
        if (input.scopeMode === 'scope') {
            const ttlMs = input.requestedTtlMs === undefined
                ? DIRECT_ROUTE_GRANT_TTL_MS.boundedTransferScopedDefault
                : clampDirectRouteGrantTtlMs(
                    input.requestedTtlMs,
                    DIRECT_ROUTE_GRANT_TTL_MS.boundedTransferScopedMin,
                    DIRECT_ROUTE_GRANT_TTL_MS.boundedTransferScopedMax,
                );
            return { ttlMs, renewable: false };
        }
        return { ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.boundedTransferSingle, renewable: false };
    }

    if (input.flowKind === 'machine_rpc') {
        if (input.routeKind === 'loopback_direct') {
            return { ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault, renewable: false };
        }
        return { ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.lanTailscaleMachineRpcMax, renewable: false };
    }

    if (input.flowKind === 'tcp_tunnel') {
        return { ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel, renewable: true };
    }

    if (input.flowKind === 'live_stream') {
        return { ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.directLiveStream, renewable: true };
    }

    return { ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.boundedTransferSingle, renewable: false };
}
