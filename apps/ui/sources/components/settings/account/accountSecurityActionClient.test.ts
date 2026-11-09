import { describe, expect, it, vi } from 'vitest';
import {
    encodePasswordCredentialFieldV1,
    type PlainAccountPasswordCredentialV1,
} from '@happier-dev/protocol/auth/accountPasswordCredential';

import {
    AccountSecurityActionApprovalPendingError,
    createAccountSecurityActionClient,
} from './accountSecurityActionClient';

describe('accountSecurityActionClient', () => {
    it('uses the injected authenticated enrollment-email requester and preserves cancellation', async () => {
        const requestEnrollmentEmail = vi.fn(async () => undefined);
        const client = createAccountSecurityActionClient({
            execute: vi.fn() as never,
            requestEnrollmentEmail,
            resolveServerId: () => 'home-a',
        });
        const controller = new AbortController();

        await client.requestPasswordEnrollmentEmail({ email: 'person@example.test' }, controller.signal);

        expect(requestEnrollmentEmail).toHaveBeenCalledWith(
            { email: 'person@example.test' },
            controller.signal,
        );
    });

    it('runs Account Security intents through the present-user Action front door', async () => {
        const execute = vi.fn(async (actionId: string) => {
            if (actionId === 'account.security.get') {
                return {
                    ok: true as const,
                    result: {
                        v: 1 as const,
                        encryptionMode: 'plain' as const,
                        nativeEmail: 'person@example.test',
                        password: { status: 'enrolled' as const, revision: 3 },
                    },
                };
            }
            if (actionId === 'account.email.change.request') {
                return { ok: true as const, result: { v: 1 as const, status: 'verification_sent' as const } };
            }
            return { ok: true as const, result: { v: 1 as const, status: 'updated' as const } };
        });
        const client = createAccountSecurityActionClient({ execute: execute as never, resolveServerId: () => 'home-a' });
        const plainTargetCredential = {
            v: 1,
            kind: 'plain_password_hash',
            hash: {
                v: 1,
                algorithm: 'scrypt',
                parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
            },
        } as const satisfies PlainAccountPasswordCredentialV1;

        await expect(client.read()).resolves.toMatchObject({ nativeEmail: 'person@example.test' });
        await expect(client.changePlainPassword({
            expectedCredentialRevision: 3,
            currentPassword: 'old password that is long enough',
            newPassword: 'new password that is long enough',
        })).resolves.toEqual({ v: 1, status: 'updated' });
        await expect(client.changeE2eePassword({
            v: 1,
            kind: 'e2ee',
            action: 'change',
            expectedCredentialRevision: 3,
            targetCredential: {
                kind: 'e2ee_password_envelope',
                authKeyVersion: 1,
                authKey: 'a'.repeat(43),
                envelope: {
                    v: 1,
                    algorithm: 'xchacha20-poly1305',
                    kdf: 'argon2id',
                    salt: 'b'.repeat(22),
                    nonce: 'c'.repeat(32),
                    ciphertext: 'd'.repeat(64),
                    keyLength: 32,
                    memoryCostKiB: 65536,
                    timeCost: 3,
                    parallelism: 1,
                },
            },
            proof: { challengeId: 'challenge', publicKey: 'e'.repeat(43), signature: 'f'.repeat(86) },
        } as never)).resolves.toEqual({ v: 1, status: 'updated' });
        await expect(client.enrollE2eePassword({
            v: 1,
            kind: 'e2ee',
            email: 'person@example.test',
        } as never)).resolves.toEqual({ v: 1, status: 'updated' });
        await expect(client.enrollPlainPassword({
            v: 1,
            kind: 'plain',
            email: 'person@example.test',
            targetCredential: plainTargetCredential,
            verificationToken: 'A'.repeat(43),
            reauthentication: {
                provider: 'github',
                pending: 'oauth-pending',
                proof: 'oauth-proof',
            },
        })).resolves.toEqual({ v: 1, status: 'updated' });
        await expect(client.requestEmailChange({ email: 'next@example.test' })).resolves.toEqual({ v: 1, status: 'verification_sent' });

        expect(execute).toHaveBeenCalledWith('account.security.get', {}, expect.objectContaining({
            surface: 'ui',
            authority: 'present_user',
            actionCaller: { kind: 'host' },
        }));
        expect(execute).toHaveBeenCalledWith('account.password.change', {
            v: 1,
            kind: 'plain',
            expectedCredentialRevision: 3,
            currentPassword: 'old password that is long enough',
            newPassword: 'new password that is long enough',
        }, expect.objectContaining({ authority: 'present_user' }));
        expect(execute).toHaveBeenCalledWith('account.email.change.request', {
            v: 1,
            email: 'next@example.test',
        }, expect.objectContaining({ authority: 'present_user' }));
        expect(execute).toHaveBeenCalledWith('account.password.change', expect.objectContaining({
            kind: 'e2ee',
            action: 'change',
            expectedCredentialRevision: 3,
        }), expect.objectContaining({ authority: 'present_user' }));
        expect(execute).toHaveBeenCalledWith('account.password.enroll', expect.objectContaining({
            kind: 'e2ee',
            email: 'person@example.test',
        }), expect.objectContaining({ authority: 'present_user' }));
        expect(execute).toHaveBeenCalledWith('account.password.enroll', {
            v: 1,
            kind: 'plain',
            email: 'person@example.test',
            targetCredential: plainTargetCredential,
            verificationToken: 'A'.repeat(43),
            reauthentication: {
                provider: 'github',
                pending: 'oauth-pending',
                proof: 'oauth-proof',
            },
        }, expect.objectContaining({ authority: 'present_user' }));
    });

    it('preserves typed Action refusal codes for recovery UI', async () => {
        const client = createAccountSecurityActionClient({
            execute: vi.fn(async () => ({
                ok: false as const,
                errorCode: 'approval_rejected',
                error: 'The request was declined',
            })) as never,
            resolveServerId: () => 'home-a',
        });

        await expect(client.removePlainPassword({
            expectedCredentialRevision: 2,
            currentPassword: 'current password is long enough',
        })).rejects.toMatchObject({ code: 'approval_rejected' });
    });

    it('preserves the exact deferred approval identity instead of discarding it as a generic pending error', async () => {
        const client = createAccountSecurityActionClient({
            execute: vi.fn(async () => ({
                ok: true as const,
                result: { kind: 'approval_request_created' as const, artifactId: 'approval-1', actionId: 'account.password.enroll' },
            })) as never,
            resolveServerId: () => 'home-a',
        });

        await expect(client.enrollPlainPassword({
            v: 1,
            kind: 'plain',
            email: 'person@example.test',
            targetCredential: {
                v: 1,
                kind: 'plain_password_hash',
                hash: {
                    v: 1,
                    algorithm: 'scrypt',
                    parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                    salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                    digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
                },
            },
            verificationToken: 'A'.repeat(43),
            reauthentication: { provider: 'github', pending: 'pending-1', proof: 'proof-1' },
        })).rejects.toEqual(expect.objectContaining({
            name: 'AccountSecurityActionApprovalPendingError',
            artifactId: 'approval-1',
            actionId: 'account.password.enroll',
        }));
    });

    it('rejects a deferred approval envelope for a different Action', async () => {
        const client = createAccountSecurityActionClient({
            execute: vi.fn(async () => ({
                ok: true as const,
                result: { kind: 'approval_request_created' as const, artifactId: 'approval-1', actionId: 'account.password.change' },
            })) as never,
            resolveServerId: () => 'home-a',
        });

        const promise = client.enrollPlainPassword({
            v: 1,
            kind: 'plain',
            email: 'person@example.test',
            targetCredential: {
                v: 1,
                kind: 'plain_password_hash',
                hash: {
                    v: 1,
                    algorithm: 'scrypt',
                    parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                    salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                    digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
                },
            },
            reauthentication: { provider: 'github', pending: 'pending-1', proof: 'proof-1' },
        });

        await expect(promise).rejects.not.toBeInstanceOf(AccountSecurityActionApprovalPendingError);
        await expect(promise).rejects.toMatchObject({ code: 'invalid_action_output' });
    });
});
