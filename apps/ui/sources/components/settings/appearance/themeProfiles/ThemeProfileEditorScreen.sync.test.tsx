import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { ThemeProfileEditorScreen } from './ThemeProfileEditorScreen';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import { activateThemeProfile } from '@/theme/profiles/themeProfileRuntime';
import { rebaseThemeProfileUiChange, rememberThemeProfileMigration, resolveAccountThemeProfileView } from '@/sync/domains/settings/themeProfiles';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';

const boundary = vi.hoisted(() => ({
    params: { profileId: 'ocean' },
    updateTheme: vi.fn<(name: 'light' | 'dark', update: (theme: Theme) => Theme) => void>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Appearance: { getColorScheme: () => 'light' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: { updateTheme: boundary.updateTheme } });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => boundary.params }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('reanimated-color-picker', async () => {
    const { createReanimatedColorPickerMock } = await import('@/dev/testkit/mocks/reanimatedColorPicker');
    return createReanimatedColorPickerMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: async () => {} }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: () => {} }));

describe('theme editor with live settings', () => {
    const initial = storage.getState();
    afterEach(() => { getPersistenceStorage().clearAll(); storage.setState(initial, true); boundary.params = { profileId: 'ocean' }; vi.clearAllMocks(); });

    it('retains its unsaved draft across source refresh and saves without deleting arriving profiles', async () => {
        getPersistenceStorage().clearAll();
        const profile: ThemeProfileV1 = { schemaVersion: 1, id: 'ocean', name: 'Ocean',
            createdAt: '2026-10-01', updatedAt: '2026-10-01', base: { light: 'light', dark: 'dark' },
            overrides: { light: {}, dark: {} } };
        storage.setState({ settingsScope: null, settings: { ...settingsDefaults },
            localSettings: { ...localSettingsDefaults, themeProfiles: {
                profiles: [profile], activeProfileIds: { light: null, dark: null },
            } } });
        const screen = await renderScreen(<ThemeProfileEditorScreen />);
        try {
            await act(async () => screen.changeTextByTestId('settings-theme-profile-name', 'My unsaved name'));
            await act(async () => {
                storage.getState().applyLocalSettings({ themeProfiles: {
                    profiles: [{ ...profile, name: 'Refreshed source' }, { ...profile, id: 'incoming', name: 'Incoming' }],
                    activeProfileIds: { light: null, dark: null },
                } });
            });
            expect(screen.findByTestId('settings-theme-profile-name')?.props.value).toBe('My unsaved name');
            await screen.pressByTestIdAsync('settings-theme-profile-save');
            expect(storage.getState().localSettings.themeProfiles.profiles.map(entry => [entry.id, entry.name])).toEqual([
                ['ocean', 'My unsaved name'], ['incoming', 'Incoming'],
            ]);
        } finally {
            await screen.unmount();
        }
    });

    it('allows repeated saves after a new draft fills the creation limit', async () => {
        boundary.params = { profileId: 'new' };
        const existingProfiles = Array.from({ length: THEME_PROFILE_MAX_PROFILES - 1 }, (_, index): ThemeProfileV1 => ({
            schemaVersion: 1, id: `existing_${index}`, name: `Existing ${index}`, createdAt: '2026-10-01', updatedAt: '2026-10-01',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
        }));
        storage.setState({ settingsScope: null, settings: { ...settingsDefaults },
            localSettings: { ...localSettingsDefaults, themeProfiles: {
                profiles: existingProfiles, activeProfileIds: { light: null, dark: null },
            } } });
        const screen = await renderScreen(<ThemeProfileEditorScreen />);
        try {
            await screen.pressByTestIdAsync('settings-theme-profile-save');
            await act(async () => screen.changeTextByTestId('settings-theme-profile-name', 'Second save'));
            await screen.pressByTestIdAsync('settings-theme-profile-save');
            expect(storage.getState().localSettings.themeProfiles.profiles).toHaveLength(THEME_PROFILE_MAX_PROFILES);
            expect(storage.getState().localSettings.themeProfiles.profiles.find(profile => !profile.id.startsWith('existing_'))?.name)
                .toBe('Second save');
        } finally { await screen.unmount(); }
    });

    it('applies the accepted rebased library to the runtime after a collision is acknowledged', async () => {
        const scope = { serverId: 'runtime', accountId: 'accepted' };
        const profile: ThemeProfileV1 = { schemaVersion: 1, id: 'same', name: 'Legacy', createdAt: '2026-10-01', updatedAt: '2026-10-01',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: { 'background.canvas': '#123456' } } };
        const empty = { profiles: [], activeProfileIds: { light: null, dark: null } };
        const captured = resolveAccountThemeProfileView({ profiles: [], legacy: { ...empty, profiles: [profile] },
            selection: null, scope, legacyScope: null });
        rememberThemeProfileMigration(scope, new Map([['same', 'same_2']]));
        const current = resolveAccountThemeProfileView({ profiles: [
            { ...profile, name: 'Cloud', overrides: { light: { 'background.canvas': '#abcdef' }, dark: {} } }, { ...profile, id: 'same_2' },
        ], legacy: empty, selection: { light: 'same', dark: 'same_2' }, legacyScope: scope, scope });
        const themes: Record<'light' | 'dark', Theme> = { light: lightTheme, dark: darkTheme };
        boundary.updateTheme.mockImplementation((name, update) => { themes[name] = update(themes[name]); });

        await activateThemeProfile({ profileId: 'same', profileMode: 'dark', reduceMotion: true, platform: 'web',
            systemTheme: 'light', loadLocalSettings: () => ({ themePreference: 'light', themeProfiles: captured.state }),
            // Persistence may resolve a legacy identity while committing; runtime must consume its accepted result.
            saveLocalSettings: next => ({ ...next, themeProfiles: rebaseThemeProfileUiChange(captured, next.themeProfiles, current) }),
        });

        expect(themes.light.colors.background.canvas).toBe('#abcdef');
        expect(themes.dark.colors.background.canvas).toBe('#123456');
    });
});
