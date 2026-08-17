import {
    parseSessionOwnerMetadataEnvelopeV1,
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionOwnerMetadataCiphertextV1Schema,
    type SessionOwnerMetadataEnvelopeV1,
    validateSessionOwnerMetadataEnvelopeForAccountModeV1,
} from "@happier-dev/protocol";

export type SessionOwnerMetadataAccountMode = "plain" | "e2ee";

/**
 * Parses the persisted layout-1 owner envelope at the Server Session boundary.
 *
 * The bare kind-10 branch is limited to the retained development shape that
 * predates explicit envelopes: layout 1 plus an E2EE Account. It never decrypts
 * or content-sniffs the ciphertext, and every current writer emits the explicit
 * envelope. Remove this branch after the complete retained-development database
 * inventory reports zero bare kind-10 layout-1 owner values.
 */
export function parsePersistedSessionOwnerMetadataEnvelopeV1(params: Readonly<{
    metadataLayoutVersion: number;
    accountMode: SessionOwnerMetadataAccountMode;
    ownerMetadata: string | null;
    allowRetainedDevelopmentCiphertext: boolean;
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
    if (
        !params.allowRetainedDevelopmentCiphertext
        || params.accountMode !== "e2ee"
    ) {
        return null;
    }
    const retainedCiphertext =
        SessionOwnerMetadataCiphertextV1Schema.safeParse(
            params.ownerMetadata,
        );
    return retainedCiphertext.success
        ? { t: "encrypted", c: retainedCiphertext.data }
        : null;
}
