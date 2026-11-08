import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

// The network, browser storage and randomness are the boundaries; the key challenge,
// Directory credential custody and session construction run their real owners.
installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('account_service_key_auth');
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const generatedSecret = vi.hoisted(() => new Uint8Array(32).fill(9));
const getRandomBytesAsync = vi.hoisted(() => vi.fn(async () => generatedSecret.slice()));
vi.mock('@/platform/cryptoRandom', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/platform/cryptoRandom')>(),
    getRandomBytesAsync,
}));
const boundary = vi.hoisted(() => ({ request: vi.fn<(endpoint: string, path: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return boundary.request(url.origin, `${url.pathname}${url.search}`, init);
    },
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));

import { digestAccountDirectoryCredentialToken, TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountDirectoryServiceKey } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import {
    authenticateSelectedAccountServiceWithGeneratedKey,
    authenticateSelectedAccountServiceWithKey,
    authenticateSelectedAccountServiceWithPassword,
} from './accountDirectoryKeyAuth';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});

describe('supplied Account key operation', () => {
    let restoreStorage: () => void;
    let restoreLocks: () => void;
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;

    /** Serves the restricted Directory key challenge; `redeem` answers the signed assertion. */
    function serveKeyChallenge(redeem: () => Response) {
        const { service } = fixture;
        boundary.request.mockImplementation(async (endpoint, path, init) => {
            if (path === '/v1/auth/account-directory/challenge') return json({
                challengeId: 'directory-challenge', nonce: 'nonce', issuedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                audience: { origin: service.canonicalServerUrl, serverIdentityId: service.serverIdentityId },
            });
            if (path === '/v1/auth/account-directory') return redeem();
            return await fixture.request(endpoint, path, init);
        });
    }

    beforeEach(() => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        fixture = createDirectoryHttpFixture();
        boundary.request.mockReset();
        getRandomBytesAsync.mockClear();
    });
    afterEach(() => {
        restoreLocks();
        restoreStorage();
    });

    it('rejects malformed supplied material locally rather than probing or prompting for another key', async () => {
        expect(await authenticateSelectedAccountServiceWithKey({ service: fixture.service, secret: new Uint8Array(12) }))
            .toEqual({ kind: 'invalid_key' });
        expect(boundary.request).not.toHaveBeenCalled();
    });

    it('does no ceremony for an already aborted form submission', async () => {
        const abort = new AbortController();
        abort.abort();
        expect(await authenticateSelectedAccountServiceWithKey({ service: fixture.service, secret: new Uint8Array(32), signal: abort.signal }))
            .toEqual({ kind: 'cancelled' });
        expect(boundary.request).not.toHaveBeenCalled();
    });

    it('preserves relink recovery when a generated key is rejected by the exact authority', async () => {
        serveKeyChallenge(() => json({ error: 'invalid_request' }, 409));

        await expect(authenticateSelectedAccountServiceWithGeneratedKey({ service: fixture.service }))
            .resolves.toMatchObject({ kind: 'relink_required', error: { status: 409, code: 'invalid_request' } });

        expect(getRandomBytesAsync).toHaveBeenCalledWith(32);
    });

    it('authenticates a supplied key into a Directory session holding only the restricted credential', async () => {
        serveKeyChallenge(() => json({ token: 'directory-token' }));
        const { service } = fixture;
        const target = { endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId };

        const outcome = await authenticateSelectedAccountServiceWithKey({ service, secret: new Uint8Array(32).fill(7) });

        expect(outcome).toMatchObject({
            kind: 'authenticated',
            service,
            serviceKey: createAccountDirectoryServiceKey(target),
            credentialTokenDigest: await digestAccountDirectoryCredentialToken('directory-token'),
        });
        await expect(TokenStorage.accountDirectoryAuthCredentials.get(target)).resolves.toEqual({ token: 'directory-token' });
    });

    it('authenticates a Plain Account by email and password without holding an Account key', async () => {
        const { service } = fixture;
        const target = { endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId };
        boundary.request.mockImplementation(async (endpoint, path, init) => {
            if (path.endsWith('/prelogin')) return json({ v: 1, kind: 'plain_password' });
            if (path === '/v1/auth/email/login') {
                expect(JSON.parse(String(init?.body))).toMatchObject({ credentialTarget: 'account_directory' });
                return json({ token: 'directory-password-token' });
            }
            return await fixture.request(endpoint, path, init);
        });

        const outcome = await authenticateSelectedAccountServiceWithPassword({
            service, email: 'person@example.test', password: 'correct horse battery staple',
        });

        expect(outcome).toMatchObject({
            kind: 'authenticated',
            serviceKey: createAccountDirectoryServiceKey(target),
            credentialTokenDigest: await digestAccountDirectoryCredentialToken('directory-password-token'),
        });
        if (outcome.kind !== 'authenticated') return;
        expect(outcome.session.takeKeyAuthSecret()).toBeNull();
        await expect(TokenStorage.accountDirectoryAuthCredentials.get(target)).resolves.toEqual({ token: 'directory-password-token' });
    });
});
