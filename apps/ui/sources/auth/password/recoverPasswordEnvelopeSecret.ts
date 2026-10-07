import { encodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';

import type { ServerFetch } from '@/sync/http/client';
import { preloginEmailPassword, unlockEmailPassword } from '@/sync/api/auth/emailPassword';

import { arePasswordEnvelopeKdfsEqual, derivePasswordKeys, openPasswordEnvelope } from './passwordEnvelope';

/**
 * Recover the Account recovery secret without changing authentication state.
 * Password text stays on-device; only its derived authentication key crosses
 * the existing unlock boundary. Every derived byte buffer is zeroed here.
 */
export async function recoverPasswordEnvelopeSecret(input: Readonly<{
    request: ServerFetch;
    email: string;
    password: string;
    signal?: AbortSignal;
}>): Promise<Uint8Array> {
    const prelogin = await preloginEmailPassword(input.request, input.email);
    if (prelogin.kind !== 'e2ee_password_unlock') throw new Error('password_authentication_failed');
    const keys = await derivePasswordKeys(input.password, prelogin.kdf, { signal: input.signal });
    try {
        const unlocked = await unlockEmailPassword(input.request, {
            v: 1,
            email: input.email,
            authKey: encodePasswordCredentialFieldV1(keys.authKey),
        });
        if (!arePasswordEnvelopeKdfsEqual(prelogin.kdf, unlocked.envelope.kdf)) {
            throw new Error('password_authentication_failed');
        }
        return await openPasswordEnvelope(unlocked.envelope, keys.wrapKey);
    } finally {
        keys.authKey.fill(0);
        keys.wrapKey.fill(0);
    }
}
