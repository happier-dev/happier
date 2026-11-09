import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { teamGroupFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useSessionAccessDirectory } from './useSessionAccessDirectory';
import type { SessionAccessCandidateRowModel } from './sessionAccessEditorTypes';

describe('shared directory viewer presentation', () => {
    it('discovers Teams and Groups for a newly opened draft through the real Action front door', async () => {
        const releaseLoader = await installRealActionExecutorModuleLoader();
        const team = teamSummaryFixture();
        const group = teamGroupFixture();
        const home = await serveAccountHomes({ homes: [{ key: 'draft', serverUrl: 'https://draft-directory.test', accountId: 'owner' }],
            route: request => request.path === '/v1/teams/list'
                ? Response.json({ items: [team], nextCursor: null })
                : request.path === '/v1/teams/groups/list'
                    ? Response.json({ items: [group], nextCursor: null }) : undefined,
        });
        try {
            const scope = { serverId: home.homes.draft!.id, accountId: 'owner' };
            const hook = await renderHook(({ enabled }: { enabled: boolean }) => useSessionAccessDirectory({ scope, enabled,
                availability: 'available', operations: {}, revision: 0, contextTeams: [] }), { initialProps: { enabled: false } });
            expect(home.requests.filter(request => request.path === '/v1/teams/list')).toHaveLength(0);
            await hook.rerender({ enabled: true });
            await vi.waitFor(() => expect(hook.getCurrent().activeTeamContexts).toEqual([expect.objectContaining({ teamId: team.id })]));
            let groups: readonly SessionAccessCandidateRowModel[] = [];
            await act(async () => {
                groups = await hook.getCurrent().sections.find(section => section.kind === 'group')!.resolveCandidates!('', new AbortController().signal);
            });
            expect(hook.getCurrent().sections.find(section => section.kind === 'team')!.candidates.map(row => row.principal.ref))
                .toEqual([{ kind: 'team', teamId: team.id }]);
            expect(groups.map(row => row.principal.ref)).toEqual([{ kind: 'group', teamId: team.id, groupId: group.id }]);
            expect(home.requests.filter(request => request.path === '/v1/teams/list')).toHaveLength(1);
            await hook.unmount();
        } finally { await home.dispose(); releaseLoader(); }
    });
    it('prefers the scoped viewer profile to a generic audience name for that same person', () => {
        const principal = presentSharePrincipal({ ref: { kind: 'account', accountId: 'owner' }, viewerAccountId: 'owner', name: 'Person',
            profile: { name: 'Avery Owner', firstName: 'Avery', lastName: 'Owner', username: null, avatarUrl: null } });
        expect(principal.displayName).toBe('Avery Owner');
        expect(principal.secondaryLabel).toBe(t('shareSheet.you'));
    });
    it('uses the safe display profile avatar when no separate audience avatar is supplied', () => {
        const principal = presentSharePrincipal({ ref: { kind: 'account', accountId: 'owner' }, viewerAccountId: 'owner',
            profile: { name: 'Avery Owner', firstName: 'Avery', lastName: 'Owner', username: null, avatarUrl: 'https://directory-viewer.test/avery.png' } });
        expect(principal.avatar?.imageUrl).toBe('https://directory-viewer.test/avery.png');
    });
    it('names the viewer through the captured Home profile and never borrows another Home profile', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'captured', serverUrl: 'https://directory-viewer.test', accountId: 'owner' },
            { key: 'other', serverUrl: 'https://directory-other-viewer.test', accountId: 'other-owner' }],
            route: request => request.path === '/v1/user/search' ? Response.json({ users: [{ id: 'owner', firstName: 'Remote',
                lastName: 'Owner', username: 'owner', avatar: null, bio: null, status: 'none', publicKey: null }], nextCursor: null }) : undefined,
        });
        try {
            const scope = { serverId: home.homes.captured!.id, accountId: 'owner' };
            getStorage().setState({ profileScope: { serverId: home.homes.other!.id, accountId: 'other-owner' },
                profile: AccountProfileSchema.parse({ id: 'other-owner', firstName: 'Wrong', lastName: 'Person' }) });
            const hook = await renderHook(() => useSessionAccessDirectory({ scope, enabled: true, availability: 'unavailable',
                operations: {}, revision: 0, contextTeams: [], principalKinds: ['account'] }));
            const resolve = async () => {
                let rows: readonly SessionAccessCandidateRowModel[] = [];
                await act(async () => { rows = await hook.getCurrent().sections[0].resolveCandidates!('owner', new AbortController().signal); });
                return rows;
            };
            expect((await resolve())[0].principal).toMatchObject({ displayName: 'Remote Owner', secondaryLabel: t('shareSheet.you') });
            await act(async () => { getStorage().setState({ profileScope: scope,
                profile: AccountProfileSchema.parse({ id: 'owner' }) }); });
            expect((await resolve())[0].principal).toMatchObject({ displayName: 'Remote Owner', secondaryLabel: t('shareSheet.you') });
            await act(async () => { getStorage().setState({ profileScope: scope,
                profile: AccountProfileSchema.parse({ id: 'owner', firstName: 'Avery', lastName: 'Owner',
                    avatar: { path: '/avery.png', url: 'https://directory-viewer.test/avery.png' } }) }); });
            expect((await resolve())[0].principal).toMatchObject({ displayName: 'Avery Owner', secondaryLabel: t('shareSheet.you'),
                avatar: { imageUrl: 'https://directory-viewer.test/avery.png' } });
            await act(async () => { getStorage().setState({ profileScope: scope,
                profile: AccountProfileSchema.parse({ id: 'owner' }) }); });
            expect((await resolve())[0].principal).toMatchObject({ displayName: 'Remote Owner', secondaryLabel: t('shareSheet.you') });
            expect(home.requests.filter(request => request.path === '/v1/user/search')).toHaveLength(1);
            expect(home.requests.filter(request => request.path === '/v1/user/search').every(request => request.home === 'captured')).toBe(true);
            await hook.unmount();
        } finally { await home.dispose(); }
    });
});
