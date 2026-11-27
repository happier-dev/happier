import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { CollectionSpacesV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { clearPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { selectCollectionSpace } from '@/sync/domains/session/listing/sessionListSpaces';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { admitHomeCredential } from '@/sync/runtime/orchestration/homeAccountChange';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionListViewFilterDefaults, buildSessionListSelectionScopeSignature } from './sessionListViewFilters';
import { useSessionListViewFilterController } from './useSessionListViewFilterController';
import {
    readRetainedSessionListPaneState,
    resetSessionListPaneRetentionForTests,
    retainSessionListPaneState,
} from '../sessionListPaneRetention';
import {
    clearSessionListViewFilterRetentionForTests,
    removeAuthoritativelyDeletedSessionListTagsForAccount,
} from './useSessionListViewFilters';

const harness = vi.hoisted(() => ({
    selection: {
        activeServerId: 'home-a',
        allowedServerIds: ['home-a', 'home-b'] as string[],
    },
    resolutions: new Map<string, { kind: 'bound'; scope: { serverId: string; accountId: string } } | { kind: 'resolving' }>(),
    requestedServerIds: [] as string[],
    hideInactiveSessions: false,
    accountScope: null as { serverId: string; accountId: string } | null,
    settingsVersion: null as number | null,
    spaceCatalog: { v: 1, spaces: [] } as CollectionSpacesV1,
}));


vi.mock('@/hooks/session/useSessionListSelectionState', () => ({
    useSessionListSelectionState: () => harness.selection,
}));
vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({ useServerProfilesGeneration: () => 1 }));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    // The canonical Home label reads the rest of the real profile owner.
    ...(await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>()),
    listServerProfiles: () => [
        { id: 'home-a', name: 'Home A' },
        { id: 'home-b', name: 'Home B' },
    ],
    resolveServerProfileScopeId: (profile: { id: string }) => profile.id,
}));
vi.mock('@/sync/domains/server/selection/serverSelectionProfileScopeIds', () => ({
    listServerProfileScopeIds: () => ['home-a', 'home-b'],
}));
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
    useSetting: (key: keyof typeof settingsDefaults) => key === 'collectionSpacesV1' ? harness.spaceCatalog
        : key === 'hideInactiveSessions' ? harness.hideInactiveSessions : settingsDefaults[key],
    useActiveServerAccountScope: () => harness.accountScope,
    useAccountSettingsScope: () => harness.accountScope,
    useSettingsVersion: () => harness.settingsVersion,
    useSettingsReady: () => harness.settingsVersion !== null,
}));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolutions: (serverIds: readonly string[]) => {
        harness.requestedServerIds = [...serverIds];
        return new Map([...harness.resolutions].filter(([serverId]) => serverIds.includes(serverId)));
    },
}));
vi.mock('@/sync/domains/session/listing/useSessionListQuerySourceState', () => ({
    useSessionListQueryHomeSupportByServerId: (serverIds: readonly string[]) => Object.fromEntries(serverIds.map((id) => [id, true])),
    useSessionListFeatureHomeSupportByServerId: (_featureId: string, serverIds: readonly string[]) => Object.fromEntries(serverIds.map((id) => [id, true])),
}));

afterEach(() => {
    standardCleanup();
    clearPersistenceStorage();
    resetSessionListPaneRetentionForTests();
    clearSessionListViewFilterRetentionForTests();
    harness.selection = { activeServerId: 'home-a', allowedServerIds: ['home-a', 'home-b'] };
    harness.resolutions = new Map();
    harness.requestedServerIds = [];
    harness.hideInactiveSessions = false;
    harness.accountScope = null;
    harness.settingsVersion = null;
    harness.spaceCatalog = { v: 1, spaces: [] };
});

function paneState() {
    return {
        summary: { sessionsReady: true, sessionCount: 2 },
        visibleSessionListIndex: [
            { type: 'session', serverId: 'home-a', sessionId: 'session-a' },
            { type: 'session', serverId: 'home-b', sessionId: 'session-b' },
        ],
        hasHiddenInactiveSessions: false,

        folderFeatureEnabledServerIds: [],
        showLoading: false,
        showEmptyState: false,
    } as const;
}

describe('useSessionListViewFilterController retention lifetime', () => {
    it('invalidates row-selection scope for every new narrowing field', () => {
        const filters = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] });
        const eligibility = { eligibleHomeServerIds: ['home-a'], eligibleAudiences: [], eligibleTagIds: [] };
        const original = buildSessionListSelectionScopeSignature(filters, eligibility);
        for (const changed of [
            { ...filters, machines: { include: [{ serverId: 'home-a', machineId: 'm1' }], exclude: [] } },
            { ...filters, agents: { include: ['codex'], exclude: [] } },
            { ...filters, branches: { include: ['main'], exclude: [] } },
            { ...filters, sections: { include: [{ serverId: 'home-a', sectionId: 's1' }], exclude: [] } },
            { ...filters, updated: { op: 'after' as const, atMs: 10 } },
            { ...filters, includeInactive: true },
        ]) expect(buildSessionListSelectionScopeSignature(changed, eligibility)).not.toBe(original);
    });
    it('adopts the device selection from its admitted Account catalog without changing another context', async () => {
        harness.accountScope = { serverId: 'home-a', accountId: 'account-a' };
        harness.settingsVersion = 1;
        const savedFilter = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'], source: 'direct', includeInactive: true });
        const { searchQuery: _searchQuery, ...filter } = savedFilter;
        harness.spaceCatalog = { v: 1, spaces: [{ id: 'saved', name: 'Saved', entityKind: 'sessionWork',
            icon: { kind: 'icon', name: 'list' }, filter, includeNeedsYouEverywhere: true }] };
        await selectCollectionSpace(harness.accountScope, 'sessionWork', 'saved');
        const hook = await renderHook(() => useSessionListViewFilterController());
        expect(hook.getCurrent().selectedSpaceId).toBe('saved');
        expect(hook.getCurrent().filters).toMatchObject({ source: 'direct', includeInactive: true, homeServerIds: ['home-a'] });
        expect(hook.getCurrent().includeNeedsYouEverywhere).toBe(true);
        await act(async () => hook.getCurrent().setSource('all'));
        expect(hook.getCurrent().isSpaceModified).toBe(true);
        expect(harness.spaceCatalog.spaces[0]).toMatchObject({ filter: { source: 'direct' } });
        await act(async () => hook.getCurrent().resetFilters());
        expect(hook.getCurrent().filters.source).toBe('direct');
        expect(hook.getCurrent().isSpaceModified).toBe(false);
    });

    it('keeps archived drafts separate from the active context', async () => {
        const active = await renderHook(() => useSessionListViewFilterController('active'));
        await act(async () => active.getCurrent().setSearchQuery('active draft'));
        const archived = await renderHook(() => useSessionListViewFilterController('archived'));
        expect(archived.getCurrent().filters.searchQuery).toBe('');
        await act(async () => archived.getCurrent().setSource('direct'));
        expect(active.getCurrent().filters.source).toBe('all');
    });
    it('loads inactive step sessions for a Runs-inclusive view while retaining the ordinary visibility preference', async () => {
        harness.hideInactiveSessions = true;
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const hook = await renderHook((show: 'sessions' | 'runs' | 'both') => useSessionListViewFilterController(
            'active', { kind: 'global' }, show,
        ), { initialProps: 'sessions' });
        expect(hook.getCurrent().includeInactive).toBe(false);
        expect(hook.getCurrent().queryHomes.map((home) => home.query.includeInactive)).toEqual([false, false]);
        const runs = await hook.rerender('runs');
        expect(runs.includeInactive).toBe(false);
        expect(runs.queryHomes.map((home) => home.query.includeInactive)).toEqual([true, true]);
        const both = await hook.rerender('both');
        expect(both.includeInactive).toBe(false);
        expect(both.queryHomes.map((home) => home.query.includeInactive)).toEqual([true, true]);
    });

    it('keeps global filters, selected Homes and retained pane identity across focus A to B', async () => {
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const hook = await renderHook(() => useSessionListViewFilterController());

        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            scope: 'assigned_to_me',
            searchQuery: 'private search',
            tagIds: { include: [
                { serverId: 'home-a', tagId: 'tag-a' },
                { serverId: 'home-b', tagId: 'tag-b' },
            ], exclude: [] },
        })));
        const sourceScopeKey = hook.getCurrent().retentionScopeKey;
        const paneIdentity = { storageKind: 'all' as const, pathname: '/', sourceScopeKey };
        retainSessionListPaneState({
            ...paneIdentity,
            paneState: paneState(),
            queryMembershipActive: true,
            selectedServerIds: ['home-a', 'home-b'],
        });

        harness.selection = { activeServerId: 'home-b', allowedServerIds: ['home-a', 'home-b'] };
        const afterFocusSwitch = await hook.rerender();

        expect(afterFocusSwitch.retentionScopeKey).toBe(sourceScopeKey);
        expect(afterFocusSwitch.filters).toMatchObject({
            scope: 'assigned_to_me',
            searchQuery: 'private search',
            homeServerIds: ['home-a', 'home-b'],
        });
        expect(readRetainedSessionListPaneState({
            ...paneIdentity,
            sourceScopeKey: afterFocusSwitch.retentionScopeKey,
        })?.paneState.visibleSessionListIndex).toEqual(paneState().visibleSessionListIndex);

        removeAuthoritativelyDeletedSessionListTagsForAccount(
            { serverId: 'home-b', accountId: 'account-b' },
            ['tag-b'],
        );
        expect((await hook.rerender()).filters.tagIds).toEqual({ include: [
            { serverId: 'home-a', tagId: 'tag-a' },
        ], exclude: [] });
    });

    it('seeds Source as All while retaining edits without rewriting the default', async () => {
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const hook = await renderHook(() => useSessionListViewFilterController());

        expect(hook.getCurrent().filters.source).toBe('all');
        expect(hook.getCurrent().defaultFilters.source).toBe('all');

        await act(async () => hook.getCurrent().setSource('direct'));

        expect(hook.getCurrent().filters.source).toBe('direct');
        expect(hook.getCurrent().defaultFilters.source).toBe('all');
    });

    it('stores inactive selection in the filter and restores the settings default on reset', async () => {
        harness.hideInactiveSessions = true;
        const hook = await renderHook(() => useSessionListViewFilterController('active', { kind: 'global' }, 'sessions'));
        expect(hook.getCurrent().includeInactive).toBe(false);
        await act(async () => hook.getCurrent().setIncludeInactive(true));
        expect(hook.getCurrent().filters.includeInactive).toBe(true);
        expect(hook.getCurrent().includeInactive).toBe(true);
        expect(hook.getCurrent().queryHomes.map((home) => home.query.includeInactive)).toEqual([true, true]);
        await act(async () => hook.getCurrent().resetFilters());
        expect(hook.getCurrent().filters.includeInactive).toBeUndefined();
        expect(hook.getCurrent().includeInactive).toBe(false);
    });

    it('forces archived inactive admission without changing the active retained filter', async () => {
        harness.hideInactiveSessions = true;
        const active = await renderHook(() => useSessionListViewFilterController('active'));
        const archived = await renderHook(() => useSessionListViewFilterController('archived'));
        await act(async () => archived.getCurrent().setIncludeInactive(false));
        expect(archived.getCurrent().includeInactive).toBe(true);
        expect(archived.getCurrent().filters.includeInactive).toBe(true);
        expect(active.getCurrent().includeInactive).toBe(false);
    });

    it('seeds Source as All across admitted Homes', async () => {
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const hook = await renderHook(() => useSessionListViewFilterController());

        expect(hook.getCurrent().filters.source).toBe('all');
    });

    it('binds Team retention only to its exact Home and resets it while replacement resolves', async () => {
        // The real credential owner publishes a cross-realm Account replacement.
        admitHomeCredential('home-a', { token: createAccountTokenForTests('account-a') });
        admitHomeCredential('home-b', { token: createAccountTokenForTests('account-b') });
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const hook = await renderHook(() => useSessionListViewFilterController(
            'active',
            { kind: 'team', team: { serverId: 'home-a', teamId: 'team-a' } },
        ));

        expect(harness.requestedServerIds).toEqual(['home-a']);
        await act(async () => hook.getCurrent().setSearchQuery('team private'));
        const teamScopeKey = hook.getCurrent().retentionScopeKey;
        const paneIdentity = { storageKind: 'all' as const, pathname: '/teams/team-a', sourceScopeKey: teamScopeKey };
        retainSessionListPaneState({
            ...paneIdentity,
            paneState: paneState(),
            queryMembershipActive: true,
            selectedServerIds: ['home-a'],
        });

        harness.selection = { activeServerId: 'home-b', allowedServerIds: ['home-a', 'home-b'] };
        expect((await hook.rerender()).retentionScopeKey).toBe(teamScopeKey);
        expect(hook.getCurrent().filters.searchQuery).toBe('team private');
        expect(readRetainedSessionListPaneState(paneIdentity)?.paneState.visibleSessionListIndex)
            .toEqual(paneState().visibleSessionListIndex);

        // An unrelated Home mutation has no Team-A contribution to retire.
        act(() => {
            admitHomeCredential('home-b', { token: createAccountTokenForTests('replacement-b') });
        });
        expect((await hook.rerender()).filters.searchQuery).toBe('team private');

        // Credential mutation retires Account A synchronously before its replacement resolves.
        act(() => {
            admitHomeCredential('home-a', { token: createAccountTokenForTests('replacement-a') });
        });
        harness.resolutions = new Map([['home-a', { kind: 'resolving' }]]);
        const resolvingReplacement = await hook.rerender();
        expect(resolvingReplacement.filters).toMatchObject({
            scope: 'all_accessible',
            homeServerIds: ['home-a'],
            audiences: { include: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }], exclude: [] },
            searchQuery: '',
        });
    });
});
