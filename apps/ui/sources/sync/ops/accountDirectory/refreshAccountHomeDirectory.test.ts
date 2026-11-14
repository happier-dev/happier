import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDirectoryHttpFixture } from './accountDirectoryTestFixtures';
import { refreshAccountHomeDirectory } from './refreshAccountHomeDirectory';
import { adoptHomeProfile, getActiveServerSnapshot, resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', () => ({ createServerFetchAtEndpoint: () => request }));
const realisticJWT = (subject: string) => `header.${btoa(JSON.stringify({ sub: subject }))}.signature`;

describe('refreshAccountHomeDirectory', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    let session: AccountDirectorySession;
    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `directory_refresh_${Date.now()}_${Math.random()}`;
        fixture = createDirectoryHttpFixture();
        fixture = { ...fixture, home: { ...fixture.home, homeServerIdentityId: 'srv_refresh_home',
            connectionDescriptor: { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_refresh_home' } } };
        fixture.state.homes = [fixture.home];
        fixture.state.preferredHomeServerIdentityId = fixture.home.homeServerIdentityId;
        request.mockReset();
        request.mockImplementation((path: string, init?: RequestInit) => fixture.request(fixture.service.endpointUrl, path, init));
        const target = { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId };
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: fixture.token });
        session = new AccountDirectorySession(target, { capability: fixture.service.capability });
    });
    afterEach(() => {
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('does not adopt cached Directory Homes after its credential has been replaced', async () => {
        fixture = { ...fixture, home: { ...fixture.home, homeServerIdentityId: 'srv_superseded_cached_home',
            connectionDescriptor: { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_superseded_cached_home' } } };
        fixture.state.homes = [fixture.home];
        fixture.state.preferredHomeServerIdentityId = fixture.home.homeServerIdentityId;
        expect((await session.refresh()).status).toBe('ready');
        await TokenStorage.accountDirectoryAuthCredentials.set(
            { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId },
            { token: realisticJWT('replacement-account') },
        );
        const result = await refreshAccountHomeDirectory(session);
        expect(result.reconciliation).toMatchObject({ kind: 'cancelled', adopted: [] });
        expect(resolveServerProfileForPortableIdentity(fixture.home.homeServerIdentityId).kind).toBe('missing');
        expect(request.mock.calls.filter(([path]) => path === '/v1/account-directory/homes')).toHaveLength(1);
    });

    it('adopts advisory metadata without changing focus or requesting enrollment', async () => {
        const focus = getActiveServerSnapshot();
        const result = await refreshAccountHomeDirectory(session);
        expect(result.reconciliation).toMatchObject({ kind: 'completed', adopted: [{ homeServerIdentityId: fixture.home.homeServerIdentityId }] });
        const resolved = resolveServerProfileForPortableIdentity(fixture.home.homeServerIdentityId);
        expect(resolved.kind).toBe('resolved');
        if (resolved.kind === 'resolved') expect(resolved.profile.descriptorProvenance).toBe('advisory-only');
        expect(getActiveServerSnapshot()).toMatchObject({ serverId: focus.serverId, serverUrl: focus.serverUrl, isSelectionExplicit: focus.isSelectionExplicit });
        expect(request.mock.calls.map(([path]) => path)).toEqual(['/v1/account-directory/homes', '/v1/account-directory/me']);
    });

    it('does not adopt a held response after cancellation', async () => {
        let release!: (response: Response) => void;
        let cancelled = false;
        request.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
        const result = refreshAccountHomeDirectory(session, { shouldCancel: () => cancelled });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        cancelled = true;
        release(await fixture.request(fixture.service.endpointUrl, '/v1/account-directory/homes'));
        expect((await result).reconciliation).toEqual({ kind: 'cancelled', adopted: [], failures: [] });
    });

    it('does not publish stale reconciliation after logout wins a held refresh', async () => {
        let release!: (response: Response) => void;
        request.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
        const refresh = refreshAccountHomeDirectory(session);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await session.logout();
        release(await fixture.request(fixture.service.endpointUrl, '/v1/account-directory/homes'));

        expect(await refresh).toMatchObject({
            status: 'idle',
            homes: [],
            reconciliation: { kind: 'not_run' },
        });
        expect(session.snapshot).toMatchObject({
            status: 'idle',
            homes: [],
            reconciliation: { kind: 'not_run' },
        });
        expect(resolveServerProfileForPortableIdentity(fixture.home.homeServerIdentityId).kind).toBe('missing');
    });

    it('reports unavailable snapshots without adoption', async () => {
        request.mockRejectedValueOnce(new Error('directory unavailable'));
        expect((await refreshAccountHomeDirectory(session)).reconciliation).toMatchObject({
            kind: 'snapshot_unavailable', snapshotStatus: 'error',
        });
    });

    it('does not let one cancelled caller suppress a concurrent valid refresh', async () => {
        let release!: (response: Response) => void;
        let cancelled = false;
        request.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
        const cancelledResult = refreshAccountHomeDirectory(session, { shouldCancel: () => cancelled });
        const validResult = refreshAccountHomeDirectory(session);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        cancelled = true;
        release(await fixture.request(fixture.service.endpointUrl, '/v1/account-directory/homes'));
        await cancelledResult;
        expect((await validResult).reconciliation).toMatchObject({ kind: 'completed', adopted: [{ homeServerIdentityId: fixture.home.homeServerIdentityId }] });
        expect(session.snapshot.status).toBe('ready');
        expect(request.mock.calls.filter(([path]) => path === '/v1/account-directory/homes')).toHaveLength(1);
    });

    it.each([0, 1])('continues independent entries after a real identity conflict at index %s', async (failedIndex) => {
        const homes = [0, 1].map((index) => {
            const identity = 'srv_refresh_partial_' + failedIndex + '_' + index;
            const url = 'https://refresh-' + failedIndex + '-' + index + '.test';
            return { ...fixture.home, homeServerIdentityId: identity, canonicalServerUrl: url, preferred: false,
                connectionDescriptor: { ...fixture.home.connectionDescriptor, homeServerIdentityId: identity, canonicalServerUrl: url, endpoints: [{ kind: 'https' as const, url }] } };
        });
        const conflicting = homes[failedIndex]!;
        await adoptHomeProfile({ source: 'qr', descriptor: { ...conflicting.connectionDescriptor, homeServerIdentityId: conflicting.homeServerIdentityId + '_actual' } });
        fixture.state.homes = homes;
        fixture.state.preferredHomeServerIdentityId = null;
        const result = await refreshAccountHomeDirectory(session);
        expect(result.reconciliation).toMatchObject({
            kind: 'partial',
            adopted: [{ homeServerIdentityId: homes[1 - failedIndex]!.homeServerIdentityId }],
            failures: [{ homeServerIdentityId: conflicting.homeServerIdentityId }],
        });
    });
});
