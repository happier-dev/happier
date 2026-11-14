import { describe, expect, it } from 'vitest';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { openPrivateLabelV1, projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';

import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { buildAccountEncryptionPrivateLabelsDirective } from './buildAccountEncryptionPrivateLabelsDirective';

const accountId = 'account-a';
const scope = {
    scope: { serverId: 'home-a', accountId },
    isCurrent: () => true,
};

function binding(entity: 'account_api_token' | 'account_directory_home', id: string) {
    return { entity, field: 'label', id } as const;
}

describe('buildAccountEncryptionPrivateLabelsDirective', () => {
    it('opens an Account-projected encrypted label and replaces it with its exact plaintext value', async () => {
        const sourceEncryption = await Encryption.create(new Uint8Array(32).fill(7));
        const sourceDataKey = new Uint8Array(32).fill(29);
        const tokenId = 'token-a';
        const stored = sealPrivateLabelV1({
            mode: 'e2ee', binding: binding('account_api_token', tokenId), value: 'Recovery token',
            dataKey: sourceDataKey,
            recipients: [{
                accountId,
                envelope: {
                    encryptedDataKey: encodeBase64(await sourceEncryption.encryptEncryptionKey(sourceDataKey), 'base64'),
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(sourceEncryption.contentDataKey),
                },
            }],
            randomBytes: length => new Uint8Array(length).fill(3),
        });

        const directive = await buildAccountEncryptionPrivateLabelsDirective({
            accountId, fromMode: 'e2ee', toMode: 'plain', sourceEncryption, targetEncryption: null, scope,
            candidates: [{ entity: 'account_api_token', field: 'label', id: tokenId,
                label: projectPrivateLabelForRecipientV1({ stored, recipientAccountId: accountId }) }],
        });

        expect(directive).toEqual({
            items: [{
                entity: 'account_api_token', field: 'label', id: tokenId,
                expectedLabel: projectPrivateLabelForRecipientV1({ stored, recipientAccountId: accountId }),
                label: { content: { t: 'plain', v: 'Recovery token' }, recipients: [] },
            }],
        });
    });

    it('gives each e2ee target label a fresh Account-wrapped data key', async () => {
        const targetEncryption = await Encryption.create(new Uint8Array(32).fill(17));
        const candidates = ['token-a', 'home-a'].map((id, index) => {
            const entity = index === 0 ? 'account_api_token' as const : 'account_directory_home' as const;
            const stored = sealPrivateLabelV1({ mode: 'plain', binding: binding(entity, id), value: `Private ${index}` });
            return { entity, field: 'label' as const, id, label: projectPrivateLabelForRecipientV1({ stored, recipientAccountId: accountId }) };
        });

        const directive = await buildAccountEncryptionPrivateLabelsDirective({
            accountId, fromMode: 'plain', toMode: 'e2ee', sourceEncryption: null, targetEncryption, scope,
            candidates,
        });

        expect(directive?.items).toHaveLength(2);
        const items = directive?.items ?? [];
        expect(items.map(item => item.label.recipients)).toEqual([
            [expect.objectContaining({ accountId, envelope: expect.objectContaining({
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(targetEncryption.contentDataKey),
            }) })],
            [expect.objectContaining({ accountId, envelope: expect.objectContaining({
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(targetEncryption.contentDataKey),
            }) })],
        ]);
        const opened = await Promise.all(items.map(async item => {
            const envelope = item.label.recipients[0]?.envelope;
            const dataKey = envelope ? await targetEncryption.decryptEncryptionKey(envelope.encryptedDataKey) : null;
            return dataKey ? openPrivateLabelV1({ binding: binding(item.entity, item.id), label: item.label, dataKey,
                readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' } }) : null;
        }));
        expect(opened).toEqual(['Private 0', 'Private 1']);
        expect(items[0]?.label.recipients[0]?.envelope.encryptedDataKey)
            .not.toBe(items[1]?.label.recipients[0]?.envelope.encryptedDataKey);
    });

    it('includes readable legacy Pool labels in an explicit Account mode change', async () => {
        const label = { content: { t: 'plain' as const, v: 'Historic Pool' }, recipientEnvelope: null, legacyPlaintext: true as const };
        await expect(buildAccountEncryptionPrivateLabelsDirective({
            accountId, fromMode: 'e2ee', toMode: 'plain', sourceEncryption: null, targetEncryption: null, scope,
            candidates: [{ entity: 'machine_pool', field: 'name', id: 'pool-a', label }],
        })).resolves.toEqual({ items: [{ entity: 'machine_pool', field: 'name', id: 'pool-a', expectedLabel: label,
            label: { content: label.content, recipients: [] } }] });
    });

    it('refuses an encrypted source projection without the Account recipient envelope', async () => {
        await expect(buildAccountEncryptionPrivateLabelsDirective({
            accountId, fromMode: 'e2ee', toMode: 'plain', sourceEncryption: await Encryption.create(new Uint8Array(32).fill(7)),
            targetEncryption: null, scope,
            candidates: [{ entity: 'account_api_token', field: 'label', id: 'token-a', label: {
                content: { t: 'encrypted', c: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
                recipientEnvelope: null,
            } }],
        })).rejects.toThrow('private_label_migration_unavailable');
    });
});
