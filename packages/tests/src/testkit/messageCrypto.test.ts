import { randomBytes } from 'node:crypto';

import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { stringifySerializedJsonValue } from '@happier-dev/protocol/crypto/serializedJsonValue';
import { encryptSessionMessage, encryptWithDataKey } from '../../../../apps/cli/src/api/encryption';

import { decodeBase64, decryptLegacyBase64, encodeBase64 } from './messageCrypto';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from './rpcCrypto';

describe('messageCrypto', () => {
  it.each(['legacy', 'dataKey'] as const)('reads native Session message frames with %s encryption', variant => {
    const secret = Uint8Array.from(randomBytes(32));
    const message = { role: 'agent', content: { type: 'message', message: 'Native assistant reply. '.repeat(1024) } };
    const ciphertext = encodeBase64(encryptSessionMessage(secret, variant, message));
    const read = variant === 'legacy' ? decryptLegacyBase64 : decryptDataKeyBase64;
    expect(read(ciphertext, secret)).toEqual(message);
  });

  it('preserves version-zero data-key RPC envelopes alongside Session message frames', () => {
    const secret = Uint8Array.from(randomBytes(32));
    const response = { result: { accepted: true }, id: 'rpc-response' };
    expect(decryptDataKeyBase64(encryptDataKeyBase64(response, secret), secret)).toEqual(response);
    expect(decryptDataKeyBase64(encodeBase64(encryptWithDataKey(response, secret)), secret)).toEqual(response);
  });

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
