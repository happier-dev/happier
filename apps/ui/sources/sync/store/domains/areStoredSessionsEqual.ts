import type { Session } from '../../domains/state/storageTypes';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';

function arePlainObjectValuesEqual(
    previous: Record<string, unknown>,
    next: Record<string, unknown>,
): boolean {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    if (previousKeys.length !== nextKeys.length) return false;

    for (const key of previousKeys) {
        if (!(key in next)) return false;
        if (!areSessionValueEqual(previous[key], next[key])) return false;
    }

    return true;
}

/**
 * Deep value equality over session-shaped plain data (objects/arrays/
 * primitives). Exported so store writers can guard value-identical writes
 * (e.g. `latestUsage`/`todos` copies from the mutable reducer state) without
 * duplicating the compare.
 */
export function areSessionValuesDeepEqual(previous: unknown, next: unknown): boolean {
    return areSessionValueEqual(previous, next);
}

function areSessionValueEqual(previous: unknown, next: unknown): boolean {
    if (previous === next) return true;
    if (previous == null || next == null) return previous === next;

    if (Array.isArray(previous) || Array.isArray(next)) {
        if (!Array.isArray(previous) || !Array.isArray(next)) return false;
        if (previous.length !== next.length) return false;
        for (let index = 0; index < previous.length; index += 1) {
            if (!areSessionValueEqual(previous[index], next[index])) return false;
        }
        return true;
    }

    if (typeof previous === 'object' || typeof next === 'object') {
        if (typeof previous !== 'object' || typeof next !== 'object') return false;
        return arePlainObjectValuesEqual(
            previous as Record<string, unknown>,
            next as Record<string, unknown>,
        );
    }

    return false;
}

export function areStoredSessionsEqual(
    previous: Session | undefined,
    next: Session,
): boolean {
    if (!previous) return false;

    const activeAtMatches =
        previous.activeAt === next.activeAt
        || (
            previous.active === true
            && next.active === true
            && previous.presence === 'online'
            && next.presence === 'online'
        );

    return previous.id === next.id
        && (previous.serverId ?? null) === (next.serverId ?? null)
        && previous.seq === next.seq
        && (previous.encryptionMode ?? null) === (next.encryptionMode ?? null)
        && previous.createdAt === next.createdAt
        && previous.updatedAt === next.updatedAt
        && (previous.meaningfulActivityAt ?? null) === (next.meaningfulActivityAt ?? null)
        && previous.active === next.active
        && activeAtMatches
        && (previous.archivedAt ?? null) === (next.archivedAt ?? null)
        && (previous.pendingVersion ?? null) === (next.pendingVersion ?? null)
        && (previous.pendingCount ?? null) === (next.pendingCount ?? null)
        && (previous.pendingBlockedCount ?? null) === (next.pendingBlockedCount ?? null)
        && (previous.lastViewedSessionSeq ?? null) === (next.lastViewedSessionSeq ?? null)
        && (previous.pendingPermissionRequestCount ?? null) === (next.pendingPermissionRequestCount ?? null)
        && (previous.pendingUserActionRequestCount ?? null) === (next.pendingUserActionRequestCount ?? null)
        && (previous.latestTurnStatus ?? null) === (next.latestTurnStatus ?? null)
        && (previous.latestTurnStatusObservedAt ?? null) === (next.latestTurnStatusObservedAt ?? null)
        && (previous.runtimeActivityState ?? null) === (next.runtimeActivityState ?? null)
        && (previous.runtimeActivityActiveCount ?? null) === (next.runtimeActivityActiveCount ?? null)
        && (previous.runtimeActivityObservedAt ?? null) === (next.runtimeActivityObservedAt ?? null)
        && (previous.runtimeActivityRevision ?? null) === (next.runtimeActivityRevision ?? null)
        && areSessionValueEqual(previous.rollbackEligibleTurnStarts ?? null, next.rollbackEligibleTurnStarts ?? null)
        && areSessionValueEqual(previous.sessionTurns ?? null, next.sessionTurns ?? null)
        && (previous.latestReadyEventSeq ?? null) === (next.latestReadyEventSeq ?? null)
        && (previous.latestReadyEventAt ?? null) === (next.latestReadyEventAt ?? null)
        && areSessionValueEqual(previous.lastRuntimeIssue ?? null, next.lastRuntimeIssue ?? null)
        && readSessionMetadataLayoutVersion(previous.metadataLayoutVersion)
            === readSessionMetadataLayoutVersion(next.metadataLayoutVersion)
        && previous.metadataVersion === next.metadataVersion
        && previous.agentStateVersion === next.agentStateVersion
        && previous.thinking === next.thinking
        && previous.thinkingAt === next.thinkingAt
        && previous.presence === next.presence
        && (previous.optimisticThinkingAt ?? null) === (next.optimisticThinkingAt ?? null)
        && (previous.resumingAt ?? null) === (next.resumingAt ?? null)
        && (previous.thinkingGraceUntil ?? null) === (next.thinkingGraceUntil ?? null)
        && (previous.lastTurnCompletedAt ?? null) === (next.lastTurnCompletedAt ?? null)
        && (previous.draft ?? null) === (next.draft ?? null)
        && (previous.permissionMode ?? null) === (next.permissionMode ?? null)
        && (previous.permissionModeUpdatedAt ?? null) === (next.permissionModeUpdatedAt ?? null)
        && (previous.modelMode ?? null) === (next.modelMode ?? null)
        && (previous.modelModeUpdatedAt ?? null) === (next.modelModeUpdatedAt ?? null)
        && (previous.owner ?? null) === (next.owner ?? null)
        && (previous.accessLevel ?? null) === (next.accessLevel ?? null)
        && (previous.canApprovePermissions ?? null) === (next.canApprovePermissions ?? null)
        && areSessionValueEqual(previous.metadata, next.metadata)
        && areSessionValueEqual(previous.ownerMetadataView ?? null, next.ownerMetadataView ?? null)
        && areSessionValueEqual(previous.agentState, next.agentState)
        && areSessionValueEqual(previous.todos ?? null, next.todos ?? null)
        && areSessionValueEqual(previous.latestUsage ?? null, next.latestUsage ?? null)
        && areSessionValueEqual(previous.ownerProfile ?? null, next.ownerProfile ?? null);
}
