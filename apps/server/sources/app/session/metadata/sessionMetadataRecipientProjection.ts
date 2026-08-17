import {
    parseSessionOwnerMetadataEnvelopeV1,
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionSharedMetadataV1Schema,
    validateSessionOwnerMetadataEnvelopeForAccountModeV1,
} from "@happier-dev/protocol";
import type {
    SessionMetadataRecipientProjectionV1,
} from "@happier-dev/protocol";

import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import type { Tx } from "@/storage/inTx";
import {
    parsePersistedSessionOwnerMetadataEnvelopeV1,
    type SessionOwnerMetadataAccountMode,
} from "./sessionOwnerMetadataPersistence";

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

export type SessionMetadataRecipientProjectionInput = Readonly<{
    accountId: string;
    encryptionMode?: string | null;
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

export type SessionMetadataOwnerAccountMode =
    SessionOwnerMetadataAccountMode;

export type SessionMetadataRecipientAuthority =
    | Readonly<{
        type: "owner";
        accountId: string;
        accountMode: SessionMetadataOwnerAccountMode;
      }>
    | Readonly<{
        type: "legacy_owner";
        accountId: string;
      }>
    | Readonly<{
        type: "shared";
        accountId: string | null;
        ownerAccountMode?: SessionMetadataOwnerAccountMode;
      }>;

export function requiresSessionMetadataOwnerAccountMode(params: Readonly<{
    session: Readonly<{
        accountId: string;
        metadataLayoutVersion?: number | null;
    }>;
}>): boolean {
    return params.session.metadataLayoutVersion
        === SESSION_METADATA_LAYOUT_VERSION_V1;
}

type SessionMetadataOwnerAccountCurrentnessRow = Readonly<{
    id: string;
    publicKey: string | null;
    encryptionMode: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
}>;

function deriveSessionMetadataOwnerAccountMode(
    account: Omit<SessionMetadataOwnerAccountCurrentnessRow, "id"> | null,
): SessionMetadataOwnerAccountMode {
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (currentness?.status !== "ready") {
        throw new SessionMetadataPrivacyUpgradeRequiredError();
    }
    return currentness.currentness.encryptionMode;
}

/**
 * Reads the persisted owning-Account currentness required before any layout-one
 * Session metadata disclosure. Invalid or incomplete E2EE bindings remain a
 * privacy failure; callers must never infer mode from the Session envelope.
 */
export async function readSessionMetadataOwnerAccountMode(
    client: Pick<Tx, "account">,
    accountId: string,
): Promise<SessionMetadataOwnerAccountMode> {
    const account = await client.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    return deriveSessionMetadataOwnerAccountMode(account);
}

/**
 * Reads one validated Account-currentness snapshot per distinct Session owner.
 * List routes use this batched owner query so recipient projection cannot degrade
 * into a per-row Account lookup.
 */
export async function readSessionMetadataOwnerAccountModes(
    client: Pick<Tx, "account">,
    accountIds: readonly string[],
): Promise<ReadonlyMap<string, SessionMetadataOwnerAccountMode>> {
    const distinctAccountIds = [...new Set(accountIds)];
    if (distinctAccountIds.length === 0) return new Map();
    if (distinctAccountIds.length === 1) {
        const accountId = distinctAccountIds[0]!;
        return new Map([[
            accountId,
            await readSessionMetadataOwnerAccountMode(client, accountId),
        ]]);
    }

    const accounts = await client.account.findMany({
        where: { id: { in: distinctAccountIds } },
        select: {
            id: true,
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    if (accounts.length !== distinctAccountIds.length) {
        throw new SessionMetadataPrivacyUpgradeRequiredError();
    }

    return new Map(accounts.map((account) => [
        account.id,
        deriveSessionMetadataOwnerAccountMode(account),
    ]));
}

/**
 * The single server-side owner/recipient projection boundary for persisted
 * session envelopes. Ciphertexts remain opaque; only ownership and the stored
 * split-layout marker determine which envelope can leave the server.
 */
export function projectSessionMetadataForRecipient(params: Readonly<{
    session: SessionMetadataRecipientProjectionInput;
    recipient: SessionMetadataRecipientAuthority;
}>): SessionMetadataRecipientProjection {
    const { session, recipient } = params;
    const isOwner =
        recipient.type !== "shared"
        && recipient.accountId === session.accountId;
    const metadataLayoutVersion = session.metadataLayoutVersion ?? 0;

    if (metadataLayoutVersion === 0) {
        if (
            session.ownerMetadata !== null
            && session.ownerMetadata !== undefined
        ) {
            throw new SessionMetadataPrivacyUpgradeRequiredError();
        }
        if (!isOwner) {
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

    const ownerMetadata = isOwner && recipient.type === "owner"
        ? parsePersistedSessionOwnerMetadataEnvelopeV1({
            metadataLayoutVersion,
            accountMode: recipient.accountMode,
            ownerMetadata: session.ownerMetadata ?? null,
            allowRetainedDevelopmentCiphertext: true,
        })
        : typeof session.ownerMetadata === "string"
            ? parseSessionOwnerMetadataEnvelopeV1(session.ownerMetadata)
            : null;
    if (
        metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1
        || ownerMetadata === null
    ) {
        throw new SessionMetadataPrivacyUpgradeRequiredError();
    }
    if (session.encryptionMode === "plain") {
        let sharedMetadata: unknown;
        try {
            sharedMetadata = JSON.parse(session.metadata);
        } catch {
            throw new SessionMetadataPrivacyUpgradeRequiredError();
        }
        if (!SessionSharedMetadataV1Schema.safeParse(sharedMetadata).success) {
            throw new SessionMetadataPrivacyUpgradeRequiredError();
        }
    }

    if (recipient.type === "legacy_owner") {
        throw new SessionMetadataPrivacyUpgradeRequiredError();
    }
    const ownerAccountMode = recipient.type === "owner"
        ? recipient.accountMode
        : recipient.ownerAccountMode;
    if (ownerAccountMode === undefined) {
        throw new SessionMetadataPrivacyUpgradeRequiredError();
    }
    const validatedOwnerMetadata =
        validateSessionOwnerMetadataEnvelopeForAccountModeV1({
            accountMode: ownerAccountMode,
            envelope: ownerMetadata,
        });
    if (!validatedOwnerMetadata.ok) {
        throw new SessionMetadataPrivacyUpgradeRequiredError();
    }

    if (isOwner) {
        if (recipient.type !== "owner") {
            throw new SessionMetadataPrivacyUpgradeRequiredError();
        }
        return {
            metadata: session.metadata,
            metadataVersion: session.metadataVersion,
            metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
            ownerMetadata: validatedOwnerMetadata.envelope,
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
