import { readServerEnabledBit, type FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';
import type { TransferRouteViabilityRecord } from '@happier-dev/transfers';

export type TransferAvailabilitySnapshot = Readonly<{
    machineTransferEnabled: boolean;
    directPeerEnabled: boolean;
    serverRelayEnabled: boolean;
    directPeerRoute: TransferRouteViabilityRecord;
    machineRpcDirectRoute: TransferRouteViabilityRecord;
}>;

function resolveTransferRouteEnabledBit(
    serverFeatures: ServerFeatures | null,
    featureId: 'machines.transfer.directPeer' | 'machines.transfer.serverRouted',
): boolean {
    if (!serverFeatures) return false;
    return readServerEnabledBit(serverFeatures, featureId) === true;
}

export function resolveTransferAvailability(input: Readonly<{
    serverFeatures: ServerFeatures | null;
    directPeerRoute: TransferRouteViabilityRecord;
    machineRpcDirectRoute: TransferRouteViabilityRecord;
}>): TransferAvailabilitySnapshot {
    const machineTransferEnabled = input.serverFeatures
        ? readServerEnabledBit(input.serverFeatures, 'machines.transfer') === true
        : false;
    const directPeerEnabled = machineTransferEnabled && resolveTransferRouteEnabledBit(input.serverFeatures, 'machines.transfer.directPeer');
    const serverRelayEnabled = machineTransferEnabled && resolveTransferRouteEnabledBit(input.serverFeatures, 'machines.transfer.serverRouted');

    return {
        machineTransferEnabled,
        directPeerEnabled,
        serverRelayEnabled,
        directPeerRoute: input.directPeerRoute,
        machineRpcDirectRoute: input.machineRpcDirectRoute,
    };
}
