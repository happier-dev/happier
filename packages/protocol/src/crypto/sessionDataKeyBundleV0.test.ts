import { describe, expect, it } from 'vitest';
import { decodeBase64 } from './base64.js';
import { CRYPTO_GOLDEN_VECTORS } from './cryptoGoldenVectors.js';
import { frameSessionDataKeyBundleV0, readSessionDataKeyBundleV0 } from './sessionDataKeyBundleV0.js';
import { openSessionDataKeyBundleV0, sealAesGcmPayloadWebCrypto } from './sessionDataKeyBundleWebCrypto.js';

describe('session data-key bundle version 0', () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index);

  it('opens fixed ciphertext captured from the pre-extraction UI writer', async () => {
    const fixture = CRYPTO_GOLDEN_VECTORS.sessionDataKeyBundleV0;
    expect(await openSessionDataKeyBundleV0(decodeBase64(fixture.ciphertextBase64), key)).toEqual({
      status: 'authenticated', value: fixture.value,
    });
  });

  it('keeps the version, 12-byte nonce and 16-byte authentication tag boundaries', () => {
    const payload = Uint8Array.from({ length: 31 }, (_, index) => index);
    const bundle = frameSessionDataKeyBundleV0(payload);
    expect(readSessionDataKeyBundleV0(bundle)).toEqual({
      status: 'ready',
      payload,
      nonce: payload.slice(0, 12),
      ciphertext: payload.slice(12, -16),
      authTag: payload.slice(-16),
    });
    expect(readSessionDataKeyBundleV0(new Uint8Array([0]))).toEqual({ status: 'unsupported' });
    expect(() => frameSessionDataKeyBundleV0(new Uint8Array(27))).toThrow();
  });

  it('distinguishes authenticated invalid JSON from authentication failure', async () => {
    const payload = await sealAesGcmPayloadWebCrypto(new TextEncoder().encode('{'), key);
    const bundle = frameSessionDataKeyBundleV0(payload);
    expect(await openSessionDataKeyBundleV0(bundle, key)).toEqual({ status: 'invalid_payload' });
    const tampered = bundle.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(await openSessionDataKeyBundleV0(tampered, key)).toEqual({ status: 'authentication_failed' });
  });
});
