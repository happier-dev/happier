import {
    isSessionOwnerMetadataCiphertextV1,
    SESSION_METADATA_LAYOUT_VERSION_V1,
} from "@happier-dev/protocol";
import type { SessionMetadataRecipientProjectionV1 } from "@happier-dev/protocol";

export const SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_CODE =
    "metadata_privacy_upgrade_required" as const;
export const SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_MESSAGE =
    "Session metadata privacy upgrade required" as const;

export class SessionMetadataPrivacyUpgradeRequiredError extends Error {
    readonly code = SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_CODE;

    constructor() {
        super(SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_MESSAGE);
        this.name = "SessionMetadataPrivacyUpgradeRequiredError";
    }
}

type SessionMetadataRecipientProjectionInput = Readonly<{
    accountId: string;
    metadata: string;
    metadataVersion: number;
    metadataLayoutVersion?: number | null;
    ownerMetadata?: string | null;
    agentState: string | null;
    agentStateVersion: number;
}>;

type LegacySessionMetadataRecipientProjection = Readonly<{
    metadata: string;
    metadataVersion: number;
    metadataLayoutVersion: 0;
    agentState: string | null;
    agentStateVersion: number;
}>;

export type SessionMetadataRecipientProjection =
    | LegacySessionMetadataRecipientProjection
    | SessionMetadataRecipientProjectionV1;

/**
 * The single server-side owner/recipient projection boundary for persisted
 * session envelopes. Ciphertexts remain opaque; only ownership and the stored
 * split-layout marker determine which envelope can leave the server.
 */
export function projectSessionMetadataForRecipient(params: Readonly<{
    session: SessionMetadataRecipientProjectionInput;
    recipientAccountId: string | null;
}>): SessionMetadataRecipientProjection {
    const { session, recipientAccountId } = params;
    const isOwner =
        recipientAccountId !== null && recipientAccountId === session.accountId;
    const metadataLayoutVersion = session.metadataLayoutVersion ?? 0;

    if (metadataLayoutVersion === 0) {
        if (session.ownerMetadata !== null && session.ownerMetadata !== undefined) {
            throw new SessionMetadataPrivacyUpgradeRequiredError();
        }

        return {
            metadata: session.metadata,
            metadataVersion: session.metadataVersion,
            metadataLayoutVersion: 0,
            agentState: session.agentState,
            agentStateVersion: session.agentStateVersion,
        };
    }

    if (
        metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1
        || typeof session.ownerMetadata !== "string"
        || !isSessionOwnerMetadataCiphertextV1(session.ownerMetadata)
    ) {
        throw new SessionMetadataPrivacyUpgradeRequiredError();
    }

    if (isOwner) {
        return {
            metadata: session.metadata,
            metadataVersion: session.metadataVersion,
            metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
            ownerMetadata: session.ownerMetadata,
            agentState: session.agentState,
            agentStateVersion: session.agentStateVersion,
        };
    }

    return {
        metadata: session.metadata,
        metadataVersion: session.metadataVersion,
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
        agentState: null,
        agentStateVersion: session.agentStateVersion,
    };
}

export function isSessionMetadataPrivacyUpgradeRequiredError(
    error: unknown,
): error is SessionMetadataPrivacyUpgradeRequiredError {
    return error instanceof SessionMetadataPrivacyUpgradeRequiredError;
}

export function createSessionMetadataPrivacyUpgradeRequiredResponse() {
    return {
        error: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_MESSAGE,
        code: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_CODE,
    };
}
