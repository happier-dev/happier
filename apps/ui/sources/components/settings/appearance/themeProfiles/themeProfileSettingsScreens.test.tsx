import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { getBuiltInThemeProfileDefinition } from '@/theme/profiles/builtInThemeProfiles';
import type { ItemAction } from '@/components/ui/lists/itemActions';

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
    fileSystemReadAsStringAsync: vi.fn(),
    fileSystemWriteAsStringAsync: vi.fn(),
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
        themeProfiles: { activeProfileId: null, profiles: [] },
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
vi.mock('expo-file-system/legacy', () => ({
    EncodingType: { UTF8: 'utf8' },
    cacheDirectory: 'file:///cache/',
    readAsStringAsync: shared.fileSystemReadAsStringAsync,
    writeAsStringAsync: shared.fileSystemWriteAsStringAsync,
}));
vi.mock('expo-sharing', () => ({ shareAsync: shared.sharingShareAsync }));
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
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const mutableSetting = createMutableSettingHook(shared.settingsState);
    return createStorageModuleMock({
        importOriginal,
        overrides: {
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
const maxProfiles = (): ThemeProfileV1[] => (
    Array.from({ length: THEME_PROFILE_MAX_PROFILES }, (_, index) => baseProfile(`theme_${index}`))
);

const findPresetDropdown = async (screen: Awaited<ReturnType<typeof renderSettingsView>>) => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    return screen.findAllByType(DropdownMenu as any)
        .find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.themeProfiles.presetSource');
};

const findBuiltInThemesDropdown = async (screen: Awaited<ReturnType<typeof renderSettingsView>>) => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    return screen.findAllByType(DropdownMenu as any)
        .find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.themeProfiles.builtInGroup');
};

const findAssetAppearanceDropdown = async (screen: Awaited<ReturnType<typeof renderSettingsView>>) => {
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    return screen.findAllByType(DropdownMenu as any)
        .find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.themeProfiles.assetAppearance');
};

const findRowActionsInNode = (node: React.ReactNode): ItemAction[] => {
    if (!React.isValidElement(node)) return [];
    const props = node.props as { actions?: ItemAction[]; children?: React.ReactNode };
    if (Array.isArray(props.actions)) return props.actions;
    return React.Children.toArray(props.children).flatMap(findRowActionsInNode);
};

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
    shared.fileSystemReadAsStringAsync.mockReset();
    shared.fileSystemWriteAsStringAsync.mockReset();
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
        themeProfiles: { activeProfileId: null, profiles: [] },
        uiFontScale: 1,
    });
});

describe('Theme profile settings screen', () => {
    it('renders built-in themes in a management dropdown and shows custom themes only when they exist', async () => {
        setThemeProfiles({ activeProfileId: null, profiles: [baseProfile('theme_ocean')] });
        const screen = await renderProfilesScreen();

        expect(screen.findByTestId('settings-theme-profiles-screen')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-built-in-dropdown-trigger')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-built-in-premiumDark')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-custom-theme_ocean')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-selector-trigger')).toBeNull();

        const builtInDropdown = await findBuiltInThemesDropdown(screen);
        expect(builtInDropdown?.props.items.map((item: { id: string }) => item.id)).toEqual([
            'light',
            'dark',
            'premiumDark',
            'pitchDark',
            'sunsetDark',
            'tokyoNight',
            'nightDark',
            'catppuccinMocha',
            'catppuccinMacchiato',
            'catppuccinFrappe',
            'oneDarkPro',
            'monokaiPro',
            'githubDark',
            'darkModern',
            'graphiteDark',
            'premiumLight',
            'paperLight',
            'catppuccinLatte',
            'githubLight',
        ]);
    });

    it('does not render a custom themes section when there are no custom profiles', async () => {
        const screen = await renderProfilesScreen();

        expect(screen.findByTestId('settings-theme-profile-custom-empty')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-create')).not.toBeNull();
    });

    it('activates a built-in theme from the built-in dropdown without storing it as a custom profile', async () => {
        const screen = await renderProfilesScreen();

        const builtInDropdown = await findBuiltInThemesDropdown(screen);

        await act(async () => {
            builtInDropdown!.props.onSelect('premiumDark');
        });

        expect(getThemeProfiles().profiles).toEqual([]);
        expect(getThemeProfiles().activeProfileId).toBe('premiumDark');
        expect(shared.updateTheme).toHaveBeenCalled();
    });

    it('duplicates a built-in theme from row actions and opens its editor', async () => {
        const screen = await renderProfilesScreen();
        const builtInDropdown = await findBuiltInThemesDropdown(screen);
        const premiumDarkItem = builtInDropdown!.props.items.find((item: { id: string }) => item.id === 'premiumDark');
        const duplicateAction = findRowActionsInNode(premiumDarkItem.rightElement).find((action) => action.id === 'duplicate-premiumDark');

        await act(async () => {
            duplicateAction!.onPress();
        });

        const [clone] = getThemeProfiles().profiles;
        expect(clone?.id).not.toBe('premiumDark');
        expect(clone?.overrides.dark['background.canvas']).toBeDefined();
        expect(shared.routerPush).toHaveBeenCalledWith({
            pathname: '/settings/appearance/themes/[profileId]',
            params: { profileId: clone?.id },
        });
    });

    it('disables profile creation and duplicate actions after the profile limit is reached', async () => {
        setThemeProfiles({ activeProfileId: null, profiles: maxProfiles() });
        const screen = await renderProfilesScreen();
        const builtInDropdown = await findBuiltInThemesDropdown(screen);
        const premiumDarkItem = builtInDropdown!.props.items.find((item: { id: string }) => item.id === 'premiumDark');

        expect(screen.findByTestId('settings-theme-profile-create')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings-theme-duplicate-premiumDark')).toBeNull();
        expect(findRowActionsInNode(premiumDarkItem.rightElement)).toEqual([]);
    });

    it('opens a new unsaved theme editor from the actions group', async () => {
        const screen = await renderProfilesScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-create');

        expect(getThemeProfiles().profiles).toEqual([]);
        expect(shared.routerPush).toHaveBeenCalledWith({
            pathname: '/settings/appearance/themes/[profileId]',
            params: { profileId: 'new' },
        });
    });

    it('keeps custom theme management controls in row actions', async () => {
        setThemeProfiles({ activeProfileId: null, profiles: [baseProfile('ocean')] });
        const screen = await renderProfilesScreen();
        await screen.pressByTestIdAsync('settings-theme-edit-ocean');

        expect(shared.routerPush).toHaveBeenCalledWith({
            pathname: '/settings/appearance/themes/[profileId]',
            params: { profileId: 'ocean' },
        });
    });

    it('deletes a custom theme from row actions after confirmation', async () => {
        setThemeProfiles({ activeProfileId: 'ocean', profiles: [baseProfile('ocean')] });
        const screen = await renderProfilesScreen();
        await screen.pressByTestIdAsync('settings-theme-delete-ocean');

        expect(shared.modalConfirm).toHaveBeenCalled();
        expect(getThemeProfiles()).toEqual({ activeProfileId: null, profiles: [] });
    });
});

describe('Theme profile editor', () => {
    it('renders token groups and defaults the editing variant to the active app mode', async () => {
        shared.settingsState.themePreference = 'dark';
        setThemeProfiles({ activeProfileId: 'ocean', profiles: [baseProfile('ocean')] });

        const screen = await renderEditorScreen('ocean');

        expect(screen.findByTestId('settings-theme-profile-editor')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-color-token-dark-background.canvas')).not.toBeNull();
        expect(screen.findRowByTitle('Canvas background')?.props.subtitle).toBe('App, root, screen, and settings-list backdrop color.');
        expect(screen.findByTestId('settings-theme-editor-mode:dark')).toBeNull();
        expect(screen.findRowByTitle('settingsAppearance.themeProfiles.editorMode')).toBeNull();
    });

    it('renders profile name as an inline transparent text field', async () => {
        const screen = await renderEditorScreen('new');
        const inputStyle = flattenTestStyle(screen.findByTestId('settings-theme-profile-name')?.props.style);

        expect(inputStyle.backgroundColor).toBe('transparent');
        expect(inputStyle.textAlign).toBe('left');
        expect(inputStyle.borderWidth).toBe(0);
    });

    it('applies draft colors to the live interface preview before save', async () => {
        setThemeProfiles({ activeProfileId: 'ocean', profiles: [baseProfile('ocean')] });
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
        expect(saved.activeProfileId).toBe(saved.profiles[0]?.id);
        expect(saved.profiles[0]?.id).toMatch(/^theme_/);
    });

    it('saves the selected asset appearance and uses it as the activation mode', async () => {
        const screen = await renderEditorScreen('new');
        const assetAppearanceDropdown = await findAssetAppearanceDropdown(screen);

        await act(async () => {
            assetAppearanceDropdown?.props.onSelect('dark');
        });
        await screen.pressByTestIdAsync('settings-theme-profile-save');

        const saved = getThemeProfiles().profiles[0] as (ThemeProfileV1 & { assetAppearance?: string }) | undefined;
        expect(saved?.assetAppearance).toBe('dark');
        expect(shared.settingsState.themePreference).toBe('dark');
    });

    it('blocks saving when the profile name is invalid', async () => {
        const screen = await renderEditorScreen('new');

        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-name', '   ');
        });

        expect(screen.findByTestId('settings-theme-profile-name-error')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')?.props.disabled).toBe(true);
    });

    it('blocks saving a new draft after the profile limit is reached', async () => {
        setThemeProfiles({ activeProfileId: null, profiles: maxProfiles() });
        const screen = await renderEditorScreen('new');

        expect(screen.findByTestId('settings-theme-profile-limit-error')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')?.props.disabled).toBe(true);
    });

    it('does not show persisted-profile actions for a new unsaved theme draft', async () => {
        const screen = await renderEditorScreen('new');

        expect(screen.findByTestId('settings-theme-profile-reset-light')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-deactivate')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-delete')).toBeNull();
    });

    it('replaces a clean draft from a selected preset without confirmation', async () => {
        setThemeProfiles({
            activeProfileId: null,
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
            activeProfileId: null,
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
        setThemeProfiles({ activeProfileId: 'ocean', profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');

        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', 'hotpink');
        });

        expect(screen.findByTestId('settings-theme-color-error-light-background.canvas')).not.toBeNull();
        expect(flattenTestStyle(screen.findByTestId('settings-theme-color-swatch-light-background.canvas')?.props.style).backgroundColor).toBe('#123456');
    });

    it('resets a token override to its fallback value', async () => {
        setThemeProfiles({ activeProfileId: 'ocean', profiles: [baseProfile('ocean', { light: { 'background.canvas': '#123456' }, dark: {} })] });
        const screen = await renderEditorScreen('ocean');

        expect(screen.findAllByTestId('settings-theme-color-reset-light-background.canvas').some((node) => node.props.subtitle || node.props.title)).toBe(false);

        await screen.pressByTestIdAsync('settings-theme-color-reset-light-background.canvas');

        expect(screen.findByTestId('settings-theme-color-reset-light-background.canvas')).toBeNull();
        expect(flattenTestStyle(screen.findByTestId('settings-theme-color-swatch-light-background.canvas')?.props.style).backgroundColor).not.toBe('#123456');
    });

    it('shows low contrast warnings without blocking save controls', async () => {
        setThemeProfiles({
            activeProfileId: 'ocean',
            profiles: [baseProfile('ocean', { light: { 'background.canvas': '#000000', 'text.primary': '#000000' }, dark: {} })],
        });

        const screen = await renderEditorScreen('ocean');

        expect(screen.findByTestId('settings-theme-contrast-warning-light-text.primary')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-deactivate')).not.toBeNull();
    });

    it('only shows deactivate for the profile that is currently active', async () => {
        setThemeProfiles({ activeProfileId: 'other', profiles: [baseProfile('ocean'), baseProfile('other')] });
        const screen = await renderEditorScreen('ocean');

        expect(screen.findByTestId('settings-theme-profile-deactivate')).toBeNull();
    });

    it('deactivates the current profile and leaves the editor to avoid reapplying live preview', async () => {
        setThemeProfiles({ activeProfileId: 'ocean', profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');

        await screen.pressByTestIdAsync('settings-theme-profile-deactivate');

        expect(getThemeProfiles().activeProfileId).toBeNull();
        expect(shared.routerBack).toHaveBeenCalled();
    });

    it('saves and activates through the runtime profile activation path', async () => {
        setThemeProfiles({ activeProfileId: null, profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');

        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
        });
        await screen.pressByTestIdAsync('settings-theme-profile-save');

        const saved = getThemeProfiles();
        expect(saved.activeProfileId).toBe('ocean');
        expect(saved.profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
        expect(shared.updateTheme).toHaveBeenCalled();
    });

    it('previews and activates a dark custom theme in its inferred mode even when the app is currently light', async () => {
        shared.settingsState.themePreference = 'light';
        setThemeProfiles({
            activeProfileId: null,
            profiles: [baseProfile('noir', { light: {}, dark: { 'background.canvas': '#0B0B0D' } })],
        });
        const screen = await renderEditorScreen('noir');
        shared.setTheme.mockClear();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 170));
        });

        expect(shared.setTheme).toHaveBeenCalledWith('dark');

        await screen.pressByTestIdAsync('settings-theme-profile-save');

        expect(shared.settingsState.themePreference).toBe('dark');
        expect(getThemeProfiles().activeProfileId).toBe('noir');
    });

    it('treats built-in presets as read-only and cloneable', async () => {
        shared.settingsState.themePreference = 'dark';
        const screen = await renderEditorScreen('premiumDark');

        expect(screen.findByTestId('settings-theme-profile-save')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-delete')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-clone-premiumDark')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-color-input-dark-background.canvas')?.props.editable).toBe(false);
        expect(screen.findByTestId('settings-theme-color-reset-dark-background.canvas')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-export-premiumDark')).not.toBeNull();
    });

    it('uses built-in preset translation metadata in the editor instead of the raw profile name', async () => {
        const screen = await renderEditorScreen('premiumDark');

        expect(screen.findRowByTitle('settingsAppearance.themeProfiles.readOnlyPreset')?.props.detail).toBe('settingsAppearance.themeProfiles.presets.premiumDark');
        expect(screen.findAllByTestId('settings-theme-profile-clone-premiumDark').find((node) => node.props.subtitle)?.props.subtitle).toBe('settingsAppearance.themeProfiles.presets.premiumDark');

        await screen.pressByTestIdAsync('settings-theme-profile-clone-premiumDark');

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

        expect(screen.findByTestId('settings-theme-profile-import-error')).not.toBeNull();
        expect(getThemeProfiles().profiles).toHaveLength(0);
    });

    it('exports the selected profile full resolved theme JSON and copies it to the clipboard', async () => {
        setThemeProfiles({ activeProfileId: 'ocean', profiles: [baseProfile('ocean', { light: { 'background.canvas': '#123456' }, dark: {} })] });
        shared.params = { profileId: 'ocean' };
        const screen = await renderExportScreen();

        const exportTextArea = screen.findByTestId('settings-theme-profile-export-json');
        expect(exportTextArea?.props.value).toContain('happier.themeProfile');
        expect(exportTextArea?.props.value).toContain('text.primary');

        await screen.pressByTestIdAsync('settings-theme-profile-export-copy');

        expect(shared.clipboardSetStringAsync).toHaveBeenCalledWith(expect.stringContaining('happier.themeProfile'));
    });

    it('downloads the selected profile JSON through the platform file handoff', async () => {
        setThemeProfiles({ activeProfileId: 'ocean', profiles: [baseProfile('ocean', { light: { 'background.canvas': '#123456' }, dark: {} })] });
        shared.params = { profileId: 'ocean' };
        const screen = await renderExportScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-export-download');

        expect(shared.fileSystemWriteAsStringAsync).toHaveBeenCalledWith(
            expect.stringContaining('happier-theme-profile-ocean.json'),
            expect.stringContaining('happier.themeProfile'),
            expect.any(Object),
        );
        expect(shared.sharingShareAsync).toHaveBeenCalled();
    });

    it('does not export an arbitrary custom profile when no profile is selected for export', async () => {
        setThemeProfiles({ activeProfileId: 'premiumDark', profiles: [baseProfile('ocean', { light: { 'background.canvas': '#123456' }, dark: {} })] });
        const screen = await renderExportScreen();

        expect(screen.findByTestId('settings-theme-profile-export-json')?.props.value).toBe('');
        expect(screen.findByTestId('settings-theme-profile-export-copy')?.props.disabled).toBe(true);
    });
});
