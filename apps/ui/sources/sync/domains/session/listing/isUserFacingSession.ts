import { isHiddenSystemSession } from '@happier-dev/protocol';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';

type UserFacingSessionCandidate = Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
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

export function isUserFacingSession(session: UserFacingSessionCandidate): boolean {
    if (session.metadataUnavailable === true) {
        return false;
    }
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    if (metadataLayoutVersion < 0) return false;
    const metadata = readSessionOwnerMetadataView({
        metadataLayoutVersion: session.metadataLayoutVersion,
        metadata: session.metadata ?? null,
        ownerMetadataView: session.ownerMetadataView,
    });
    const isSharedParticipant = session.accessLevel === 'view'
        || session.accessLevel === 'edit'
        || session.accessLevel === 'admin';
    const hasProjectedOwnerMetadata =
        session.metadataLayoutVersion === 1
        && session.accessLevel == null
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
    return !(
        hasProjectedHiddenSystemFlag(visibilityMetadata)
        || hasRawHiddenSystemFlag(visibilityMetadata)
        || isHiddenSystemSession({ metadata: visibilityMetadata })
    );
}
