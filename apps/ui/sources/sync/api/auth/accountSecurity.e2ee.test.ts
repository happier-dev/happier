import { describe, expect, it } from 'vitest';
import {
    createPasswordCredentialMutationDigestV1,
    createPasswordCredentialTargetDigestV1,
    createPasswordMutationChallengeSigningInputV1,
    type PasswordMutationChallengeV1,
} from '@happier-dev/protocol/auth/passwordMutationChallenge';
import {
    createAccountEncryptionMigrateRequestBindingDigestV1} from '@happier-dev/protocol/account/encryptionMigrate';
import {
    decodeBase64} from '@happier-dev/protocol/crypto/base64';
import {
    encodePasswordCredentialFieldV1,
    type E2eeAccountPasswordCredentialV1,
    type AccountPasswordCredentialV1} from '@happier-dev/protocol/auth/accountPasswordCredential';
import sodium from '@/encryption/libsodium.lib';
import type { ServerFetch } from '@/sync/http/client';

import {
    prepareE2eeAccountPasswordEnroll,
    prepareE2eeAccountPasswordChange,
    prepareE2eeAccountPasswordRemove,
    prepareAccountEncryptionModePasswordCredential,
    submitE2eeAccountPasswordChange,
} from './accountSecurity';

const secret = new Uint8Array(32).fill(17);

function credential(): E2eeAccountPasswordCredentialV1 {
    const signing = sodium.crypto_sign_seed_keypair(secret);
    return {
        v: 1,
        kind: 'e2ee_password_envelope',
        envelope: {
            v: 1,
            accountSigningPublicKey: encodePasswordCredentialFieldV1(signing.publicKey),
            kdf: {
                algorithm: 'argon2id13',
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                opsLimit: 3,
                memLimitBytes: 64 * 1024 * 1024,
                outputBytes: 32,
            },
            cipher: {
                algorithm: 'aes256gcm',
                nonce: encodePasswordCredentialFieldV1(new Uint8Array(12).fill(4)),
                ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48).fill(5)),
            },
        },
        authVerifier: {
            v: 1,
            hash: {
                v: 1,
                algorithm: 'scrypt',
                parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(6)),
                digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(7)),
            },
        },
    };
}

function challengeFor(input: Readonly<{
    action: 'connect' | 'change' | 'recover' | 'remove';
    targetCredential: AccountPasswordCredentialV1 | null;
    transitionRequestDigest?: string;
}>): PasswordMutationChallengeV1 {
    const mutation = {
        v: 1 as const,
        action: input.action,
        accountId: 'account-1',
        expectedCredentialRevision: input.action === 'connect' ? null : 4,
        normalizedNativeEmail: 'person@example.test',
        newCredentialDigest: input.targetCredential
            ? createPasswordCredentialTargetDigestV1(input.targetCredential, input.transitionRequestDigest ?? null)
            : null,
    };
    const operationDigest = input.targetCredential
        ? createPasswordCredentialMutationDigestV1(mutation)
        : createPasswordCredentialMutationDigestV1(mutation);
    return {
        v: 1,
        challengeId: `challenge-${input.action}`,
        nonce: 'nonce',
        issuedAt: '2026-09-07T10:00:00.000Z',
        expiresAt: '2026-09-07T10:05:00.000Z',
        audience: { origin: 'https://home.example.test', serverIdentityId: 'srv_home' },
        expectedAccountId: 'account-1',
        operationKind: 'password_credential_mutation_v1',
        operationDigest,
    };
}

describe('E2EE Account Security mutation client', () => {
    it('prepares first enrollment for the shared present-user Action without directly committing it', async () => {
        await sodium.ready;
        const targetCredential = credential();
        const challenge = challengeFor({ action: 'connect', targetCredential });
        const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
        const request: ServerFetch = async (path, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            calls.push({ path, body });
            return new Response(JSON.stringify({ targetCredential, challenge }), { status: 200 });
        };

        const prepared = await prepareE2eeAccountPasswordEnroll(request, {
            accountId: 'account-1',
            email: 'Person@Example.test',
            normalizedNativeEmail: 'person@example.test',
            newPassword: 'correct horse battery staple',
            secret,
            expectedAudience: challenge.audience,
            preparedCredentialMaterial: {
                envelope: targetCredential.envelope,
                authKey: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(8)),
            },
            verificationToken: 'v'.repeat(43),
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            path: '/v1/auth/password/mutation/challenge',
            body: { v: 1, action: 'connect', expectedCredentialRevision: null },
        });
        expect(prepared).toMatchObject({
            v: 1,
            kind: 'e2ee',
            email: 'Person@Example.test',
            verificationToken: 'v'.repeat(43),
            targetCredential,
        });
    });

    it('can prepare a recovery replacement for Action dispatch with an exact recover operation', async () => {
        await sodium.ready;
        const targetCredential = credential();
        const challenge = challengeFor({ action: 'recover', targetCredential });
        const request: ServerFetch = async () => new Response(JSON.stringify({ targetCredential, challenge }), { status: 200 });

        const prepared = await prepareE2eeAccountPasswordChange(request, {
            accountId: 'account-1',
            action: 'recover',
            expectedCredentialRevision: 4,
            normalizedNativeEmail: 'person@example.test',
            newPassword: 'correct horse battery staple',
            secret,
            expectedAudience: challenge.audience,
            preparedCredentialMaterial: {
                envelope: targetCredential.envelope,
                authKey: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(8)),
            },
        });

        expect(prepared.action).toBe('recover');
    });

    it('binds an E2EE-to-Plain replacement proof to the base migration request', async () => {
        await sodium.ready;
        const plainCredential = {
            v: 1 as const,
            kind: 'plain_password_hash' as const,
            hash: credential().authVerifier.hash,
        };
        const baseRequest = {
            toMode: 'plain' as const,
            expectedAccountVersion: 7,
            expectedSigningKeyFingerprint: 'signing',
            expectedContentKeyFingerprint: 'content',
            expectedSettingsVersion: 2,
            settingsContent: null,
            connectedServices: { action: 'assert_empty' as const },
            automations: { action: 'assert_empty' as const },
            machines: { action: 'assert_empty' as const },
            todos: { action: 'assert_empty' as const },
            artifacts: { action: 'assert_empty' as const },
            sessions: { action: 'assert_empty' as const },
            reviewComments: { action: 'assert_empty' as const },
            sessionOrganization: { action: 'assert_empty' as const },
            pets: { action: 'assert_empty' as const },
        };
        const transitionRequestDigest = createAccountEncryptionMigrateRequestBindingDigestV1({
            request: baseRequest,
            accountId: 'account-1',
            sourceMode: 'e2ee',
        });
        const challenge = challengeFor({
            action: 'change',
            targetCredential: plainCredential,
            transitionRequestDigest,
        });
        let submitted: Record<string, unknown> | null = null;
        const request: ServerFetch = async (_path, init) => {
            submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({ targetCredential: plainCredential, challenge }), { status: 200 });
        };

        const prepared = await prepareAccountEncryptionModePasswordCredential(request, {
            scope: { scope: { serverId: 'home-a', accountId: 'account-1' }, isCurrent: () => true },
            fromMode: 'e2ee', toMode: 'plain', password: 'correct horse battery staple',
            accountId: 'account-1', expectedCredentialRevision: 4,
            normalizedNativeEmail: 'person@example.test', secret,
            expectedAudience: challenge.audience,
            baseRequest,
        });

        expect(submitted).toMatchObject({ action: 'change', transitionRequestDigest: expect.stringMatching(/^aemrb1_/) });
        expect(prepared).toMatchObject({ expectedRevision: 4, credential: plainCredential, proof: { challengeId: challenge.challengeId } });
    });

    it('rejects a substituted E2EE envelope during a Plain-to-E2EE password transition', async () => {
        await sodium.ready;
        const localCredential = credential();
        const substitutedCredential = credential();
        substitutedCredential.envelope = {
            ...substitutedCredential.envelope,
            cipher: {
                ...substitutedCredential.envelope.cipher,
                ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48).fill(99)),
            },
        };
        const request: ServerFetch = async () => new Response(JSON.stringify({
            targetCredential: substitutedCredential,
            challenge: challengeFor({ action: 'change', targetCredential: substitutedCredential }),
        }), { status: 200 });

        await expect(prepareAccountEncryptionModePasswordCredential(request, {
            scope: { scope: { serverId: 'home-a', accountId: 'account-1' }, isCurrent: () => true },
            fromMode: 'plain', toMode: 'e2ee', password: 'correct horse battery staple',
            accountId: 'account-1', expectedCredentialRevision: 4,
            normalizedNativeEmail: 'person@example.test', secret,
            expectedAudience: challengeFor({ action: 'change', targetCredential: substitutedCredential }).audience,
            preparedCredentialMaterial: {
                envelope: localCredential.envelope,
                authKey: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(8)),
            },
        })).rejects.toMatchObject({ code: 'credential_inconsistent' });
    });

    it('prepares the exact server challenge for Action-dispatched change with the existing recovery secret', async () => {
        await sodium.ready;
        const targetCredential = credential();
        const challenge = challengeFor({ action: 'change', targetCredential });
        const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
        const request: ServerFetch = async (path, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            calls.push({ path, body });
            if (path.endsWith('/challenge')) {
                return new Response(JSON.stringify({ targetCredential, challenge }), { status: 200 });
            }
            return new Response(JSON.stringify({ v: 1, status: 'updated' }), { status: 200 });
        };

        const submitted = await prepareE2eeAccountPasswordChange(request, {
            accountId: 'account-1',
            expectedCredentialRevision: 4,
            normalizedNativeEmail: 'person@example.test',
            newPassword: 'correct horse battery staple',
            secret,
            expectedAudience: challenge.audience,
            preparedCredentialMaterial: {
                envelope: targetCredential.envelope,
                authKey: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(8)),
            },
        });

        await submitE2eeAccountPasswordChange(request, submitted);

        expect(calls.map((call) => call.path)).toEqual([
            '/v1/auth/password/mutation/challenge',
            '/v1/account/password/change',
        ]);
        expect(submitted.action).toBe('change');
        expect(submitted.targetCredential).toEqual(targetCredential);
        expect(submitted.proof.publicKey).toBe(targetCredential.envelope.accountSigningPublicKey);
        expect(sodium.crypto_sign_verify_detached(
            decodeBase64(submitted.proof.signature, 'base64url'),
            createPasswordMutationChallengeSigningInputV1(challenge),
            decodeBase64(submitted.proof.publicKey, 'base64url'),
        )).toBe(true);
    });

    it('prepares E2EE removal for Action dispatch only after a purpose-bound proof and sends no password material', async () => {
        await sodium.ready;
        const challenge = challengeFor({ action: 'remove', targetCredential: null });
        const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
        const request: ServerFetch = async (path, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            calls.push({ path, body });
            if (path.endsWith('/challenge')) {
                return new Response(JSON.stringify({ challenge }), { status: 200 });
            }
            return new Response(JSON.stringify({ v: 1, status: 'removed' }), { status: 200 });
        };

        const submitted = await prepareE2eeAccountPasswordRemove(request, {
            accountId: 'account-1',
            expectedCredentialRevision: 4,
            normalizedNativeEmail: 'person@example.test',
            secret,
            expectedAudience: challenge.audience,
        });

        expect(calls.map((call) => call.path)).toEqual([
            '/v1/auth/password/mutation/challenge',
        ]);
        expect(calls[0]!.body).not.toHaveProperty('newPlainPassword');
        expect(calls[0]!.body).not.toHaveProperty('newE2eePassword');
        expect(submitted).toMatchObject({ v: 1, kind: 'e2ee', expectedCredentialRevision: 4 });
    });
});
