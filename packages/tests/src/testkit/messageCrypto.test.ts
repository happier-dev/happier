import { randomBytes } from 'node:crypto';

import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { stringifySerializedJsonValue } from '@happier-dev/protocol';

import { decodeBase64, decryptLegacyBase64, encodeBase64 } from './messageCrypto';

describe('messageCrypto', () => {
  it('unwraps serialized JSON envelopes produced by runtime legacy encryption', () => {
    const secret = Uint8Array.from(randomBytes(32));
    const expected = {
      path: '/tmp/worktree',
      host: 'e2e',
      acpSessionModeOverrideV1: { v: 1, updatedAt: 2000, modeId: 'plan' },
    };

    const nonce = Uint8Array.from(randomBytes(tweetnacl.secretbox.nonceLength));
    const plaintext = new TextEncoder().encode(stringifySerializedJsonValue(expected));
    const encrypted = tweetnacl.secretbox(plaintext, nonce, secret);
    const bundle = new Uint8Array(nonce.length + encrypted.length);
    bundle.set(nonce, 0);
    bundle.set(encrypted, nonce.length);

    expect(decodeBase64(encodeBase64(bundle))).toEqual(bundle);
    expect(decryptLegacyBase64(encodeBase64(bundle), secret)).toEqual(expected);
  });
});
