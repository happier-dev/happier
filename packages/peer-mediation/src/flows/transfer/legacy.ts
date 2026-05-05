import type { PeerRouteKind } from '../../route/types.js';

export const DEFAULT_BOUNDED_TRANSFER_DIRECT_ROUTE_KINDS: readonly Exclude<PeerRouteKind, 'server_relay'>[] = [
    'loopback_direct',
    'lan_direct',
    'tailscale_serve_direct',
] as const;

export type CanonicalMachineTransferStrategy = 'direct_peer' | 'server_relay_stream';
export type LegacyMachineTransferStrategy = 'server_routed_stream';
export type MachineTransferStrategy = CanonicalMachineTransferStrategy | LegacyMachineTransferStrategy;
export type TransferRouteKind = MachineTransferStrategy | 'machine_rpc_direct';

export type MachineTransferUnavailableReasonCode =
    | 'server_features_unavailable'
    | 'transfer_disabled'
    | 'server_routed_transfer_disabled';

export type MachineTransferNegotiationResult =
    | Readonly<{
        kind: 'selected';
        strategy: MachineTransferStrategy;
        allowServerRelayFallback: boolean;
        allowServerRoutedFallback: boolean;
    }>
    | Readonly<{
        kind: 'unavailable';
        reasonCode: MachineTransferUnavailableReasonCode;
    }>;

export function normalizeMachineTransferStrategy(
    strategy: MachineTransferStrategy,
): CanonicalMachineTransferStrategy {
    if (strategy === 'server_routed_stream') {
        return 'server_relay_stream';
    }
    return strategy;
}

export function toLegacyMachineTransferStrategy(routeKind: PeerRouteKind): CanonicalMachineTransferStrategy {
    if (routeKind === 'server_relay') {
        return 'server_relay_stream';
    }
    return 'direct_peer';
}

export function toBoundedTransferPeerRouteKind(input: Readonly<{
    strategy: MachineTransferStrategy;
    directRouteKind?: Exclude<PeerRouteKind, 'server_relay'>;
}>): PeerRouteKind {
    const normalizedStrategy = normalizeMachineTransferStrategy(input.strategy);
    if (normalizedStrategy === 'server_relay_stream') {
        return 'server_relay';
    }
    return input.directRouteKind ?? DEFAULT_BOUNDED_TRANSFER_DIRECT_ROUTE_KINDS[0];
}

export function toBoundedTransferPeerRouteKinds(input: Readonly<{
    strategy: MachineTransferStrategy;
    directRouteKinds?: readonly Exclude<PeerRouteKind, 'server_relay'>[];
}>): readonly PeerRouteKind[] {
    const normalizedStrategy = normalizeMachineTransferStrategy(input.strategy);
    if (normalizedStrategy === 'server_relay_stream') {
        return ['server_relay'];
    }
    return input.directRouteKinds ?? DEFAULT_BOUNDED_TRANSFER_DIRECT_ROUTE_KINDS;
}
