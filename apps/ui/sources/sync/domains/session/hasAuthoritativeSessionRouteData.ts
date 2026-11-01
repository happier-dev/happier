import { StoredSessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { SessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import { readSessionOwnerMetadataView } from './readSessionOwnerMetadataView';
import { isSessionAccessOwner, isSessionAccessRecipient, type NormalizedSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from './listing/sessionListRenderable';
import { classifySessionTupleApplyCurrentness } from './sessionTupleApplyCurrentness';
import { readSessionFullPublicationUpdatedAt } from './sessionRuntimeObservation';
import {
    SESSION_LIST_DOCUMENT_ADMISSION,
    areSessionListDocumentAdmissionsEqual,
    hasCurrentSessionListDisplayMetadata,
    type SessionListDocumentAdmission,
} from './sessionDocumentAdmission';
import {
    readBlockedSessionContentAvailability,
    readSessionContentAvailability,
    type SessionContentAvailability,
} from './encryptedContentAvailability';

type SessionRouteDataCandidate = Readonly<{
    metadataLayoutVersion?: number;
    metadataProjection?: Session['metadataProjection'];
    metadata?: unknown;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
    access?: NormalizedSessionAccessProjection | null;
    encryptionMode?: 'e2ee' | 'plain' | null;
    encryptedContentAvailability?: SessionContentAvailability | null;
    metadataVersion?: number;
    agentStateVersion?: number;
    [SESSION_LIST_DOCUMENT_ADMISSION]?: SessionListDocumentAdmission;
}> | null | undefined;

/** A full publication must cover the currently observed row without crossing document custody. */
export function isHydratedSessionCurrentForListState(
    session: Pick<Session, 'id' | 'seq' | 'updatedAt' | 'metadataLayoutVersion' | 'metadataVersion' | 'agentStateVersion' | 'archivedAt' | typeof SESSION_LIST_DOCUMENT_ADMISSION>,
    getCurrentSessionListRenderable: ((sessionId: string) => SessionListRenderableSession | null | undefined) | undefined,
    sessionPublicationUpdatedAt = session.updatedAt,
): boolean {
    if (!getCurrentSessionListRenderable) return true;
    const currentRenderable = getCurrentSessionListRenderable(session.id);
    if (!currentRenderable) return false;
    const observedAdmission = currentRenderable[SESSION_LIST_DOCUMENT_ADMISSION];
    if (observedAdmission && !areSessionListDocumentAdmissionsEqual(session[SESSION_LIST_DOCUMENT_ADMISSION], observedAdmission)) return false;
    if ((observedAdmission?.observedMetadataVersion ?? currentRenderable.metadataVersion) > session.metadataVersion) return false;
    if ((observedAdmission?.observedAgentStateVersion ?? currentRenderable.agentStateVersion) > session.agentStateVersion) return false;
    if (currentRenderable.seq > session.seq) return false;
    if (readSessionFullPublicationUpdatedAt({ id: currentRenderable.id, serverId: currentRenderable.serverId })
        > sessionPublicationUpdatedAt) return false;
    if (!classifySessionTupleApplyCurrentness(currentRenderable, session).fullyCurrent) return false;
    return (currentRenderable.archivedAt ?? null) === (session.archivedAt ?? null);
}

/** An opened transcript's inventory must include the latest admitted lifecycle fact. */
export function hasCurrentSessionTurnsProjection(session: Readonly<{
    latestTurnId?: string | null;
    latestTurnStatus?: string | null;
    sessionTurns?: SessionTurnsProjectionV1 | null;
}>): boolean {
    const projection = session.sessionTurns;
    if (!projection) return false;
    if (!session.latestTurnId) return true;
    const latest = projection.turns.find(turn => turn.turnId === session.latestTurnId);
    return latest !== undefined && (session.latestTurnStatus == null || latest.status === session.latestTurnStatus);
}

/**
 * Returns whether a stored Session has the owner-authoritative metadata needed
 * by route consumers. Layout-1 owner list rows intentionally omit the owner
 * view and require exact-session hydration. An exact scoped producer may establish a
 * session-only projection without claiming the full owner view. Shared participants, identified by
 * their access level, are authoritative from the normalized stored shared projection and
 * must never be made to request owner data.
 */
export function hasAuthoritativeSessionRouteData(
    session: SessionRouteDataCandidate,
    options?: Readonly<{ hasSessionEncryption: boolean }>,
): boolean {
    // A presentation reconstruction has no full documents, even when its source row
    // retained opened-version witnesses or a settled unavailable display answer.
    if (!session || session.metadataProjection === 'displayOnly') return false;
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    if (metadataLayoutVersion !== 0 && metadataLayoutVersion !== 1) return false;
    // A settled locked answer is authoritative on its own; an unsettled one still needs hydration.
    if (readBlockedSessionContentAvailability(readSessionContentAvailability(session)) !== null) return true;
    const admission = session[SESSION_LIST_DOCUMENT_ADMISSION];
    // Markerless values retain the existing internal full-publication contract. Compact
    // and cached display ingress writes list rows; B1 document readers attach custody.
    if (admission) {
        // Display/cache custody proves only opened metadata. Route controls also need the
        // actual Agent-state document, including an explicitly opened null/privacy redaction.
        if (typeof session.metadataVersion !== 'number' || typeof session.agentStateVersion !== 'number'
            || !hasCurrentSessionListDisplayMetadata({ ...session, metadata: session.metadata,
                metadataVersion: session.metadataVersion, encryptionMode: session.encryptionMode ?? undefined })
            || session.metadataVersion < (admission.observedMetadataVersion ?? session.metadataVersion)
            || admission.openedAgentStateVersion !== session.agentStateVersion
            || session.agentStateVersion < (admission.observedAgentStateVersion ?? session.agentStateVersion)) return false;
    }
    if (options && session.encryptionMode !== 'plain' && !options.hasSessionEncryption) return false;
    if (metadataLayoutVersion === 0) {
        return session.metadata != null;
    }
    if (metadataLayoutVersion !== 1) {
        return false;
    }
    if (session.metadataProjection === 'sessionOnly') {
        return session.access?.capabilities.readTranscript === true
            && StoredSessionSharedMetadataV1Schema.safeParse(session.metadata).success;
    }
    if (isSessionAccessRecipient(session.access, session.accessLevel)) {
        return StoredSessionSharedMetadataV1Schema.safeParse(session.metadata).success;
    }
    if (!isSessionAccessOwner(session.access, session.accessLevel)) {
        return false;
    }
    return readSessionOwnerMetadataView({
        metadataLayoutVersion,
        metadata: session.metadata ?? null,
        ownerMetadataView: session.ownerMetadataView,
    }) != null;
}
