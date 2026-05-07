import { isHiddenSystemSession } from '@happier-dev/protocol';

type UserFacingSessionCandidate = Readonly<{
    metadata?: unknown;
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
    return !(
        hasProjectedHiddenSystemFlag(session.metadata)
        || hasRawHiddenSystemFlag(session.metadata)
        || isHiddenSystemSession({ metadata: session.metadata })
    );
}
