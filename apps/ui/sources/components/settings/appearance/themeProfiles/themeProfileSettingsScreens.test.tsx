import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { flattenTestStyle, flushHookEffects, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { getBuiltInThemeProfileDefinition } from '@/theme/profiles/builtInThemeProfiles';

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const baseProfile = (id: string, overrides: ThemeProfileV1['overrides'] = { light: {}, dark: {} }): ThemeProfileV1 => ({
    schemaVersion: 1,
    id,
    name: `Profile ${id}`,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides,
});

const shared = vi.hoisted(() => ({
    routerPush: vi.fn(),
    routerBack: vi.fn(),
    clipboardSetStringAsync: vi.fn(),
    nativeSharedJson: '',
    sharingShareAsync: vi.fn(),
    nativePickFiles: vi.fn(),
    updateTheme: vi.fn(),
    setAdaptiveThemes: vi.fn(),
    setTheme: vi.fn(),
    setRootViewBackgroundColor: vi.fn(),
    setStatusBarStyle: vi.fn(),
    setSystemBackgroundColorAsync: vi.fn(),
    modalConfirm: vi.fn(),
    params: {} as Record<string, string | undefined>,
    settingsState: {
        themePreference: 'light',
        themeProfiles: { activeProfileIds: { light: null, dark: null }, profiles: [] },
        uiFontScale: 1,
    } as Record<string, unknown>,
}));

type MutableSettingHook = (key: string) => [unknown, (next: unknown) => void];

const createMutableSettingHook = (settingsState: Record<string, unknown>): MutableSettingHook => (key: string) => [
    Object.prototype.hasOwnProperty.call(settingsState, key) ? settingsState[key] : (localSettingsDefaults as Record<string, unknown>)[key],
    (next: unknown) => {
        settingsState[key] = next;
    },
];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Appearance: { getColorScheme: () => 'light' },
    });
});

vi.mock('reanimated-color-picker', async () => {
    const { createReanimatedColorPickerMock } = await import('@/dev/testkit/mocks/reanimatedColorPicker');
    return createReanimatedColorPickerMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: shared.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: shared.setSystemBackgroundColorAsync }));
vi.mock('expo-clipboard', () => ({ setStringAsync: shared.clipboardSetStringAsync }));
const fs = await vi.hoisted(async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock();
});
vi.mock('expo-file-system', () => fs.module);
vi.mock('expo-file-system/legacy', () => {
    throw new Error('expo-file-system/legacy should not be imported');
});
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => true,
    shareAsync: async (uri: string, options?: { mimeType?: string; dialogTitle?: string }) => {
        shared.nativeSharedJson = new TextDecoder().decode(new Uint8Array(fs.files.get(uri)!));
        await shared.sharingShareAsync(uri, options);
    },
}));
vi.mock('@/utils/files/nativePickFiles', () => ({ nativePickFiles: shared.nativePickFiles }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: () => shared.params,
        router: {
            push: shared.routerPush,
            back: shared.routerBack,
        },
    }).module;
});

vi.mock('@/modal', () => ({
    Modal: {
        confirm: shared.modalConfirm,
    },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        runtime: {
            updateTheme: shared.updateTheme,
            setAdaptiveThemes: shared.setAdaptiveThemes,
            setTheme: shared.setTheme,
            setRootViewBackgroundColor: shared.setRootViewBackgroundColor,
        },
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createLiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const mutableSetting = createMutableSettingHook(shared.settingsState);
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: createLiveStorageStoreMock(() => ({
                localSettings: { ...localSettingsDefaults, ...shared.settingsState },
                applyLocalSettings: delta => { Object.assign(shared.settingsState, delta); },
            })),
            useLocalSettingMutable: mutableSetting as typeof import('@/sync/domains/state/storage')['useLocalSettingMutable'],
            useLocalSetting: ((key: string) => mutableSetting(key)[0]) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (typeof params?.name === 'string') return `${params.name} copy`;
                if (typeof params?.count === 'number') return `Custom theme ${params.count}`;
                if (typeof params?.formats === 'string') return `Supported formats: ${params.formats}`;
                return key;
            },
        }),
        getLanguageNativeName: () => 'English',
        SUPPORTED_LANGUAGES: { en: true },
    };
});

const setThemeProfiles = (state: ThemeProfilesLocalStateV1) => {
    shared.settingsState.themeProfiles = state;
};

const getThemeProfiles = (): ThemeProfilesLocalStateV1 => shared.settingsState.themeProfiles as ThemeProfilesLocalStateV1;
const emptyThemeProfiles = (): ThemeProfilesLocalStateV1 => ({ activeProfileIds: { light: null, dark: null }, profiles: [] });
const maxProfiles = (): ThemeProfileV1[] => (
    Array.from({ length: THEME_PROFILE_MAX_PROFILES }, (_, index) => baseProfile(`theme_${index}`))
);

const findPresetDropdown = async (screen: Awaited<ReturnType<typeof renderSettingsView>>) => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    return screen.findAllByType(DropdownMenu as any)
        .find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.themeProfiles.startFrom');
};

const tileIds = (screen: Awaited<ReturnType<typeof renderSettingsView>>, prefix: string): string[] => (
    screen.findAllByProps({ accessibilityRole: 'radio' })
        .map((node: any) => String(node.props.testID ?? ''))
        .filter((testID: string) => testID.startsWith(`${prefix}:`))
        .map((testID: string) => testID.slice(prefix.length + 1))
        .filter((id: string, index: number, all: string[]) => all.indexOf(id) === index)
);

const findAddThemeMenu = async (screen: Awaited<ReturnType<typeof renderSettingsView>>) => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    return screen.findAllByType(DropdownMenu as any)
        .find((node: any) => node.props?.testID === 'settings-theme-profile-add-menu');
};

const findHeaderMenuAction = async (screen: Awaited<ReturnType<typeof renderSettingsView>>, id: string) => (
    screen.findAllByProps({ testID: 'settings-theme-profile-menu' })
        .flatMap((node: any) => (node.props.actions ?? []) as Array<{ id: string; disabled?: boolean; onSelect: () => unknown }>)
        .find((action) => action.id === id)
);

async function renderProfilesScreen() {
    const mod = await import('./ThemeProfilesSettingsScreen');
    return renderSettingsView(React.createElement(mod.ThemeProfilesSettingsScreen), { flushOptions: { cycles: 0 } });
}

async function renderEditorScreen(profileId: string) {
    shared.params = { profileId };
    const mod = await import('./ThemeProfileEditorScreen');
    return renderSettingsView(React.createElement(mod.ThemeProfileEditorScreen), { flushOptions: { cycles: 0 } });
}

async function renderImportScreen() {
    const mod = await import('./ThemeProfileImportScreen');
    return renderSettingsView(React.createElement(mod.ThemeProfileImportScreen), { flushOptions: { cycles: 0 } });
}

async function renderExportScreen() {
    const mod = await import('./ThemeProfileExportScreen');
    return renderSettingsView(React.createElement(mod.ThemeProfileExportScreen), { flushOptions: { cycles: 0 } });
}

afterEach(() => {
    standardCleanup();
    vi.resetModules();
    shared.routerPush.mockClear();
    shared.routerBack.mockClear();
    shared.clipboardSetStringAsync.mockReset();
    fs.files.clear();
    shared.nativeSharedJson = '';
    shared.sharingShareAsync.mockReset();
    shared.nativePickFiles.mockReset();
    shared.nativePickFiles.mockResolvedValue([]);
    shared.updateTheme.mockClear();
    shared.setAdaptiveThemes.mockClear();
    shared.setTheme.mockClear();
    shared.setRootViewBackgroundColor.mockClear();
    shared.setStatusBarStyle.mockClear();
    shared.setSystemBackgroundColorAsync.mockClear();
    shared.modalConfirm.mockReset();
    shared.modalConfirm.mockResolvedValue(true);
    shared.params = {};
    for (const key of Object.keys(shared.settingsState)) {
        delete shared.settingsState[key];
    }
    Object.assign(shared.settingsState, {
        themePreference: 'light',
        themeProfiles: emptyThemeProfiles(),
        uiFontScale: 1,
    });
});

describe('Theme profile settings screen', () => {
    it('offers each mode its themes as visual tiles, with your own themes in their mode', async () => {
        setThemeProfiles({
            activeProfileIds: { light: null, dark: null },
            profiles: [baseProfile('noir', { light: {}, dark: { 'background.canvas': '#0B0B0D' } })],
        });
        const screen = await renderProfilesScreen();

        expect(screen.findByTestId('settings-theme-profiles-screen')).not.toBeNull();
        expect(tileIds(screen, 'settings-theme-light')).toEqual([
            'light',
            'premiumLight',
            'paperLight',
            'catppuccinLatte',
            'githubLight',
        ]);
        expect(tileIds(screen, 'settings-theme-dark')).toEqual([
            'dark',
            'premiumDark',
            'pitchDark',
            'sunsetDark',
            'tokyoNight',
            'nightDark',
            'classicDark',
            'catppuccinMocha',
            'catppuccinMacchiato',
            'catppuccinFrappe',
            'oneDarkPro',
            'monokaiPro',
            'githubDark',
            'darkModern',
            'graphiteDark',
            'noir',
        ]);
        expect(screen.findByTestId('settings-theme-light:light')?.props.accessibilityState?.selected).toBe(true);
        expect(screen.findByTestId('settings-theme-profile-custom-noir')).not.toBeNull();
    });

    it('activates a built-in theme for its mode from the tiles without storing it as a custom profile', async () => {
        const screen = await renderProfilesScreen();

        await screen.pressByTestIdAsync('settings-theme-dark:premiumDark');

        expect(getThemeProfiles().profiles).toEqual([]);
        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: 'premiumDark' });
        expect(shared.settingsState.themePreference).toBe('light');
        expect(shared.updateTheme).toHaveBeenCalled();
    });

    it('returns a mode to its default theme from the default tile', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: 'premiumDark' }, profiles: [] });
        const screen = await renderProfilesScreen();

        expect(screen.findByTestId('settings-theme-dark:premiumDark')?.props.accessibilityState?.selected).toBe(true);
        await screen.pressByTestIdAsync('settings-theme-dark:dark');

        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: null });
    });

    it('offers a new theme when you have none of your own', async () => {
        const screen = await renderProfilesScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-custom-empty');

        expect(getThemeProfiles().profiles).toEqual([]);
        expect(shared.routerPush).toHaveBeenCalledWith({
            pathname: '/settings/appearance/themes/[profileId]',
            params: { profileId: 'new' },
        });
    });

    it('adds a theme from the section menu: a new one or an import', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: [baseProfile('ocean')] });
        const screen = await renderProfilesScreen();
        const addMenu = await findAddThemeMenu(screen);

        await act(async () => {
            addMenu!.props.onSelect('create');
        });
        expect(shared.routerPush).toHaveBeenLastCalledWith({
            pathname: '/settings/appearance/themes/[profileId]',
            params: { profileId: 'new' },
        });

        await act(async () => {
            addMenu!.props.onSelect('import');
        });
        expect(shared.routerPush).toHaveBeenLastCalledWith('/settings/appearance/themes/import');
    });

    it('stops offering new themes once the theme limit is reached', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: maxProfiles() });
        const screen = await renderProfilesScreen();
        const addMenu = await findAddThemeMenu(screen);

        expect(addMenu!.props.items.find((item: { id: string }) => item.id === 'create')?.disabled).toBe(true);
        await act(async () => {
            addMenu!.props.onSelect('create');
        });
        expect(shared.routerPush).not.toHaveBeenCalled();
    });

    it('opens one of your themes in its editor', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: [baseProfile('ocean')] });
        const screen = await renderProfilesScreen();
        await screen.pressByTestIdAsync('settings-theme-profile-custom-ocean');

        expect(shared.routerPush).toHaveBeenCalledWith({
            pathname: '/settings/appearance/themes/[profileId]',
            params: { profileId: 'ocean' },
        });
    });
});

describe('Theme profile editor', () => {
    it('merges its draft into current settings at commit and applies the saved custom theme', async () => {
        const edited = baseProfile('ocean', { light: {}, dark: { 'background.canvas': '#123456' } });
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: [edited] });
        const screen = await renderEditorScreen('ocean');
        shared.setRootViewBackgroundColor.mockClear();
        shared.setStatusBarStyle.mockClear();
        vi.stubGlobal('document', {
            documentElement: { animate: vi.fn() },
            startViewTransition: (update: () => Promise<void>) => ({
                ready: Promise.resolve().then(async () => {
                    shared.settingsState.themePreference = 'dark';
                    shared.settingsState.uiFontScale = 1.2;
                    setThemeProfiles({ activeProfileIds: { light: null, dark: null },
                        profiles: [edited, baseProfile('arrived-during-transition')] });
                    await update();
                }),
            }),
        });
        onTestFinished(() => { vi.unstubAllGlobals(); });

        await screen.pressByTestIdAsync('settings-theme-profile-save');

        expect(getThemeProfiles().profiles.map(profile => profile.id)).toEqual(['ocean', 'arrived-during-transition']);
        expect(shared.settingsState).toMatchObject({ themePreference: 'dark', uiFontScale: 1.2 });
        expect(shared.setTheme).toHaveBeenLastCalledWith('dark');
        expect(shared.setRootViewBackgroundColor).toHaveBeenLastCalledWith('#123456');
        expect(shared.setStatusBarStyle).toHaveBeenLastCalledWith('light', true);
    });
    it('renders token groups and defaults the editing variant to the active app mode', async () => {
        shared.settingsState.themePreference = 'dark';
        setThemeProfiles({ activeProfileIds: { light: null, dark: 'ocean' }, profiles: [baseProfile('ocean')] });

        const screen = await renderEditorScreen('ocean');

        expect(screen.findByTestId('settings-theme-profile-editor')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-color-token-dark-background.canvas')).not.toBeNull();
        expect(screen.findRowByTitle('Canvas background')?.props.subtitle).toBe('App, root, screen, and settings-list backdrop color.');
        expect(screen.findRowByTitle('settingsAppearance.themeProfiles.groups.composer')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-editor-mode:dark')).toBeNull();
        expect(screen.findRowByTitle('settingsAppearance.themeProfiles.editorMode')).toBeNull();
    });

    it('applies draft colors to the live interface preview before save', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');
        shared.updateTheme.mockClear();

        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
            await new Promise((resolve) => setTimeout(resolve, 170));
        });

        const swatch = screen.findByTestId('settings-theme-color-swatch-light-background.canvas');
        expect(swatch?.props.color).toBeUndefined();
        expect(flattenTestStyle(swatch?.props.style).backgroundColor).toBe('#123456');
        expect(shared.updateTheme).toHaveBeenCalled();
    });

    it('opens a new unsaved theme draft and saves it as a custom profile', async () => {
        const screen = await renderEditorScreen('new');

        expect(screen.findByTestId('settings-theme-profile-name')).not.toBeNull();
        expect(getThemeProfiles().profiles).toEqual([]);

        await screen.pressByTestIdAsync('settings-theme-profile-save');

        const saved = getThemeProfiles();
        expect(saved.profiles).toHaveLength(1);
        expect(saved.activeProfileIds).toEqual({ light: saved.profiles[0]?.id, dark: null });
        expect(saved.profiles[0]?.id).toMatch(/^theme_/);
    });

    it('saves the selected asset appearance and assigns that theme slot without changing appearance mode', async () => {
        const screen = await renderEditorScreen('new');
        await screen.pressByTestIdAsync('settings-theme-profile-asset-appearance:dark');
        await screen.pressByTestIdAsync('settings-theme-profile-save');

        const saved = getThemeProfiles().profiles[0] as (ThemeProfileV1 & { assetAppearance?: string }) | undefined;
        expect(saved?.assetAppearance).toBe('dark');
        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: saved?.id });
        expect(shared.settingsState.themePreference).toBe('light');
    });

    it('blocks saving when the profile name is invalid', async () => {
        const screen = await renderEditorScreen('new');

        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-name', '   ');
        });

        expect(screen.findByTestId('settings-theme-profile-name.error')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')?.props.disabled).toBe(true);
    });

    it('blocks saving a new draft after the profile limit is reached', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: maxProfiles() });
        const screen = await renderEditorScreen('new');

        expect(screen.findByTestId('settings-theme-profile-limit-error')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')?.props.disabled).toBe(true);
    });

    it('does not offer persisted-theme operations for a new unsaved theme draft', async () => {
        const screen = await renderEditorScreen('new');

        expect(await findHeaderMenuAction(screen, 'reset')).toBeDefined();
        expect(await findHeaderMenuAction(screen, 'deactivate')).toBeUndefined();
        expect(await findHeaderMenuAction(screen, 'delete')).toBeUndefined();
        expect(await findHeaderMenuAction(screen, 'export')).toBeUndefined();
    });

    it('deletes a saved theme that is not in use from the header menu after confirmation', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');
        const deleteAction = await findHeaderMenuAction(screen, 'delete');

        await act(async () => {
            await deleteAction!.onSelect();
        });

        expect(shared.modalConfirm).toHaveBeenCalled();
        expect(getThemeProfiles()).toEqual({ activeProfileIds: { light: null, dark: null }, profiles: [] });
        expect(shared.routerBack).toHaveBeenCalled();
    });

    it('deletes the theme in use and returns its mode to the default theme', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: 'ocean' }, profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');
        const deleteAction = await findHeaderMenuAction(screen, 'delete');

        await act(async () => {
            await deleteAction!.onSelect();
        });

        expect(getThemeProfiles()).toEqual({ activeProfileIds: { light: null, dark: null }, profiles: [] });
    });

    it('names the slot a theme is assigned to before deleting it, then applies the slot default through the theme owner', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: 'ocean' }, profiles: [baseProfile('ocean')] });
        shared.setStatusBarStyle.mockClear();
        const screen = await renderEditorScreen('ocean');
        const deleteAction = await findHeaderMenuAction(screen, 'delete');

        await act(async () => {
            await deleteAction!.onSelect();
        });

        const [, body] = shared.modalConfirm.mock.calls.at(-1) ?? [];
        expect(body).toBe('settingsAppearance.themeProfiles.deleteAssignedThemeBody');
        expect(getThemeProfiles()).toEqual({ activeProfileIds: { light: null, dark: null }, profiles: [] });
        // The canonical selection owner applies the fallback to the running app, status bar included.
        await vi.waitFor(() => expect(shared.setStatusBarStyle).toHaveBeenCalled());
    });

    it('replaces a clean draft from a selected preset without confirmation', async () => {
        setThemeProfiles({
            activeProfileIds: { light: null, dark: null },
            profiles: [baseProfile('ocean', { light: { 'background.canvas': '#ABCDEF' }, dark: {} })],
        });
        const screen = await renderEditorScreen('new');
        const presetDropdown = await findPresetDropdown(screen);

        await act(async () => {
            presetDropdown!.props.onSelect('ocean');
        });

        expect(shared.modalConfirm).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-theme-color-input-light-background.canvas')?.props.value).toBe('#ABCDEF');
    });

    it('confirms before replacing a dirty draft from another preset', async () => {
        shared.modalConfirm.mockResolvedValueOnce(false);
        setThemeProfiles({
            activeProfileIds: { light: null, dark: null },
            profiles: [baseProfile('ocean', { light: { 'background.canvas': '#ABCDEF' }, dark: {} })],
        });
        const screen = await renderEditorScreen('new');
        const presetDropdown = await findPresetDropdown(screen);

        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
        });
        await act(async () => {
            presetDropdown!.props.onSelect('ocean');
        });

        expect(shared.modalConfirm).toHaveBeenCalled();
        expect(screen.findByTestId('settings-theme-color-input-light-background.canvas')?.props.value).toBe('#123456');
    });

    it('rejects invalid colors and preserves the last valid preview value', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');

        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', 'hotpink');
        });

        expect(screen.findByTestId('settings-theme-color-error-light-background.canvas')).not.toBeNull();
        expect(flattenTestStyle(screen.findByTestId('settings-theme-color-swatch-light-background.canvas')?.props.style).backgroundColor).toBe('#123456');
    });

    it('resets a token override to its fallback value', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [baseProfile('ocean', { light: { 'background.canvas': '#123456' }, dark: {} })] });
        const screen = await renderEditorScreen('ocean');

        expect(screen.findAllByTestId('settings-theme-color-reset-light-background.canvas').some((node) => node.props.subtitle || node.props.title)).toBe(false);

        await screen.pressByTestIdAsync('settings-theme-color-reset-light-background.canvas');

        expect(screen.findByTestId('settings-theme-color-reset-light-background.canvas')).toBeNull();
        expect(flattenTestStyle(screen.findByTestId('settings-theme-color-swatch-light-background.canvas')?.props.style).backgroundColor).not.toBe('#123456');
    });

    it('shows low contrast warnings without blocking save controls', async () => {
        setThemeProfiles({
            activeProfileIds: { light: 'ocean', dark: null },
            profiles: [baseProfile('ocean', { light: { 'background.canvas': '#000000', 'text.primary': '#000000' }, dark: {} })],
        });

        const screen = await renderEditorScreen('ocean');

        expect(screen.findByTestId('settings-theme-contrast-warning-light-text.primary')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')).not.toBeNull();
        expect(await findHeaderMenuAction(screen, 'deactivate')).toBeDefined();
    });

    it('only shows deactivate for the profile that is currently active', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'other', dark: null }, profiles: [baseProfile('ocean'), baseProfile('other')] });
        const screen = await renderEditorScreen('ocean');

        expect(await findHeaderMenuAction(screen, 'deactivate')).toBeUndefined();
    });

    it('deactivates the current profile and leaves the editor to avoid reapplying live preview', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');

        const deactivate = await findHeaderMenuAction(screen, 'deactivate');
        await act(async () => {
            await deactivate!.onSelect();
        });

        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: null });
        expect(shared.routerBack).toHaveBeenCalled();
    });

    it('saves and activates through the runtime profile activation path', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');

        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
        });
        await screen.pressByTestIdAsync('settings-theme-profile-save');

        const saved = getThemeProfiles();
        expect(saved.activeProfileIds).toEqual({ light: 'ocean', dark: null });
        expect(saved.profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
        expect(shared.updateTheme).toHaveBeenCalled();
    });

    it('previews and activates a dark custom theme in its inferred mode even when the app is currently light', async () => {
        shared.settingsState.themePreference = 'light';
        setThemeProfiles({
            activeProfileIds: { light: null, dark: null },
            profiles: [baseProfile('noir', { light: {}, dark: { 'background.canvas': '#0B0B0D' } })],
        });
        const screen = await renderEditorScreen('noir');
        shared.setTheme.mockClear();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 170));
        });

        expect(shared.setTheme).toHaveBeenCalledWith('dark');

        await screen.pressByTestIdAsync('settings-theme-profile-save');

        expect(shared.settingsState.themePreference).toBe('light');
        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: 'noir' });
    });

    it('treats built-in presets as read-only and cloneable', async () => {
        shared.settingsState.themePreference = 'dark';
        const screen = await renderEditorScreen('premiumDark');

        expect(screen.findByTestId('settings-theme-profile-save')).toBeNull();
        expect(await findHeaderMenuAction(screen, 'delete')).toBeUndefined();
        expect(await findHeaderMenuAction(screen, 'duplicate')).toBeDefined();
        expect(screen.findByTestId('settings-theme-color-input-dark-background.canvas')?.props.editable).toBe(false);
        expect(screen.findByTestId('settings-theme-color-reset-dark-background.canvas')).toBeNull();
        expect(await findHeaderMenuAction(screen, 'export')).toBeDefined();
    });

    it('uses built-in preset translation metadata in the editor instead of the raw profile name', async () => {
        const screen = await renderEditorScreen('premiumDark');

        expect(screen.findAllByProps({ testID: 'settings-theme-profile-header' }).find((node: any) => node.props.title)?.props.title).toBe('settingsAppearance.themeProfiles.presets.premiumDark');

        const duplicate = await findHeaderMenuAction(screen, 'duplicate');
        await act(async () => {
            await duplicate!.onSelect();
        });

        expect(getThemeProfiles().profiles[0]?.name).toBe('settingsAppearance.themeProfiles.presets.premiumDark copy');
    });
});

describe('Theme profile import and export screens', () => {
    it('imports pasted valid JSONC as a new profile', async () => {
        const json = `{
            "kind": "happier.themeProfile",
            "schemaVersion": 1,
            "profile": {
                "schemaVersion": 1,
                "id": "shared",
                "name": "Shared",
                "createdAt": "2026-05-12T00:00:00.000Z",
                "updatedAt": "2026-05-12T00:00:00.000Z",
                "base": {
                    "light": "light",
                    "dark": "dark",
                },
                "overrides": {
                    "light": {
                        "background.canvas": "#123456",
                    },
                    "dark": {},
                },
            },
        }`;
        const screen = await renderImportScreen();

        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-import-json', json);
        });
        await screen.pressByTestIdAsync('settings-theme-profile-import-submit');

        expect(getThemeProfiles().profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
        expect(shared.routerBack).toHaveBeenCalled();
    });

    it('imports a theme JSON file picked from disk', async () => {
        const json = exportThemeProfileToJson(baseProfile('shared', { light: { 'background.canvas': '#123456' }, dark: {} }));
        shared.nativePickFiles.mockResolvedValueOnce([{ kind: 'web', file: new File([json], 'theme.json', { type: 'application/json' }) }]);
        const screen = await renderImportScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-import-file');
        await screen.pressByTestIdAsync('settings-theme-profile-import-submit');

        expect(getThemeProfiles().profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
    });

    it('imports a native theme JSON file through Expo File', async () => {
        const json = exportThemeProfileToJson(baseProfile('shared', { light: { 'background.canvas': '#123456' }, dark: {} }));
        fs.files.set('file:///picked/theme.json', [...new TextEncoder().encode(json)]);
        shared.nativePickFiles.mockResolvedValueOnce([{ kind: 'native', uri: 'file:///picked/theme.json', name: 'theme.json', mimeType: 'application/json' }]);
        const screen = await renderImportScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-import-file');
        await screen.pressByTestIdAsync('settings-theme-profile-import-submit');

        expect(getThemeProfiles().profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
    });

    it('shows the supported import formats hint on the import screen', async () => {
        const screen = await renderImportScreen();

        expect(screen.getTextContent()).toContain('Supported formats: Happier theme profile JSON, VS Code theme JSON');
    });

    it('keeps import warnings visible before leaving the import screen', async () => {
        const json = JSON.stringify({
            kind: 'happier.themeProfile',
            schemaVersion: 1,
            profile: baseProfile('shared', { light: { 'unknown.token': '#123456' }, dark: {} }),
        });
        const screen = await renderImportScreen();

        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-import-json', json);
        });
        await screen.pressByTestIdAsync('settings-theme-profile-import-submit');

        expect(screen.findByTestId('settings-theme-profile-import-warnings')).not.toBeNull();
        expect(getThemeProfiles().profiles).toHaveLength(1);
        expect(shared.routerBack).not.toHaveBeenCalled();
    });

    it('shows an error for invalid import JSON', async () => {
        const screen = await renderImportScreen();

        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-import-json', '{not json}');
        });
        await screen.pressByTestIdAsync('settings-theme-profile-import-submit');

        expect(screen.findByTestId('settings-theme-profile-import-json.error')).not.toBeNull();
        expect(getThemeProfiles().profiles).toHaveLength(0);
    });

    it('exports the selected profile full resolved theme JSON and copies it to the clipboard', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [baseProfile('ocean', { light: { 'background.canvas': '#123456' }, dark: {} })] });
        shared.params = { profileId: 'ocean' };
        const screen = await renderExportScreen();

        const exportTextArea = screen.findByTestId('settings-theme-profile-export-json');
        expect(exportTextArea?.props.value).toContain('happier.themeProfile');
        expect(exportTextArea?.props.value).toContain('text.primary');

        await screen.pressByTestIdAsync('settings-theme-profile-export-copy');

        expect(shared.clipboardSetStringAsync).toHaveBeenCalledWith(expect.stringContaining('happier.themeProfile'));
    });

    it('downloads the selected profile JSON through the platform file handoff', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [baseProfile('ocean', { light: { 'background.canvas': '#123456' }, dark: {} })] });
        shared.params = { profileId: 'ocean' };
        const screen = await renderExportScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-export-download');
        // RoundButton's synchronous onPress does not return the async export promise.
        await vi.waitFor(() => expect(shared.sharingShareAsync).toHaveBeenCalledOnce());
        await flushHookEffects();

        const [exportedUri] = shared.sharingShareAsync.mock.calls.at(-1)!;
        expect(exportedUri).toContain('/happier-downloads/');
        expect(shared.nativeSharedJson).toContain('happier.themeProfile');
        expect(fs.files.size).toBe(0);
    });

    it('does not export an arbitrary custom profile when no profile is selected for export', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: 'premiumDark' }, profiles: [baseProfile('ocean', { light: { 'background.canvas': '#123456' }, dark: {} })] });
        const screen = await renderExportScreen();

        expect(screen.findByTestId('settings-theme-profile-export-json')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-export-copy')).toBeNull();
    });
});
