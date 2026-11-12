import { createCipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-modules-core', async () => {
    const { happierCryptoWorkerStub } = await import('@/dev/happierCryptoWorkerStub');
    return { requireNativeModule: () => happierCryptoWorkerStub };
});

import { SessionEncryption } from './sessionEncryption';
import { AES256Encryption } from './encryptor';
import { EncryptionCache } from './encryptionCache';
import { openSessionMessageContent } from './sessionMessageContent';
import inflateBounds from '../../../../../packages/protocol/src/crypto/fixtures/contentInflateBoundsV1.json';

describe('native SessionMessage byte cipher', () => {
    it('rejects authenticated gzip beyond the owning ingress ceiling', async () => {
        const frame = inflateBounds.vectors.find(vector => vector.expectedStatus === 'invalid_payload')!;
        const key = new Uint8Array(32).fill(3);
        const nonce = new Uint8Array(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        const encrypted = Buffer.concat([cipher.update(Buffer.from(frame.frameBase64, 'base64')), cipher.final()]);
        const bundle = Buffer.concat([Buffer.from([1]), nonce, encrypted, cipher.getAuthTag()]);
        await expect(openSessionMessageContent(bundle, key)).resolves.toEqual({ status: 'invalid_payload' });
    });

    it('does not report authenticated malformed content as authentication failure', async () => {
        const key = new Uint8Array(32).fill(3);
        const nonce = new Uint8Array(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        const encrypted = Buffer.concat([cipher.update(new Uint8Array([2])), cipher.final()]);
        const bundle = Buffer.concat([Buffer.from([1]), nonce, encrypted, cipher.getAuthTag()]);
        const failures: number[] = [];
        await expect(new AES256Encryption(key).decrypt([bundle], { onAuthenticationFailure: index => failures.push(index) })).resolves.toEqual([null]);
        expect(failures).toEqual([]);
    });

    it('seals compressed content and opens it through the native module byte boundary', async () => {
        const value = { role: 'user', content: { type: 'text', text: 'Native Unicode 🗝️ '.repeat(100) } } as const;
        const session = new SessionEncryption('session', new AES256Encryption(new Uint8Array(32).fill(3), {
            encryptString: async () => { throw new Error('String cipher cannot transport compressed bytes'); },
            decryptString: async () => { throw new Error('String cipher cannot open compressed bytes'); },
        }), new EncryptionCache());
        const ciphertext = await session.encryptRawRecord(value);
        expect(Buffer.from(ciphertext, 'base64')[0]).toBe(1);
        expect(Buffer.from(ciphertext, 'base64').length).toBeLessThan(Buffer.byteLength(JSON.stringify(value)));
        await expect(session.decryptRaw(ciphertext)).resolves.toEqual(value);
    });
});
