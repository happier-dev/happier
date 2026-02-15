import type { ResumeSessionOptions } from '@/sync/ops';
import type { Session } from '../state/storageTypes';
import { resolveAgentIdFromFlavor, buildWakeResumeExtras } from '@/agents/catalog/catalog';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';

export type PendingQueueWakeResumeOptions = ResumeSessionOptions;

export function getPendingQueueWakeResumeOptions(opts: {
    sessionId: string;
    session: Session;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    // Optional: gate waking behind an external capability check (e.g. local machine encryption).
    // This is used to avoid attempting machine RPCs in contexts where the client cannot encrypt them.
    canWakeMachineId?: (machineId: string) => boolean;
}): PendingQueueWakeResumeOptions | null {
    const { sessionId, session, resumeCapabilityOptions, permissionOverride, canWakeMachineId } = opts;

    // Only gate waking on "idle" when the session is actively running.
    // For inactive/archived sessions, `thinking` / `agentState.requests` can be stale; blocking wake would
    // strand pending-queue messages until the user sends another message (or the state refreshes).
    const isSessionActive = session.presence === 'online';
    if (isSessionActive) {
        if (session.thinking === true) return null;
        const requests = session.agentState?.requests;
        if (requests && Object.keys(requests).length > 0) return null;
    }

    const machineId = session.metadata?.machineId;
    const directory = session.metadata?.path;
    const flavor = session.metadata?.flavor;
    if (!machineId || !directory || !flavor) return null;
    if (canWakeMachineId && canWakeMachineId(machineId) === false) return null;

    const agentId = resolveAgentIdFromFlavor(flavor);
    if (!agentId) return null;

    const base = buildResumeSessionBaseOptionsFromSession({
        sessionId,
        session,
        resumeCapabilityOptions,
        permissionOverride,
    });
    if (!base) return null;

    return {
        ...base,
        ...buildWakeResumeExtras({ agentId, resumeCapabilityOptions }),
    };
}
