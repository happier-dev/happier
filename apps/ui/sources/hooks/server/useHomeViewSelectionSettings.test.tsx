import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

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

    it('keeps Home selection device-local instead of entering the Account-settings writer', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { useHomeViewSelectionSettingsMutable } = await import('./useHomeViewSelectionSettings');

        const original = await profiles.upsertServerProfile({ name: 'Original', serverUrl: 'https://original-home.example.test' });
        const target = await profiles.upsertServerProfile({ name: 'Target', serverUrl: 'https://target-home.example.test' });
        await profiles.saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: original.id });

        const hook = await renderHook(() => useHomeViewSelectionSettingsMutable());
        expect(hook.getCurrent().serverSelectionActiveTargetId).toBe(original.id);
        await act(async () => {
            await hook.getCurrent().setHomeViewSelectionSettings({
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: 'server',
                serverSelectionActiveTargetId: target.id,
            });
        });

        // The device-global owner saved it, and the Settings projection exists only so existing
        // readers keep working. This is the one catalogued local-only exception: it must never
        // reach the scoped Account-settings writer, which would seal, queue and sync it to a
        // Home (Lane 07.6 §2, completion evidence 9).
        expect(profiles.loadHomeViewState()).toMatchObject({ activeTargetKind: 'server', activeTargetId: target.id });
        expect(loadEffectiveHomeViewState()).toMatchObject({ activeTargetKind: 'server', activeTargetId: target.id });
        expect(hook.getCurrent().serverSelectionActiveTargetId).toBe(target.id);
        expect(getStorage().getState().settings.serverSelectionActiveTargetId).toBe(target.id);
        expect(homes.requests.filter(request => request.path.includes('/account/settings') && request.method !== 'GET')).toEqual([]);
    });
});
