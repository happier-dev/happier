import { isTeamPrincipalRoleV1 } from "@happier-dev/protocol/teams";
import { parseEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";
import type { SavedSecretResourceEnvelopeCensusRecipientV1 } from "@happier-dev/protocol/account/settings/savedSecretCatalogV1";
import * as privacyKit from "privacy-kit";

import {
    deriveAccountRecipientEnvelopeReadinessFromRow,
    type AccountRecipientEnvelopeReadinessRow,
} from "@/app/encryption/accountRecipientEnvelopeReadiness";
import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
    type AccountDisplayProfileRow,
} from "@/app/account/profile/accountDisplayProfile";
import type { Tx } from "@/storage/inTx";

/** The current recipient rows every Team-readable resource seals to. */
export const RESOURCE_RECIPIENT_ACCOUNT_SELECT = {
    ...ACCOUNT_DISPLAY_PROFILE_SELECT,
    publicKey: true,
    encryptionMode: true,
    contentPublicKey: true,
    contentPublicKeySig: true,
} as const;

export type ResourceRecipientAccountRow = AccountDisplayProfileRow & AccountRecipientEnvelopeReadinessRow;

/** A caller-normalized data-key envelope. Storage adapters own serialization. */
export type ResourceRecipientEnvelopeRow = Readonly<{
    accountId: string;
    encryptedDataKey: Uint8Array;
    recipientContentPublicKeyFingerprint: string;
}>;

export type ResourceRecipientEnvelopeRejectionV1 =
    | "duplicate_recipient"
    | "unknown_recipient"
    | "key_unavailable"
    | "fingerprint_mismatch"
    | "malformed_envelope";

export type RequiredResourceRecipientEnvelopeRejectionV1 =
    | ResourceRecipientEnvelopeRejectionV1
    | "recipient_set_mismatch";

export type TargetOwnerRecipientEnvelopeRejectionV1 =
    | "recipient_set_mismatch"
    | "owner_recipient_mismatch"
    | "fingerprint_mismatch"
    | "malformed_envelope";

/** Saved Secret Team-wide grants admit active non-guest members; explicit Groups may admit guests. */
const ACTIVE_SAVED_SECRET_MEMBERSHIP_WHERE = {
    status: "active", account: { status: "active" },
} as const;

const ACTIVE_SAVED_SECRET_PRINCIPAL_MEMBERSHIP_WHERE = {
    ...ACTIVE_SAVED_SECRET_MEMBERSHIP_WHERE, role: { not: "guest" },
} as const;

/**
 * The recipient-audience policy for Saved Secret resources and Team-readable
 * labels. The caller supplies only authoritative grants; the client never
 * expands Team membership or chooses encryption recipients.
 */
export async function resolveSavedSecretAudienceAccountIdsInTx(
    tx: Tx,
    input: Readonly<{
        /** Human-authored resources include their author; Team automation does not invent one. */
        ownerAccountId?: string;
        accountIds: readonly string[];
        teamIds: readonly string[];
        groupIds: readonly string[];
    }>,
): Promise<readonly string[]> {
    const [teamMembers, groupMembers] = await Promise.all([
        input.teamIds.length === 0 ? [] : tx.teamMembership.findMany({
            where: {
                teamId: { in: [...input.teamIds] },
                ...ACTIVE_SAVED_SECRET_PRINCIPAL_MEMBERSHIP_WHERE,
                team: { archivedAt: null },
            },
            select: { accountId: true, role: true },
        }),
        input.groupIds.length === 0 ? [] : tx.teamGroupMembership.findMany({
            where: {
                teamGroupId: { in: [...input.groupIds] },
                group: { archivedAt: null, team: { archivedAt: null } },
                teamMembership: ACTIVE_SAVED_SECRET_MEMBERSHIP_WHERE,
            },
            select: { teamMembership: { select: { accountId: true } } },
        }),
    ]);
    return [...new Set([
        ...(input.ownerAccountId === undefined ? [] : [input.ownerAccountId]),
        ...input.accountIds,
        ...teamMembers.filter((member) => isTeamPrincipalRoleV1(member.role)).map((member) => member.accountId),
        ...groupMembers.map((member) => member.teamMembership.accountId),
    ])];
}

/** Current recipient rows and canonical readiness wire projection for a fresh or repaired resource revision. */
export async function readSavedSecretAudienceRecipientEnvelopeCensusInTx(
    tx: Tx,
    input: Readonly<{
        ownerAccountId?: string;
        accountIds?: readonly string[];
        teamIds?: readonly string[];
        groupIds?: readonly string[];
        envelopes?: readonly ResourceRecipientEnvelopeRow[];
    }>,
): Promise<Readonly<{
    recipientAccountIds: readonly string[];
    recipients: readonly SavedSecretResourceEnvelopeCensusRecipientV1[];
}>> {
    const recipientAccountIds = await resolveSavedSecretAudienceAccountIdsInTx(tx, {
        ownerAccountId: input.ownerAccountId,
        accountIds: input.accountIds ?? [],
        teamIds: input.teamIds ?? [],
        groupIds: input.groupIds ?? [],
    });
    const accounts = recipientAccountIds.length === 0 ? [] : await tx.account.findMany({
        where: { id: { in: [...recipientAccountIds] } },
        select: RESOURCE_RECIPIENT_ACCOUNT_SELECT,
    });
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    return {
        recipientAccountIds,
        recipients: projectSavedSecretRecipientEnvelopeCensusRecipientsV1({
            accounts: recipientAccountIds.flatMap((accountId) => {
                const account = accountsById.get(accountId);
                return account ? [account] : [];
            }),
            envelopes: input.envelopes ?? [],
        }),
    };
}

/** One owner-level answer to whether one submitted envelope is current and structurally valid. */
export function readResourceRecipientEnvelopeRejectionV1(
    input: Readonly<{
        envelopes: readonly ResourceRecipientEnvelopeRow[];
        recipientsById: ReadonlyMap<string, ResourceRecipientAccountRow>;
    }>,
): ResourceRecipientEnvelopeRejectionV1 | null {
    const recipientIds = input.envelopes.map((envelope) => envelope.accountId);
    if (new Set(recipientIds).size !== recipientIds.length) return "duplicate_recipient";
    for (const envelope of input.envelopes) {
        const recipient = input.recipientsById.get(envelope.accountId);
        if (!recipient) return "unknown_recipient";
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(recipient);
        if (readiness.status !== "available") return "key_unavailable";
        if (readiness.binding.contentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint) {
            return "fingerprint_mismatch";
        }
        if (parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) === null) return "malformed_envelope";
    }
    return null;
}

/**
 * An Account-mode transition has exactly one verified target recipient: the
 * owner under the transition's target content-key fingerprint. It cannot use
 * the current Account row because that row still carries source key material.
 */
export function readTargetOwnerRecipientEnvelopeRejectionV1(
    input: Readonly<{
        ownerAccountId: string;
        ownerContentPublicKeyFingerprint: string;
        envelopes: readonly ResourceRecipientEnvelopeRow[];
    }>,
): TargetOwnerRecipientEnvelopeRejectionV1 | null {
    if (input.envelopes.length !== 1) return "recipient_set_mismatch";
    const [ownerEnvelope] = input.envelopes;
    if (!ownerEnvelope || ownerEnvelope.accountId !== input.ownerAccountId) return "owner_recipient_mismatch";
    if (ownerEnvelope.recipientContentPublicKeyFingerprint !== input.ownerContentPublicKeyFingerprint) {
        return "fingerprint_mismatch";
    }
    return parseEncryptedDataKeyEnvelopeV1(ownerEnvelope.encryptedDataKey) === null ? "malformed_envelope" : null;
}

/** A Team-authored E2EE revision must cover its complete current recipient audience. */
export function readRequiredResourceRecipientEnvelopeRejectionV1(
    input: Readonly<{
        expectedRecipientAccountIds: readonly string[];
        envelopes: readonly ResourceRecipientEnvelopeRow[];
        recipientsById: ReadonlyMap<string, ResourceRecipientAccountRow>;
    }>,
): RequiredResourceRecipientEnvelopeRejectionV1 | null {
    const expected = new Set(input.expectedRecipientAccountIds);
    if (expected.size !== input.expectedRecipientAccountIds.length) return "recipient_set_mismatch";
    const rejection = readResourceRecipientEnvelopeRejectionV1(input);
    if (rejection !== null) return rejection;
    const submitted = input.envelopes.map((envelope) => envelope.accountId);
    return submitted.length === expected.size && submitted.every((accountId) => expected.has(accountId))
        ? null
        : "recipient_set_mismatch";
}

/**
 * The Saved Secret wire census is reused by every client-side rewrap path.
 * Existing resource adapters pass their persisted envelopes; fresh labels pass
 * none and therefore receive `missing` for every ready recipient.
 */
export function projectSavedSecretRecipientEnvelopeCensusRecipientsV1(
    input: Readonly<{
        accounts: readonly ResourceRecipientAccountRow[];
        envelopes: readonly ResourceRecipientEnvelopeRow[];
    }>,
): readonly SavedSecretResourceEnvelopeCensusRecipientV1[] {
    const envelopesByAccountId = new Map(input.envelopes.map((envelope) => [envelope.accountId, envelope]));
    return input.accounts.map((account): SavedSecretResourceEnvelopeCensusRecipientV1 => {
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
        const envelope = envelopesByAccountId.get(account.id) ?? null;
        const usableEnvelope = envelope && parseEncryptedDataKeyEnvelopeV1(new Uint8Array(envelope.encryptedDataKey)) !== null
            ? envelope
            : null;
        const envelopeStatus = !envelope
            ? "missing" as const
            : !usableEnvelope
                ? "invalid" as const
                : readiness.status === "available"
                    && readiness.binding.contentPublicKeyFingerprint === usableEnvelope.recipientContentPublicKeyFingerprint
                    ? "prepared" as const
                    : "stale" as const;
        return {
            account: {
                kind: "account",
                accountId: account.id,
                ...projectAccountDisplayProfileV1(account),
            },
            readiness: readiness.status === "available"
                ? {
                    status: "available",
                    contentPublicKey: privacyKit.encodeBase64(readiness.binding.contentPublicKey),
                    contentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
                }
                : readiness,
            envelopeStatus,
        };
    });
}
