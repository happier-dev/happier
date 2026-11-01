import { parseSessionOwnerMetadataEnvelopeV1, SESSION_METADATA_LAYOUT_VERSION_V1, type SessionOwnerMetadataEnvelopeV1, validateSessionOwnerMetadataEnvelopeForAccountModeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

export type SessionOwnerMetadataAccountMode = "plain" | "e2ee";

/**
 * Parses the persisted layout-1 owner envelope at the Server Session boundary.
 */
export function parsePersistedSessionOwnerMetadataEnvelopeV1(params: Readonly<{
    metadataLayoutVersion: number;
    accountMode: SessionOwnerMetadataAccountMode;
    ownerMetadata: string | null;
}>): SessionOwnerMetadataEnvelopeV1 | null {
    if (
        params.metadataLayoutVersion
            !== SESSION_METADATA_LAYOUT_VERSION_V1
        || params.ownerMetadata === null
    ) {
        return null;
    }
    const explicit = parseSessionOwnerMetadataEnvelopeV1(
        params.ownerMetadata,
    );
    if (explicit !== null) {
        return validateSessionOwnerMetadataEnvelopeForAccountModeV1({
            accountMode: params.accountMode,
            envelope: explicit,
        }).ok
            ? explicit
            : null;
    }
    return null;
}
