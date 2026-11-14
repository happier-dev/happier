import type {
    PrivateLabelReadV1,
    PrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import {
    parsePrivateLabelStoredV1,
    projectPrivateLabelForRecipientV1,
    serializePrivateLabelStoredV1,
    validatePrivateLabelStoredForModeV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import * as privacyKit from 'privacy-kit';

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import {
    RESOURCE_RECIPIENT_ACCOUNT_SELECT,
    readRequiredResourceRecipientEnvelopeRejectionV1,
    resolveSavedSecretAudienceAccountIdsInTx,
    type ResourceRecipientEnvelopeRow,
} from '@/app/encryption/savedSecretRecipientEnvelopeCensus';
import type { Tx } from '@/storage/inTx';

export type TeamCredentialResourceDisplayNameWriteResult =
    | Readonly<{ kind: 'ready'; label: PrivateLabelStoredV1; serialized: string }>
    | Readonly<{ kind: 'invalid_mode' }>
    | Readonly<{ kind: 'invalid_recipients' }>;

/** Raw historic labels remain readable until normal save; malformed envelopes fail closed. */
export function readTeamCredentialResourceDisplayNameStored(serialized: string): PrivateLabelStoredV1 | null {
    const parsed = parsePrivateLabelStoredV1(serialized, { allowLegacyPlaintext: true });
    return parsed.kind !== 'invalid' ? parsed.stored : null;
}

/**
 * The content tag records the authoring Account mode for this revision. It is
 * intentionally not compared with a viewer's (or a later owner's) current
 * Account mode when projecting historical labels.
 */
export function projectTeamCredentialResourceDisplayNameForRecipient(params: Readonly<{
    serialized: string;
    recipientAccountId: string;
}>): PrivateLabelReadV1 | null {
    const parsed = parsePrivateLabelStoredV1(params.serialized, { allowLegacyPlaintext: true });
    return parsed.kind === 'invalid' ? null : projectPrivateLabelForRecipientV1({
        stored: parsed.stored,
        ...(parsed.kind === 'legacy_plain' ? { legacyPlaintext: true } : {}),
        recipientAccountId: params.recipientAccountId,
    });
}

/**
 * External API-key labels share the credential Team audience owner, but bind
 * their ciphertext to the immutable key id rather than the resource id.
 */
export function projectTeamCredentialExternalApiKeyLabelForRecipient(params: Readonly<{
    serialized: string;
    recipientAccountId: string;
}>): PrivateLabelReadV1 | null {
    return projectTeamCredentialResourceDisplayNameForRecipient(params);
}

export function readTeamCredentialExternalApiKeyLabelStored(serialized: string): PrivateLabelStoredV1 | null {
    return readTeamCredentialResourceDisplayNameStored(serialized);
}

function toEnvelopeRows(label: PrivateLabelStoredV1): readonly ResourceRecipientEnvelopeRow[] | null {
    try {
        return label.recipients.map((recipient) => ({
            accountId: recipient.accountId,
            encryptedDataKey: new Uint8Array(privacyKit.decodeBase64(recipient.envelope.encryptedDataKey)),
            recipientContentPublicKeyFingerprint: recipient.envelope.recipientContentPublicKeyFingerprint,
        }));
    } catch {
        return null;
    }
}

/**
 * Validates a new resource-label revision at the one Team-readable audience
 * owner. The server never opens the text; it only stores canonical opaque JSON.
 */
export async function prepareTeamCredentialResourceDisplayNameForWriteInTx(params: Readonly<{
    tx: Tx;
    ownerAccountId: string;
    teamId: string;
    label: PrivateLabelStoredV1;
}>): Promise<TeamCredentialResourceDisplayNameWriteResult> {
    const owner = await params.tx.account.findUnique({
        where: { id: params.ownerAccountId },
        select: { encryptionMode: true },
    });
    if (!owner) return { kind: 'invalid_mode' };
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(owner);
    if (mode.status !== 'ready') return { kind: 'invalid_mode' };

    const validated = validatePrivateLabelStoredForModeV1({ mode: mode.mode, stored: params.label });
    if (validated.kind !== 'available') return { kind: 'invalid_mode' };

    if (mode.mode === 'e2ee') {
        const expectedRecipientAccountIds = await resolveSavedSecretAudienceAccountIdsInTx(params.tx, {
            ownerAccountId: params.ownerAccountId,
            accountIds: [],
            teamIds: [params.teamId],
            groupIds: [],
        });
        const accounts = expectedRecipientAccountIds.length === 0 ? [] : await params.tx.account.findMany({
            where: { id: { in: [...expectedRecipientAccountIds] } },
            select: RESOURCE_RECIPIENT_ACCOUNT_SELECT,
        });
        const envelopes = toEnvelopeRows(validated.stored);
        if (envelopes === null || readRequiredResourceRecipientEnvelopeRejectionV1({
            expectedRecipientAccountIds,
            envelopes,
            recipientsById: new Map(accounts.map((account) => [account.id, account])),
        }) !== null) return { kind: 'invalid_recipients' };
    }

    return {
        kind: 'ready',
        label: validated.stored,
        serialized: serializePrivateLabelStoredV1(validated.stored),
    };
}

/** The external-key writer has the same author-mode and Team-audience contract. */
export async function prepareTeamCredentialExternalApiKeyLabelForWriteInTx(params: Readonly<{
    tx: Tx;
    ownerAccountId: string;
    teamId: string;
    label: PrivateLabelStoredV1;
}>): Promise<TeamCredentialResourceDisplayNameWriteResult> {
    return prepareTeamCredentialResourceDisplayNameForWriteInTx(params);
}
