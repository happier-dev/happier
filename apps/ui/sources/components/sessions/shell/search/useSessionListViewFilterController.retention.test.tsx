import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
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
    credentialObservers: new Set<(event: { serverId: string }) => void>(),
    hideInactiveSessions: false,
    storage: {
        externalSessionsEnabled: true,
        storageKind: 'persisted' as 'all' | 'persisted' | 'direct',
        setStorageKind: vi.fn(),
    },
}));

vi.mock('@/components/sessions/model/useSessionListStorageKind', () => ({
    useSessionListStorageKind: () => harness.storage,
}));

vi.mock('@/sync/runtime/orchestration/homeAccountChange', () => ({
    subscribeHomeCredentialChange: (observer: (event: { serverId: string }) => void) => {
        harness.credentialObservers.add(observer);
        return () => harness.credentialObservers.delete(observer);
    },
}));

vi.mock('@/hooks/session/useSessionListSelectionState', () => ({
    useSessionListSelectionState: () => harness.selection,
}));
vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({ useServerProfilesGeneration: () => 1 }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => [
        { id: 'home-a', name: 'Home A' },
        { id: 'home-b', name: 'Home B' },
    ],
    resolveServerProfileScopeId: (profile: { id: string }) => profile.id,
}));
vi.mock('@/sync/domains/server/selection/serverSelectionProfileScopeIds', () => ({
    listServerProfileScopeIds: () => ['home-a', 'home-b'],
}));
vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: () => [harness.hideInactiveSessions, vi.fn()],
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
    resetSessionListPaneRetentionForTests();
    clearSessionListViewFilterRetentionForTests();
    harness.selection = { activeServerId: 'home-a', allowedServerIds: ['home-a', 'home-b'] };
    harness.resolutions = new Map();
    harness.requestedServerIds = [];
    harness.credentialObservers.clear();
    harness.hideInactiveSessions = false;
    harness.storage = { externalSessionsEnabled: true, storageKind: 'persisted', setStorageKind: vi.fn() };
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
    it('loads inactive step sessions for a Runs-inclusive view while retaining the ordinary visibility preference', async () => {
        harness.hideInactiveSessions = true;
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const { useSessionListViewFilterController } = await import('./useSessionListViewFilterController');
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
        const { useSessionListViewFilterController } = await import('./useSessionListViewFilterController');
        const hook = await renderHook(() => useSessionListViewFilterController());

        await act(async () => hook.getCurrent().updateFilters((current) => ({
            ...current,
            scope: 'assigned_to_me',
            searchQuery: 'private search',
            tagIds: [
                { serverId: 'home-a', tagId: 'tag-a' },
                { serverId: 'home-b', tagId: 'tag-b' },
            ],
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
        expect((await hook.rerender()).filters.tagIds).toEqual([
            { serverId: 'home-a', tagId: 'tag-a' },
        ]);
    });

    it('seeds Source from the persisted preference and writes the choice back through it', async () => {
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const { useSessionListViewFilterController } = await import('./useSessionListViewFilterController');
        const hook = await renderHook(() => useSessionListViewFilterController());

        // The device-local preference is the one seed for every surface, so mount
        // order can no longer decide which default the shared global context gets.
        expect(hook.getCurrent().filters.source).toBe('persisted');
        expect(hook.getCurrent().defaultFilters.source).toBe('persisted');

        await act(async () => hook.getCurrent().setSource('direct'));

        expect(harness.storage.setStorageKind).toHaveBeenCalledWith('direct');
        expect(hook.getCurrent().filters.source).toBe('direct');
    });

    it('seeds Source as All when no Home exposes external sessions', async () => {
        harness.storage = { externalSessionsEnabled: false, storageKind: 'persisted', setStorageKind: vi.fn() };
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const { useSessionListViewFilterController } = await import('./useSessionListViewFilterController');
        const hook = await renderHook(() => useSessionListViewFilterController());

        expect(hook.getCurrent().filters.source).toBe('all');
    });

    it('binds Team retention only to its exact Home and resets it while replacement resolves', async () => {
        harness.resolutions = new Map([
            ['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }],
            ['home-b', { kind: 'bound', scope: { serverId: 'home-b', accountId: 'account-b' } }],
        ]);
        const { useSessionListViewFilterController } = await import('./useSessionListViewFilterController');
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
            for (const observer of harness.credentialObservers) observer({ serverId: 'home-b' });
        });
        expect((await hook.rerender()).filters.searchQuery).toBe('team private');

        // Credential mutation retires Account A synchronously before its replacement resolves.
        act(() => {
            for (const observer of harness.credentialObservers) observer({ serverId: 'home-a' });
        });
        harness.resolutions = new Map([['home-a', { kind: 'resolving' }]]);
        const resolvingReplacement = await hook.rerender();
        expect(resolvingReplacement.filters).toMatchObject({
            scope: 'all_accessible',
            homeServerIds: ['home-a'],
            audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a' }],
            searchQuery: '',
        });
    });
});
