import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args) }));
vi.mock('@/auth/accountDirectory/accountDirectoryCredentialStorage', () => ({
    normalizeAccountDirectoryEndpoint: (value: string) => value.replace(/\/$/, ''),
    accountDirectoryCredentialStorage: { get: vi.fn(async () => ({ token: 'directory-token' })) },
}));

const activeSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'focused', serverUrl: 'https://focused.test', generation: 1 })));
vi.mock('@/sync/domains/server/serverRuntime', () => ({ getActiveServerSnapshot: activeSnapshotMock }));

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('account directory client', () => {
    afterEach(() => {
        runtimeFetchMock.mockReset();
        activeSnapshotMock.mockClear();
        vi.resetModules();
    });

    it('targets the supplied Account Service endpoint and does not read focused Home state', async () => {
        runtimeFetchMock.mockResolvedValue(json({ v: 1, homes: [], preferredHomeServerIdentityId: null }));
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        const client = createAccountDirectoryClient('https://directory.test/');
        await expect(client.listHomes()).resolves.toEqual({ v: 1, homes: [], preferredHomeServerIdentityId: null });
        expect(String(runtimeFetchMock.mock.calls[0]?.[0])).toBe('https://directory.test/v1/account-directory/homes');
        expect(activeSnapshotMock).not.toHaveBeenCalled();
    });

    it('dedicated redemption request never sends Account Service bearer credentials', async () => {
        runtimeFetchMock.mockResolvedValue(json({ v: 1, outcome: 'authorized', homeServerIdentityId: 'srv_home1', sealedHomeTokenBase64Url: 'A'.repeat(43), issuedAtMs: 1, expiresAtMs: 120001 }));
        const { redeemHomeLoginAssertion } = await import('./accountDirectoryClient');
        await redeemHomeLoginAssertion('https://home.test', {
            v: 1,
            purpose: 'happier.home-login',
            issuerServerIdentityId: 'srv_dir1',
            issuerSubjectId: 'account-1',
            audienceHomeServerIdentityId: 'srv_home1',
            clientBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            issuedAtMs: 1,
            expiresAtMs: 120001,
            keyId: 'a'.repeat(64),
            signatureBase64Url: 'A'.repeat(86),
        });
        const init = runtimeFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(new Headers(init.headers).get('Authorization')).toBeNull();
    });

    it('rejects unknown descriptor fields and overlong assertion windows', async () => {
        const { HomeConnectionDescriptorV1Schema, HomeLoginAssertionV1Schema } = await import('./accountDirectoryClient');
        expect(HomeConnectionDescriptorV1Schema.safeParse({
            v: 1,
            homeServerIdentityId: 'home-1',
            canonicalServerUrl: 'https://home.test',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.test' }],
            unexpected: true,
        }).success).toBe(false);
        expect(HomeLoginAssertionV1Schema.safeParse({
            v: 1, purpose: 'happier.home-login', issuerServerIdentityId: 'd', issuerSubjectId: 'a',
            audienceHomeServerIdentityId: 'srv_h', clientBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', issuedAtMs: 0,
            expiresAtMs: 11 * 60 * 1000, keyId: 'kid', signatureBase64Url: 'sig',
        }).success).toBe(false);
    });
});
