import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { applyLocalSettings, localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import { resolveAppearanceDefaults } from '@/components/settings/appearance/appearanceDefaults';

const shared = vi.hoisted(() => ({
    local: null as LocalSettings | null,
    themes: null as Record<'light' | 'dark', Theme> | null,
    update: vi.fn((name: 'light' | 'dark', updater: (theme: Theme) => Theme) => {
        if (shared.themes) shared.themes[name] = updater(shared.themes[name]);
    }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Appearance: { getColorScheme: () => 'light' } });
});

// The OS theme adapter is the boundary; the scale/profile/application owners below it stay real.
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: {
        getTheme: (name: 'light' | 'dark') => shared.themes?.[name],
        updateTheme: shared.update,
    } });
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createLiveStorageStoreMock, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    return createStorageModuleStub({
        storage: createLiveStorageStoreMock(() => ({ localSettings: shared.local ?? localSettingsDefaults })),
        useLocalSetting: createUseLocalSettingMock({ fallback: key => (shared.local ?? localSettingsDefaults)[key] }),
    });
});

afterEach(standardCleanup);

describe('surface finish runtime', () => {
    it('applies local and Reset writes in place and keeps theme identity when the selected values have not changed', async () => {
        shared.local = localSettingsDefaults;
        shared.themes = { light: lightTheme, dark: darkTheme };
        shared.update.mockClear();
        const { SurfaceFinishRuntime } = await import('./SurfaceFinishRuntime');
        const screen = await renderScreen(<SurfaceFinishRuntime />);
        expect(shared.update).not.toHaveBeenCalled();
        shared.local = applyLocalSettings(shared.local, { uiSurfaceFinish: 'flat', uiSurfaceFinishOverrides: { composer: 'soft' } });
        await act(async () => screen.update(<SurfaceFinishRuntime />));
        expect(shared.themes.light.parts.card.finish).toBe('flat');
        expect(shared.themes.light.parts.composer.finish).toBe('soft');
        const selected = shared.themes.light;
        shared.update.mockClear();
        await act(async () => screen.update(<SurfaceFinishRuntime />));
        expect(shared.themes.light).toBe(selected);
        expect(shared.update).not.toHaveBeenCalled();
        shared.local = applyLocalSettings(shared.local, resolveAppearanceDefaults().local);
        await act(async () => screen.update(<SurfaceFinishRuntime />));
        expect(shared.themes.light.finish).toBe('soft');
        expect(shared.themes.light.parts.card.finish).toBe('soft');
        expect(shared.local.uiSurfaceFinishOverrides).toEqual({});
    });
});
