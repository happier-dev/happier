import type { Metadata, Session } from '@/sync/domains/state/storageTypes';

import type { SessionListRenderableSession } from './sessionListRenderable';

function normalizeProjectionSeq(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

export function isSessionListRenderableNewerThanSession(
    renderable: SessionListRenderableSession,
    session: Pick<Session, 'seq' | 'agentStateVersion'>,
): boolean {
    return normalizeProjectionSeq(renderable.seq) > normalizeProjectionSeq(session.seq)
        || normalizeProjectionSeq(renderable.agentStateVersion) > normalizeProjectionSeq(session.agentStateVersion);
}

function mergeRenderableMetadata(
    baseMetadata: Metadata | null | undefined,
    renderableMetadata: SessionListRenderableSession['metadata'],
): Metadata | null {
    return baseMetadata ?? renderableMetadata as Metadata | null;
}

export function buildSessionFromListRenderable(
    renderable: SessionListRenderableSession,
    options: Readonly<{
        baseSession?: Session;
        serverId?: string | null;
    }> = {},
): Session {
    const seq = normalizeProjectionSeq(renderable.seq);
    const normalizedServerId = typeof options.serverId === 'string' && options.serverId.trim()
        ? options.serverId.trim()
        : options.baseSession?.serverId;
    const pendingRequestObservedAt = typeof renderable.pendingRequestObservedAt === 'number'
        && Number.isFinite(renderable.pendingRequestObservedAt)
        && renderable.pendingRequestObservedAt > 0
        ? renderable.pendingRequestObservedAt
        : null;
    const hasRenderablePendingSummary = typeof renderable.hasPendingPermissionRequests === 'boolean'
        || typeof renderable.hasPendingUserActionRequests === 'boolean';
    const hasCurrentCanonicalAgentState = options.baseSession !== undefined
        && options.baseSession.agentStateVersion >= renderable.agentStateVersion;
    const agentState = hasCurrentCanonicalAgentState
        ? options.baseSession!.agentState
        : null;
    const agentStateVersion = hasCurrentCanonicalAgentState
        ? options.baseSession!.agentStateVersion
        : renderable.agentStateVersion;

    return {
        ...options.baseSession,
        id: renderable.id,
        serverId: normalizedServerId,
        seq: renderable.hasUnreadMessages === true ? Math.max(1, seq) : seq,
        createdAt: renderable.createdAt,
        updatedAt: renderable.updatedAt,
        active: renderable.active,
        activeAt: renderable.activeAt,
        archivedAt: renderable.archivedAt ?? null,
        meaningfulActivityAt: renderable.meaningfulActivityAt ?? null,
        pendingVersion: renderable.pendingVersion,
        pendingCount: renderable.pendingCount,
        pendingBlockedCount: renderable.pendingBlockedCount,
        lastViewedSessionSeq: renderable.hasUnreadMessages === true ? 0 : seq,
        pendingPermissionRequestCount: typeof renderable.hasPendingPermissionRequests === 'boolean'
            ? renderable.hasPendingPermissionRequests ? 1 : 0
            : options.baseSession?.pendingPermissionRequestCount,
        pendingUserActionRequestCount: typeof renderable.hasPendingUserActionRequests === 'boolean'
            ? renderable.hasPendingUserActionRequests ? 1 : 0
            : options.baseSession?.pendingUserActionRequestCount,
        pendingRequestObservedAt: hasRenderablePendingSummary
            ? pendingRequestObservedAt
            : options.baseSession?.pendingRequestObservedAt,
        latestReadyEventSeq: renderable.hasUnreadMessages === true
            ? Math.max(1, seq)
            : renderable.latestReadyEventSeq,
        latestTurnStatus: renderable.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: renderable.latestTurnStatusObservedAt ?? null,
        runtimeActivityState: renderable.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: renderable.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: renderable.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: renderable.runtimeActivityRevision ?? null,
        lastRuntimeIssue: renderable.lastRuntimeIssue ?? null,
        lastTurnCompletedAt: renderable.lastTurnCompletedAt ?? null,
        metadata: mergeRenderableMetadata(options.baseSession?.metadata, renderable.metadata),
        metadataVersion: renderable.metadataVersion,
        agentState,
        agentStateVersion,
        thinking: renderable.thinking,
        thinkingAt: renderable.thinkingAt,
        presence: renderable.presence,
        optimisticThinkingAt: renderable.optimisticThinkingAt,
        resumingAt: renderable.resumingAt,
        thinkingGraceUntil: renderable.thinkingGraceUntil,
        owner: renderable.owner,
        accessLevel: renderable.accessLevel,
        canApprovePermissions: renderable.canApprovePermissions,
    };
}
