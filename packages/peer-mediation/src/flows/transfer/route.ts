import { readServerEnabledBit, type FeaturesResponse } from '@happier-dev/protocol';

import { resolvePeerRouteDecision } from '../../route/decision.js';
import type { PeerRouteKind } from '../../route/types.js';
import {
    DEFAULT_BOUNDED_TRANSFER_DIRECT_ROUTE_KINDS,
    toBoundedTransferPeerRouteKinds,
    toLegacyMachineTransferStrategy,
    type MachineTransferNegotiationResult,
    type MachineTransferStrategy,
} from './legacy.js';

export function resolveBoundedTransferRouteDecision(input: Readonly<{
    serverFeatures?: FeaturesResponse | null;
    preferredStrategies: readonly MachineTransferStrategy[];
    directPeerAvailable: boolean;
    directRouteKind?: Exclude<PeerRouteKind, 'server_relay'>;
    directRouteKinds?: readonly Exclude<PeerRouteKind, 'server_relay'>[];
}>): MachineTransferNegotiationResult {
    if (!input.serverFeatures) {
        return { kind: 'unavailable', reasonCode: 'server_features_unavailable' };
    }

    const transferEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer') === true;
    if (!transferEnabled) {
        return { kind: 'unavailable', reasonCode: 'transfer_disabled' };
    }

    const directPeerEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer.directPeer') === true;
    const serverRoutedEnabled = readServerEnabledBit(input.serverFeatures, 'machines.transfer.serverRouted') === true;
    const directRouteKinds = input.directRouteKinds
        ?? (input.directRouteKind
            ? [input.directRouteKind]
            : DEFAULT_BOUNDED_TRANSFER_DIRECT_ROUTE_KINDS);
    const preferredRouteKinds = input.preferredStrategies.flatMap((strategy) => toBoundedTransferPeerRouteKinds({
        strategy,
        directRouteKinds,
    }));
    const directViability = input.directPeerAvailable
        ? { status: 'viable' as const, checkedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER }
        : { status: 'unavailable' as const, checkedAt: 0, expiresAt: 0, failureReason: 'direct_peer_unavailable' };

    const routeDecision = resolvePeerRouteDecision({
        flowKind: 'bounded_transfer',
        preferredRouteKinds,
        candidates: [
            ...directRouteKinds.map((routeKind) => ({
                routeKind,
                enabled: directPeerEnabled,
                viability: directViability,
            })),
            {
                routeKind: 'server_relay',
                enabled: serverRoutedEnabled,
            },
        ],
    });

    if (routeDecision.kind === 'selected') {
        const strategy = toLegacyMachineTransferStrategy(routeDecision.routeKind);
        return {
            kind: 'selected',
            strategy,
            allowServerRelayFallback: strategy === 'server_relay_stream' ? true : serverRoutedEnabled,
            allowServerRoutedFallback: strategy === 'server_relay_stream' ? true : serverRoutedEnabled,
        };
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
