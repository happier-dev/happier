import type {
    PrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import {
    parsePrivateLabelStoredV1,
    projectPrivateLabelForRecipientV1,
    sealPrivateLabelV1,
    serializePrivateLabelStoredV1,
    validatePrivateLabelStoredForModeV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import { prepareSavedSecretResourceRecipientEnvelopesV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import type { TeamGroupNameProjectionV1 } from '@happier-dev/protocol/teams';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import {
    RESOURCE_RECIPIENT_ACCOUNT_SELECT,
    readRequiredResourceRecipientEnvelopeRejectionV1,
    readSavedSecretAudienceRecipientEnvelopeCensusInTx,
    resolveSavedSecretAudienceAccountIdsInTx,
    type ResourceRecipientEnvelopeRow,
} from '@/app/encryption/savedSecretRecipientEnvelopeCensus';
import type { Tx } from '@/storage/inTx';

export type TeamGroupNameWriteResult =
    | Readonly<{ kind: 'ready'; serialized: string }>
    | Readonly<{ kind: 'invalid_mode' }>
    | Readonly<{ kind: 'invalid_recipients' }>;

export type TeamGroupAutomatedNameWriteResult =
    | Readonly<{ kind: 'ready'; serialized: string }>
    | Readonly<{ kind: 'invalid_current_label' }>
    | Readonly<{ kind: 'recipient_unavailable' }>;

type TeamGroupSealAudienceResult =
    | Readonly<{ kind: 'ready'; serialized: string }>
    | Readonly<{ kind: 'recipient_unavailable' }>;

/** Raw historic names remain readable until their next normal save. */
export function projectTeamGroupNameForRecipient(params: Readonly<{
    serialized: string;
    recipientAccountId: string;
}>): TeamGroupNameProjectionV1 {
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
 * A human author supplies opaque label bytes; this server-side admission binds
 * their persisted mode and current Team recipient audience once at the write.
 */
export async function prepareTeamGroupNameForHumanWriteInTx(params: Readonly<{
    tx: Tx;
    authorAccountId: string;
    teamId: string;
    label: PrivateLabelStoredV1;
}>): Promise<TeamGroupNameWriteResult> {
    const author = await params.tx.account.findUnique({
        where: { id: params.authorAccountId },
        select: { encryptionMode: true },
    });
    if (!author) return { kind: 'invalid_mode' };
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(author);
    if (mode.status !== 'ready') return { kind: 'invalid_mode' };

    const validated = validatePrivateLabelStoredForModeV1({ mode: mode.mode, stored: params.label });
    if (validated.kind !== 'available') return { kind: 'invalid_mode' };
    if (mode.mode === 'e2ee') {
        const expectedRecipientAccountIds = await resolveSavedSecretAudienceAccountIdsInTx(params.tx, {
            ownerAccountId: params.authorAccountId,
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
    return { kind: 'ready', serialized: serializePrivateLabelStoredV1(validated.stored) };
}

async function sealTeamGroupNameToCurrentAudienceInTx(params: Readonly<{
    tx: Tx;
    mode: 'plain' | 'e2ee';
    ownerAccountId?: string;
    teamId: string;
    groupId: string;
    value: string;
}>): Promise<TeamGroupSealAudienceResult> {
    const binding = { entity: 'team_group', field: 'name', id: params.groupId } as const;
    if (params.mode === 'plain') {
        return {
            kind: 'ready',
            serialized: serializePrivateLabelStoredV1(sealPrivateLabelV1({
                mode: 'plain', binding, value: params.value,
            })),
        };
    }
    const census = await readSavedSecretAudienceRecipientEnvelopeCensusInTx(params.tx, {
        ...(params.ownerAccountId === undefined ? {} : { ownerAccountId: params.ownerAccountId }),
        teamIds: [params.teamId],
    });
    if (census.recipients.some((recipient) => recipient.readiness.status !== 'available')) {
        return { kind: 'recipient_unavailable' };
    }
    const dataKey = tweetnacl.randomBytes(tweetnacl.secretbox.keyLength);
    const prepared = prepareSavedSecretResourceRecipientEnvelopesV1({
        recipients: census.recipients,
        resourceDataKey: dataKey,
        randomBytes: tweetnacl.randomBytes,
    });
    if (prepared.length !== census.recipients.length) return { kind: 'recipient_unavailable' };
    return {
        kind: 'ready',
        serialized: serializePrivateLabelStoredV1(sealPrivateLabelV1({
            mode: 'e2ee',
            binding,
            value: params.value,
            dataKey,
            recipients: prepared.map((recipient) => ({
                accountId: recipient.recipientAccountId,
                envelope: {
                    encryptedDataKey: recipient.encryptedDataKey,
                    recipientContentPublicKeyFingerprint: recipient.recipientContentPublicKeyFingerprint,
                },
            })),
            randomBytes: tweetnacl.randomBytes,
        })),
    };
}

/** Initial directory-created Group labels enter through a human-authorized binding action. */
export async function prepareTeamGroupNameForDirectoryInitialWriteInTx(params: Readonly<{
    tx: Tx;
    authorAccountId: string;
    teamId: string;
    groupId: string;
    value: string;
}>): Promise<TeamGroupAutomatedNameWriteResult> {
    const author = await params.tx.account.findUnique({
        where: { id: params.authorAccountId },
        select: { encryptionMode: true },
    });
    if (!author) return { kind: 'invalid_current_label' };
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(author);
    if (mode.status !== 'ready') return { kind: 'invalid_current_label' };
    return sealTeamGroupNameToCurrentAudienceInTx({
        tx: params.tx,
        mode: mode.mode,
        ownerAccountId: params.authorAccountId,
        teamId: params.teamId,
        groupId: params.groupId,
        value: params.value,
    });
}

/**
 * External directory updates have no live human author. The prior valid
 * `content.t` is therefore this resource's durable privacy arm: it was
 * admitted under a human's persisted Account mode at creation, and is carried
 * forward here without inferring a mode from key presence. The update reseals
 * transient provider text to the current eligible Team audience and never
 * decrypts the prior label.
 */
export async function prepareTeamGroupNameForAutomatedWriteInTx(params: Readonly<{
    tx: Tx;
    teamId: string;
    groupId: string;
    currentSerialized: string;
    nextValue: string;
}>): Promise<TeamGroupAutomatedNameWriteResult> {
    const current = parsePrivateLabelStoredV1(params.currentSerialized);
    if (current.kind !== 'current') return { kind: 'invalid_current_label' };
    return sealTeamGroupNameToCurrentAudienceInTx({
        tx: params.tx,
        mode: current.stored.content.t === 'plain' ? 'plain' : 'e2ee',
        teamId: params.teamId,
        groupId: params.groupId,
        value: params.nextValue,
    });
}
