import { readServerEnabledBit, type FeaturesResponse } from '@happier-dev/protocol';

export type CanonicalMachineTransferStrategy = 'direct_peer' | 'server_relay_stream';
export type LegacyMachineTransferStrategy = 'server_routed_stream';
export type MachineTransferStrategy = CanonicalMachineTransferStrategy | LegacyMachineTransferStrategy;

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

type ResolveMachineTransferRouteInput = Readonly<{
    serverFeatures?: FeaturesResponse | null;
    preferredStrategies: readonly MachineTransferStrategy[];
    directPeerAvailable: boolean;
}>;

function normalizeMachineTransferStrategy(strategy: MachineTransferStrategy): CanonicalMachineTransferStrategy {
    if (strategy === 'server_routed_stream') {
        return 'server_relay_stream';
    }
    return strategy;
}

export function resolveMachineTransferRoute(
    input: ResolveMachineTransferRouteInput,
): MachineTransferNegotiationResult {
    if (!input.serverFeatures) {
        return { kind: 'unavailable', reasonCode: 'server_features_unavailable' };
    }

    const transferEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer') === true;
    if (!transferEnabled) {
        return { kind: 'unavailable', reasonCode: 'transfer_disabled' };
    }

    const directPeerEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer.directPeer') === true;
    const serverRoutedEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer.serverRouted') === true;

    for (const strategy of input.preferredStrategies) {
        const normalizedStrategy = normalizeMachineTransferStrategy(strategy);
        if (normalizedStrategy === 'direct_peer' && directPeerEnabled && input.directPeerAvailable) {
            return {
                kind: 'selected',
                strategy: 'direct_peer',
                allowServerRelayFallback: serverRoutedEnabled,
                allowServerRoutedFallback: serverRoutedEnabled,
            };
        }
        if (normalizedStrategy === 'server_relay_stream' && serverRoutedEnabled) {
            return {
                kind: 'selected',
                strategy: 'server_relay_stream',
                allowServerRelayFallback: true,
                allowServerRoutedFallback: true,
            };
        }
    }

    if (!serverRoutedEnabled) {
        return { kind: 'unavailable', reasonCode: 'server_routed_transfer_disabled' };
    }

    return {
        kind: 'selected',
        strategy: 'server_relay_stream',
        allowServerRelayFallback: true,
        allowServerRoutedFallback: true,
    };
}
