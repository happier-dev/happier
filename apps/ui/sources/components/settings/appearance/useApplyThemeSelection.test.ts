import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { storage, useLocalSettingMutable, useThemeProfilesMutable } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { setActiveThemeProfileForMode } from '@/theme/profiles/themeProfilePersistence';
import { registerNativeThemePreferenceTransitionController } from './themePreferenceTransition';
import { useApplyThemeSelection } from './useApplyThemeSelection';

const boundary = vi.hoisted(() => ({
    updateTheme: vi.fn<(name: 'light' | 'dark', update: (theme: Theme) => Theme) => void>(),
}));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, { Appearance: { getColorScheme: () => 'light' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: { updateTheme: boundary.updateTheme } });
});
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: async () => {} }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: () => {} }));

const profile = (id: string, color: string): ThemeProfileV1 => ({
    schemaVersion: 1, id, name: id, createdAt: '2026-10-01', updatedAt: '2026-10-01',
    base: { light: 'light', dark: 'dark' }, overrides: { light: { 'background.canvas': color }, dark: { 'background.canvas': color } },
});

function useSelection() {
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles, setThemeProfiles] = useThemeProfilesMutable();
    const apply = useApplyThemeSelection({ themePreference, setThemePreference, setThemeProfiles, reduceMotion: false });
    return { themeProfiles, apply };
}

describe('theme selection commit', () => {
    const initial = storage.getState();
    let unregister = () => {};
    afterEach(() => { unregister(); getPersistenceStorage().clearAll(); storage.setState(initial, true); vi.clearAllMocks(); });

    it('applies the accepted current library after settings arrive during the native transition', async () => {
        const selected = profile('selected', '#123456');
        const incoming = profile('incoming', '#abcdef');
        storage.setState({ settingsScope: { serverId: 'server', accountId: 'account' },
            settings: { ...settingsDefaults, themeProfiles: [selected] }, localSettings: { ...localSettingsDefaults } });
        const themes: Record<'light' | 'dark', Theme> = { light: lightTheme, dark: darkTheme };
        boundary.updateTheme.mockImplementation((name, update) => { themes[name] = update(themes[name]); });
        let commit: (() => void) | undefined;
        unregister = registerNativeThemePreferenceTransitionController({ run: mutation => { commit = mutation; } });
        const hook = await renderHook(useSelection);
        try {
            const captured = hook.getCurrent();
            await act(async () => captured.apply('dark', setActiveThemeProfileForMode(captured.themeProfiles, 'dark', selected.id)));
            expect(commit).toBeTypeOf('function');
            await act(async () => {
                storage.getState().applySettingsLocal({ themeProfiles: [profile(selected.id, '#654321'), incoming] });
                storage.getState().applyLocalSettings({ themeProfileSelection: { light: incoming.id, dark: null } });
            });
            await act(async () => commit?.());
            expect(storage.getState().localSettings.themeProfileSelection).toEqual({ light: incoming.id, dark: selected.id });
            expect(storage.getState().settings.themeProfiles.map(entry => entry.id)).toEqual([selected.id, incoming.id]);
            expect(themes.dark.colors.background.canvas).toBe('#654321');
        } finally { await hook.unmount(); }
    });

    it('keeps appearance preference unchanged when a delayed profile write is rejected after account switching', async () => {
        storage.setState({ settingsScope: { serverId: 'server', accountId: 'first' },
            settings: { ...settingsDefaults }, localSettings: { ...localSettingsDefaults, themePreference: 'light' } });
        let commit: (() => void) | undefined;
        unregister = registerNativeThemePreferenceTransitionController({ run: mutation => { commit = mutation; } });
        const hook = await renderHook(useSelection);
        try {
            const captured = hook.getCurrent();
            await act(async () => captured.apply('dark', captured.themeProfiles));
            await act(async () => storage.setState({ settingsScope: { serverId: 'server', accountId: 'second' } }));
            await act(async () => { expect(() => commit?.()).toThrow(); });
            expect(storage.getState().localSettings.themePreference).toBe('light');
        } finally { await hook.unmount(); }
    });
});
