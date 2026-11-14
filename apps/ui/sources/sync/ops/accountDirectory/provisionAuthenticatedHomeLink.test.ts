import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { createDirectoryHttpFixture, toAccountDirectoryHomeWire } from './accountDirectoryTestFixtures';
import { provisionAuthenticatedHomeLink, revokeAuthenticatedHomeLink } from './provisionAuthenticatedHomeLink';

const boundary = vi.hoisted(() => ({ request: vi.fn(), acquire: vi.fn(), release: vi.fn(async () => {}) }));
vi.mock('@/sync/http/client', () => ({ createServerFetchAtEndpoint: () => boundary.request }));
vi.mock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({ acquireIrohHomeRuntimeOrigin: (...args: unknown[]) => boundary.acquire(...args) }));
vi.mock('@/utils/platform/desktopHost', () => ({
    desktopHostKind: () => 'tauri', isDesktopHost: () => true,
    invokeDesktopHost: vi.fn(async () => undefined),
}));
const realisticJWT = (subject: string) => `header.${btoa(JSON.stringify({ sub: subject }))}.signature`;

describe('provisionAuthenticatedHomeLink', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    let session: AccountDirectorySession;
    let homeStatus: number;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `directory_link_${Date.now()}_${Math.random()}`;
        boundary.request.mockReset();
        boundary.acquire.mockReset();
        boundary.release.mockClear();
        fixture = createDirectoryHttpFixture();
        homeStatus = 200;
        await TokenStorage.accountDirectoryAuthCredentials.set(
            { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { token: fixture.token },
        );
        session = new AccountDirectorySession(
            { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId },
            { capability: fixture.service.capability },
        );
        await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'qr' });
        await TokenStorage.setCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId }, { token: fixture.token });
        boundary.request.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account-directory/me') return json({
                v: 1, accountId: 'directory-subject', encryptionMode: 'plain', displayName: null, avatar: null, linkedAuthenticationMethods: [],
            });
            if (path.startsWith('/v1/account/directory-links/')) return json(homeStatus === 200 ? {
                v: 1, issuerServerIdentityId: fixture.service.serverIdentityId, issuerSubjectId: 'directory-subject',
                issuerSigningKeyId: fixture.service.capability.homeLoginAssertion.keyId,
                issuerSigningPublicKeyBase64Url: fixture.service.capability.homeLoginAssertion.publicKeyBase64Url,
            } : { error: 'invalid_request' }, homeStatus);
            if (path === '/v1/account-directory/private-labels/recipient-census') return json({ contentEncryptionMode: 'plain', recipients: [] });
            if (path.startsWith('/v1/account-directory/homes/')) return json(toAccountDirectoryHomeWire(fixture.home));
            return fixture.request(fixture.service.endpointUrl, path, init);
        });
    });
    afterEach(() => {
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });
    const input = () => ({
        session, homeServerIdentityId: fixture.home.homeServerIdentityId,
        issuerServerIdentityId: fixture.service.serverIdentityId, capability: fixture.service.capability,
    });

    it('publishes the Home trust link before its Directory entry', async () => {
        expect(await provisionAuthenticatedHomeLink(input())).toEqual({ kind: 'linked', homeServerIdentityId: fixture.home.homeServerIdentityId });
        expect(boundary.request.mock.calls.map(([path]) => path)).toEqual([
            '/v1/account-directory/me',
            '/v1/account/directory-links/' + fixture.service.serverIdentityId,
            '/v1/account-directory/me',
            '/v1/account-directory/private-labels/recipient-census',
            '/v1/account-directory/homes/' + fixture.home.homeServerIdentityId,
        ]);
    });

    it('refuses a different selected issuer before contacting either authority', async () => {
        expect(await provisionAuthenticatedHomeLink({ ...input(), issuerServerIdentityId: 'srv_other' })).toEqual({ kind: 'failed' });
        expect(boundary.request).not.toHaveBeenCalled();
    });

    it('fails closed for a missing Home without borrowing focused credentials', async () => {
        expect(await provisionAuthenticatedHomeLink({ ...input(), homeServerIdentityId: 'srv_missing' })).toEqual({ kind: 'unavailable', reason: 'home_profile_unavailable' });
        expect(boundary.request).not.toHaveBeenCalled();
    });

    it('reports relink-required without publishing the Directory entry', async () => {
        homeStatus = 409;
        expect(await provisionAuthenticatedHomeLink(input())).toEqual({ kind: 'relink_required', homeServerIdentityId: fixture.home.homeServerIdentityId });
        expect(boundary.request.mock.calls.some(([path]) => String(path).startsWith('/v1/account-directory/homes/'))).toBe(false);
    });

    it('revokes the Home trust link with the Home credential and never writes to the Account Service', async () => {
        boundary.request.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.startsWith('/v1/account/directory-links/')) {
                expect(init?.method).toBe('DELETE');
                return json({ v: 1, deleted: true, issuerServerIdentityId: fixture.service.serverIdentityId });
            }
            throw new Error(`Unexpected request ${path}`);
        });
        expect(await revokeAuthenticatedHomeLink({
            homeServerIdentityId: fixture.home.homeServerIdentityId,
            issuerServerIdentityId: fixture.service.serverIdentityId,
        })).toEqual({ kind: 'unlinked', homeServerIdentityId: fixture.home.homeServerIdentityId });
        expect(boundary.request.mock.calls.map(([path]) => path)).toEqual([
            '/v1/account/directory-links/' + fixture.service.serverIdentityId,
        ]);
    });

    it('fails closed when the Home has no stored credential instead of borrowing focused state', async () => {
        await TokenStorage.removeCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId });
        expect(await revokeAuthenticatedHomeLink({
            homeServerIdentityId: fixture.home.homeServerIdentityId,
            issuerServerIdentityId: fixture.service.serverIdentityId,
        })).toEqual({ kind: 'unavailable', reason: 'home_credentials_unavailable' });
        expect(boundary.request).not.toHaveBeenCalled();
    });

    it('does not publish a link after credential replacement while Home transport is acquired', async () => {
        const endpointId = 'c'.repeat(64);
        const descriptor = { ...fixture.home.connectionDescriptor, revision: 2, endpoints: [{ kind: 'iroh' as const, endpointId }] };
        await adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
        let release!: () => void;
        boundary.acquire.mockImplementation(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
            return { leaseId: 'link-test', endpointId, homeServerIdentityId: fixture.home.homeServerIdentityId,
                runtimeOrigin: 'http://127.0.0.1:54321', status: 'ready', release: boundary.release };
        });
        const result = provisionAuthenticatedHomeLink(input());
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await TokenStorage.accountDirectoryAuthCredentials.set(
            { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { token: realisticJWT('replacement-account') },
        );
        release();
        expect(await result).toMatchObject({ kind: 'failed' });
        expect(boundary.request.mock.calls.map(([path]) => path)).toEqual(['/v1/account-directory/me']);
        expect(boundary.release).toHaveBeenCalledOnce();
    });
});
