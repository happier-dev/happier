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
