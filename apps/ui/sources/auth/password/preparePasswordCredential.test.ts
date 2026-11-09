import {
    PASSWORD_ENVELOPE_WRITER_PROFILE_V1,
    PasswordWrappedRecoverySecretV1Schema,
    encodePasswordCredentialFieldV1,
} from '@happier-dev/protocol/auth/accountPasswordCredential';
import { expect, it, vi } from 'vitest';

import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { derivePasswordKeys, openPasswordEnvelope } from './passwordEnvelope';
import { preparePasswordCredentialMaterialV1 } from './preparePasswordCredential';

// The memory-hard KDF runs in a platform worker (Web Worker / native crypto
// worker), a genuine system boundary that does not exist under the test
// runtime. It is replaced by a deterministic stand-in so the envelope, AAD
// binding and wrap/auth key split below are exercised for real.
vi.mock('./derivePasswordEnvelopeKey', () => ({
    derivePasswordEnvelopeKey: async (input: {
        password: string;
        kdf: { salt: string; opsLimit: number; memLimitBytes: number };
    }) => {
        const seed = new TextEncoder().encode(
            `${input.password}|${input.kdf.salt}|${input.kdf.opsLimit}|${input.kdf.memLimitBytes}`,
        );
        const root = new Uint8Array(32);
        for (let index = 0; index < seed.length; index += 1) {
            root[index % 32] = (root[index % 32]! * 31 + seed[index]! + index) & 0xff;
        }
        return root;
    },
}));

const SECRET = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff);
const PASSWORD = '  exact é password 🔑  ';

it('writes an envelope the canonical reader opens back to the exact recovery secret', async () => {
    const prepared = await preparePasswordCredentialMaterialV1({ password: PASSWORD, secret: SECRET });

    const envelope = PasswordWrappedRecoverySecretV1Schema.parse(prepared.envelope);
    expect(envelope.kdf.opsLimit).toBe(PASSWORD_ENVELOPE_WRITER_PROFILE_V1.opsLimit);
    expect(envelope.kdf.memLimitBytes).toBe(PASSWORD_ENVELOPE_WRITER_PROFILE_V1.memLimitBytes);
    expect(envelope.accountSigningPublicKey)
        .toBe(encodePasswordCredentialFieldV1(deriveAccountSigningPublicKey(SECRET)));

    const keys = await derivePasswordKeys(PASSWORD, envelope.kdf);
    expect(encodePasswordCredentialFieldV1(keys.authKey)).toBe(prepared.authKey);
    expect([...await openPasswordEnvelope(envelope, keys.wrapKey)]).toEqual([...SECRET]);
});

it('uses a fresh salt and nonce for every prepared credential', async () => {
    const first = await preparePasswordCredentialMaterialV1({ password: PASSWORD, secret: SECRET });
    const second = await preparePasswordCredentialMaterialV1({ password: PASSWORD, secret: SECRET });

    expect(second.envelope.kdf.salt).not.toBe(first.envelope.kdf.salt);
    expect(second.envelope.cipher.nonce).not.toBe(first.envelope.cipher.nonce);
});

it('rejects password text the shared acceptance owner refuses', async () => {
    await expect(preparePasswordCredentialMaterialV1({ password: '\ud800', secret: SECRET }))
        .rejects.toThrow('password_not_accepted');
});
