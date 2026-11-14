import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { UserProfileSchema } from '@happier-dev/protocol/social/friends';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { serveAccountHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';
import { standardCleanup } from '@/dev/testkit';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { TokenStorage, type HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { useDiscussionParticipantProfiles } from './useDiscussionParticipantProfiles';

afterEach(standardCleanup);

function requestedPeople(request: ServedHomeRequest): string[] {
    const body = request.body;
    if (!body || typeof body !== 'object' || !('ids' in body) || !Array.isArray(body.ids)
        || !body.ids.every((id): id is string => typeof id === 'string')) throw new Error('invalid_people_batch');
    return body.ids;
}

function usePeople(input: Omit<Parameters<typeof useDiscussionParticipantProfiles>[0], 'accountLifetime'>) {
    const bindings = useServerCredentialAccountScopeBindings([input.scope.serverId]);
    return useDiscussionParticipantProfiles({ ...input, accountLifetime: bindings.get(input.scope.serverId) ?? null });
}

function roster(ownerAccountId: string) {
    return DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'discussion-1', ownerAccountId, access: 'view', participants: [],
        grants: [{ principal: { kind: 'account', accountId: 'collaborator' }, accessLevel: 'edit',
            createdByAccountId: ownerAccountId, createdAt: 1, display: { name: 'Roster Name', username: 'colleague' } }],
    });
}

describe('useDiscussionParticipantProfiles', () => {
    it('resolves receipt actor ids without a Discussion and uses the shared withheld-name fallback', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'captured', serverUrl: 'https://receipt-people.test', accountId: 'viewer' }],
            route: request => request.path === '/v1/user/profiles' ? Response.json({ users: requestedPeople(request)
                .filter(id => id !== 'withheld').map(id => ({ id, name: 'Ana', firstName: '', lastName: null,
                    username: '', avatar: null, bio: null, status: 'none', publicKey: null })) }) : undefined });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'viewer' };
            const hook = await renderHook(() => usePeople({ scope, roster: null,
                accountIds: ['actor', 'withheld', 'actor'], enabled: true }));
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(resolveAccountActorPresentation(hook.getCurrent().accounts.get('actor')!, scope).name).toBe('Ana');
            expect(resolveAccountActorPresentation(hook.getCurrent().accounts.get('withheld')!, scope).name)
                .toBe(t('message.accountActorFormerMember'));
            expect(home.requests.filter(request => request.path === '/v1/user/profiles').map(requestedPeople))
                .toEqual([['actor', 'withheld']]);
            await hook.unmount();
        } finally { await home.dispose(); }
    });
    it('lets the explicit roster relationship override a retained summary profile and removes the former avatar', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'captured', serverUrl: 'https://discussion-former-people.test', accountId: 'viewer' }],
            route: () => undefined });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'viewer' };
            const retainedProfile = { name: 'Retained Person', firstName: 'Retained', lastName: 'Person',
                username: 'retained', avatarUrl: 'https://discussion-former-people.test/retained.png' };
            const people = DiscussionParticipantsListResponseV1Schema.parse({ ...roster('owner'), accountActors: [
                { v: 1, accountId: 'owner', accessibility: 'current', profile: null },
                { v: 1, accountId: 'collaborator', accessibility: 'former', profile: retainedProfile },
            ] });
            const participantAccounts = [SessionMessageAccountActorV1Schema.parse({ v: 1, accountId: 'collaborator',
                accessibility: 'current', profile: retainedProfile })];
            const hook = await renderHook(() => usePeople({ scope, roster: people, participantAccounts, enabled: true }));

            const actor = hook.getCurrent().accounts.get('collaborator');
            expect(actor?.accessibility).toBe('former');
            expect(resolveAccountActorPresentation(actor!, scope)).toMatchObject({
                name: t('message.accountActorFormerMember'), avatar: { imageUrl: null },
            });
            expect(home.requests.filter(request => request.path.startsWith('/v1/user/'))).toHaveLength(0);
            await hook.unmount();
        } finally { await home.dispose(); }
    });

    it('uses the complete profiles already admitted by the Discussion summary without per-person HTTP reads', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'captured', serverUrl: 'https://discussion-admitted-people.test', accountId: 'viewer' }],
            route: request => request.path === '/v1/user/profiles' ? Response.json({ users: requestedPeople(request).map(id => ({
                id: id, firstName: 'Scoped', lastName: id,
                username: 'person', avatar: { path: '/face.png', url: 'https://discussion-admitted-people.test/face.png' },
                bio: null, status: 'none', publicKey: null,
            })) }) : undefined });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'viewer' };
            const people = DiscussionParticipantsListResponseV1Schema.parse({ ...roster('owner'),
                grants: Array.from({ length: 4 }, (_, index) => ({ principal: { kind: 'account', accountId: `person-${index}` },
                    accessLevel: 'edit', createdByAccountId: 'owner', createdAt: 1, display: { name: `Scoped person-${index}`, username: 'person' } })),
            });
            const participantAccounts = ['owner', ...people.grants.flatMap(grant => grant.principal.kind === 'account' ? [grant.principal.accountId] : [])]
                .map(accountId => SessionMessageAccountActorV1Schema.parse({ v: 1, accountId, profile: {
                    name: `Scoped ${accountId}`, firstName: 'Scoped', lastName: accountId, username: 'person',
                    avatarUrl: 'https://discussion-admitted-people.test/face.png',
                } }));
            const input = { scope, roster: people, participantAccounts, enabled: true };
            const hook = await renderHook(({ participantAccounts }) => usePeople({ ...input, participantAccounts }),
                { initialProps: { participantAccounts } });
            await vi.waitFor(() => expect(hook.getCurrent().accounts.size).toBe(5));
            expect(hook.getCurrent().owner?.profile?.avatarUrl).toBe('https://discussion-admitted-people.test/face.png');
            const reads = home.requests.filter(request => request.path.startsWith('/v1/user/'));
            console.info('Discussion admitted-profile HTTP cost', reads.length);
            expect(reads.length).toBe(0);
            await hook.rerender({ participantAccounts: participantAccounts.map(actor => actor.accountId === 'owner'
                ? { ...actor, profile: null } : actor) });
            expect(hook.getCurrent().owner?.profile).toBeNull();
            expect(home.requests.filter(request => request.path.startsWith('/v1/user/')).length).toBe(0);
            await hook.unmount();
        } finally { await home.dispose(); }
    });

    it('resolves the owner and humans from the captured Home without borrowing the same Account on another Home', async () => {
        const home = await serveAccountHomes({
            homes: [{ key: 'captured', serverUrl: 'https://discussion-people.test', accountId: 'viewer' },
                { key: 'focused', serverUrl: 'https://discussion-other-people.test', accountId: 'owner' }],
            route: request => request.path === '/v1/user/profiles' ? Response.json({ users: requestedPeople(request).map(id => ({
                id: id, firstName: 'Captured', lastName: 'Person', username: 'person',
                avatar: { path: '/face.png', url: 'https://discussion-people.test/face.png' },
                bio: null, status: 'none', publicKey: null,
            })) }) : undefined,
        });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'viewer' };
            const wrongScope = { serverId: home.homes.focused!.id, accountId: 'owner' };
            getStorage().setState({ profileScope: wrongScope,
                profile: AccountProfileSchema.parse({ id: 'owner', firstName: 'Wrong', lastName: 'Home' }) });
            getStorage().getState().applyUsers({ owner: UserProfileSchema.parse({ id: 'owner', name: 'Wrong Home Cache',
                firstName: '', lastName: null, username: '', avatar: null, bio: null, status: 'none', publicKey: null }) });
            const people = roster('owner');
            const hook = await renderHook(() => usePeople({ scope, roster: people, enabled: true }));
            await vi.waitFor(() => expect(hook.getCurrent().owner?.profile?.name).toBe('Captured Person'));
            expect(hook.getCurrent().owner).toMatchObject({ serverId: scope.serverId, accountId: 'owner',
                profile: { name: 'Captured Person', avatarUrl: 'https://discussion-people.test/face.png' } });
            expect(hook.getCurrent().accounts.get('collaborator')?.profile?.avatarUrl).toBe('https://discussion-people.test/face.png');
            expect(resolveAccountActorPresentation(hook.getCurrent().owner!, wrongScope)).toMatchObject({ isSelf: false, name: 'Captured Person' });
            expect(home.requests.filter(request => request.path.startsWith('/v1/user/')).map(request => request.home)).toEqual(['captured']);
            await hook.unmount();
        } finally { await home.dispose(); }
    });

    it('reuses only the exact Home Account cache without a People request', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'captured', serverUrl: 'https://discussion-cached-people.test', accountId: 'viewer' }],
            route: () => undefined });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'viewer' };
            getStorage().getState().applyUsers({ colleague: UserProfileSchema.parse({ id: 'colleague', name: 'Cached Colleague',
                firstName: '', lastName: null, username: '', avatar: null, bio: null, status: 'none', publicKey: null }) });
            const hook = await renderHook(() => usePeople({ scope, roster: null, accountIds: ['colleague'], enabled: true }));
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
            expect(hook.getCurrent().accounts.get('colleague')?.profile?.name).toBe('Cached Colleague');
            expect(home.requests.filter(request => request.path.startsWith('/v1/user/'))).toHaveLength(0);
            await hook.unmount();
        } finally { await home.dispose(); }
    });

    it('keeps missing owner profiles distinct from unnamed members and overlays only the exact viewer profile', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'captured', serverUrl: 'https://discussion-viewer-profile.test', accountId: 'viewer' }],
            route: request => request.path === '/v1/user/profiles'
                ? Response.json({ users: requestedPeople(request).filter(id => id !== 'missing').map(id => ({ id,
                    firstName: '', lastName: null, username: '', avatar: null, bio: null, status: 'none', publicKey: null })) }) : undefined });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'viewer' };
            const hook = await renderHook(({ owner }) => usePeople({ scope, roster: roster(owner), enabled: true }),
                { initialProps: { owner: 'missing' } });
            await vi.waitFor(() => expect(hook.getCurrent().owner?.accountId).toBe('missing'));
            expect(hook.getCurrent().owner).toMatchObject({ accountId: 'missing', profile: null });
            expect(resolveAccountActorPresentation(hook.getCurrent().owner!, scope).name).toBe(t('message.accountActorFormerMember'));
            await hook.rerender({ owner: 'unnamed' });
            await vi.waitFor(() => expect(hook.getCurrent().owner?.accountId).toBe('unnamed'));
            expect(resolveAccountActorPresentation(hook.getCurrent().owner!, scope).name).toBe(t('message.accountActorUnnamedMember'));
            await act(async () => { getStorage().setState({ profileScope: scope,
                profile: AccountProfileSchema.parse({ id: 'viewer', firstName: 'Scoped', lastName: 'Viewer',
                    avatar: { path: '/viewer.png', url: 'https://discussion-viewer-profile.test/viewer.png' } }) }); });
            await hook.rerender({ owner: 'viewer' });
            expect(hook.getCurrent().owner?.profile).toMatchObject({ name: 'Scoped Viewer', avatarUrl: 'https://discussion-viewer-profile.test/viewer.png' });
            expect(resolveAccountActorPresentation(hook.getCurrent().owner!, scope).isSelf).toBe(true);
            await hook.unmount();
        } finally { await home.dispose(); }
    });

    it('hides a retired same-Account binding and discards its late profile result after credential renewal', async () => {
        let ownerReads = 0;
        let releaseRetired: ((value: Response) => void) | undefined;
        let retiredSignal: AbortSignal | null | undefined;
        const home = await serveAccountHomes({ homes: [
            { key: 'captured', serverUrl: 'https://discussion-profile-renewal.test', accountId: 'viewer' },
            { key: 'focused', serverUrl: 'https://discussion-profile-renewal-other.test', accountId: 'other' },
        ], route: request => {
            if (request.path !== '/v1/user/profiles') return undefined;
            const ids = requestedPeople(request);
            if (ids.includes('owner') && ++ownerReads === 2) {
                retiredSignal = request.signal;
                return new Promise<Response>(resolve => { releaseRetired = resolve; });
            }
            return Response.json({ users: ids.map(id => ({ id, firstName: ownerReads >= 3 ? 'Fresh' : 'Old', lastName: 'Owner', username: 'owner',
                avatar: null, bio: null, status: 'none', publicKey: null })) });
        } });
        const rollbacks: HomeCredentialWriteRollback[] = [];
        try {
            const target = home.homes.captured!;
            const scope: ServerAccountScope = { serverId: target.id, accountId: 'viewer' };
            const people = roster('owner');
            const hook = await renderHook(() => usePeople({ scope, roster: people, enabled: true }));
            await vi.waitFor(() => expect(hook.getCurrent().owner?.profile?.name).toBe('Old Owner'));
            const rotate = async (signature: string) => {
                await act(async () => {
                    const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer' })).toString('base64url')}.${signature}`;
                    const rollback = await TokenStorage.setCredentialsForServerUrlWithRollback(target.serverUrl, { serverId: target.id }, { token });
                    if (!rollback) throw new Error('Credential renewal did not persist');
                    rollbacks.push(rollback);
                });
            };
            await rotate('renewal-one');
            expect(hook.getCurrent().owner).toBeNull();
            await vi.waitFor(() => expect(releaseRetired).toBeDefined());
            await rotate('renewal-two');
            await vi.waitFor(() => expect(hook.getCurrent().owner?.profile?.name).toBe('Fresh Owner'));
            expect(retiredSignal?.aborted).toBe(true);
            await act(async () => { releaseRetired!(Response.json({ users: [{ id: 'owner', firstName: 'Retired', lastName: 'Owner',
                username: 'owner', avatar: null, bio: null, status: 'none', publicKey: null }] })); });
            expect(hook.getCurrent().owner?.profile?.name).toBe('Fresh Owner');
            await hook.unmount();
        } finally {
            releaseRetired?.(Response.json({ error: 'gone' }, { status: 404 }));
            for (const rollback of rollbacks.reverse()) await rollback.rollback();
            await home.dispose();
        }
    });
});
