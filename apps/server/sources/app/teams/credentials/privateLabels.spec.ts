import { describe, expect, it } from 'vitest';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
    sealPrivateLabelV1,
    serializePrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import tweetnacl from 'tweetnacl';

import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import type { ResourceRecipientAccountRow } from '@/app/encryption/savedSecretRecipientEnvelopeCensus';
import type { Tx } from '@/storage/inTx';

import {
    prepareTeamCredentialResourceDisplayNameForWriteInTx,
    projectTeamCredentialResourceDisplayNameForRecipient,
} from './privateLabels';

function recipient(id: string): ResourceRecipientAccountRow {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    return {
        id,
        name: id,
        firstName: null,
        lastName: null,
        username: null,
        avatar: null,
        publicKey: Buffer.from(signing.publicKey).toString('hex'),
        encryptionMode: 'e2ee',
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey: content.publicKey,
        }),
    };
}

function labelFor(recipients: readonly ResourceRecipientAccountRow[]) {
    const dataKey = tweetnacl.randomBytes(32);
    return sealPrivateLabelV1({
        mode: 'e2ee',
        binding: { entity: 'team_credential_resource', field: 'displayName', id: 'resource-1' },
        value: 'Build provider',
        dataKey,
        recipients: recipients.map((account) => {
            const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
            if (readiness.status !== 'available') throw new Error('Expected a ready test recipient');
            return {
                accountId: account.id,
                envelope: {
                    encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({
                        dataKey,
                        recipientPublicKey: readiness.binding.contentPublicKey,
                        randomBytes: tweetnacl.randomBytes,
                    })).toString('base64'),
                    recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
                },
            };
        }),
        randomBytes: tweetnacl.randomBytes,
    });
}

function writeTx(owner: ResourceRecipientAccountRow, member: ResourceRecipientAccountRow): Tx {
    return {
        account: {
            findUnique: async () => ({ encryptionMode: 'e2ee' }),
            findMany: async () => [owner, member],
        },
        teamMembership: {
            findMany: async () => [{ accountId: member.id, role: 'member' }],
        },
    } as unknown as Tx;
}

describe('Team credential private display labels', () => {
    it('admits only the Saved-Secret Team audience and projects one encrypted recipient envelope', async () => {
        const owner = recipient('owner');
        const member = recipient('member');
        const label = labelFor([owner, member]);

        const write = await prepareTeamCredentialResourceDisplayNameForWriteInTx({
            tx: writeTx(owner, member),
            ownerAccountId: owner.id,
            teamId: 'team-1',
            label,
        });

        expect(write).toMatchObject({ kind: 'ready' });
        if (write.kind !== 'ready') return;
        expect(write.serialized).not.toContain('Build provider');

        expect(projectTeamCredentialResourceDisplayNameForRecipient({
            serialized: write.serialized,
            recipientAccountId: member.id,
        })).toMatchObject({
            content: { t: 'encrypted' },
            recipientEnvelope: label.recipients.find((recipient) => recipient.accountId === member.id)?.envelope,
        });
        expect(projectTeamCredentialResourceDisplayNameForRecipient({
            serialized: write.serialized,
            recipientAccountId: 'former-member',
        })).toMatchObject({ content: { t: 'encrypted' }, recipientEnvelope: null });
    });

    it('rejects a stale or partial label instead of accepting a server-readable fallback', async () => {
        const owner = recipient('owner');
        const member = recipient('member');
        const label = labelFor([owner]);

        await expect(prepareTeamCredentialResourceDisplayNameForWriteInTx({
            tx: writeTx(owner, member),
            ownerAccountId: owner.id,
            teamId: 'team-1',
            label,
        })).resolves.toEqual({ kind: 'invalid_recipients' });
        expect(projectTeamCredentialResourceDisplayNameForRecipient({
            serialized: 'Build provider',
            recipientAccountId: owner.id,
        })).toEqual({ content: { t: 'plain', v: 'Build provider' }, recipientEnvelope: null, legacyPlaintext: true });
        expect(projectTeamCredentialResourceDisplayNameForRecipient({
            serialized: '{"content":{"t":"encrypted","c":"bad"},"recipients":[]}', recipientAccountId: owner.id,
        })).toBeNull();
        expect(serializePrivateLabelStoredV1(label)).not.toContain('Build provider');
    });
});
