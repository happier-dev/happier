import type { MachinePoolPrivateLabelProjectionV1, MachinePoolPrivateLabelStoredV1 } from '@happier-dev/protocol/machines/pools/v1';
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

export type MachinePoolPrivateLabelWriteResult =
    | Readonly<{ kind: 'ready'; name: string; description: string | null }>
    | Readonly<{ kind: 'invalid_mode' }>
    | Readonly<{ kind: 'invalid_recipients' }>;

/**
 * Projects one persisted Pool label for one caller without exposing its recipient audience. Pool
 * raw historic rows remain readable until normal save.
 */
export function projectMachinePoolPrivateLabelForRecipient(params: Readonly<{
    serialized: string;
    recipientAccountId: string;
}>): MachinePoolPrivateLabelProjectionV1 {
    const parsed = parsePrivateLabelStoredV1(params.serialized, { allowLegacyPlaintext: true });
    if (parsed.kind === 'invalid') return { kind: 'unavailable' };
    return {
        kind: 'available',
        label: projectPrivateLabelForRecipientV1({
            stored: parsed.stored,
            ...(parsed.kind === 'legacy_plain' ? { legacyPlaintext: true } : {}),
            recipientAccountId: params.recipientAccountId,
        }),
    };
}

function toEnvelopeRows(label: MachinePoolPrivateLabelStoredV1): readonly ResourceRecipientEnvelopeRow[] | null {
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
 * The mutating Account's persisted encryption mode and the Saved Secret audience owner are the
 * only authorities for Pool-label writes. The server validates envelopes but never opens label text.
 */
export async function prepareMachinePoolPrivateLabelsForWriteInTx(params: Readonly<{
    tx: Tx;
    authorAccountId: string;
    teamId: string | null;
    name: MachinePoolPrivateLabelStoredV1;
    description?: MachinePoolPrivateLabelStoredV1 | null;
}>): Promise<MachinePoolPrivateLabelWriteResult> {
    const owner = await params.tx.account.findUnique({
        where: { id: params.authorAccountId },
        select: { encryptionMode: true },
    });
    if (!owner) return { kind: 'invalid_mode' };
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(owner);
    if (mode.status !== 'ready') return { kind: 'invalid_mode' };

    const labels = [params.name, ...(params.description === undefined || params.description === null ? [] : [params.description])];
    const validated = labels.map((label) => validatePrivateLabelStoredForModeV1({ mode: mode.mode, stored: label }));
    if (validated.some((label) => label.kind !== 'available')) return { kind: 'invalid_mode' };

    if (mode.mode === 'e2ee') {
        const expectedRecipientAccountIds = await resolveSavedSecretAudienceAccountIdsInTx(params.tx, {
            ownerAccountId: params.authorAccountId,
            accountIds: [],
            teamIds: params.teamId === null ? [] : [params.teamId],
            groupIds: [],
        });
        const accounts = expectedRecipientAccountIds.length === 0 ? [] : await params.tx.account.findMany({
            where: { id: { in: [...expectedRecipientAccountIds] } },
            select: RESOURCE_RECIPIENT_ACCOUNT_SELECT,
        });
        const recipientsById = new Map(accounts.map((account) => [account.id, account]));
        for (const label of labels) {
            const envelopes = toEnvelopeRows(label);
            if (envelopes === null || readRequiredResourceRecipientEnvelopeRejectionV1({
                expectedRecipientAccountIds,
                envelopes,
                recipientsById,
            }) !== null) return { kind: 'invalid_recipients' };
        }
    }

    return {
        kind: 'ready',
        name: serializePrivateLabelStoredV1(params.name),
        description: params.description === undefined || params.description === null
            ? null
            : serializePrivateLabelStoredV1(params.description),
    };
}
