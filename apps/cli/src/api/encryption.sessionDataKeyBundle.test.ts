import { describe, expect, it } from 'vitest';
import {
  CRYPTO_GOLDEN_VECTORS,
  decodeBase64,
  openSessionDataKeyBundleV0,
  sealSessionDataKeyBundleV0,
} from '@happier-dev/protocol';
import { decryptWithDataKeyResult, encryptWithDataKey } from './encryption';

describe('session data-key cross-adapter contract', () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index);

  it('opens fixed ciphertext from the original UI writer', () => {
    const fixture = CRYPTO_GOLDEN_VECTORS.sessionDataKeyBundleV0;
    expect(decryptWithDataKeyResult(decodeBase64(fixture.ciphertextBase64), key)).toEqual({
      status: 'authenticated', value: fixture.value,
    });
  });

  it.each([undefined, null, { message: '跨端 🗝️', list: [null, false, 0, ''] }])(
    'opens WebCrypto writes with Node and Node writes with WebCrypto (%j)', async (value) => {
      const webCiphertext = await sealSessionDataKeyBundleV0(value, key);
      expect(decryptWithDataKeyResult(webCiphertext, key)).toEqual({ status: 'authenticated', value });
      const nodeCiphertext = encryptWithDataKey(value, key);
      expect(await openSessionDataKeyBundleV0(nodeCiphertext, key)).toEqual({ status: 'authenticated', value });
    },
  );

  it('returns typed failure for wrong versions, truncated framing, wrong keys and tampered tags', async () => {
    const ciphertext = encryptWithDataKey({ message: 'authenticated' }, key);
    const wrongVersion = ciphertext.slice();
    wrongVersion[0] = 99;
    const tampered = ciphertext.slice();
    tampered[tampered.length - 1] ^= 1;
    for (const bundle of [wrongVersion, new Uint8Array([0])]) {
      expect(decryptWithDataKeyResult(bundle, key)).toEqual({ status: 'unsupported' });
      expect(await openSessionDataKeyBundleV0(bundle, key)).toEqual({ status: 'unsupported' });
    }
    for (const [bundle, dataKey] of [[tampered, key], [ciphertext, new Uint8Array(32).fill(255)]] as const) {
      expect(decryptWithDataKeyResult(bundle, dataKey)).toEqual({ status: 'authentication_failed' });
      expect(await openSessionDataKeyBundleV0(bundle, dataKey)).toEqual({ status: 'authentication_failed' });
    }
  });
});
