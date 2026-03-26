import { describe, expect, it, vi } from 'vitest';

import { TRANSFER_CHUNK_HARD_MAX_BYTES } from './transferChunkSizeLimit';
import { decryptEncryptedTransferChunkEnvelope, parseTransferRecipientPublicKeyBase64 } from './transferChunkEncryption';

describe('decryptEncryptedTransferChunkEnvelope', () => {
  it('fails closed before base64 decoding when payloadBase64 exceeds the hard max bytes', () => {
    const transferId = 'transfer_oversized_payload_base64';
    const maxBytes =
      1 /* version */ + 12 /* nonce */ + TRANSFER_CHUNK_HARD_MAX_BYTES + 16 /* auth tag */;
    const oversizedChars = Math.ceil((maxBytes + 1) / 3) * 4;
    const payloadBase64 = 'A'.repeat(oversizedChars);

    const fromSpy = vi.spyOn(Buffer, 'from');
    expect(() => {
      decryptEncryptedTransferChunkEnvelope({
        transferId,
        sequence: 0,
        payloadBase64,
        encryptedDataKeyEnvelopeBase64: 'AA==',
        recipientSecretKeySeed: new Uint8Array(32),
      });
    }).toThrow(`Invalid encrypted transfer chunk for ${transferId}`);
    expect(fromSpy).not.toHaveBeenCalled();
    fromSpy.mockRestore();
  });

  it('fails closed before base64 decoding when encryptedDataKeyEnvelopeBase64 exceeds the hard max bytes', () => {
    const transferId = 'transfer_oversized_key_envelope_base64';
    const minimumBundleBytes = 1 + 12 + 16;
    const minimumBundle = Buffer.alloc(minimumBundleBytes);
    minimumBundle[0] = 0;

    const fromSpy = vi.spyOn(Buffer, 'from');
    expect(() => {
      decryptEncryptedTransferChunkEnvelope({
        transferId,
        sequence: 0,
        payloadBase64: minimumBundle.toString('base64'),
        encryptedDataKeyEnvelopeBase64: 'A'.repeat(10_000),
        recipientSecretKeySeed: new Uint8Array(32),
      });
    }).toThrow(`Invalid encrypted transfer data key for ${transferId}`);
    expect(fromSpy).not.toHaveBeenCalled();
    fromSpy.mockRestore();
  });
});

describe('parseTransferRecipientPublicKeyBase64', () => {
  it('fails closed before base64 decoding when recipientPublicKeyBase64 is oversized', () => {
    const fromSpy = vi.spyOn(Buffer, 'from');
    expect(() => parseTransferRecipientPublicKeyBase64('A'.repeat(10_000))).toThrow('Invalid transfer recipient public key');
    expect(fromSpy).not.toHaveBeenCalled();
    fromSpy.mockRestore();
  });

  it('caches parsed recipient keys to avoid repeated base64 decode work', () => {
    const recipientPublicKeyBytes = Buffer.alloc(32, 7);
    const recipientPublicKeyBase64 = recipientPublicKeyBytes.toString('base64');

    const fromSpy = vi.spyOn(Buffer, 'from');
    const first = parseTransferRecipientPublicKeyBase64(recipientPublicKeyBase64);
    const second = parseTransferRecipientPublicKeyBase64(recipientPublicKeyBase64);

    expect(second).toBe(first);
    expect(fromSpy).toHaveBeenCalledTimes(1);
    fromSpy.mockRestore();
  });

  it('evicts old keys from the cache when it exceeds its hard max', () => {
    const fromSpy = vi.spyOn(Buffer, 'from');

    const base64Keys: string[] = [];
    for (let index = 0; index < 257; index += 1) {
      const bytes = Buffer.alloc(32, 9);
      bytes[0] = Math.floor(index / 256);
      bytes[1] = index % 256;
      base64Keys.push(bytes.toString('base64'));
    }

    for (const key of base64Keys) {
      parseTransferRecipientPublicKeyBase64(key);
    }

    // Calling the oldest entry again should require another decode because it was evicted.
    parseTransferRecipientPublicKeyBase64(base64Keys[0]!);

    expect(fromSpy).toHaveBeenCalledTimes(258);
    fromSpy.mockRestore();
  });
});
