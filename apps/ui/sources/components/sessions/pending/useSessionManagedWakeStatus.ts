import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readManagedWakeAuthorization } from '@/sync/domains/pending/managedWakeProjection';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { UiSessionManagedWakeFacts } from '@/sync/domains/session/attention/runtimePresentation';

/** A mounted row reads its exact Home Machine projection, never pending bodies or protected inventory. */
export function useSessionManagedWakeStatus(session: SessionListRenderableSession | null, serverId: string | null | undefined): UiSessionManagedWakeFacts | null {
    const authorization = session ? readManagedWakeAuthorization(session) : null;
    const machineId = authorization?.managedWakeTargetV1?.enrolledMachineId;
    const machine = useMachinePresenceSummaries(serverId, machineId ? [machineId] : [])[0];
    return authorization && typeof machine?.nativeReady === 'boolean' ? { managedWakeMachine: {
        state: machine.nativeState, nativeReady: machine.nativeReady, activationStatus: authorization.status,
    } } : null;
}
