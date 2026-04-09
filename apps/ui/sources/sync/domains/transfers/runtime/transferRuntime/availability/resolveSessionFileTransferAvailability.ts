import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';
import type { TransferRouteViabilityRecord } from '@happier-dev/transfers';

import type { TransferRouteDecision, ResolveTransferRouteDecisionInput } from '../routing/resolveTransferRouteDecision';
import { resolveTransferRouteDecision } from '../routing/resolveTransferRouteDecision';
import {
    resolveMachineDaemonTransferDirectPeerDiagnostics,
    type MachineDaemonTransferDirectPeerDiagnostics,
} from './machineDaemonTransferState';

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
    daemonDirectPeerDiagnostics: MachineDaemonTransferDirectPeerDiagnostics;
}>;

function resolveSessionDirectPeerRoute(
    daemonRoute: TransferRouteViabilityRecord,
    directPeerRoute?: TransferRouteViabilityRecord | null,
): TransferRouteViabilityRecord {
    if (daemonRoute.status !== 'viable') {
        return daemonRoute;
    }

    if (directPeerRoute?.status === 'viable' || directPeerRoute?.status === 'unavailable') {
        return directPeerRoute;
    }

    return daemonRoute;
}

export function resolveSessionFileTransferAvailability(
    input: ResolveSessionFileTransferAvailabilityInput,
): ResolveSessionFileTransferAvailabilityResult {
    const daemonDirectPeerDiagnostics = resolveMachineDaemonTransferDirectPeerDiagnostics({
        daemonState: input.machineDaemonState,
    });

    if (!input.sessionAvailable || !input.machineTargetAvailable || !input.serverFeatures) {
        return {
            available: false,
            decision: null,
            daemonDirectPeerDiagnostics,
        };
    }

    const daemonTransferRoute = daemonDirectPeerDiagnostics.route;
    const directPeerRoute = resolveSessionDirectPeerRoute(daemonTransferRoute, input.directPeerRoute);

    const decision = resolveTransferRouteDecision({
        serverFeatures: input.serverFeatures,
        directPeerRoute: directPeerRoute ?? { status: 'unknown' },
        machineRpcDirectRoute: input.machineRpcDirectRoute ?? { status: 'unknown' },
        preferredRouteKinds: input.preferredRouteKinds,
    });

    return {
        available: decision.kind === 'selected',
        decision,
        daemonDirectPeerDiagnostics,
    };
}
