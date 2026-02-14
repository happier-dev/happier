import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

import { Encryption } from './encryption';
import { SecretBoxEncryption } from './encryptor';

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
        const legacySecretbox = new SecretBoxEncryption(recoverySecret);
        const legacyCiphertext = encodeBase64((await legacySecretbox.encrypt([payload]))[0], 'base64');

        const decrypted = await legacyEncryption.decryptAutomationTemplateRaw(legacyCiphertext);
        expect(decrypted).toEqual(payload);
    });

    it('legacy mode can still decrypt pre-protocol templates sealed with the machine key', async () => {
        const recoverySecret = new Uint8Array(32).fill(5);
        const legacyEncryption = await Encryption.create(recoverySecret);

        const machineKey = legacyEncryption.getContentPrivateKey();
        const payload = { directory: '/tmp/project', prompt: 'Legacy machine secretbox' };
        const machineSecretbox = new SecretBoxEncryption(machineKey);
        const legacyCiphertext = encodeBase64((await machineSecretbox.encrypt([payload]))[0], 'base64');

        const decrypted = await legacyEncryption.decryptAutomationTemplateRaw(legacyCiphertext);
        expect(decrypted).toEqual(payload);
    });
});

