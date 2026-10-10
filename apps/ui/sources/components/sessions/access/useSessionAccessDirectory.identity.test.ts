import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useSessionAccessDirectory } from './useSessionAccessDirectory';
import type { SessionAccessCandidateRowModel } from './sessionAccessEditorTypes';

describe('shared directory viewer presentation', () => {
    it('prefers the scoped viewer profile to a generic audience name for that same person', () => {
        const principal = presentSharePrincipal({ ref: { kind: 'account', accountId: 'owner' }, viewerAccountId: 'owner', name: 'Person',
            profile: { firstName: 'Avery', lastName: 'Owner', username: null, avatarUrl: null } });
        expect(principal.displayName).toBe('Avery Owner');
        expect(principal.secondaryLabel).toBe(t('shareSheet.you'));
    });
    it('uses the safe display profile avatar when no separate audience avatar is supplied', () => {
        const principal = presentSharePrincipal({ ref: { kind: 'account', accountId: 'owner' }, viewerAccountId: 'owner',
            profile: { firstName: 'Avery', lastName: 'Owner', username: null, avatarUrl: 'https://directory-viewer.test/avery.png' } });
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
        } finally { home.dispose(); }
    });
});
