import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionMachineReachability } from '@/sync/domains/machines/reachability/resolveSessionMachineReachability';
import { resolveSessionMachineReachability } from '@/sync/domains/machines/reachability/resolveSessionMachineReachability';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { resolveMachineTargetForSessionFromState, resolveDisplayIdentityForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { resolveSessionRpcAvailabilityState } from '@/sync/domains/session/sessionRpcAvailability';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveSessionFileTransferAvailability } from '@/sync/domains/transfers/runtime/transferRuntime/availability/resolveSessionFileTransferAvailability';
import { resolveMachineCarrierHostEligibility } from '@/sync/domains/transfers/runtime/transferRuntime/routing/resolveMachineCarrierPreselection';
import { resolveBrowserIrohHostDecision } from '@/sync/runtime/browserIroh/hostEligibility';
import { isIrohMachineTransferLifecycleAvailable } from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { readSessionAttachmentUploadContext } from './sessionAttachmentUploadContext';

export type SessionFileUploadAvailabilitySnapshot = Readonly<{
    uploadAvailable: boolean;
    machineReachability: SessionMachineReachability;
}>;

/** Local snapshot only: no presence subscription, lifecycle probe or feature fetch. */
export async function readSessionFileUploadAvailability(address: SessionAddress): Promise<SessionFileUploadAvailabilitySnapshot> {
    const resolution = await resolveServerCredentialAccountScope(address.serverId);
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    const state = storage.getState();
    const rpc = resolveSessionRpcAvailabilityState(state, address.sessionId, address.serverId);
    const sessionBound = readSessionAttachmentUploadContext(address.sessionId, rpc.sessionRpcAvailable ? scope : null);
    const machineTarget = resolveMachineTargetForSessionFromState(state, address);
    const displayIdentity = machineTarget ? null : resolveDisplayIdentityForSessionFromState({
        state, serverId: address.serverId, sessionId: address.sessionId,
    });
    const machine = resolveExactServerScopedMachine({ serverId: address.serverId,
        machineId: machineTarget?.machineId ?? displayIdentity?.machineId ?? '',
        activeServerId: getActiveServerSnapshot().serverId,
        get activeMachines() { return Object.values(state.machines); },
        activeMachineRecords: state.machines,
        machineListByServerId: state.machineListByServerId,
        machineListStatusByServerId: state.machineListStatusByServerId,
        machineRecordsByServerId: state.machineRecordsByServerId,
    });
    const machineReachability = machine ? resolveMachineReachability(scope, machine) : 'unknown';
    if (sessionBound) return { uploadAvailable: true, machineReachability };
    const snapshot = getCachedServerFeaturesSnapshot({ serverId: address.serverId });
    const machineAvailability = resolveSessionFileTransferAvailability({
        applicationCarrierEligibility: state.localSettings.homeApplicationCarrierEligibility,
        sessionAvailable: rpc.sessionExists,
        machineTargetAvailable: Boolean(machineTarget?.basePath) && resolveSessionMachineReachability({
            machineIsKnown: Boolean(machine), machineIsOnline: machineReachability === 'reachable',
        }),
        serverFeatures: snapshot?.status === 'ready' ? snapshot.features : null,
        machineDaemonState: machine?.daemonState ?? null, machineKind: machine?.kind ?? null,
        machineOperationProtocolCapabilities: machine?.operationProtocolCapabilities ?? null,
        machineOperationProtocolCapabilitiesRevision: machine?.operationProtocolCapabilitiesRevision ?? null,
        machineActive: machine?.active ?? null, machineRevokedAt: machine?.revokedAt ?? null,
        machineCarrierHost: resolveMachineCarrierHostEligibility({ browserIroh: resolveBrowserIrohHostDecision(),
            nativeLifecycleAvailable: isIrohMachineTransferLifecycleAvailable() }),
    });
    return { uploadAvailable: machineAvailability.available, machineReachability };
}
