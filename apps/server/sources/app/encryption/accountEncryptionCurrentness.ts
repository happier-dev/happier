import { AccountEncryptionCurrentnessResponseSchema, type AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';

import { deriveAccountEncryptionCurrentnessFromRow } from './accountContentKeyAdmission';
import { deriveAccountEncryptionMigrationKeyFingerprints } from './accountEncryptionTransition';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from './accountRecipientEnvelopeReadiness';
import { buildUpdateAccountUpdate, eventRouter } from '@/app/events/eventRouter';
import { afterTx, type Tx } from '@/storage/inTx';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { afterAccountChangePublication } from '@/app/changes/markAccountChanged';
import { log } from '@/utils/logging/log';

type AccountEncryptionCurrentnessRow = Readonly<{
    publicKey: string | null;
    encryptionMode: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
    encryptionModeUpdatedAt: Date;
    seq: number;
    settingsVersion: number;
}>;

/** The same admitted, key-free Account fact is exposed over HTTP and pushed after a write. */
export function projectAccountEncryptionCurrentnessFromRow(
    account: AccountEncryptionCurrentnessRow,
): AccountEncryptionCurrentnessResponse | null {
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status !== 'ready') return null;
    const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account, currentness);
    return AccountEncryptionCurrentnessResponseSchema.parse({
        mode: currentness.currentness.encryptionMode,
        version: account.seq,
        settingsVersion: account.settingsVersion,
        recipientEnvelopeReadiness: readiness.status === 'available'
            ? { status: 'available' }
            : readiness,
        ...deriveAccountEncryptionMigrationKeyFingerprints(account),
        updatedAt: account.encryptionModeUpdatedAt.getTime(),
    });
}

/** Read the completed publication's Account fact; emit only after its transaction commits. */
export async function publishAccountEncryptionCurrentnessAfterTx(tx: Tx, accountId: string): Promise<void> {
    afterAccountChangePublication(tx, async (publicationTx) => {
        const account = await publicationTx.account.findUniqueOrThrow({
            where: { id: accountId },
            select: {
                publicKey: true, encryptionMode: true,
                contentPublicKey: true, contentPublicKeySig: true,
                encryptionModeUpdatedAt: true, seq: true, settingsVersion: true,
            },
        });
        const currentness = projectAccountEncryptionCurrentnessFromRow(account);
        const payload = buildUpdateAccountUpdate(
            accountId, {}, account.seq, randomKeyNaked(12),
            currentness,
        );
        afterTx(publicationTx, () => {
            eventRouter.emitUpdate({ userId: accountId, payload, recipientFilter: { type: 'user-scoped-only' } });
            eventRouter.emitUpdate({ userId: accountId, payload, recipientFilter: { type: 'user-machine-scoped-only' } });
            if (currentness?.recipientEnvelopeReadiness?.status === 'available') {
                void import('@/app/session/encryption/sessionDataKeyEnvelopeService')
                    .then(({ publishSessionRecipientReadinessWake }) => publishSessionRecipientReadinessWake(accountId))
                    .catch(() => log({ module: 'session-recipient-envelopes', level: 'warn' }, 'Could not publish Session recipient readiness wake'));
            }
        });
    });
}
