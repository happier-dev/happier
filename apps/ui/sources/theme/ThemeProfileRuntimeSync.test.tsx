import { writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { savePendingAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import type { ThemeProfileMigrationIntent } from '@/theme/profiles/themeProfileTypes';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { darkTheme, lightTheme, type Theme } from '@/theme';

const shared = vi.hoisted(() => ({
    themes: null as Record<'light' | 'dark', Theme> | null,
    update: vi.fn((name: 'light' | 'dark', updater: (theme: Theme) => Theme) => {
        if (shared.themes) shared.themes[name] = updater(shared.themes[name]);
    }),
}));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Appearance: { getColorScheme: () => 'light' } }));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ runtime: {
        getTheme: (name: 'light' | 'dark') => shared.themes?.[name], updateTheme: shared.update,
    } }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
const originalState = storage.getState();
const pendingScope = { serverId: 'theme-pending-server', accountId: 'theme-pending-account' };
const otherPendingScope = { serverId: 'theme-pending-server', accountId: 'theme-pending-other-account' };
afterEach(() => {
    standardCleanup();
    savePendingAccountSettings(pendingScope, {}, null);
    savePendingAccountSettings(otherPendingScope, {}, null);
    storage.setState(originalState, true);
    writeThemeProfileLegacyAccountScope(null);
});

const profile = { ...createThemeProfileDraft({ id: 'ocean', name: 'Ocean', now: '2026-10-20T12:00:00.000Z' }),
    overrides: { light: { 'background.canvas': '#f1e2d3' }, dark: {} } };

describe('theme runtime account synchronization', () => {
    it('projects an acknowledged pending theme without duplicate backup rows or unrelated pending renders', async () => {
        const cloud = { ...profile, name: 'Account ocean', overrides: { light: { 'background.canvas': '#aabbcc' }, dark: {} } };
        const committed = { ...profile, id: 'ocean_2', name: 'Edited ocean' };
        const checkpoint = { edits: [{ target: { kind: 'legacy', id: profile.id }, profile: committed }],
            legacyProfileIds: { [profile.id]: committed.id }, acknowledged: true } satisfies ThemeProfileMigrationIntent;
        writeThemeProfileLegacyAccountScope(pendingScope);
        storage.setState({ settings: settingsParse({ themeProfiles: [cloud, committed] }), settingsScope: pendingScope,
            localSettings: { ...localSettingsDefaults,
                themeProfileSelection: { light: { legacyProfileId: profile.id }, dark: null },
                themeProfiles: { profiles: [profile], activeProfileIds: { light: profile.id, dark: null } } } });
        const { useThemeProfilesSnapshot } = await import('@/sync/store/useThemeProfiles');
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useThemeProfilesSnapshot(); });
        expect(hook.getCurrent().themeProfiles.profiles).toHaveLength(3);
        const before = renders;
        for (const analyticsOptOut of [true, false, true]) {
            await act(async () => { savePendingAccountSettings(pendingScope, { analyticsOptOut }); });
        }
        expect(renders - before).toBe(0);
        await act(async () => { savePendingAccountSettings(pendingScope, { themeProfiles: [cloud, committed] }, checkpoint); });
        expect(hook.getCurrent().themeProfiles.profiles.map(profile => profile.id)).toEqual([cloud.id, committed.id]);
        expect(hook.getCurrent().themeProfiles.activeProfileIds.light).toBe(committed.id);
        const afterAcknowledgement = renders;
        await act(async () => { savePendingAccountSettings(otherPendingScope, { themeProfiles: [cloud, committed] }, checkpoint); });
        expect(renders - afterAcknowledgement).toBe(0);
        await hook.unmount();
    });

    it('drops a foreign account legacy view when only the account scope changes', async () => {
        const accountA = { serverId: 'server-a', accountId: 'account-a' };
        const accountB = { serverId: 'server-a', accountId: 'account-b' };
        writeThemeProfileLegacyAccountScope(accountA);
        storage.setState({ settings: settingsParse({}), settingsScope: accountA, localSettings: {
            ...localSettingsDefaults,
            themeProfiles: { profiles: [profile], activeProfileIds: { light: profile.id, dark: null } },
        } });
        const local = storage.getState().localSettings;
        const accountProfiles = storage.getState().settings.themeProfiles;
        const { useThemeProfiles } = await import('@/sync/store/useThemeProfiles');
        const hook = await renderHook(() => useThemeProfiles());
        expect(hook.getCurrent().profiles[0]?.id).toBe(profile.id);
        await act(async () => { storage.setState({ settingsScope: accountB }); });
        expect(storage.getState().localSettings).toBe(local);
        expect(storage.getState().settings.themeProfiles).toBe(accountProfiles);
        expect(hook.getCurrent().profiles).toEqual([]);
        expect(hook.getCurrent().activeProfileIds).toEqual({ light: null, dark: null });
        await hook.unmount();
    });

    it('updates a mounted legacy view when its migration binding changes without a preference write', async () => {
        const account = { serverId: 'theme-binding-server', accountId: 'theme-binding-account' };
        const other = { ...account, accountId: 'other-account' };
        writeThemeProfileLegacyAccountScope(account);
        storage.setState({ settings: settingsParse({}), settingsScope: account, localSettings: {
            ...localSettingsDefaults,
            themeProfiles: { profiles: [profile], activeProfileIds: { light: profile.id, dark: null } },
        } });
        const local = storage.getState().localSettings;
        const { useThemeProfiles } = await import('@/sync/store/useThemeProfiles');
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useThemeProfiles(); });
        expect(hook.getCurrent().profiles.map(profile => profile.id)).toEqual([profile.id]);
        await act(async () => { writeThemeProfileLegacyAccountScope(other); });
        expect(hook.getCurrent().profiles).toEqual([]);
        expect(storage.getState().localSettings).toBe(local);
        const before = renders;
        await act(async () => { writeThemeProfileLegacyAccountScope(other); });
        expect(renders - before).toBe(0);
        await hook.unmount();
    });

    it('keeps the composed view stable across unrelated account and local updates', async () => {
        storage.setState({ settings: settingsParse({ themeProfiles: [profile] }), localSettings: localSettingsDefaults });
        storage.getState().applyLocalSettings({ themeProfileSelection: { light: profile.id, dark: null } });
        const { useThemeProfiles } = await import('@/sync/store/useThemeProfiles');
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useThemeProfiles(); });
        const initial = hook.getCurrent();
        const before = renders;
        for (const scale of [1.1, 1.15, 1.2]) {
            await act(async () => {
                storage.getState().applySettingsLocal({ showFlavorIcons: scale === 1.15 });
                storage.getState().applyLocalSettings({ uiFontScale: scale });
            });
        }
        expect(renders - before).toBe(0);
        expect(hook.getCurrent()).toBe(initial);
        await act(async () => { storage.getState().applySettingsLocal({ themeProfiles: [{ ...profile, name: 'Ocean blue' }] }); });
        expect(hook.getCurrent().profiles[0]?.name).toBe('Ocean blue');
        expect(hook.getCurrent().activeProfileIds.light).toBe(profile.id);
        await hook.unmount();
    });

    it('leaves host-selected embedded themes with their host runtime owner', async () => {
        shared.themes = { light: lightTheme, dark: darkTheme }; shared.update.mockClear();
        storage.setState({ settings: settingsParse({ themeProfiles: [profile] }), localSettings: {
            ...localSettingsDefaults, themeProfileSelection: { light: profile.id, dark: null },
        } });
        const { ThemeProfileRuntimeSync } = await import('./ThemeProfileRuntimeSync');
        const screen = await renderScreen(<ThemeProfileRuntimeSync enabled={false} />);
        expect(shared.update).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('applies account profile changes and local finish without writing the library on mount', async () => {
        shared.themes = { light: lightTheme, dark: darkTheme }; shared.update.mockClear();
        storage.setState({ settings: settingsParse({ themeProfiles: [profile] }), localSettings: {
            ...localSettingsDefaults, themePreference: 'light',
            themeProfileSelection: { light: profile.id, dark: null },
        } });
        const { ThemeProfileRuntimeSync } = await import('./ThemeProfileRuntimeSync');
        const screen = await renderScreen(<ThemeProfileRuntimeSync />);
        expect(shared.themes!.light.colors.background.canvas).toBe('#f1e2d3');
        const settings = storage.getState().settings;
        await act(async () => { storage.getState().applySettings(settingsParse({ ...settings,
            themeProfiles: [{ ...profile, overrides: { light: { 'background.canvas': '#ddeeff' }, dark: {} } }],
        }), 1); });
        expect(shared.themes!.light.colors.background.canvas).toBe('#ddeeff');
        await act(async () => { storage.getState().applyLocalSettings({ uiSurfaceFinish: 'flat', uiSurfaceFinishOverrides: { composer: 'soft' } }); });
        expect(shared.themes!.light.parts.card.finish).toBe('flat');
        expect(shared.themes!.light.parts.composer.finish).toBe('soft');
        expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([]);
        const selected = shared.themes!.light; shared.update.mockClear();
        await act(async () => { storage.getState().applyLocalSettings({ uiFontScale: 1.15 }); });
        expect(shared.themes!.light).toBe(selected);
        expect(shared.update).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
