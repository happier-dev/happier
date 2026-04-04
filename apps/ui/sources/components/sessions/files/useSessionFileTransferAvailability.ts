import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useSession } from '@/sync/domains/state/storage';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import {
    readCachedMachineRpcDirectRoute,
} from '@/sync/domains/transfers/runtime/transferRouteCache';
import { resolveSessionFileTransferAvailability } from '@/sync/domains/transfers/runtime/transferSubstrate';
import { resolveMachineDaemonTransferDirectPeerRoute } from '@/sync/domains/transfers/runtime/transferSubstrate/machineDaemonTransferState';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

export function useSessionFileTransferAvailabilityResolver(sessionId: string): (transferSizeBytes?: number | null) => boolean {
    const session = useSession(sessionId);
    const { machineRpcTargetAvailable } = useSessionMachineReachability(sessionId);
    const serverId = resolvePreferredServerIdForSessionId(sessionId) ?? null;
    const serverSnapshot = useServerFeaturesSnapshotForServerId(serverId, {
        enabled: Boolean(serverId) && machineRpcTargetAvailable,
    });
    const machineTarget = readMachineTargetForSession(sessionId);
    const machine = useServerScopedMachine(serverId, machineTarget?.machineId ?? '');
    const machineDirectPeerRoute = resolveMachineDaemonTransferDirectPeerRoute({
        daemonState: machine?.daemonState ?? null,
    });
    const machineRpcRouteInput = machineTarget && serverId
        ? {
            serverId,
            remoteMachineId: machineTarget.machineId,
        }
        : null;

    return (transferSizeBytes?: number | null) => {
        void transferSizeBytes;
        if (!session) {
            return false;
        }
        if (!serverId) {
            return false;
        }
        if (serverSnapshot.status !== 'ready') {
            return false;
        }
        if (!machineTarget) {
            return false;
        }
        if (!machineRpcTargetAvailable) {
            return false;
        }

        const { available } = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures: serverSnapshot.features,
            machineDaemonState: machine?.daemonState ?? null,
            directPeerRoute: machineDirectPeerRoute,
            machineRpcDirectRoute: machineRpcRouteInput
                ? readCachedMachineRpcDirectRoute(machineRpcRouteInput)
                : { status: 'unknown' },
        });

        return available;
    };
}

export function useSessionFileTransferAvailability(sessionId: string): boolean {
    const canTransfer = useSessionFileTransferAvailabilityResolver(sessionId);
    return canTransfer(null);
}
