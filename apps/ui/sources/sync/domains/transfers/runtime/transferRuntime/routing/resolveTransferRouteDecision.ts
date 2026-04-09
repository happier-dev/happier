import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';
import type { TransferRouteViabilityRecord } from '@happier-dev/transfers';

import type { TransferAvailabilitySnapshot } from '../availability/transferAvailability';
import { resolveTransferAvailability } from '../availability/transferAvailability';
import type { TransferRouteKind } from './transferRouteKinds';

export type ResolveTransferRouteDecisionInput = Readonly<{
    serverFeatures: ServerFeatures | null;
    directPeerRoute?: TransferRouteViabilityRecord;
    machineRpcDirectRoute?: TransferRouteViabilityRecord;
    preferredRouteKinds?: readonly TransferRouteKind[];
}>;

export type TransferRouteDecision =
    | Readonly<{
        kind: 'selected';
        preferredRouteKind: TransferRouteKind;
        preferScopedMachineRpc: boolean;
        availability: TransferAvailabilitySnapshot;
    }>
    | Readonly<{
        kind: 'unavailable';
        reasonCode: 'server_features_unavailable' | 'transfer_disabled' | 'no_routes_available';
        preferScopedMachineRpc: boolean;
        availability: TransferAvailabilitySnapshot;
    }>;

const DEFAULT_ROUTE_PREFERENCE_ORDER: readonly TransferRouteKind[] = [
    'direct_peer',
    'server_relay_stream',
    'machine_rpc_direct',
] as const;

function isViable(record: TransferRouteViabilityRecord): boolean {
    return record.status === 'viable';
}

export function resolveTransferRouteDecision(
    input: ResolveTransferRouteDecisionInput,
): TransferRouteDecision {
    const availability = resolveTransferAvailability({
        serverFeatures: input.serverFeatures,
        directPeerRoute: input.directPeerRoute ?? { status: 'unknown' },
        machineRpcDirectRoute: input.machineRpcDirectRoute ?? { status: 'unknown' },
    });

    if (!input.serverFeatures) {
        return {
            kind: 'unavailable',
            reasonCode: 'server_features_unavailable',
            preferScopedMachineRpc: true,
            availability,
        };
    }

    if (!availability.machineTransferEnabled) {
        return {
            kind: 'unavailable',
            reasonCode: 'transfer_disabled',
            preferScopedMachineRpc: true,
            availability,
        };
    }

    const preferredRouteKinds = input.preferredRouteKinds ?? DEFAULT_ROUTE_PREFERENCE_ORDER;
    for (const routeKind of preferredRouteKinds) {
        if (routeKind === 'direct_peer' && availability.directPeerEnabled && isViable(availability.directPeerRoute)) {
            return {
                kind: 'selected',
                preferredRouteKind: 'direct_peer',
                preferScopedMachineRpc: true,
                availability,
            };
        }
        if (routeKind === 'server_relay_stream' && availability.serverRelayEnabled) {
            return {
                kind: 'selected',
                preferredRouteKind: 'server_relay_stream',
                preferScopedMachineRpc: true,
                availability,
            };
        }
        if (routeKind === 'machine_rpc_direct' && isViable(availability.machineRpcDirectRoute)) {
            return {
                kind: 'selected',
                preferredRouteKind: 'machine_rpc_direct',
                preferScopedMachineRpc: false,
                availability,
            };
        }
    }

    if (availability.directPeerEnabled && isViable(availability.directPeerRoute)) {
        return {
            kind: 'selected',
            preferredRouteKind: 'direct_peer',
            preferScopedMachineRpc: true,
            availability,
        };
    }

    if (availability.serverRelayEnabled) {
        return {
            kind: 'selected',
            preferredRouteKind: 'server_relay_stream',
            preferScopedMachineRpc: true,
            availability,
        };
    }

    if (isViable(availability.machineRpcDirectRoute)) {
        return {
            kind: 'selected',
            preferredRouteKind: 'machine_rpc_direct',
            preferScopedMachineRpc: false,
            availability,
        };
    }

    return {
        kind: 'unavailable',
        reasonCode: 'no_routes_available',
        preferScopedMachineRpc: true,
        availability,
    };
}
