import { createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseSerializedJsonValue } from '@happier-dev/protocol/crypto/serializedJsonValue';
import vectors from '../../../../../packages/protocol/src/crypto/fixtures/sessionMessageContentV1.json';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
import { decodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import { AES256Encryption, SecretBoxEncryption } from './encryptor';
import { EncryptionCache } from './encryptionCache';
import { SessionEncryption } from './sessionEncryption';

const key = new Uint8Array(32).fill(7);
const record = { role: 'user', content: { type: 'text', text: 'Repeated session content. '.repeat(80) } } as const;

describe('SessionMessage content codec boundary', () => {
    it('opens the shared 0.2 and current byte frames through the UI session boundary', async () => {
        for (const vector of vectors.vectors) {
            const secret = decodeBase64(vectors.keyBase64);
            const cipher = vector.variant === 'dataKey' ? new AES256Encryption(secret) : new SecretBoxEncryption(secret);
            const session = new SessionEncryption('session', cipher, new EncryptionCache());
            await expect(session.decryptRaw(vector.ciphertextBase64)).resolves.toEqual(vector.value);
        }
    });
    for (const kind of ['aes', 'secretbox'] as const) {
        it(`${kind} compresses message writes and keeps generic session content historical`, async () => {
            const cipher = kind === 'aes' ? new AES256Encryption(key) : new SecretBoxEncryption(key);
            const session = new SessionEncryption('session', cipher, new EncryptionCache());
            const message = decodeBase64(await session.encryptRawRecord(record));
            const generic = decodeBase64(await session.encryptRaw(record));
            expect(message.byteLength).toBeLessThan(generic.byteLength);
            let opened: Uint8Array;
            if (kind === 'aes') {
                expect(message[0]).toBe(1);
                expect(generic[0]).toBe(0);
                const decipher = createDecipheriv('aes-256-gcm', key, message.subarray(1, 13));
                decipher.setAuthTag(message.subarray(-16));
                opened = Buffer.concat([decipher.update(message.subarray(13, -16)), decipher.final()]);
            } else {
                opened = sodium.crypto_secretbox_open_easy(message.subarray(24), message.subarray(0, 24), key);
            }
            expect(opened[0]).toBe(1);
            expect(parseSerializedJsonValue(gunzipSync(opened.subarray(1)).toString('utf8'))).toEqual(record);
            expect(await cipher.decrypt([message, generic])).toEqual([record, record]);
        });
    }
});
