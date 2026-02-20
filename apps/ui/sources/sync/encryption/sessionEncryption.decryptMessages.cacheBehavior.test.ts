import { describe, it, expect } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { EncryptionCache } from './encryptionCache';
import { SessionEncryption } from './sessionEncryption';
import { AES256Encryption } from './encryptor';

describe('SessionEncryption.decryptMessages (cache behavior)', () => {
  it('returns plaintext messages without decrypting and caches them', async () => {
    const cache = new EncryptionCache()
    const sessionId = 's_plain'

    const encryptor = {
      encrypt: async () => {
        throw new Error('encrypt should not be called')
      },
      decrypt: async () => {
        throw new Error('decrypt should not be called')
      },
    }

    const sessionEnc = new SessionEncryption(sessionId, encryptor as any, cache)

    const msg = {
      id: 'm_plain_1',
      seq: 1,
      localId: null,
      createdAt: 1,
      updatedAt: 1,
      content: {
        t: 'plain' as const,
        v: { role: 'user', content: { type: 'text', text: 'hello' } },
      },
    }

    const first = await sessionEnc.decryptMessages([msg as any])
    expect(first[0]).toBeTruthy()
    expect(first[0]!.content).toEqual({ role: 'user', content: { type: 'text', text: 'hello' } })

    const second = await sessionEnc.decryptMessages([msg as any])
    expect(second[0]).toBeTruthy()
    expect(second[0]!.content).toEqual({ role: 'user', content: { type: 'text', text: 'hello' } })
  })

  it('rehydrates plaintext messages when content changes for the same message id', async () => {
    const cache = new EncryptionCache()
    const sessionId = 's_plain_stream'

    const encryptor = {
      encrypt: async () => {
        throw new Error('encrypt should not be called')
      },
      decrypt: async () => {
        throw new Error('decrypt should not be called')
      },
    }

    const sessionEnc = new SessionEncryption(sessionId, encryptor as any, cache)

    const base = {
      id: 'm_plain_stream_1',
      seq: 1,
      localId: null,
      createdAt: 1,
      updatedAt: 1,
    }

    const msg1 = { ...base, content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'partial' } } } }
    const msg2 = { ...base, updatedAt: 2, content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'final' } } } }

    const first = await sessionEnc.decryptMessages([msg1 as any])
    expect(first[0]).toBeTruthy()
    expect(first[0]!.content).toEqual({ role: 'user', content: { type: 'text', text: 'partial' } })

    const second = await sessionEnc.decryptMessages([msg2 as any])
    expect(second[0]).toBeTruthy()
    expect(second[0]!.content).toEqual({ role: 'user', content: { type: 'text', text: 'final' } })
  })

  it('treats invalid plaintext envelopes as undecipherable (content: null)', async () => {
    const cache = new EncryptionCache()
    const sessionId = 's_plain_invalid'

    const encryptor = {
      encrypt: async () => {
        throw new Error('encrypt should not be called')
      },
      decrypt: async () => {
        throw new Error('decrypt should not be called')
      },
    }

    const sessionEnc = new SessionEncryption(sessionId, encryptor as any, cache)

    const msg = {
      id: 'm_plain_invalid_1',
      seq: 1,
      localId: null,
      createdAt: 1,
      updatedAt: 1,
      content: { t: 'plain' as const, v: { kind: 'not-a-raw-record', text: 'hello' } },
    }

    const result = await sessionEnc.decryptMessages([msg as any])
    expect(result[0]).toBeTruthy()
    expect(result[0]!.content).toBeNull()
  })

  it('retries decrypting encrypted messages when a prior attempt failed (does not permanently cache null)', async () => {
    const cache = new EncryptionCache();
    const sessionId = 's1';
    const wrongKey = new Uint8Array(32).fill(3);
    const correctKey = new Uint8Array(32).fill(4);

    const payload = { kind: 'user-text', text: 'hello' };
    const correctEncryptor = new AES256Encryption(correctKey);
    const encrypted = await correctEncryptor.encrypt([payload]);
    const ciphertextB64 = encodeBase64(encrypted[0], 'base64');

    const msg = {
      id: 'm1',
      seq: 1,
      localId: null,
      createdAt: 1,
      updatedAt: 1,
      content: { t: 'encrypted' as const, c: ciphertextB64 },
    };

    const wrongSessionEnc = new SessionEncryption(sessionId, new AES256Encryption(wrongKey), cache);
    const first = await wrongSessionEnc.decryptMessages([msg as any]);
    expect(first[0]).toBeTruthy();
    expect(first[0]!.content).toBeNull();

    const correctSessionEnc = new SessionEncryption(sessionId, new AES256Encryption(correctKey), cache);
    const second = await correctSessionEnc.decryptMessages([msg as any]);
    expect(second[0]).toBeTruthy();
    expect(second[0]!.content).toEqual(payload);
  });

  it('re-decrypts when encrypted ciphertext changes for the same message id (streaming updates)', async () => {
    const cache = new EncryptionCache();
    const sessionId = 's_stream';
    const key = new Uint8Array(32).fill(9);

    const encryptor = new AES256Encryption(key);
    const sessionEnc = new SessionEncryption(sessionId, encryptor, cache);

    const payload1 = { kind: 'agent-text', text: 'partial' };
    const payload2 = { kind: 'agent-text', text: 'final' };

    const encrypted1 = await encryptor.encrypt([payload1]);
    const encrypted2 = await encryptor.encrypt([payload2]);
    const ciphertext1 = encodeBase64(encrypted1[0], 'base64');
    const ciphertext2 = encodeBase64(encrypted2[0], 'base64');

    const msg1 = {
      id: 'm_stream_1',
      seq: 10,
      localId: null,
      createdAt: 10,
      updatedAt: 10,
      content: { t: 'encrypted' as const, c: ciphertext1 },
    };
    const msg2 = {
      ...msg1,
      updatedAt: 11,
      content: { t: 'encrypted' as const, c: ciphertext2 },
    };

    const first = await sessionEnc.decryptMessages([msg1 as any]);
    expect(first[0]).toBeTruthy();
    expect(first[0]!.content).toEqual(payload1);

    const second = await sessionEnc.decryptMessages([msg2 as any]);
    expect(second[0]).toBeTruthy();
    expect(second[0]!.content).toEqual(payload2);
  });
});
