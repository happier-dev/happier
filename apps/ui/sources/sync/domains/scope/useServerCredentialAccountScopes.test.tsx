import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import * as serverProfiles from '@/sync/domains/server/serverProfiles';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';

// Real TokenStorage and credential-change fan-out over the device secure-store boundary.
const signedIn: Array<Readonly<{ serverId: string; serverUrl: string }>> = [];

beforeEach(async () => {
    // Persisted profiles, not an alternate profile resolver: bulk and scalar
    // consumers must see the same local/portable correspondence.
    await seedPersistedHomeProfilesForTests({ activeServerId: 'home-a', profiles: [
        ...['home-a', 'home-b'].map(id => ({ id, name: id, serverUrl: `https://${id}.example.test`,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1 })),
        { id: 'local-home-b', serverIdentityId: 'srv_home_b', name: 'Portable Home B',
            serverUrl: 'https://portable-home-b.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
    ] });
});
afterEach(async () => {
    standardCleanup();
    for (const home of signedIn.splice(0)) await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId });
    storage.setState(storage.getInitialState(), true);
});

function homeUrl(serverId: string): string {
    return serverId === 'srv_home_b' ? 'https://portable-home-b.example.test' : `https://${serverId}.example.test`;
}

/** Stores (or replaces) that Home's credential; replacement publishes the credential mutation. */
async function signIn(serverId: string, accountId: string): Promise<void> {
    const home = { serverId, serverUrl: homeUrl(serverId) };
    expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId }, {
        token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    })).toBe(true);
    signedIn.push(home);
}

describe('useServerCredentialAccountScopes', () => {
    it('keeps credential custody through Home label publications and still retires it when that Home is removed', async () => {
        await signIn('home-a', 'account-a');
        const { useServerCredentialAccountScopes } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopes(['home-a']));
        await vi.waitFor(() => expect(hook.getCurrent().get('home-a')?.accountId).toBe('account-a'));
        const binding = hook.getCurrent().get('home-a')!;
        const retired = vi.fn();
        binding.onRetire(retired);
        await act(async () => { await serverProfiles.upsertServerProfile({ serverUrl: 'https://home-a.example.test', name: 'Renamed Home' }); });
        expect(binding.isCurrent()).toBe(true);
        expect(hook.getCurrent().get('home-a')).toBe(binding);
        expect(retired).not.toHaveBeenCalled();
        await act(async () => { await serverProfiles.removeServerProfile('home-a'); });
        expect(binding.isCurrent()).toBe(false);
        expect(retired).toHaveBeenCalledOnce();
    });
    it('renders a single-Home consumer twice from mount to bound: the resolving state is not a republish', async () => {
        await signIn('home-a', 'account-a');
        const { useServerCredentialAccountScopeBinding } = await import('./useServerCredentialAccountScopes');
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useServerCredentialAccountScopeBinding('home-a');
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().binding?.accountId).toBe('account-a'));
            // Mount (resolving) and bound. A third render would be the same resolving state republished
            // as a fresh object, multiplied by every row of a picker that reads the scope.
            expect(renders).toBe(2);
        } finally { await hook.unmount(); }
    });
    it('does not reacquire the profile resolver per entry on unchanged credential-scope renders', async () => {
        await signIn('home-a', 'account-a');
        await signIn('home-b', 'account-b');
        const { useServerCredentialAccountScopes } = await import('./useServerCredentialAccountScopes');
        const ids = Array.from({ length: 100 }, (_, index) => index % 2 ? 'home-a' : 'home-b');
        const hook = await renderHook(() => useServerCredentialAccountScopes(ids));
        await vi.waitFor(() => expect(hook.getCurrent().size).toBe(2));
        const resolve = vi.spyOn(serverProfiles, 'resolveServerProfileScopeIdForIdentifier');
        try {
            for (let index = 0; index < 3; index++) await hook.rerender();
            expect(resolve).not.toHaveBeenCalled();
        } finally { resolve.mockRestore(); await hook.unmount(); }
    });
    it('keeps a destination Find seed after its Search source closes, then clears it on Home Account retirement', async () => {
        await signIn('home-b', 'account-b');
        const { useServerCredentialAccountScopes } = await import('./useServerCredentialAccountScopes');
        const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
        const destination = { host: 'project' as const, id: 'project-b', accountId: 'account-b', path: 'src/a.ts',
            scope: { serverId: 'home-b', machineId: 'machine-b', rootPath: '/repo' } };
        const seed = { query: 'needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: destination.path } };
        function Source() {
            const sourceBindings = useServerCredentialAccountScopes(['home-b']);
            const pane = useAppPaneContext();
            const source = sourceBindings.get('home-b');
            const authority = pane.fileFindSeedAccountBindings.get('home-b');
            React.useEffect(() => {
                if (source?.isCurrent() && authority?.isCurrent()) pane.fileFindSeedHandoff.stage(destination, seed, authority);
            }, [source, authority, pane.fileFindSeedHandoff]);
            return null;
        }
        function Probe() { return React.createElement('FindAuthorityProbe', { handoff: useAppPaneContext().fileFindSeedHandoff }); }
        const frame = (sourceVisible: boolean) => React.createElement(AppPaneProvider, null,
            sourceVisible ? React.createElement(Source) : null, React.createElement(Probe));
        const screen = await renderScreen(frame(true));
        const handoff = screen.root.findByType('FindAuthorityProbe').props.handoff as ReturnType<typeof useAppPaneContext>['fileFindSeedHandoff'];
        await vi.waitFor(() => expect(handoff.peek(destination)).toEqual(seed));
        await screen.update(frame(false));
        expect(handoff.peek(destination)).toEqual(seed);
        await act(async () => {
            await TokenStorage.removeCredentialsForServerUrl(homeUrl('home-b'), { serverId: 'home-b' });
            expect(handoff.peek(destination)).toBeNull();
        });
    });
    it('resolves each Home Account from that Home credential and immediately retires it on mutation', async () => {
        await signIn('home-a', 'account-a');
        await signIn('home-b', 'account-b');
        const { useServerCredentialAccountScopes } = await import('./useServerCredentialAccountScopes');
        const hook = await renderHook(() => useServerCredentialAccountScopes(['home-a', 'home-b']));

        await vi.waitFor(() => expect(hook.getCurrent().get('home-b')?.accountId).toBe('account-b'));
        const oldBinding = hook.getCurrent().get('home-b')!;
        let retired = false;
        oldBinding.onRetire(() => { retired = true; });
        storage.setState((state) => ({
            ...state,
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId, 'home-b': {} },
            sessionListIndexByServerId: { ...state.sessionListIndexByServerId, 'home-b': [] },
        }));

        await act(async () => {
            await signIn('home-b', 'account-b-next');
            expect(oldBinding.isCurrent()).toBe(false);
            expect(retired).toBe(true);
        });

        await vi.waitFor(() => expect(hook.getCurrent().get('home-b')?.accountId).toBe('account-b-next'));
        expect(storage.getState().sessionListRowsByServerId['home-b']).toBeUndefined();
        expect(storage.getState().sessionListIndexByServerId['home-b']).toBeUndefined();
        expect(hook.getCurrent().get('home-a')?.accountId).toBe('account-a');
    });

    it('retires that Home Team and Group rows with the credential that authorized them', async () => {
        await signIn('home-b', 'account-b');
        const { useServerCredentialAccountScopes } = await import('./useServerCredentialAccountScopes');
        const {
            applyTeamGroupsPage,
            getTeamGroupsSnapshot,
            resetTeamsSnapshotsForTests,
        } = await import('@/sync/store/teams/teamsSnapshots');
        const { createServerAccountScope } = await import('./serverAccountScope');
        const { createTeamAddress } = await import('@/sync/domains/teams/teamAddress');
        const { teamGroupsQueryKeyV1, NO_TEAM_GROUP_CAPABILITIES_V1 } = await import('@happier-dev/protocol/teams');
        // The engine is the effectful owner that retires these rows, and every
        // Teams surface reaches the store through it; importing it here is the
        // same wiring production has rather than a test-only subscription.
        const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');

        resetTeamsDirectoryEngineForTests();
        resetTeamsSnapshotsForTests();
        const hook = await renderHook(() => useServerCredentialAccountScopes(['home-b']));
        await vi.waitFor(() => expect(hook.getCurrent().get('home-b')?.accountId).toBe('account-b'));

        const scope = createServerAccountScope('home-b', 'account-b')!;
        const address = createTeamAddress('home-b', 'team-1')!;
        const key = teamGroupsQueryKeyV1({ v: 1, teamId: 'team-1', archived: 'active' });
        applyTeamGroupsPage({
            scope,
            address,
            queryKey: key,
            items: [{
                v: 1,
                id: 'g1',
                teamId: 'team-1',
                name: 'Developers',
                description: null,
                archivedAt: null,
                memberCount: 1,
                management: { kind: 'native' },
                capabilities: NO_TEAM_GROUP_CAPABILITIES_V1,
            }],
            nextCursor: null,
            observedAt: 1,
        });
        expect(getTeamGroupsSnapshot(scope, address, key)?.data).toHaveLength(1);

        await act(async () => {
            await signIn('home-b', 'account-b-next');
            // These rows were readable only because that credential authorized
            // them. Leaving them behind would outlive the credential and let a
            // replacing Account read the previous one's Teams and Groups.
            expect(getTeamGroupsSnapshot(scope, address, key)).toBeNull();
        });

        resetTeamsSnapshotsForTests();
    });

    it('keys a local profile request and its credential lookup by portable server identity', async () => {
        await signIn('srv_home_b', 'account-b');
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        try {
            const { useServerCredentialAccountScopes } = await import('./useServerCredentialAccountScopes');
            const hook = await renderHook(() => useServerCredentialAccountScopes(['local-home-b']));

            await vi.waitFor(() => expect(hook.getCurrent().get('srv_home_b')?.accountId).toBe('account-b'));
            expect(hook.getCurrent().has('local-home-b')).toBe(false);
            const lookupKeys = credentialRead.mock.calls.map(([, options]) => options?.serverId);
            expect(lookupKeys).toContain('srv_home_b');
            expect(lookupKeys).not.toContain('local-home-b');
        } finally { credentialRead.mockRestore(); }
    });
});
