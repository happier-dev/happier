import * as React from 'react';

import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useLocalSetting, useServerScopedMachine, useSessionRpcAvailabilityState } from '@/sync/domains/state/storage';
import {
    resolveSessionFileTransferAvailability,
    type ResolveSessionFileTransferAvailabilityResult,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import {
    isIrohMachineTransferLifecycleAvailable,
    probeIrohMachineTransferLifecycleAvailability,
    subscribeIrohMachineTransferLifecycleAvailability,
} from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { isBrowserIrohHost } from '@/sync/runtime/browserIroh/hostEligibility';

export function useSessionFileTransferAvailabilityState(
    sessionId: string,
    sessionServerId?: string | null,
    enabled = true,
): ResolveSessionFileTransferAvailabilityResult {
    const availableSessionId = enabled ? sessionId : '';
    const { sessionExists } = useSessionRpcAvailabilityState(availableSessionId);
    const applicationCarrierEligibility = useLocalSetting('homeApplicationCarrierEligibility');
    const { machineRpcTargetAvailable } = useSessionMachineReachability(availableSessionId, enabled ? sessionServerId : null);
    const preferredServerId = usePreferredServerIdForSession({ serverId: enabled ? sessionServerId : null, sessionId: availableSessionId }, enabled);
    const serverId = enabled ? preferredServerId : null;
    const serverSnapshot = useServerFeaturesSnapshotForServerId(serverId, {
        enabled: Boolean(serverId) && machineRpcTargetAvailable,
    });
    const machineTarget = enabled ? readMachineTargetForSession(serverId
        ? { serverId, sessionId }
        : sessionId) : null;
    const machine = useServerScopedMachine(serverId, machineTarget?.machineId ?? '');
    const nativeMachineCarrierAvailable = React.useSyncExternalStore(
        subscribeIrohMachineTransferLifecycleAvailability,
        isIrohMachineTransferLifecycleAvailable,
        isIrohMachineTransferLifecycleAvailable,
    );
    React.useEffect(() => {
        if (enabled && applicationCarrierEligibility !== 'standard_only') {
            void probeIrohMachineTransferLifecycleAvailability();
        }
    }, [applicationCarrierEligibility, enabled]);
    return resolveSessionFileTransferAvailability({
        applicationCarrierEligibility,
        sessionAvailable: enabled && sessionExists,
        machineTargetAvailable: machineRpcTargetAvailable,
        serverFeatures: serverSnapshot.status === 'ready' ? serverSnapshot.features : null,
        machineDaemonState: machine?.daemonState ?? null,
        machineKind: machine?.kind ?? null,
        machineOperationProtocolCapabilities: machine?.operationProtocolCapabilities ?? null,
        machineOperationProtocolCapabilitiesRevision: machine?.operationProtocolCapabilitiesRevision ?? null,
        machineActive: machine?.active ?? null,
        machineRevokedAt: machine?.revokedAt ?? null,
        machineCarrierHost: isBrowserIrohHost()
            ? { kind: 'browser' }
            : { kind: 'native', lifecycleAvailable: nativeMachineCarrierAvailable },
    });
}

export function useSessionFileTransferAvailabilityResolver(
    sessionId: string,
    sessionServerId?: string | null,
    enabled = true,
): (transferSizeBytes?: number | null) => boolean {
    const availability = useSessionFileTransferAvailabilityState(sessionId, sessionServerId, enabled);

    return React.useCallback((transferSizeBytes?: number | null) => {
        void transferSizeBytes;
        return availability.available;
    }, [availability.available]);
}

export function useSessionFileTransferAvailability(sessionId: string, sessionServerId?: string | null, enabled = true): boolean {
    const canTransfer = useSessionFileTransferAvailabilityResolver(sessionId, sessionServerId, enabled);
    return canTransfer(null);
}
