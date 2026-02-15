import { describe, it, expect } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from './encryption';

describe('Encryption.initializeSessions (key updates)', () => {
  it('updates session encryption when a data key becomes available later', async () => {
    const masterSecret = new Uint8Array(32).fill(1);
    const sessionDataKey = new Uint8Array(32).fill(2);
    const sessionId = 'session_1';

    const encryption = await Encryption.create(masterSecret);

    // First initialize without a data key (fallback encryption).
    await encryption.initializeSessions(new Map([[sessionId, null]]));
    const before = encryption.getSessionEncryption(sessionId);
    expect(before).toBeTruthy();

    // Encrypt a payload using the session data key (AES mode).
    const aes = await encryption.openEncryption(sessionDataKey);
    const payload = { hello: 'world' };
    const encrypted = await aes.encrypt([payload]);
    const ciphertextB64 = encodeBase64(encrypted[0], 'base64');

    // With fallback encryption, decrypting AES ciphertext must fail.
    expect(await before!.decryptRaw(ciphertextB64)).toBeNull();

    // Later, the data key becomes available (e.g. after decryptEncryptionKey succeeds).
    await encryption.initializeSessions(new Map([[sessionId, sessionDataKey]]));
    const after = encryption.getSessionEncryption(sessionId);
    expect(after).toBeTruthy();

    // After re-initialization, decryption should succeed.
    expect(await after!.decryptRaw(ciphertextB64)).toEqual(payload);
  });
});

