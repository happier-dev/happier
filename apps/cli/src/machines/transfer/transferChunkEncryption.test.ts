import { describe, expect, it, vi } from 'vitest';

import { TRANSFER_CHUNK_HARD_MAX_BYTES } from './transferChunkSizeLimit';
import { decryptEncryptedTransferChunkEnvelope } from './transferChunkEncryption';

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
