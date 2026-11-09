import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    type DirectPeerRouteKind,
    resolvePeerRouteDecision,
    type PeerRouteKind,
    type PeerRouteViabilityRecord as TransferRouteViabilityRecord,
} from '@happier-dev/peer-mediation';

import type { TransferAvailabilitySnapshot } from '../availability/transferAvailability';
import { resolveTransferAvailability } from '../availability/transferAvailability';
import { isIrohMachineCarrierFeatureEnabled } from './resolveMachineCarrierPreselection';
import type { TransferRouteKind } from './transferRouteKinds';

export type ResolveTransferRouteDecisionInput = Readonly<{
    serverFeatures: ServerFeatures | null;
    directPeerRoute?: TransferRouteViabilityRecord;
    directPeerRouteKinds?: readonly DirectPeerRouteKind[];
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
    'iroh_peer',
    'direct_peer',
    'server_relay_stream',
    'machine_rpc_direct',
] as const;

function isViable(record: TransferRouteViabilityRecord): boolean {
    return record.status === 'viable';
}

function resolveTransferPeerRoute(input: Readonly<{
    routeKind: 'iroh_peer' | 'direct_peer' | 'server_relay_stream';
    availability: TransferAvailabilitySnapshot;
}>): TransferRouteKind | null {
    const preferredRouteKinds: readonly PeerRouteKind[] = input.routeKind === 'iroh_peer'
        ? ['iroh_peer']
        : input.routeKind === 'direct_peer'
            ? input.availability.directPeerRouteKinds.filter((kind) => kind !== 'iroh_peer')
        : ['server_relay'];
    const decision = resolvePeerRouteDecision({
        flowKind: 'bounded_transfer',
        preferredRouteKinds,
        candidates: [
            ...input.availability.directPeerRouteKinds.map((routeKind) => ({
                routeKind,
                enabled: input.availability.directPeerEnabled && isViable(input.availability.directPeerRoute),
                viability: input.availability.directPeerRoute,
            })),
            {
                routeKind: 'server_relay',
                enabled: input.availability.serverRelayEnabled,
            },
        ],
    });

    if (decision.kind !== 'selected') {
        return null;
    }

    return decision.routeKind === 'server_relay'
        ? 'server_relay_stream'
        : decision.routeKind === 'iroh_peer' ? 'iroh_peer' : 'direct_peer';
}

export function resolveTransferRouteDecision(
    input: ResolveTransferRouteDecisionInput,
): TransferRouteDecision {
    const availability = resolveTransferAvailability({
        serverFeatures: input.serverFeatures,
        directPeerRoute: input.directPeerRoute ?? { status: 'unknown' },
        directPeerRouteKinds: input.directPeerRouteKinds ?? [],
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
        if (
            routeKind === 'iroh_peer'
            && isIrohMachineCarrierFeatureEnabled(input.serverFeatures)
            && resolveTransferPeerRoute({ routeKind, availability }) === 'iroh_peer'
        ) {
            return {
                kind: 'selected',
                preferredRouteKind: 'iroh_peer',
                preferScopedMachineRpc: true,
                availability,
            };
        }
        if (routeKind === 'direct_peer' && resolveTransferPeerRoute({ routeKind, availability }) === 'direct_peer') {
            return {
                kind: 'selected',
                preferredRouteKind: 'direct_peer',
                preferScopedMachineRpc: true,
                availability,
            };
        }
        if (routeKind === 'server_relay_stream' && resolveTransferPeerRoute({ routeKind, availability }) === 'server_relay_stream') {
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

    if (resolveTransferPeerRoute({ routeKind: 'direct_peer', availability }) === 'direct_peer') {
        return {
            kind: 'selected',
            preferredRouteKind: 'direct_peer',
            preferScopedMachineRpc: true,
            availability,
        };
    }

    if (resolveTransferPeerRoute({ routeKind: 'server_relay_stream', availability }) === 'server_relay_stream') {
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
