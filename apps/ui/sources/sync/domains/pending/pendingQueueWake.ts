import type { ResumeSessionOptions } from '@/sync/ops';
import type { Session } from '../state/storageTypes';
import { buildWakeResumeExtras } from '@/agents/catalog/catalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { PermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { deriveSessionInputReadinessState } from '@/sync/domains/session/control/deriveSessionInputReadinessState';
import {
    deriveLatestPendingRequestObservedAtFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

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

function resolvePendingQueueWakeCursor(session: Session): number | null {
    const seq = session.seq;
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return null;
    return Math.trunc(seq);
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
    const isSessionActive = session.active === true && session.presence === 'online';
    if (isSessionActive) {
        const requests = session.agentState?.requests;
        const hasRuntimeRequests = Boolean(requests && Object.keys(requests).length > 0);
        const inputReadiness = deriveSessionInputReadinessState({
            active: session.active,
            activeAt: session.activeAt,
            presence: session.presence,
            thinking: session.thinking,
            thinkingAt: session.thinkingAt,
            optimisticThinkingAt: session.optimisticThinkingAt,
            hasPendingUserMessages: typeof session.pendingCount === 'number' && session.pendingCount > 0,
            latestTurnStatus: session.latestTurnStatus,
            latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
            hasPendingPermissionRequests: hasRuntimeRequests,
            hasPendingUserActionRequests: hasRuntimeRequests,
            pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
        }, Date.now());
        if (!inputReadiness.canWakePendingQueue) return null;
    }

    const reachableTarget = readMachineControlTargetForSession(sessionId);
    const machineId = normalizeNonEmptyString(resumeTargetOverride?.machineId)
        ?? normalizeNonEmptyString(reachableTarget?.machineId);
    const directory = normalizeNonEmptyString(resumeTargetOverride?.directory)
        ?? normalizeNonEmptyString(reachableTarget?.basePath);
    if (!machineId || !directory) return null;
    if (canWakeMachineId && canWakeMachineId(machineId) === false) return null;

    const base = buildResumeSessionBaseOptionsFromSession({
        sessionId,
        session,
        resumeCapabilityOptions,
        resumeTargetOverride: resumeTargetOverride ?? { machineId, directory },
        permissionOverride,
    });
    if (!base) return null;

    const initialTranscriptAfterSeq = resolvePendingQueueWakeCursor(session);
    const baseWithCursor = initialTranscriptAfterSeq === null
        ? base
        : {
            ...base,
            initialTranscriptAfterSeq,
        };

    const backendTarget = baseWithCursor.backendTarget;
    if (typeof backendTarget === 'object' && backendTarget !== null && 'kind' in backendTarget && backendTarget.kind === 'configuredAcpBackend') {
        return baseWithCursor;
    }

    const agentId = resolveAgentIdFromSessionMetadata(
        readSessionOwnerMetadataView(session),
    )
        ?? (typeof backendTarget === 'object' && backendTarget !== null && 'kind' in backendTarget && backendTarget.kind === 'builtInAgent'
            ? backendTarget.agentId
            : null);
    if (!agentId) return baseWithCursor;

    // `buildWakeResumeExtras` is the one owner of an Agent's wake-resume extras
    // and already answers `{}` when no behavior is contributed under this id.
    // A bundled-id filter here would drop the extras an externally installed
    // Agent projects through its `plugin.ui.v1` descriptor, which the session
    // goal resume path (`@/sync/ops/sessionGoals`) already delivers.
    return {
        ...baseWithCursor,
        ...buildWakeResumeExtras({ agentId, resumeCapabilityOptions, session }),
    };
}
