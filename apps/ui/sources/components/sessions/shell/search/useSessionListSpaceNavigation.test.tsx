import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { clearSessionListViewFilterRetentionForTests } from './useSessionListViewFilters';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const originalState = storage.getState();
afterEach(() => {
    standardCleanup();
    clearSessionListViewFilterRetentionForTests();
    storage.setState(originalState, true);
});

describe('Session space navigation through Settings Actions', () => {
    it('suspends saved filtering and navigation through Account enablement declarations, then restores selection', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol/sessions/listFilter/sessionListFilterV1');
        const { useSessionListViewFilterController } = await import('./useSessionListViewFilterController');
        const { useSessionListSpaceNavigation } = await import('./useSessionListSpaceNavigation');
        const { useSettingActionFeedback } = await import('@/components/settings/shell/useSettingActionFeedback');
        const space = { entityKind: 'sessionWork' as const, id: 'saved', name: 'Saved',
            icon: { kind: 'icon' as const, name: 'filter' as const }, includeNeedsYouEverywhere: true,
            filter: normalizeSessionListFilterV1({ homeServerIds: [account.scope.serverId], agents: { include: ['agent:happier.agent.codex/codex'], exclude: [] } }) };
        account.replaceSettings(settingsParse({ ...account.persistedSettings, collectionSpacesV1: { v: 1, spaces: [space] } }));
        const probe = await renderHook(() => {
            const controller = useSessionListViewFilterController();
            return { controller, navigation: useSessionListSpaceNavigation(controller), settings: useSettingActionFeedback() };
        });
        try {
            await vi.waitFor(() => expect(probe.getCurrent().controller.spaces.some(entry => entry.id === 'saved')).toBe(true));
            await act(async () => { expect(await probe.getCurrent().navigation.selectSpace('saved')).toBe(true); });
            expect(probe.getCurrent().controller.filters.agents?.include).toEqual(['agent:happier.agent.codex/codex']);
            for (const anchor of ['session.list.spacesEnabled', 'spaces.enabled']) {
                await act(async () => { expect(await probe.getCurrent().settings.setSetting({ anchor }, false)).toBe(true); });
                expect(probe.getCurrent().controller.spacesEnabled).toBe(false);
                expect(probe.getCurrent().controller.filters).toEqual(probe.getCurrent().controller.contextDefaultFilters);
                expect(probe.getCurrent().controller.includeNeedsYouEverywhere).toBe(false);
                expect(probe.getCurrent().controller.selectedSpaceId).toBe('saved');
                expect(probe.getCurrent().navigation.selectOrdinal(1)).toBe(false);
                expect(probe.getCurrent().navigation.selectRelative(-1)).toBe(false);
                expect(await probe.getCurrent().navigation.selectSpace('my-work')).toBe(false);
                act(() => { probe.getCurrent().controller.resetFilters(); });
                expect(probe.getCurrent().controller.filters.agents).toBeUndefined();
                expect(account.persistedSettings.collectionSpacesV1.spaces).toEqual([space]);
                await act(async () => { expect(await probe.getCurrent().settings.setSetting({ anchor }, true)).toBe(true); });
                expect(probe.getCurrent().controller.spacesEnabled).toBe(true);
                expect(probe.getCurrent().controller.filters.agents?.include).toEqual(['agent:happier.agent.codex/codex']);
                expect(probe.getCurrent().controller.selectedSpaceId).toBe('saved');
            }
        } finally { standardCleanup(); await account.dispose(); }
    });

    it.each(['my-work', 'saved'])('keeps the Settings Show coordinators intent when navigation replaces the mounted %s list', async initialSpaceId => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        const { useSessionListViewFilterController } = await import('./useSessionListViewFilterController');
        const { useSessionListSpaceNavigation } = await import('./useSessionListSpaceNavigation');
        const { showOnlyCoordinatorsInSessionList } = await import('./useSessionListViewFilters');
        const renderList = () => renderHook(() => {
            const controller = useSessionListViewFilterController();
            return { controller, navigation: useSessionListSpaceNavigation(controller) };
        });
        try {
            const before = await renderList();
            await vi.waitFor(() => expect(before.getCurrent().controller.spacesReady).toBe(true));
            if (initialSpaceId === 'saved') {
                const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol/sessions/listFilter/sessionListFilterV1');
                await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                    collectionSpacesV1: { v: 1, spaces: [{ entityKind: 'sessionWork', id: 'saved', name: 'Saved work',
                        icon: { kind: 'icon', name: 'filter' }, includeNeedsYouEverywhere: false,
                        filter: normalizeSessionListFilterV1({ homeServerIds: [account.scope.serverId], source: 'direct' }),
                    }] },
                })); });
                await act(async () => { expect(await before.getCurrent().navigation.selectSpace('saved')).toBe(true); });
                expect(before.getCurrent().controller.selectedSpaceId).toBe('saved');
            }
            act(() => { showOnlyCoordinatorsInSessionList(); });
            await before.unmount();
            const after = await renderList();
            await vi.waitFor(() => expect({ coordinator: after.getCurrent().controller.filters.coordinator,
                selectedSpaceId: after.getCurrent().controller.selectedSpaceId,
                pending: after.getCurrent().controller.showCoordinatorsRequest,
            }).toEqual({ coordinator: 'coordinator', selectedSpaceId: 'my-work', pending: 0 }));
            expect(after.getCurrent().controller.selectedSpaceId).toBe('my-work');
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('navigates Session spaces through the declared local selection without changing saved definitions', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol/sessions/listFilter/sessionListFilterV1');
        const { CollectionSpacesV1Schema } = await import('@happier-dev/protocol/collections/spaces/collectionSpacesV1');
        const { useSessionListViewFilterController } = await import('@/components/sessions/shell/search/useSessionListViewFilterController');
        const { useSessionListSpaceNavigation } = await import('@/components/sessions/shell/search/useSessionListSpaceNavigation');
        const { showOnlyCoordinatorsInSessionList } = await import('@/components/sessions/shell/search/useSessionListViewFilters');
        const spaces = Array.from({ length: 10 }, (_, index) => ({
            entityKind: 'sessionWork' as const, id: `space-${index + 1}`, name: `Space ${index + 1}`,
            icon: { kind: 'icon' as const, name: 'filter' as const }, includeNeedsYouEverywhere: false,
            filter: normalizeSessionListFilterV1({ homeServerIds: [account.scope.serverId], includeInactive: index % 2 === 0 }),
        }));
        const workflowSpace = { entityKind: 'workflow' as const, id: 'other-workflows', name: 'Other workflows',
            icon: { kind: 'icon' as const, name: 'list' as const }, filter: { view: 'all' as const }, includeNeedsYouEverywhere: false };
        account.replaceSettings(settingsParse({ ...account.persistedSettings,
            collectionSpacesV1: CollectionSpacesV1Schema.parse({ v: 1, spaces: [workflowSpace, ...spaces] }) }));
        const probe = await renderHook(() => {
            const controller = useSessionListViewFilterController();
            return { controller, navigation: useSessionListSpaceNavigation(controller) };
        });
        try {
            await vi.waitFor(() => expect(probe.getCurrent().controller.spacesReady).toBe(true));
            const definitions = account.persistedSettings.collectionSpacesV1;
            expect(probe.getCurrent().controller.selectedSpaceId).toBe('my-work');
            await act(async () => { expect(probe.getCurrent().navigation.selectOrdinal(9)).toBe(true); });
            await vi.waitFor(() => expect(probe.getCurrent().controller.selectedSpaceId).toBe('space-8'));
            await act(async () => { probe.getCurrent().controller.setSearchQuery('discard this draft'); });
            await act(async () => { expect(await probe.getCurrent().navigation.selectSpace('space-10')).toBe(true); });
            await vi.waitFor(() => expect(probe.getCurrent().controller.selectedSpaceId).toBe('space-10'));
            expect(probe.getCurrent().controller.filters.searchQuery).toBe('');
            expect(probe.getCurrent().navigation.selectOrdinal(12)).toBe(false);
            expect(probe.getCurrent().navigation.selectRelative(1)).toBe(false);
            await act(async () => { expect(probe.getCurrent().navigation.selectRelative(-1)).toBe(true); });
            await vi.waitFor(() => expect(probe.getCurrent().controller.selectedSpaceId).toBe('space-9'));
            const reordered = { ...definitions, spaces: [workflowSpace, spaces[9]!, ...spaces.slice(0, 9)] };
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, collectionSpacesV1: reordered })); });
            expect(probe.getCurrent().controller.selectedSpaceId).toBe('space-9');
            await act(async () => { expect(probe.getCurrent().navigation.selectOrdinal(2)).toBe(true); });
            await vi.waitFor(() => expect(probe.getCurrent().controller.selectedSpaceId).toBe('space-10'));
            await act(async () => { probe.getCurrent().controller.setSearchQuery('wait for the same Account catalog'); });
            const admittedVersion = storage.getState().settingsVersion;
            await act(async () => { storage.setState({ settingsVersion: null }); });
            await act(async () => { showOnlyCoordinatorsInSessionList(); });
            expect(probe.getCurrent().controller.spacesReady).toBe(false);
            expect(probe.getCurrent().controller.filters.searchQuery).toBe('wait for the same Account catalog');
            expect(probe.getCurrent().controller.filters.coordinator).toBeUndefined();
            expect(probe.getCurrent().controller.showCoordinatorsRequest).toBe(1);
            expect(probe.getCurrent().navigation.filterOpenRequested).toBe(false);
            await act(async () => { storage.setState({ settingsVersion: admittedVersion }); });
            await vi.waitFor(() => expect(probe.getCurrent().controller.selectedSpaceId).toBe('my-work'));
            await vi.waitFor(() => expect(probe.getCurrent().controller.filters.coordinator).toBe('coordinator'));
            expect(probe.getCurrent().controller.filters).toMatchObject({ ...probe.getCurrent().controller.contextDefaultFilters,
                coordinator: 'coordinator' });
            expect(probe.getCurrent().navigation.filterOpenRequested).toBe(true);
            expect(probe.getCurrent().controller.isSpaceModified).toBe(true);
            await act(async () => { probe.getCurrent().navigation.acknowledgeFilterOpenRequest(); });
            expect(probe.getCurrent().navigation.filterOpenRequested).toBe(false);
            const globalFilters = probe.getCurrent().controller.filters;
            const team = { serverId: account.scope.serverId, teamId: 'team-a' };
            const teamProbe = await renderHook(() => {
                const controller = useSessionListViewFilterController('active', { kind: 'team', team });
                return { controller, navigation: useSessionListSpaceNavigation(controller) };
            });
            await act(async () => { showOnlyCoordinatorsInSessionList(teamProbe.getCurrent().controller.viewContextKey); });
            await vi.waitFor(() => expect(teamProbe.getCurrent().controller.filters.coordinator).toBe('coordinator'));
            expect(teamProbe.getCurrent().controller.filters).toMatchObject({ scope: 'all_accessible',
                audiences: [{ ...team, kind: 'team' }] });
            expect(teamProbe.getCurrent().navigation.filterOpenRequested).toBe(true);
            expect(teamProbe.getCurrent().controller.isSpaceModified).toBe(true);
            expect(probe.getCurrent().controller.filters).toEqual(globalFilters);
            expect(account.persistedSettings.collectionSpacesV1).toEqual(reordered);
            expect(account.settingsWrites).toEqual([]);
            expect(account.artifacts.list()).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
