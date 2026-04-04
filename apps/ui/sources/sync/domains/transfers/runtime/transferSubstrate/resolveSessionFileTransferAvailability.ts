import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';
import type { TransferRouteViabilityRecord } from '@happier-dev/transfers';

import type { TransferRouteDecision, ResolveTransferRouteDecisionInput } from './resolveTransferRouteDecision';
import { resolveTransferRouteDecision } from './resolveTransferRouteDecision';
import { resolveMachineDaemonTransferDirectPeerRoute } from './machineDaemonTransferState';

export type ResolveSessionFileTransferAvailabilityInput = Readonly<{
    sessionAvailable: boolean;
    machineTargetAvailable: boolean;
    serverFeatures: ServerFeatures | null;
    machineDaemonState?: unknown | null;
    directPeerRoute?: TransferRouteViabilityRecord | null;
    machineRpcDirectRoute?: TransferRouteViabilityRecord | null;
    preferredRouteKinds?: ResolveTransferRouteDecisionInput['preferredRouteKinds'];
}>;

export type ResolveSessionFileTransferAvailabilityResult = Readonly<{
    available: boolean;
    decision: TransferRouteDecision | null;
}>;

export function resolveSessionFileTransferAvailability(
    input: ResolveSessionFileTransferAvailabilityInput,
): ResolveSessionFileTransferAvailabilityResult {
    if (!input.sessionAvailable || !input.machineTargetAvailable || !input.serverFeatures) {
        return {
            available: false,
            decision: null,
        };
    }

    const daemonTransferRoute = resolveMachineDaemonTransferDirectPeerRoute({
        daemonState: input.machineDaemonState,
    });
    const directPeerRoute = daemonTransferRoute.status === 'unavailable'
        ? daemonTransferRoute
        : input.directPeerRoute?.status === 'unavailable'
            ? input.directPeerRoute
            : input.directPeerRoute?.status === 'viable'
                ? input.directPeerRoute
                : daemonTransferRoute;

    const decision = resolveTransferRouteDecision({
        serverFeatures: input.serverFeatures,
        directPeerRoute: directPeerRoute ?? { status: 'unknown' },
        machineRpcDirectRoute: input.machineRpcDirectRoute ?? { status: 'unknown' },
        preferredRouteKinds: input.preferredRouteKinds,
    });

    return {
        available: decision.kind === 'selected',
        decision,
    };
}
