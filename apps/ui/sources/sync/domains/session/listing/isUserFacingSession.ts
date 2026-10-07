import { isHiddenSystemSession } from '@happier-dev/protocol/sessions/control/contract';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { isSessionAccessRecipient, isSessionAccessOwner, type NormalizedSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { isSessionListRenderableOwnerProjection } from './sessionListRenderableSessionProjection';

type UserFacingSessionCandidate = Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
    access?: NormalizedSessionAccessProjection | null;
    metadataUnavailable?: boolean;
}>;

function readObjectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : null;
}

function hasProjectedHiddenSystemFlag(metadata: unknown): boolean {
    const record = readObjectRecord(metadata);
    return record?.hiddenSystemSession === true;
}

function hasRawHiddenSystemFlag(metadata: unknown): boolean {
    const record = readObjectRecord(metadata);
    const systemSession = readObjectRecord(record?.systemSessionV1);
    return systemSession?.hidden === true;
}

/** The three shapes a hidden system row can take, asked once. */
function isHiddenSystemCandidate(metadata: unknown): boolean {
    return hasProjectedHiddenSystemFlag(metadata)
        || hasRawHiddenSystemFlag(metadata)
        || isHiddenSystemSession({ metadata });
}

/**
 * An authorized recipient whose Session content is still locked.
 *
 * Hidden-system facts (`systemSessionV1`, `hiddenSystemSession`) are layout-1
 * owner-private keys, so they are never projected into a recipient's shared
 * view. A recipient row therefore has no hidden-system fact that unreadable
 * metadata could be concealing, and Lane 04's access projection is itself a safe
 * server-owned fact: hiding the row would make an authorized encrypted Session
 * silently disappear until a manager prepared its key.
 *
 * An owner is deliberately not covered. When the owner view is unavailable the
 * hidden-system answer is genuinely unknown for that viewer, so failing closed
 * is what keeps Voice carriers and other hidden system Sessions out of the list
 * during Account recovery.
 *
 * The explicit projection is required: legacy `accessLevel` inference reads an
 * absent field as ownership, which would let call sites that pass only metadata
 * fall into the visible branch.
 */
function isAuthorizedLockedRecipient(session: UserFacingSessionCandidate): boolean {
    return session.access != null && session.access.role === 'recipient';
}

export function isUserFacingSession(session: UserFacingSessionCandidate): boolean {
    if (session.metadataUnavailable === true) {
        if (isSessionAccessOwner(session.access, session.accessLevel)) {
            // Layout-one owner metadata is Account-encrypted independently of the Session DEK.
            // When that exact owner envelope opened, its system marker is sufficient to keep an
            // ordinary locked Session visible without exposing owner facts to the Home or a
            // recipient. If it did not open, the hidden-system answer remains unknown and fails
            // closed as before.
            return session.ownerMetadataView != null
                && !isHiddenSystemCandidate(session.ownerMetadataView);
        }
        if (!isAuthorizedLockedRecipient(session)) return false;
        // Whatever safe metadata survived the unavailable contraction still decides
        // hidden-system visibility; absence of metadata is not proof of a system row.
        return !isHiddenSystemCandidate(session.metadata);
    }
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    if (metadataLayoutVersion < 0) return false;
    const metadata = readSessionOwnerMetadataView({
        metadataLayoutVersion: session.metadataLayoutVersion,
        metadata: session.metadata ?? null,
        ownerMetadataView: session.ownerMetadataView,
    });
    const isSharedParticipant = isSessionAccessRecipient(session.access, session.accessLevel);
    const hasProjectedOwnerMetadata =
        isSessionListRenderableOwnerProjection(session)
        && session.metadataUnavailable === false;
    if (
        metadataLayoutVersion === 1
        && metadata == null
        && !isSharedParticipant
        && !hasProjectedOwnerMetadata
    ) {
        return false;
    }
    const visibilityMetadata = metadata
        ?? (isSharedParticipant || hasProjectedOwnerMetadata ? session.metadata : null);
    return !isHiddenSystemCandidate(visibilityMetadata);
}
