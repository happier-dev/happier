import { installPasswordKdfWorkerBoundary } from '@/dev/testkit/mocks/passwordKdfWorker';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { preparePasswordCredentialMaterialV1 } from './preparePasswordCredential';
import { recoverPasswordEnvelopeSecret } from './recoverPasswordEnvelopeSecret';
import { KeyChallengeV2IssueResponseSchema } from '@happier-dev/protocol/auth/keyChallenge';
import { NativeEmailPasswordPreloginResponseV1Schema, NativeEmailPasswordUnlockResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';

// Keep KDF validation, key splitting and envelope crypto on the real path.
beforeEach(installPasswordKdfWorkerBoundary);
afterEach(() => vi.unstubAllGlobals());

const issuedChallenge = KeyChallengeV2IssueResponseSchema.parse({
    challengeId: 'password-recovery-challenge',
    nonce: 'password-recovery-nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    audience: { origin: 'https://home.example.test', serverIdentityId: 'srv_home' },
});

it('opens the existing E2EE password envelope locally and never sends password text', async () => {
    const secret = new Uint8Array(32).fill(19);
    const prepared = await preparePasswordCredentialMaterialV1({
        password: 'correct horse battery staple',
        secret,
    });
    const bodies: string[] = [];
    const request = async (path: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        if (path.endsWith('/prelogin')) {
            return Response.json(NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'e2ee_password_unlock', kdf: prepared.envelope.kdf }));
        }
        return Response.json(NativeEmailPasswordUnlockResponseV1Schema.parse({
            envelope: prepared.envelope,
            expectedAccountId: 'account-a',
            challenge: issuedChallenge,
        }));
    };

    const recovered = await recoverPasswordEnvelopeSecret({
        request,
        email: 'person@example.test',
        password: 'correct horse battery staple',
    });

    expect(recovered).toEqual(secret);
    expect(bodies.join('\n')).not.toContain('correct horse battery staple');
    recovered.fill(0);
});

it('rejects a wrong password without returning secret material', async () => {
    const secret = new Uint8Array(32).fill(23);
    const prepared = await preparePasswordCredentialMaterialV1({ password: 'right password value', secret });
    const request = async (path: string) => path.endsWith('/prelogin')
        ? Response.json(NativeEmailPasswordPreloginResponseV1Schema.parse({ v: 1, kind: 'e2ee_password_unlock', kdf: prepared.envelope.kdf }))
        : Response.json(NativeEmailPasswordUnlockResponseV1Schema.parse({
            envelope: prepared.envelope,
            expectedAccountId: 'account-a',
            challenge: issuedChallenge,
        }));

    await expect(recoverPasswordEnvelopeSecret({
        request,
        email: 'person@example.test',
        password: 'wrong password value',
    })).rejects.toThrow('password_authentication_failed');
});
