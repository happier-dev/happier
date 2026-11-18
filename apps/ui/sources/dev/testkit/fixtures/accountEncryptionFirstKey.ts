import { AccountEncryptionMigrateRequestSchema } from '@happier-dev/protocol/account/encryptionMigrate';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountTokenForTests } from '../harness/homeGovernanceHarness';

/** Valid producer-shaped first-key material shared by custody and recovery tests. */
export async function createAccountEncryptionFirstKeyFixture(options: Readonly<{
    accountId?: string;
    token?: string;
}> = {}) {
    const accountId = options.accountId ?? 'account-1';
    const token = options.token ?? createAccountTokenForTests(accountId);
    const seed = new Uint8Array(32).fill(7);
    const secret = encodeBase64(seed, 'base64url');
    const contentBinding = await buildContentKeyBinding(seed);
    const request = AccountEncryptionMigrateRequestSchema.parse({
        toMode: 'e2ee', expectedAccountVersion: 8,
        expectedSigningKeyFingerprint: null, expectedContentKeyFingerprint: null,
        expectedSettingsVersion: 3, settingsContent: { t: 'encrypted', c: 'ciphertext' },
        connectedServices: { action: 'assert_empty' }, automations: { action: 'assert_empty' },
        machines: { action: 'assert_empty' }, todos: { action: 'assert_empty' },
        artifacts: { action: 'assert_empty' }, sessions: { action: 'assert_empty' },
        reviewComments: { action: 'assert_empty' }, sessionOrganization: { action: 'assert_empty' },
        pets: { action: 'assert_empty' },
        keyProof: { v: 1, publicKey: encodeBase64(deriveAccountSigningPublicKey(seed)),
            ...contentBinding, signature: 'request-signature' },
    });
    return { accountId, seed, contentBinding, currentCredentials: { token },
        proposedCredentials: { token, secret }, request };
}
