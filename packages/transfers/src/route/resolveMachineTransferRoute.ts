import { readServerEnabledBit, type FeaturesResponse } from '@happier-dev/protocol';

export type MachineTransferStrategy = 'direct_peer' | 'server_routed_stream';

export type MachineTransferUnavailableReasonCode =
    | 'server_features_unavailable'
    | 'transfer_disabled'
    | 'server_routed_transfer_disabled';

export type MachineTransferNegotiationResult =
    | Readonly<{
        kind: 'selected';
        strategy: MachineTransferStrategy;
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
        if (strategy === 'direct_peer' && directPeerEnabled && input.directPeerAvailable) {
            return {
                kind: 'selected',
                strategy: 'direct_peer',
                allowServerRoutedFallback: serverRoutedEnabled,
            };
        }
        if (strategy === 'server_routed_stream' && serverRoutedEnabled) {
            return {
                kind: 'selected',
                strategy: 'server_routed_stream',
                allowServerRoutedFallback: true,
            };
        }
    }

    if (!serverRoutedEnabled) {
        return { kind: 'unavailable', reasonCode: 'server_routed_transfer_disabled' };
    }

    return {
        kind: 'selected',
        strategy: 'server_routed_stream',
        allowServerRoutedFallback: true,
    };
}
