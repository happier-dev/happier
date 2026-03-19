import type { ResumeSessionOptions } from '@/sync/ops';
import type { Session } from '../state/storageTypes';
import { resolveAgentIdFromFlavor, buildWakeResumeExtras } from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

export type PendingQueueWakeResumeOptions = ResumeSessionOptions;

type PendingQueueWakeTargetOverride = Readonly<{
    machineId?: string | null;
    directory?: string | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function getPendingQueueWakeResumeOptions(opts: {
    sessionId: string;
    session: Session;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    resumeTargetOverride?: PendingQueueWakeTargetOverride | null;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
    // Optional: gate waking behind an external capability check (e.g. local machine encryption).
    // This is used to avoid attempting machine RPCs in contexts where the client cannot encrypt them.
    canWakeMachineId?: (machineId: string) => boolean;
}): PendingQueueWakeResumeOptions | null {
    const { sessionId, session, resumeCapabilityOptions, resumeTargetOverride, permissionOverride, canWakeMachineId } = opts;

    // Only gate waking on "idle" when the session is actively running.
    // For inactive/archived sessions, `thinking` / `agentState.requests` can be stale; blocking wake would
    // strand pending-queue messages until the user sends another message (or the state refreshes).
    const isSessionActive = session.presence === 'online';
    if (isSessionActive) {
        if (session.thinking === true) return null;
        const requests = session.agentState?.requests;
        if (requests && Object.keys(requests).length > 0) return null;
    }

    const reachableTarget = readMachineTargetForSession(sessionId);
    const machineId = normalizeNonEmptyString(resumeTargetOverride?.machineId)
        ?? normalizeNonEmptyString(reachableTarget?.machineId)
        ?? normalizeNonEmptyString(session.metadata?.machineId);
    const directory = normalizeNonEmptyString(resumeTargetOverride?.directory)
        ?? normalizeNonEmptyString(reachableTarget?.basePath)
        ?? normalizeNonEmptyString(session.metadata?.path);
    if (!machineId || !directory) return null;
    if (canWakeMachineId && canWakeMachineId(machineId) === false) return null;

    const agentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? resolveAgentIdFromFlavor(session.metadata?.flavor);
    if (!agentId) return null;

    const base = buildResumeSessionBaseOptionsFromSession({
        sessionId,
        session,
        resumeCapabilityOptions,
        resumeTargetOverride,
        permissionOverride,
    });
    if (!base) return null;

    return {
        ...base,
        ...buildWakeResumeExtras({ agentId, resumeCapabilityOptions, session }),
    };
}
