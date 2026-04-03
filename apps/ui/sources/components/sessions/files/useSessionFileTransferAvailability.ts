import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useSession } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { readServerEnabledBit } from '@happier-dev/protocol';

export function useSessionFileTransferAvailabilityResolver(sessionId: string): (transferSizeBytes?: number | null) => boolean {
    const session = useSession(sessionId);
    const { machineRpcTargetAvailable } = useSessionMachineReachability(sessionId);
    const serverId = resolvePreferredServerIdForSessionId(sessionId) ?? null;
    const serverSnapshot = useServerFeaturesSnapshotForServerId(serverId, {
        enabled: Boolean(serverId) && machineRpcTargetAvailable,
    });

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
        if (readServerEnabledBit(serverSnapshot.features, 'machines.transfer') !== true) {
            return false;
        }

        const machineTarget = readMachineTargetForSession(sessionId);
        if (!machineTarget) {
            return false;
        }
        if (!machineRpcTargetAvailable) {
            return false;
        }
        return true;
    };
}

export function useSessionFileTransferAvailability(sessionId: string): boolean {
    const canTransfer = useSessionFileTransferAvailabilityResolver(sessionId);
    return canTransfer(null);
}
