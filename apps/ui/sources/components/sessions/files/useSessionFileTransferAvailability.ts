import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useSession } from '@/sync/domains/state/storage';
import { useMachine, useServerScopedMachine } from '@/sync/domains/state/storage';
import {
    readCachedMachineRpcDirectRoute,
} from '@/sync/domains/transfers/runtime/transferRouteCache';
import {
    resolveSessionFileTransferAvailability,
    type ResolveSessionFileTransferAvailabilityResult,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';

export function useSessionFileTransferAvailabilityState(sessionId: string): ResolveSessionFileTransferAvailabilityResult {
    const session = useSession(sessionId);
    const { machineRpcTargetAvailable } = useSessionMachineReachability(sessionId);
    const serverId = usePreferredServerIdForSession(sessionId);
    const serverSnapshot = useServerFeaturesSnapshotForServerId(serverId, {
        enabled: Boolean(serverId) && machineRpcTargetAvailable,
    });
    const machineTarget = readMachineTargetForSession(sessionId);
    const globalMachine = useMachine(machineTarget?.machineId ?? '');
    const serverScopedMachine = useServerScopedMachine(serverId, machineTarget?.machineId ?? '');
    const machine = serverScopedMachine ?? globalMachine;
    const machineRpcRouteInput = machineTarget && serverId
        ? {
            serverId,
            remoteMachineId: machineTarget.machineId,
        }
        : null;

    return resolveSessionFileTransferAvailability({
        sessionAvailable: Boolean(session),
        machineTargetAvailable: machineRpcTargetAvailable,
        serverFeatures: serverSnapshot.status === 'ready' ? serverSnapshot.features : null,
        machineDaemonState: machine?.daemonState ?? null,
        machineRpcDirectRoute: machineRpcRouteInput
            ? readCachedMachineRpcDirectRoute(machineRpcRouteInput)
            : { status: 'unknown' },
    });
}

export function useSessionFileTransferAvailabilityResolver(sessionId: string): (transferSizeBytes?: number | null) => boolean {
    const availability = useSessionFileTransferAvailabilityState(sessionId);

    return (transferSizeBytes?: number | null) => {
        void transferSizeBytes;
        return availability.available;
    };
}

export function useSessionFileTransferAvailability(sessionId: string): boolean {
    const canTransfer = useSessionFileTransferAvailabilityResolver(sessionId);
    return canTransfer(null);
}
