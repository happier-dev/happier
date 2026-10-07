// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol/crypto/accountScopedCipher';

describe('DOM TextEncoder boundary', () => {
    it('preserves UTF8 encoding and encodeInto partial-code-point semantics', () => {
        const encoder = new TextEncoder();
        expect(encoder.encoding).toBe('utf-8');
        expect(encoder.encode('A€😄')).toEqual(Uint8Array.from([65, 226, 130, 172, 240, 159, 152, 132]));

        const destination = new Uint8Array(5);
        expect(encoder.encodeInto('A€😄', destination)).toEqual({ read: 2, written: 4 });
        expect(destination).toEqual(Uint8Array.from([65, 226, 130, 172, 0]));
    });

    it('round-trips real Account ciphertext with TweetNaCl-owned key material and nonce', () => {
        const material = {
            type: 'dataKey' as const,
            machineKey: tweetnacl.randomBytes(tweetnacl.secretbox.keyLength),
        };
        const payload = { probe: 'Voice saved-secret binding' };
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material,
            payload,
            randomBytes: (length) => tweetnacl.randomBytes(length),
        });

        expect(openAccountScopedBlobCiphertext({
            kind: 'account_settings', material, ciphertext,
        })).toMatchObject({ format: 'account_scoped_v1', value: payload });
    });
});
