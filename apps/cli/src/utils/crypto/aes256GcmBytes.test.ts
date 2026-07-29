import { describe, expect, it } from 'vitest';

import { openAes256GcmBytes, sealAes256GcmBytes } from './aes256GcmBytes';

describe('Node AES-256-GCM byte adapter', () => {
  it('matches the peer-application cross-runtime golden vector and rejects modified ciphertext', async () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    const aad = new TextEncoder().encode('{"accountId":"account-1","applicationAttemptId":"attempt-1","applicationAuthorityDigest":"sha256:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","applicationKind":"speech_transcription","authorityDigest":"sha256:acdb52b3d7de70428b1c54fbb340ab675b98d6900d2b86ababad20baa7aed6ca","direction":"client_to_daemon","domain":"happier.peer-application.aead","flowKind":"voice_media","generation":7,"machineId":"machine-1","phase":"data","sequence":9,"streamId":"stream-1","substreamId":"daemon.voiceInference.stt.stream-1.7","suite":"aes-256-gcm","tunnelId":"tunnel-1","v":1}');
    const ciphertext = await sealAes256GcmBytes({ key, nonce, aad, plaintext: Uint8Array.from([0, 1, 2, 3, 255]) });
    expect(Buffer.from(ciphertext).toString('hex')).toBe('b816fba638bf88ec3ef6111e7d53aad8985807ec48');
    expect(openAes256GcmBytes({ key, nonce, aad, ciphertext })).toEqual(Uint8Array.from([0, 1, 2, 3, 255]));
    ciphertext[0] ^= 1;
    expect(() => openAes256GcmBytes({ key, nonce, aad, ciphertext })).toThrow('aes_256_gcm_authentication_failed');
  });
});
