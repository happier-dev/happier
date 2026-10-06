import type { Session } from '@/sync/domains/state/storageTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { isSessionAccessOwner, isSessionAccessRecipient } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { classifySessionTupleApplyCurrentness } from '@/sync/store/domains/sessionTupleApplyCurrentness';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';

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
        || !classifySessionTupleApplyCurrentness(renderable, {
            ...renderable,
            agentStateVersion: session.agentStateVersion,
        }).agentStateCurrent;
}

/**
 * Whether a list row's composed `metadata` is its owner view.
 *
 * A row has no separate owner field: the renderable builders compose this viewer's projection
 * into `metadata` (the owner view for the owner, the shared projection for a recipient). So for a
 * layout-1 owner row that metadata IS the owner view — the fact every row reader (display names,
 * the renderable→Session projection) and every row writer (a shared-only socket frame must not
 * replace it) has to agree on. One rule, so they cannot.
 */
type SessionListRenderableOwnerProjectionInput = Readonly<{
    metadataLayoutVersion?: unknown;
    access?: SessionListRenderableSession['access'];
    accessLevel?: unknown;
}>;

export function isSessionListRenderableOwnerProjection(
    renderable: SessionListRenderableOwnerProjectionInput,
): boolean {
    return readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion) === 1
        && isSessionAccessOwner(renderable.access, renderable.accessLevel);
}

/** A list row's owner metadata view, with the same layout rules as a hydrated Session's. */
export function readSessionListRenderableOwnerMetadataView(
    renderable: SessionListRenderableOwnerProjectionInput & Readonly<{ metadata: unknown }>,
): Metadata | null {
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(renderable.metadataLayoutVersion);
    if (metadataLayoutVersion === 0 || isSessionListRenderableOwnerProjection(renderable)) {
        return renderable.metadata as Metadata | null;
    }
    return null;
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
    const {
        responsibleAccountId: _baseResponsibleAccountId,
        responsibleAccount: _baseResponsibleAccount,
        ...baseSessionWithoutResponsibility
    } = options.baseSession ?? {};
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
        && classifySessionTupleApplyCurrentness(renderable, options.baseSession).agentStateCurrent;
    const agentState = hasCurrentCanonicalAgentState
        ? options.baseSession!.agentState
        : null;
    const agentStateVersion = hasCurrentCanonicalAgentState
        ? options.baseSession!.agentStateVersion
        : renderable.agentStateVersion;
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(
        renderable.metadataLayoutVersion ?? options.baseSession?.metadataLayoutVersion,
    );
    const ownerMetadataView = renderable.metadataUnavailable === true
        ? null
        : metadataLayoutVersion === 0
            ? undefined
            : isSessionListRenderableOwnerProjection({
                metadataLayoutVersion,
                access: renderable.access,
                accessLevel: renderable.accessLevel,
            })
                ? renderable.metadata as Metadata | null
                : null;

    return {
        ...baseSessionWithoutResponsibility,
        id: renderable.id,
        viewer: renderable.viewer,
        encryptionMode: renderable.encryptionMode ?? options.baseSession?.encryptionMode,
        encryptedContentAvailability: renderable.encryptedContentAvailability !== undefined
            ? renderable.encryptedContentAvailability
            : options.baseSession?.encryptedContentAvailability,
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
        pendingActivationAuthorization: renderable.pendingActivationAuthorization ?? null,
        lastViewedSessionSeq: renderable.viewer !== undefined
            ? renderable.viewer.readState.state === 'tracking'
                ? renderable.viewer.readState.lastViewedSessionSeq
                : null
            : renderable.hasUnreadMessages === true ? 0 : seq,
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
        reportsTo: renderable.reportsTo ?? options.baseSession?.reportsTo ?? null,
        origin: renderable.origin ?? options.baseSession?.origin,
        workDepth: renderable.workDepth ?? options.baseSession?.workDepth,
        reports: renderable.reports ?? options.baseSession?.reports ?? null,
        metadata: mergeRenderableMetadata(options.baseSession?.metadata, renderable.metadata),
        // The row owns this ephemeral projection; a stale base must not revive a retired title.
        lockedDisplayTitle: metadataLayoutVersion === 1
            && renderable.metadata === null
            && isSessionAccessRecipient(renderable.access, renderable.accessLevel)
            ? readSessionDisplayTitleField({ lockedDisplayTitle: renderable.lockedDisplayTitle }).value
            : null,
        metadataLayoutVersion: metadataLayoutVersion || undefined,
        ownerMetadataView,
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
        access: renderable.access,
        ...(Object.prototype.hasOwnProperty.call(renderable, 'responsibleAccountId')
            ? { responsibleAccountId: renderable.responsibleAccountId }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(renderable, 'responsibleAccount')
            ? { responsibleAccount: renderable.responsibleAccount }
            : {}),
        accessLevel: renderable.accessLevel,
        canApprovePermissions: renderable.canApprovePermissions,
    };
}
