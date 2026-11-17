import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { StoredNavigationSurfacePlacementsV1Schema } from '@/sync/domains/settings/navigationPlacement';
import { navigationPlacementStorageBinding } from '@/components/settings/appearance/navigationPlacementSettingBinding';
import { useNavigationSurfacePlacement, useNavigationSurfacePlacementActionWriter, useDetailPageTabsPositionActionWriter } from './useNavigationSurfacePlacement';
import { renderHook } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { Modal } from '@/modal';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const initial = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(initial, true); });

it('commits deliberate rail pin/order and page-tab choices without an Inbox approval under Ask policy', async () => {
    const account = await createSecretSettingsTestHarness({ settings: settingsParse({
        actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
    }) });
    const hook = await renderHook(() => ({
        place: useNavigationSurfacePlacementActionWriter('sessionRail'),
        tabs: useDetailPageTabsPositionActionWriter('session'),
    }));
    vi.mocked(Modal.confirm).mockClear();
    try {
        let placed: boolean | undefined;
        await act(async () => { void hook.getCurrent().place({ orderedIds: ['insights', 'database'],
            placements: { insights: 'pinned', database: 'pinned' } }).then(result => { placed = result; }); });
        await vi.waitFor(() => expect(placed).toBeDefined());
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(account.artifacts.list()).toHaveLength(0);
        expect(placed).toBe(true);
        expect(storage.getState().localSettings.navigationSurfacePlacementsV1.sessionRail).toEqual({
            orderedIds: ['insights', 'database'], placements: { insights: 'pinned', database: 'pinned' },
        });
        await act(async () => { expect(await hook.getCurrent().tabs('top')).toBe(true); });
        expect(storage.getState().localSettings.navigationSurfacePlacementsV1.pageTabs?.session).toBe('top');
        expect(account.artifacts.list()).toHaveLength(0);
        expect(account.settingsWrites).toHaveLength(0);
        expect(Modal.confirm).not.toHaveBeenCalled();
    } finally { standardCleanup(); await account.dispose(); }
});

it('keeps a Session desktop subscriber idle for Machine phone edits and unrelated Session arrivals', async () => {
    let renders = 0;
    const sessionRail = { orderedIds: ['files'], placements: {} };
    storage.setState(state => ({ localSettings: { ...state.localSettings, navigationSurfacePlacementsV1: { sessionRail } } }));
    const observed: unknown[] = [];
    function SessionDesktop() {
        renders++;
        observed.push(useNavigationSurfacePlacement({ pageKind: 'session', device: 'desktop', section: 'companions' }).preferences);
        return null;
    }
    await renderScreen(<SessionDesktop />);
    const mounted = renders;
    // The canonical local-settings writer merges the Machine phone edit (unchanged surfaces keep their identity).
    const patch = navigationPlacementStorageBinding.parse({ detailPages: { machine: { phone: { items: { orderedIds: [], placements: {} } } } } });
    if (!patch.success) throw new Error('Expected a valid Machine phone placement');
    await act(async () => navigationPlacementStorageBinding.commit(storage.getState().localSettings, patch.value,
        delta => storage.getState().applyLocalSettings(delta, { persist: false })));
    await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
        unrelated: createSessionFixture({ id: 'unrelated', serverId: 'other-home' }),
    } })));
    expect(renders - mounted).toBe(0);
    expect(observed.at(-1)).toBe(sessionRail);
});

it('reads newer stored detail preferences by stripping unknown fields at every stored boundary', () => {
    const parsed = StoredNavigationSurfacePlacementsV1Schema.safeParse({ detailPages: { machine: {
        future: true, phone: { future: true, items: { orderedIds: [], placements: {}, future: true } },
    } } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.detailPages?.machine).toEqual({ phone: { items: { orderedIds: [], placements: {} } } });
});
