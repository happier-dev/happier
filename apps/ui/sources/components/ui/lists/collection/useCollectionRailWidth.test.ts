import { afterEach, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { useCollectionRailWidth } from './useCollectionRailWidth';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readBuiltInSettingUiRef } from '@/components/settings/catalog/settingDeclarations';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

const previous = getStorage().getState();
afterEach(() => {
    standardCleanup();
    getStorage().setState(previous, true);
});

it('restores a keyed preference, preserves neighbouring commits and does not render for another rail', async () => {
    const account = await createSecretSettingsTestHarness({});
    try {
    getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: { machines: 350, teams: 290 } });
    const beforeMount = getStorage().getState().localSettings.collectionRailWidthsV1;
    let renders = 0;
    const machines = await renderHook(() => {
        renders += 1;
        return useCollectionRailWidth('machines');
    });
    const teams = await renderHook(() => useCollectionRailWidth('teams'));
    expect(machines.getCurrent().widthPx).toBe(350);
    expect(getStorage().getState().localSettings.collectionRailWidthsV1).toBe(beforeMount);
    const beforeNeighbourChange = renders;
    await act(async () => teams.getCurrent().commit(310));
    expect(renders).toBe(beforeNeighbourChange);
    await act(async () => {
        await Promise.all([machines.getCurrent().commit(375), teams.getCurrent().commit(325)]);
    });
    expect(loadLocalSettings().collectionRailWidthsV1).toEqual({ machines: 375, teams: 325 });
    await machines.unmount();
    const restored = await renderHook(() => useCollectionRailWidth('machines'));
    expect(restored.getCurrent().widthPx).toBe(375);
    await act(async () => restored.getCurrent().reset());
    expect(restored.getCurrent().widthPx).toBeUndefined();
    expect(loadLocalSettings().collectionRailWidthsV1).toEqual({ teams: 325 });
    expect(account.settingsWrites).toEqual([]);
    expect(account.artifacts.list()).toEqual([]);
    } finally { standardCleanup(); await account.dispose(); }
});

it('exposes rail widths to agent Settings reads, keyed writes and reset without replacing neighbours', async () => {
    const account = await createSecretSettingsTestHarness({});
    try {
        getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: { teams: 325 } });
        const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => null });
        const context = { surface: 'agent', serverId: account.scope.serverId, authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
        const anchor = 'appearance.collectionRailWidths';
        await act(async () => {
            expect(await executor.execute('settings.list', { pageId: 'appearance' }, context)).toMatchObject({ ok: true,
                result: { items: expect.arrayContaining([expect.objectContaining({ anchor, readable: true, writable: true, storageScope: 'local' })]) } });
            expect(await executor.execute('settings.get', { anchor }, context)).toMatchObject({ ok: true, result: { value: { teams: 325 } } });
            expect(await executor.execute('settings.set', { anchor, value: { resizeKey: 'triage', widthPx: 375 } }, context)).toMatchObject({ ok: true });
        });
        expect(loadLocalSettings().collectionRailWidthsV1).toEqual({ teams: 325, triage: 375 });
        await act(async () => {
            expect(await executor.execute('settings.set', { anchor, value: { resizeKey: 'triage', widthPx: null } }, context)).toMatchObject({ ok: true });
        });
        expect(loadLocalSettings().collectionRailWidthsV1).toEqual({ teams: 325 });
        expect(account.settingsWrites).toEqual([]);
        expect(account.artifacts.list()).toEqual([]);
    } finally { standardCleanup(); await account.dispose(); }
});

it('keeps unrelated local owners outside standalone preference resolution', () => {
    expect(readBuiltInSettingUiRef('session.list.selectedSpace')).toBeNull();
    expect(readBuiltInSettingUiRef('desktop.captureShortcut')).toBeNull();
});

it('applies Settings Action restrictions to rail resize and reset gestures', async () => {
    const account = await createSecretSettingsTestHarness({ settings: settingsParse({
        actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
    }) });
    try {
        getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: { triage: 375 } });
        const rail = await renderHook(() => useCollectionRailWidth('triage'));
        await act(async () => { await rail.getCurrent().commit(420); });
        expect(loadLocalSettings().collectionRailWidthsV1).toEqual({ triage: 375 });
        await act(async () => { await rail.getCurrent().reset(); });
        expect(loadLocalSettings().collectionRailWidthsV1).toEqual({ triage: 375 });
    } finally { standardCleanup(); await account.dispose(); }
});
