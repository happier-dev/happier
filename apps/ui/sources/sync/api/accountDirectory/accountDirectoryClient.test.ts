import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeCredentialDestinationDigestV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { toAccountDirectoryHomeWire } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';

const endpointFetchMock = vi.hoisted(() => vi.fn());
const createServerFetchAtEndpointMock = vi.hoisted(() => vi.fn(() => endpointFetchMock));
vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: createServerFetchAtEndpointMock,
}));

const activeSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'focused', serverUrl: 'https://focused.test', generation: 1 })));
vi.mock('@/sync/domains/server/serverRuntime', () => ({ getActiveServerSnapshot: activeSnapshotMock }));

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const realisticJWT = (subject = 'account-directory') => `header.${btoa(JSON.stringify({ sub: subject }))}.signature`;
const plainLabelCensus = () => json({ contentEncryptionMode: 'plain', recipients: [] });
const plainDirectoryMe = () => json({
    v: 1, accountId: 'account-directory', encryptionMode: 'plain', displayName: null, avatar: null, linkedAuthenticationMethods: [],
});

describe('account directory client', () => {
    beforeEach(async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        for (const serverIdentityId of ['directory-new', 'srv_dir_1']) {
            await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: 'https://directory.test', serverIdentityId }, { token: realisticJWT() });
        }
    });
    afterEach(() => {
        endpointFetchMock.mockReset();
        createServerFetchAtEndpointMock.mockReset();
        createServerFetchAtEndpointMock.mockImplementation(() => endpointFetchMock);
        activeSnapshotMock.mockClear();
        vi.resetModules();
    });

    it('scopes credential lookup and transport to the selected Account Service identity', async () => {
        endpointFetchMock.mockResolvedValue(json({ v: 1, homes: [], preferredHomeServerIdentityId: null }));
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        const client = createAccountDirectoryClient({
            endpoint: 'https://directory.test',
            serverIdentityId: 'directory-new',
        });

        await client.listHomes();

        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith({
            endpointUrl: 'https://directory.test',
            serverId: 'directory-new',
            credentials: { token: realisticJWT() },
        });
    });

    it('targets the supplied Account Service endpoint and does not read focused Home state', async () => {
        endpointFetchMock.mockResolvedValue(json({ v: 1, homes: [], preferredHomeServerIdentityId: null }));
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        const client = createAccountDirectoryClient({ endpoint: 'https://directory.test/', serverIdentityId: 'srv_dir_1' });
        await expect(client.listHomes()).resolves.toEqual({ v: 1, homes: [], preferredHomeServerIdentityId: null });
        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith({
            endpointUrl: 'https://directory.test',
            serverId: 'srv_dir_1',
            credentials: { token: realisticJWT() },
        });
        const requestInit = endpointFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(new Headers(requestInit.headers).get('Authorization')).toBeNull();
        expect(endpointFetchMock.mock.calls[0]?.[0]).toBe('/v1/account-directory/homes');
        expect(endpointFetchMock.mock.calls[0]?.[2]).toEqual({ includeAuth: true, retry: 'none' });
        expect(activeSnapshotMock).not.toHaveBeenCalled();
    });

    it('never borrows a replacement credential for a client created under earlier custody', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        const target = { endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' };
        const original = createAccountDirectoryClient(target);
        const replacementToken = realisticJWT('replacement-account');
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: replacementToken });
        await expect(original.listHomes()).rejects.toThrow();
        expect(endpointFetchMock).not.toHaveBeenCalled();
        endpointFetchMock.mockResolvedValueOnce(json({ v: 1, homes: [], preferredHomeServerIdentityId: null }));
        expect(await createAccountDirectoryClient(target).listHomes()).toEqual({ v: 1, homes: [], preferredHomeServerIdentityId: null });
        expect(createServerFetchAtEndpointMock).toHaveBeenLastCalledWith(expect.objectContaining({ credentials: { token: replacementToken } }));
    });

    it('sends the strict versioned body required by directory deletion', async () => {
        endpointFetchMock.mockResolvedValue(json({
            v: 1,
            deleted: true,
            homeServerIdentityId: 'srv_home1',
            preferredHomeServerIdentityId: null,
        }));
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        await createAccountDirectoryClient({ endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' }).deleteHome('srv_home1');

        const init = endpointFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(init.method).toBe('DELETE');
        expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
        expect(JSON.parse(String(init.body))).toEqual({ v: 1 });
    });

    it('seals Plain Home label writes and opens the opaque response before returning the Home', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = `header.${btoa(JSON.stringify({ sub: 'directory-account' }))}.signature`;
        const target = { endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' };
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token });
        const connectionDescriptor = {
            v: 1 as const, homeServerIdentityId: 'srv_home1', canonicalServerUrl: 'https://destination.test',
            revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://destination.test' }],
        };
        const plainLabel = { content: { t: 'plain' as const, v: 'Private Home' }, recipients: [] };
        endpointFetchMock
            .mockResolvedValueOnce(plainDirectoryMe())
            .mockResolvedValueOnce(json({ contentEncryptionMode: 'plain', recipients: [] }))
            .mockResolvedValueOnce(json({
                v: 1, homeServerIdentityId: 'srv_home1', canonicalServerUrl: 'https://destination.test',
                connectionDescriptor, label: { content: plainLabel.content, recipientEnvelope: null },
                createdAtMs: 1, updatedAtMs: 1, preferred: false,
            }));
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        const result = await createAccountDirectoryClient(target).putHome({
            homeServerIdentityId: 'srv_home1', connectionDescriptor, label: 'Private Home',
        });
        expect(result.label).toBe('Private Home');
        expect(endpointFetchMock.mock.calls.map(call => call[0])).toEqual([
            '/v1/account-directory/me', '/v1/account-directory/private-labels/recipient-census', '/v1/account-directory/homes/srv_home1',
        ]);
        const sent = JSON.parse(String((endpointFetchMock.mock.calls[2]?.[1] as RequestInit).body));
        expect(sent).toEqual({ v: 1, connectionDescriptor, label: plainLabel });
    });

    it('publishes the exact destination descriptor with its durable frontier and mixed endpoints', async () => {
        const entry = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home1',
            canonicalServerUrl: 'https://destination.test',
            label: 'Moved Home',
            connectionDescriptor: {
                v: 1 as const,
                homeServerIdentityId: 'srv_home1',
                canonicalServerUrl: 'https://destination.test',
                revision: 27,
                endpoints: [
                    { kind: 'https' as const, url: 'https://destination.test' },
                    { endpointId: 'ab'.repeat(32), relayUrls: ['https://relay.test'], kind: 'iroh' as const },
                ],
            },
            createdAtMs: 1,
            updatedAtMs: 2,
            preferred: true,
        };
        const wireEntry = toAccountDirectoryHomeWire(entry);
        endpointFetchMock
            .mockResolvedValueOnce(plainDirectoryMe())
            .mockResolvedValueOnce(plainLabelCensus())
            .mockResolvedValueOnce(json(wireEntry))
            .mockResolvedValueOnce(json({ v: 1, homes: [wireEntry], preferredHomeServerIdentityId: 'srv_home1' }))
            .mockResolvedValueOnce(plainDirectoryMe());
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        const client = createAccountDirectoryClient({ endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' });

        await expect(client.publishHomeDescriptor({
            homeServerIdentityId: 'srv_home1',
            label: 'Moved Home',
            connectionDescriptor: entry.connectionDescriptor,
        })).resolves.toEqual({ kind: 'published', entry });
        await expect(client.readHomeDescriptor('srv_home1')).resolves.toEqual(entry);

        expect(endpointFetchMock.mock.calls[0]?.[0]).toBe('/v1/account-directory/me');
        expect(endpointFetchMock.mock.calls[1]?.[0]).toBe('/v1/account-directory/private-labels/recipient-census');
        expect(endpointFetchMock.mock.calls[2]?.[0]).toBe('/v1/account-directory/homes/srv_home1');
        expect(JSON.parse(String((endpointFetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
            v: 1,
            label: { content: { t: 'plain', v: 'Moved Home' }, recipients: [] },
            connectionDescriptor: entry.connectionDescriptor,
        });
        expect(endpointFetchMock.mock.calls[3]?.[0]).toBe('/v1/account-directory/homes');
    });

    it('preserves a publication refusal without retrying a different write shape', async () => {
        endpointFetchMock
            .mockResolvedValueOnce(plainDirectoryMe())
            .mockResolvedValueOnce(plainLabelCensus())
            .mockResolvedValueOnce(json({ error: 'invalid_request' }, 400));
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        const client = createAccountDirectoryClient({ endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' });

        await expect(client.publishHomeDescriptor({
            homeServerIdentityId: 'srv_home1',
            label: 'Moved Home',
            connectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home1', canonicalServerUrl: 'https://destination.test',
                revision: 8, endpoints: [{ kind: 'https', url: 'https://destination.test' }] },
        })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(3);
    });

    it('returns the newer authoritative descriptor when another publication already won', async () => {
        const currentEntry = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home1',
            canonicalServerUrl: 'https://newer.test',
            label: 'Moved Again',
            connectionDescriptor: {
                v: 1 as const,
                homeServerIdentityId: 'srv_home1',
                canonicalServerUrl: 'https://newer.test',
                revision: 9,
                endpoints: [{ kind: 'https' as const, url: 'https://newer.test' }],
            },
            createdAtMs: 1,
            updatedAtMs: 3,
            preferred: true,
        };
        endpointFetchMock
            .mockResolvedValueOnce(plainDirectoryMe())
            .mockResolvedValueOnce(plainLabelCensus())
            .mockResolvedValueOnce(json(toAccountDirectoryHomeWire(currentEntry)));
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');

        await expect(createAccountDirectoryClient({ endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' }).publishHomeDescriptor({
            homeServerIdentityId: 'srv_home1',
            label: 'Moved Home',
            connectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home1', canonicalServerUrl: 'https://destination.test',
                revision: 8, endpoints: [{ kind: 'https', url: 'https://destination.test' }] },
        })).resolves.toEqual({ kind: 'current', entry: currentEntry });
    });

    it('preserves the typed equal-revision conflict for authoritative readback recovery', async () => {
        endpointFetchMock
            .mockResolvedValueOnce(plainDirectoryMe())
            .mockResolvedValueOnce(plainLabelCensus())
            .mockResolvedValueOnce(json({ error: 'descriptor_revision_conflict' }, 409));
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');

        await expect(createAccountDirectoryClient({ endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' }).publishHomeDescriptor({
            homeServerIdentityId: 'srv_home1',
            label: 'Moved Home',
            connectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home1', canonicalServerUrl: 'https://destination.test',
                revision: 8, endpoints: [{ kind: 'https', url: 'https://destination.test' }] },
        })).rejects.toMatchObject({ status: 409, code: 'descriptor_revision_conflict' });
    });

    it('accepts only protocol-owned error codes from Account Directory responses', async () => {
        const { AccountDirectoryRequestError, createAccountDirectoryClient } = await import('./accountDirectoryClient');
        const client = createAccountDirectoryClient({ endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' });

        endpointFetchMock.mockResolvedValueOnce(json({ error: 'assertion_expired' }, 401));
        await expect(client.listHomes()).rejects.toMatchObject({
            name: 'AccountDirectoryRequestError',
            code: 'assertion_expired',
        });

        endpointFetchMock.mockResolvedValueOnce(json({ error: 'attacker_controlled_expired' }, 401));
        try {
            await client.listHomes();
            throw new Error('Expected request failure');
        } catch (error) {
            expect(error).toBeInstanceOf(AccountDirectoryRequestError);
            expect((error as InstanceType<typeof AccountDirectoryRequestError>).code).toBeUndefined();
        }
    });

    it('redeems against the selected runtime origin while retaining canonical Home identity', async () => {
        endpointFetchMock.mockResolvedValue(json({ v: 1, homeServerIdentityId: 'srv_home1', sealedHomeTokenBase64Url: 'A'.repeat(43), issuedAtMs: 1, expiresAtMs: 120001 }));
        const { redeemHomeLoginAssertion } = await import('./accountDirectoryClient');
        const { resolveHomeEnrollmentTransport } = await import('@/auth/enrollment/homeEnrollmentTransport');
        const resolved = await resolveHomeEnrollmentTransport({
            v: 1,
            canonicalServerUrl: 'https://home.internal.test',
            homeServerIdentityId: 'srv_home1',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.internal.test' }],
        }, { runtimeOrigin: 'https://public.home.test' });
        if (!resolved.ok) throw new Error('Expected Home transport');
        await redeemHomeLoginAssertion(resolved.transport, {
            v: 1,
            purpose: 'happier.home-login',
            issuerServerIdentityId: 'srv_dir1',
            issuerSubjectId: 'account-1',
            audienceHomeServerIdentityId: 'srv_home1',
            credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1({
                v: 1,
                canonicalServerUrl: 'https://home.internal.test',
                homeServerIdentityId: 'srv_home1',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://home.internal.test' }],
            }),
            clientBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            issuedAtMs: 1,
            expiresAtMs: 120001,
            keyId: 'a'.repeat(64),
            signatureBase64Url: 'A'.repeat(86),
        });
        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith({
            endpointUrl: 'https://home.internal.test',
            runtimeOrigin: 'https://public.home.test',
            serverId: 'srv_home1',
            credentials: null,
        });
        const init = endpointFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(new Headers(init.headers).get('Authorization')).toBeNull();
        expect(endpointFetchMock.mock.calls[0]?.[2]).toEqual({ includeAuth: false, retry: 'none' });
    });

    it('puts the Home directory link through the Home transport with full Home credentials and no relink', async () => {
        endpointFetchMock.mockResolvedValue(json({
            v: 1,
            issuerServerIdentityId: 'srv_dir1',
            issuerSubjectId: 'account-1',
            issuerSigningKeyId: 'a'.repeat(64),
            issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
        }));
        const { putHomeDirectoryLink } = await import('./accountDirectoryClient');
        const { resolveHomeEnrollmentTransport } = await import('@/auth/enrollment/homeEnrollmentTransport');
        const resolved = await resolveHomeEnrollmentTransport({
            v: 1,
            canonicalServerUrl: 'https://home.internal.test',
            homeServerIdentityId: 'srv_home1',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.internal.test' }],
        });
        if (!resolved.ok) throw new Error('Expected Home transport');
        await putHomeDirectoryLink(resolved.transport, {
            issuerServerIdentityId: 'srv_dir1',
            issuerSubjectId: 'account-1',
            issuerSigningKeyId: 'a'.repeat(64),
            issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
        }, { credentials: { token: 'home-token' } });

        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith({
            endpointUrl: 'https://home.internal.test',
            runtimeOrigin: 'https://home.internal.test',
            serverId: 'srv_home1',
            credentials: { token: 'home-token' },
        });
        expect(endpointFetchMock.mock.calls[0]?.[0]).toBe('/v1/account/directory-links/srv_dir1');
        const init = endpointFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(init.method).toBe('PUT');
        expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
        expect(JSON.parse(String(init.body))).toEqual({
            v: 1,
            issuerServerIdentityId: 'srv_dir1',
            issuerSubjectId: 'account-1',
            issuerSigningKeyId: 'a'.repeat(64),
            issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
            relink: false,
        });
        expect(endpointFetchMock.mock.calls[0]?.[2]).toEqual({ includeAuth: true, retry: 'none' });
    });

    it('sends relink only when an explicit caller opts into replacing pinned Home trust', async () => {
        endpointFetchMock.mockResolvedValue(json({
            v: 1,
            issuerServerIdentityId: 'srv_dir1',
            issuerSubjectId: 'account-1',
            issuerSigningKeyId: 'a'.repeat(64),
            issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
        }));
        const { putHomeDirectoryLink } = await import('./accountDirectoryClient');
        const { resolveHomeEnrollmentTransport } = await import('@/auth/enrollment/homeEnrollmentTransport');
        const resolved = await resolveHomeEnrollmentTransport({
            v: 1,
            canonicalServerUrl: 'https://home.internal.test',
            homeServerIdentityId: 'srv_home1',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.internal.test' }],
        });
        if (!resolved.ok) throw new Error('Expected Home transport');

        await putHomeDirectoryLink(resolved.transport, {
            issuerServerIdentityId: 'srv_dir1',
            issuerSubjectId: 'account-1',
            issuerSigningKeyId: 'a'.repeat(64),
            issuerSigningPublicKeyBase64Url: 'A'.repeat(43),
        }, { credentials: { token: 'home-token' }, relink: true });

        const init = endpointFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ relink: true }));
    });

    it('deletes the Home directory link through the Home transport with full Home credentials', async () => {
        endpointFetchMock.mockResolvedValue(json({ v: 1, deleted: true, issuerServerIdentityId: 'srv_dir1' }));
        const { deleteHomeDirectoryLink } = await import('./accountDirectoryClient');
        const { resolveHomeEnrollmentTransport } = await import('@/auth/enrollment/homeEnrollmentTransport');
        const resolved = await resolveHomeEnrollmentTransport({
            v: 1,
            canonicalServerUrl: 'https://home.internal.test',
            homeServerIdentityId: 'srv_home1',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.internal.test' }],
        });
        if (!resolved.ok) throw new Error('Expected Home transport');

        await expect(deleteHomeDirectoryLink(resolved.transport, 'srv_dir1', { credentials: { token: 'home-token' } }))
            .resolves.toEqual({ v: 1, deleted: true, issuerServerIdentityId: 'srv_dir1' });

        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith({
            endpointUrl: 'https://home.internal.test',
            runtimeOrigin: 'https://home.internal.test',
            serverId: 'srv_home1',
            credentials: { token: 'home-token' },
        });
        expect(endpointFetchMock.mock.calls[0]?.[0]).toBe('/v1/account/directory-links/srv_dir1');
        const init = endpointFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(init.method).toBe('DELETE');
        expect(JSON.parse(String(init.body))).toEqual({ v: 1 });
        expect(endpointFetchMock.mock.calls[0]?.[2]).toEqual({ includeAuth: true, retry: 'none' });
    });

    it('classifies only the exact Home link conflict as requiring explicit relink', async () => {
        const {
            AccountDirectoryRequestError,
            isAccountDirectoryRelinkConflict,
        } = await import('./accountDirectoryClient');

        expect(isAccountDirectoryRelinkConflict(
            new AccountDirectoryRequestError(409, 'invalid_request'),
        )).toBe(true);
        expect(isAccountDirectoryRelinkConflict(
            new AccountDirectoryRequestError(400, 'invalid_request'),
        )).toBe(false);
        expect(isAccountDirectoryRelinkConflict(
            new AccountDirectoryRequestError(409, 'directory_link_not_found'),
        )).toBe(false);
        expect(isAccountDirectoryRelinkConflict(new Error('conflict'))).toBe(false);
    });

    it('refuses a Plain recipient census for an E2EE Directory before disclosing a Home label', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
        const { encodeBase64 } = await import('@/encryption/base64');
        const target = { endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' };
        const token = realisticJWT('directory-e2ee-owner');
        const encryption = await createEncryptionFromAuthCredentials({
            token, secret: encodeBase64(new Uint8Array(32).fill(73), 'base64url'),
        });
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token }, {
            retainedContentKey: {
                publicKey: encodeBase64(encryption.contentDataKey, 'base64'),
                machineKey: encodeBase64(encryption.getContentPrivateKey(), 'base64'),
            },
        });
        const connectionDescriptor = {
            v: 1 as const, homeServerIdentityId: 'srv_private_home', canonicalServerUrl: 'https://private-home.test',
            revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://private-home.test' }],
        };
        const privateName = 'Private infrastructure label';
        endpointFetchMock.mockImplementation(async (path: string) => {
            if (path === '/v1/account-directory/me') return json({
                v: 1, accountId: 'directory-e2ee-owner', encryptionMode: 'e2ee', displayName: null,
                avatar: null, linkedAuthenticationMethods: [], recoveryKey: 'key_only',
            });
            if (path === '/v1/account-directory/private-labels/recipient-census') return plainLabelCensus();
            if (path === '/v1/account-directory/homes/srv_private_home') return json({
                v: 1, homeServerIdentityId: 'srv_private_home', canonicalServerUrl: 'https://private-home.test',
                connectionDescriptor, label: { content: { t: 'plain', v: privateName }, recipientEnvelope: null },
                createdAtMs: 1, updatedAtMs: 1, preferred: false,
            });
            throw new Error(`Unexpected Directory request: ${path}`);
        });
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        await expect(createAccountDirectoryClient(target).putHome({
            homeServerIdentityId: 'srv_private_home', connectionDescriptor, label: privateName,
        })).rejects.toMatchObject({ operation: 'home_label_sealing_unavailable' });
        expect(endpointFetchMock.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
            '/v1/account-directory/me', '/v1/account-directory/private-labels/recipient-census',
        ]));
        expect(endpointFetchMock.mock.calls.some(call => (call[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
        expect(endpointFetchMock.mock.calls.every(call => !String((call[1] as RequestInit | undefined)?.body).includes(privateName))).toBe(true);
    });

    it('refuses Plain Home label projections for the captured E2EE Directory Account', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
        const { encodeBase64 } = await import('@/encryption/base64');
        const target = { endpoint: 'https://directory.test', serverIdentityId: 'srv_dir_1' };
        const token = realisticJWT('directory-e2ee-owner');
        const encryption = await createEncryptionFromAuthCredentials({
            token, secret: encodeBase64(new Uint8Array(32).fill(73), 'base64url'),
        });
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token }, {
            retainedContentKey: {
                publicKey: encodeBase64(encryption.contentDataKey, 'base64'),
                machineKey: encodeBase64(encryption.getContentPrivateKey(), 'base64'),
            },
        });
        const homes = ['srv_private_home', 'srv_other_home'].map(homeServerIdentityId => ({
            v: 1, homeServerIdentityId, canonicalServerUrl: 'https://private-home.test',
            connectionDescriptor: { v: 1, homeServerIdentityId, canonicalServerUrl: 'https://private-home.test',
                revision: 1, endpoints: [{ kind: 'https', url: 'https://private-home.test' }] },
            label: { content: { t: 'plain', v: 'Injected plaintext label' }, recipientEnvelope: null },
            createdAtMs: 1, updatedAtMs: 1, preferred: false,
        }));
        endpointFetchMock.mockImplementation(async (path: string) => {
            if (path === '/v1/account-directory/homes') return json({
                v: 1, homes, preferredHomeServerIdentityId: null,
            });
            if (path === '/v1/account-directory/me') return json({
                v: 1, accountId: 'directory-e2ee-owner', encryptionMode: 'e2ee', displayName: null,
                avatar: null, linkedAuthenticationMethods: [], recoveryKey: 'key_only',
            });
            throw new Error(`Unexpected Directory request: ${path}`);
        });
        const { createAccountDirectoryClient } = await import('./accountDirectoryClient');
        await expect(createAccountDirectoryClient(target).listHomes())
            .rejects.toMatchObject({ operation: 'home_label_unavailable' });
        expect(endpointFetchMock.mock.calls.filter(call => call[0] === '/v1/account-directory/me')).toHaveLength(1);
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
