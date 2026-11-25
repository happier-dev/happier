import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { MMKV } from 'react-native-mmkv';

import { renderHook, standardCleanup } from '@/dev/testkit';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { loadEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';

const homes = createHomeGovernanceHarness();
const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
let locks: ReturnType<typeof installWebLockManagerMock>;

describe('useHomeViewSelectionSettings', () => {
    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `home_view_hook_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        profiles.resetServerProfilesRuntimeForTests();
        locks = installWebLockManagerMock();
        installHomeGovernanceBoundaries(homes);
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        getStorage().setState({ settings: { ...settingsDefaults }, settingsScope: null });
    });
    afterEach(async () => {
        standardCleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        await homes.reset();
        locks.restore();
        resetRuntimeFetch();
        profiles.resetServerProfilesRuntimeForTests();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('reads the legacy Home-view fallback without subscribing to unrelated Account settings', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { useHomeViewSelectionSettings } = await import('./useHomeViewSelectionSettings');

        expect(profiles.loadHomeViewState()).toBeNull();
        expect(loadEffectiveHomeViewState()).toBeNull();

        let renderCount = 0;
        const hook = await renderHook(() => {
            renderCount += 1;
            return useHomeViewSelectionSettings();
        });

        expect(hook.getCurrent().serverSelectionActiveTargetId).toBeNull();
        const rendersAfterMount = renderCount;

        await act(async () => {
            getStorage().getState().applySettingsLocal({ lastUsedAgent: 'claude' });
        });

        // A Home-view reader must not rerender for an unrelated Account setting.
        // Persistent surfaces (header/sidebar connection control, session lists)
        // mount this hook for the whole session.
        expect(renderCount).toBe(rendersAfterMount);

        await act(async () => {
            getStorage().getState().applySettingsLocal({
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: 'srv-legacy',
            });
        });

        expect(renderCount).toBeGreaterThan(rendersAfterMount);
        expect(hook.getCurrent()).toMatchObject({
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'srv-legacy',
        });
    });

    it('prefers the device-global Home-view owner over the legacy Account-scoped keys', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { useHomeViewSelectionSettings } = await import('./useHomeViewSelectionSettings');

        getStorage().getState().applySettingsLocal({
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: 'srv-legacy',
        });
        const device = await profiles.upsertServerProfile({ name: 'Device Home', serverUrl: 'https://device-home.example.test' });
        await profiles.saveHomeViewState({
            version: 1,
            groups: [],
            activeTargetKind: 'server',
            activeTargetId: device.id,
        });

        const hook = await renderHook(() => useHomeViewSelectionSettings());

        expect(hook.getCurrent()).toMatchObject({
            serverSelectionActiveTargetKind: 'server',
            serverSelectionActiveTargetId: device.id,
        });
    });

    it.each(['profile adoption', 'descriptor refresh'] as const)('measures mounted Settings costs for %s', async (path) => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const serverUrl = 'https://descriptor-home.example.test';
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_descriptor_home',
            canonicalServerUrl: serverUrl,
            revision: 7,
            endpoints: [{ kind: 'https' as const, url: serverUrl }],
        };
        const profile = await profiles.adoptHomeProfile({ descriptor, source: 'qr' });
        const storage = getStorage();
        const scope = { serverId: profile.id, accountId: 'account-a' };
        storage.setState({ settingsScope: scope, settingsVersion: 1 });
        saveAccountSettings(scope, storage.getState().settings, 1);
        let renders = 0;
        await renderHook(() => {
            renders++;
            return storage(state => state.settings);
        });
        const initialRenders = renders;
        const settingsWriter = vi.spyOn(storage.getState(), 'applySettingsLocal');
        const disk = vi.spyOn(MMKV.prototype, 'set');
        const next = { ...descriptor, revision: 8 };
        await act(async () => {
            if (path === 'profile adoption') {
                // This is the writer the old refresh delegated to for this established Home.
                await profiles.adoptHomeProfile({
                    descriptor: next, source: 'qr', preserveUserLabel: true, preserveProfileSource: true,
                    descriptorAuthority: 'current_connection_observation',
                });
            } else {
                await profiles.reconcileServerProfileHomeConnectionDescriptor({
                    serverUrl, observedServerIdentityId: next.homeServerIdentityId, descriptor: next,
                });
            }
        });
        expect(profiles.getServerProfileById(profile.id)?.homeConnectionDescriptor).toEqual(next);
        const storageKeys = disk.mock.calls.map(([key]) => key);
        expect({
            settingsWriter: settingsWriter.mock.calls.length,
            settingsWrites: storageKeys.filter(key => key === 'settings' || key.startsWith('account-settings:v2:')).length,
            settingsRenders: renders - initialRenders,
            syncPushes: homes.requests.filter(request => request.path.includes('/account/settings') && request.method !== 'GET').length,
            profileWrites: storageKeys.filter(key => key === 'server-state-v1').length,
            cacheWrites: storageKeys.filter(key => key === 'home-descriptor-cache-v1').length,
        }).toEqual({
            settingsWriter: 0, settingsWrites: 0, settingsRenders: 0, syncPushes: 0,
            profileWrites: path === 'profile adoption' ? 1 : 0,
            cacheWrites: path === 'descriptor refresh' ? 1 : 0,
        });
    });

    it.each(['device', 'tab'] as const)('remembers a %s selection without writing Account Settings', async (targetScope) => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { useHomeViewSelectionSettingsMutable } = await import('./useHomeViewSelectionSettings');
        const device = new Map<string, string>();
        const tab = new Map<string, string>();
        const setDevice = vi.fn((key: string, value: string) => { device.set(key, value); });
        const setTab = vi.fn((key: string, value: string) => { tab.set(key, value); });
        vi.stubGlobal('window', {
            location: { origin: 'https://app.example.test', hostname: 'app.example.test' },
            addEventListener: () => {}, removeEventListener: () => {},
            localStorage: { getItem: (key: string) => device.get(key) ?? null, setItem: setDevice },
        });
        vi.stubGlobal('document', {});
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => tab.get(key) ?? null,
            setItem: setTab,
            removeItem: (key: string) => tab.delete(key),
        });

        const original = await profiles.upsertServerProfile({ name: 'Original', serverUrl: 'https://original-home.example.test' });
        const target = await profiles.upsertServerProfile({ name: 'Target', serverUrl: 'https://target-home.example.test' });
        await profiles.saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: original.id });
        const storage = getStorage();
        const scope = { serverId: original.id, accountId: 'account-a' };
        storage.setState({ settingsScope: scope, settingsVersion: 1, settings: {
            ...storage.getState().settings, serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: original.id,
        } });
        saveAccountSettings(scope, storage.getState().settings, 1);

        let settingsRenders = 0;
        await renderHook(() => {
            settingsRenders++;
            return storage(state => state.settings);
        });
        const hook = await renderHook(useHomeViewSelectionSettingsMutable);
        const mountedSettingsRenders = settingsRenders;
        const settingsWriter = vi.spyOn(storage.getState(), 'applySettingsLocal');
        const persistence = vi.spyOn(getPersistenceStorage(), 'set');
        setDevice.mockClear();
        setTab.mockClear();
        const select = async (id: string) => await act(async () => {
            await hook.getCurrent().setHomeViewSelectionSettings({
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: id,
            }, { targetScope });
        });

        const selectTarget = () => select(target.id);
        await selectTarget();
        expect(profiles.loadHomeViewState()?.activeTargetId).toBe(targetScope === 'device' ? target.id : original.id);
        expect(hook.getCurrent().serverSelectionActiveTargetId).toBe(target.id);
        profiles.resetServerProfilesRuntimeForTests({ preserveGenerations: true });
        expect(loadEffectiveHomeViewState()?.activeTargetId).toBe(target.id);

        const measured = () => ({
            settingsWriter: settingsWriter.mock.calls.length,
            settingsWrites: persistence.mock.calls.filter(([key]) => key === 'settings' || key.startsWith('account-settings:v2:')).length,
            settingsRenders: settingsRenders - mountedSettingsRenders,
            syncPushes: homes.requests.filter(request => request.path.includes('/account/settings') && request.method !== 'GET').length,
            homeViewWrites: setDevice.mock.calls.length + setTab.mock.calls.length,
        });
        const changed = measured();
        await selectTarget();
        const repeated = measured();
        expect({ changed, repeated }, 'cost for one changed selection and an equal replay').toEqual({
            changed: { settingsWriter: 0, settingsWrites: 0, settingsRenders: 0, syncPushes: 0, homeViewWrites: 1 },
            repeated: { settingsWriter: 0, settingsWrites: 0, settingsRenders: 0, syncPushes: 0, homeViewWrites: 1 },
        });
    });
});
