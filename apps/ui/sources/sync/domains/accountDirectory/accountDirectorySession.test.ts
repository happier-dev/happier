import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDirectorySession } from './accountDirectorySession';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDirectoryHttpFixture, toAccountDirectoryHomeWire } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', () => ({ createServerFetchAtEndpoint: () => request }));
const realisticJWT = (subject = 'account-directory') => `header.${btoa(JSON.stringify({ sub: subject }))}.signature`;

describe('AccountDirectorySession', () => {
    const fixture = createDirectoryHttpFixture();
    const wireHome = toAccountDirectoryHomeWire(fixture.home);
    const target = { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId };
    const createSession = (capability: unknown = fixture.service.capability) => new AccountDirectorySession(target, {
        // Malformed server capability is a real network boundary input.
        capability: capability as typeof fixture.service.capability,
    });
    const json = (body: unknown) => new Response(JSON.stringify(body));

    beforeEach(async () => {
        request.mockReset();
        request.mockImplementation((path: string, init?: RequestInit) => fixture.request(fixture.service.endpointUrl, path, init));
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: fixture.token });
    });

    it('retains equal reconciliation and account snapshots without notifying, while publishing changes', async () => {
        const session = createSession();
        const notify = vi.fn();
        const unsubscribe = session.subscribe(notify);
        try {
            const initial = session.snapshot;
            expect(session.recordReconciliation({ kind: 'not_run' })).toBe(initial);
            expect(notify).not.toHaveBeenCalled();
            session.recordReconciliation({ kind: 'snapshot_unavailable', snapshotStatus: 'stale', error: null });
            const reconciled = session.snapshot;
            session.recordReconciliation({ kind: 'snapshot_unavailable', snapshotStatus: 'stale', error: null });
            expect(session.snapshot).toBe(reconciled);
            expect(notify).toHaveBeenCalledTimes(1);
            const me = { v: 1, accountId: 'account-directory', encryptionMode: 'plain', displayName: 'Ada', avatar: null, linkedAuthenticationMethods: [] };
            request.mockImplementation(async () => json(me));
            await session.refreshAccount();
            const account = session.snapshot;
            await session.refreshAccount();
            expect(session.snapshot).toBe(account);
            expect(notify).toHaveBeenCalledTimes(2);
            request.mockImplementation(async () => json({ ...me, displayName: 'Changed' }));
            await session.refreshAccount();
            expect(session.snapshot.account?.displayName).toBe('Changed');
            expect(notify).toHaveBeenCalledTimes(3);
        } finally { unsubscribe(); }
    });

    it('disconnects only the selected identity at a reused URL', async () => {
        const other = { ...target, serverIdentityId: 'other-directory' };
        await TokenStorage.accountDirectoryAuthCredentials.set(other, { token: realisticJWT('other-directory') });
        await expect(createSession().logout()).resolves.toBe(true);
        expect(await TokenStorage.accountDirectoryAuthCredentials.get(target)).toBeNull();
        expect(await TokenStorage.accountDirectoryAuthCredentials.get(other)).toEqual({ token: realisticJWT('other-directory') });
    });

    it('deduplicates refresh and retains cached Homes during an outage', async () => {
        let release!: (response: Response) => void;
        request.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
        const session = createSession();
        const first = session.refresh();
        const second = session.refresh();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        release(json({ v: 1, homes: [wireHome], preferredHomeServerIdentityId: fixture.home.homeServerIdentityId }));
        await Promise.all([first, second]);
        expect(request.mock.calls.filter(([path]) => path === '/v1/account-directory/homes')).toHaveLength(1);
        expect(session.snapshot).toMatchObject({ status: 'ready', homes: [fixture.home] });
        request.mockRejectedValueOnce(new Error('offline'));
        expect(await session.refresh()).toMatchObject({ status: 'stale', homes: [fixture.home] });
    });

    it('reads who is signed in and keeps the last known identity when that read fails', async () => {
        const me = { v: 1, accountId: 'account-directory', encryptionMode: 'plain', displayName: 'Ada Lovelace', avatar: null,
            linkedAuthenticationMethods: [{ providerId: 'github', login: 'ada' }] };
        request.mockImplementation(async (path: string) => path === '/v1/account-directory/me'
            ? json(me)
            : json({ v: 1, homes: [wireHome], preferredHomeServerIdentityId: fixture.home.homeServerIdentityId }));
        const session = createSession();
        await session.refreshAccount();
        expect(session.snapshot.account).toEqual(me);
        // A directory refresh keeps the identity it did not read.
        expect(await session.refresh()).toMatchObject({ status: 'ready', homes: [fixture.home], account: me });

        request.mockImplementation(async () => { throw new Error('offline'); });
        await session.refreshAccount();
        expect(session.snapshot.account).toEqual(me);
    });

    it('keeps logout authoritative when an earlier refresh resolves late', async () => {
        let release!: (response: Response) => void;
        request.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
        const session = createSession();
        const refresh = session.refresh();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await session.logout();
        release(json({ v: 1, homes: [wireHome], preferredHomeServerIdentityId: null }));
        await refresh;
        expect(session.snapshot).toMatchObject({ status: 'idle', homes: [] });
    });

    it.each([undefined, { version: 1, homeDirectory: true }, { ...fixture.service.capability, version: 2 }])('fails closed on invalid capability %j', async (capability) => {
        const session = new AccountDirectorySession(target, { capability: capability as typeof fixture.service.capability });
        expect(await session.refresh()).toMatchObject({ status: 'unsupported' });
        expect(request).not.toHaveBeenCalled();
    });

    it('keeps Directory reading available without Home enrollment and refuses assertion mint', async () => {
        request.mockResolvedValueOnce(json({ v: 1, homes: [wireHome], preferredHomeServerIdentityId: fixture.home.homeServerIdentityId }));
        const session = createSession({ ...fixture.service.capability, homeEnrollment: false });
        expect(await session.refresh()).toMatchObject({ status: 'ready', homes: [fixture.home] });
        await expect(session.requestLoginAssertion(fixture.home.homeServerIdentityId, 'client-key')).rejects.toThrow();
        expect(request.mock.calls.filter(([path]) => path === '/v1/account-directory/homes')).toHaveLength(1);
    });

    it('does not publish or delete Directory metadata when the capability is absent', async () => {
        const session = createSession({ ...fixture.service.capability, homeDirectory: false });
        await expect(session.putHome(fixture.home)).rejects.toThrow();
        await expect(session.deleteHome(fixture.home.homeServerIdentityId)).rejects.toThrow();
        await expect(session.setPreferredHome(fixture.home.homeServerIdentityId)).rejects.toThrow();
        await expect(session.readHomeDescriptor(fixture.home.homeServerIdentityId)).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it('invalidates old sessions even when logout is followed by the same bearer', async () => {
        const session = createSession();
        const isCurrent = session.captureLifecycle();
        await TokenStorage.accountDirectoryAuthCredentials.logout(target);
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: fixture.token });
        expect(isCurrent()).toBe(false);
        await expect(session.readAccountSummary()).rejects.toThrow();
        await session.logout();
        expect(await TokenStorage.accountDirectoryAuthCredentials.get(target)).toEqual({ token: fixture.token });
        expect(request).not.toHaveBeenCalled();
    });
});
