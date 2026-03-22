import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@/encryption/base64';

import { Encryption } from './encryption';

function sealLegacySecretBoxJson(payload: unknown, key: Uint8Array): string {
    const nonce = new Uint8Array(tweetnacl.secretbox.nonceLength).fill(7);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const boxed = tweetnacl.secretbox(plaintext, nonce, key);
    const bytes = new Uint8Array(nonce.length + boxed.length);
    bytes.set(nonce, 0);
    bytes.set(boxed, nonce.length);
    return encodeBase64(bytes, 'base64');
}

describe('Encryption automation templates', () => {
    it('encryptAutomationTemplateRaw ciphertext is decryptable across legacy and dataKey modes', async () => {
        const recoverySecret = new Uint8Array(32).fill(3);
        const legacyEncryption = await Encryption.create(recoverySecret);
        const dataKeyEncryption = await Encryption.createFromContentKeyPair({
            publicKey: legacyEncryption.contentDataKey,
            machineKey: legacyEncryption.getContentPrivateKey(),
        });

        const payload = { directory: '/tmp/project', prompt: 'Run template' };
        const ciphertext = await legacyEncryption.encryptAutomationTemplateRaw(payload);

        const decrypted = await dataKeyEncryption.decryptAutomationTemplateRaw(ciphertext);
        expect(decrypted).toEqual(payload);
    });

    it('legacy mode can still decrypt pre-protocol templates sealed with the recovery secret', async () => {
        const recoverySecret = new Uint8Array(32).fill(4);
        const legacyEncryption = await Encryption.create(recoverySecret);

        const payload = { directory: '/tmp/project', prompt: 'Legacy secretbox' };
        const legacyCiphertext = sealLegacySecretBoxJson(payload, recoverySecret);

        const decrypted = await legacyEncryption.decryptAutomationTemplateRaw(legacyCiphertext);
        expect(decrypted).toEqual(payload);
    });

    it('legacy mode can still decrypt pre-protocol templates sealed with the machine key', async () => {
        const recoverySecret = new Uint8Array(32).fill(5);
        const legacyEncryption = await Encryption.create(recoverySecret);

        const machineKey = legacyEncryption.getContentPrivateKey();
        const payload = { directory: '/tmp/project', prompt: 'Legacy machine secretbox' };
        const legacyCiphertext = sealLegacySecretBoxJson(payload, machineKey);

        const decrypted = await legacyEncryption.decryptAutomationTemplateRaw(legacyCiphertext);
        expect(decrypted).toEqual(payload);
    });
});
