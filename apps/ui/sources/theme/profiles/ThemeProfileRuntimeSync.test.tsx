import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { lightTheme, darkTheme, type Theme } from '@/theme';
import type { ThemeProfileV1 } from './themeProfileTypes';
import { ThemeProfileRuntimeSync } from './ThemeProfileRuntimeSync';

// Unistyles is the native/web rendering boundary; settings composition and resolution stay real.
const runtime = vi.hoisted(() => ({
    updateTheme: vi.fn<(name: 'light' | 'dark', update: (theme: Theme) => Theme) => void>(),
    setRootViewBackgroundColor: vi.fn(),
}));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime });
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Appearance: { getColorScheme: () => 'light' } });
});
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: async () => {} }));

describe('synced active theme runtime', () => {
    const initialState = storage.getState();
    const profile: ThemeProfileV1 = {
        schemaVersion: 1, id: 'ocean', name: 'Ocean',
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
        base: { light: 'light', dark: 'dark' }, assetAppearance: 'light',
        overrides: { light: { 'background.canvas': '#123456' }, dark: {} },
    };

    beforeEach(() => {
        getPersistenceStorage().clearAll();
        vi.clearAllMocks();
        storage.setState({
            settings: { ...settingsDefaults, themeProfiles: [profile] },
            settingsScope: { serverId: 'server-a', accountId: 'account-a' },
            localSettings: { ...localSettingsDefaults, themePreference: 'light',
                themeProfileSelection: { light: profile.id, dark: null } },
        });
    });

    afterEach(() => {
        getPersistenceStorage().clearAll();
        storage.setState(initialState, true);
    });

    it('applies remote edits and deletion without repeating theme work for unrelated settings', async () => {
        const themes: Record<'light' | 'dark', Theme> = { light: lightTheme, dark: darkTheme };
        runtime.updateTheme.mockImplementation((name, update) => { themes[name] = update(themes[name]); });
        const screen = await renderScreen(<ThemeProfileRuntimeSync />);
        try {
            expect(themes.light.colors.background.canvas).toBe('#123456');
            const initialUpdates = runtime.updateTheme.mock.calls.length;
            await act(async () => {
                storage.getState().applySettingsLocal({ showLineNumbers: false });
            });
            expect(runtime.updateTheme).toHaveBeenCalledTimes(initialUpdates);

            await act(async () => {
                storage.getState().applySettingsLocal({ themeProfiles: [{ ...profile,
                    overrides: { ...profile.overrides, light: { 'background.canvas': '#654321' } },
                }] });
            });
            expect(themes.light.colors.background.canvas).toBe('#654321');
            expect(storage.getState().localSettings.themeProfileSelection).toEqual({ light: 'ocean', dark: null });

            await act(async () => { storage.getState().applySettingsLocal({ themeProfiles: [] }); });
            expect(themes.light.colors.background.canvas).toBe(lightTheme.colors.background.canvas);
        } finally {
            await screen.unmount();
        }
    });
});
