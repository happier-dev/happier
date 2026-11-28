import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { FeaturesResponse } from '@happier-dev/protocol';

import {
    normalizeMachineTransferStrategy,
    type MachineTransferNegotiationResult,
    type MachineTransferStrategy,
} from './legacy.js';

export function resolveBoundedTransferRouteDecision(input: Readonly<{
    serverFeatures?: FeaturesResponse | null;
    preferredStrategies: readonly MachineTransferStrategy[];
    directPeerAvailable: boolean;
}>): MachineTransferNegotiationResult {
    if (!input.serverFeatures) {
        return { kind: 'unavailable', reasonCode: 'server_features_unavailable' };
    }

    if (readServerEnabledBit(input.serverFeatures, 'machines.transfer') !== true) {
        return { kind: 'unavailable', reasonCode: 'transfer_disabled' };
    }

    const directPeerAvailable = input.directPeerAvailable
        && readServerEnabledBit(input.serverFeatures, 'machines.transfer.directPeer') === true;
    const serverRoutedEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer.serverRouted') === true;
    const preferredStrategy = input.preferredStrategies.find((strategy) =>
        strategy === 'direct_peer' ? directPeerAvailable : serverRoutedEnabled,
    );
    const strategy = preferredStrategy
        ? normalizeMachineTransferStrategy(preferredStrategy)
        : serverRoutedEnabled ? 'server_relay_stream' : null;
    if (!strategy) {
        return { kind: 'unavailable', reasonCode: 'server_routed_transfer_disabled' };
    }

    return {
        kind: 'selected',
        strategy,
        allowServerRelayFallback: serverRoutedEnabled,
        allowServerRoutedFallback: serverRoutedEnabled,
    };
}
