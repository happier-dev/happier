import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveSessionFileTransferRouteAvailability } from '@/sync/domains/transfers/runtime/resolveTransferAvailability';
import { readCachedMachineRpcDirectRoute } from '@/sync/domains/transfers/runtime/transferRouteCache';
import { useSession } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';

export function useSessionFileTransferAvailability(sessionId: string): boolean {
    const session = useSession(sessionId);
    const { machineRpcTargetAvailable } = useSessionMachineReachability(sessionId);
    const sessionRpcAvailable = session?.active !== false;
    const serverId = resolvePreferredServerIdForSessionId(sessionId) ?? null;
    const serverSnapshot = useServerFeaturesSnapshotForServerId(serverId, {
        enabled: Boolean(serverId) && (sessionRpcAvailable || machineRpcTargetAvailable),
    });

    if (!serverId) {
        return false;
    }
    if (serverSnapshot.status !== 'ready') {
        return false;
    }

    const machineTarget = readMachineTargetForSession(sessionId);
    const directRouteCache = machineTarget && machineRpcTargetAvailable
        ? readCachedMachineRpcDirectRoute({
            serverId,
            remoteMachineId: machineTarget.machineId,
        })
        : null;
    const directRouteAvailable = Boolean(
        machineTarget
        && machineRpcTargetAvailable
        && (
            directRouteCache?.status === 'viable'
            || (sessionRpcAvailable === false && directRouteCache?.status !== 'unavailable')
        ),
    );

    return resolveSessionFileTransferRouteAvailability({
        serverId,
        machineTargetAvailable: directRouteAvailable,
        sessionRpcAvailable,
        serverFeatures: serverSnapshot.features,
        sessionRpcTransferSizeBytes: null,
    }).kind === 'selected';
}
