import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { installBrowserClipboardBoundary } from '@/dev/testkit';
import 'fake-indexeddb/auto';

import { flattenTestStyle, flushHookEffects, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { Modal } from '@/modal';
import { darkTheme } from '@/theme';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resolveAccountThemeProfiles } from '@/sync/domains/settings/themeProfiles';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { getBuiltInThemeProfileDefinition } from '@/theme/profiles/builtInThemeProfiles';
import { parseThemeProfilesLocalState } from '@/theme/profiles/themeProfilePersistence';
import { loadLocalSettings } from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storageStore';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

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
    routerDismissTo: vi.fn(),
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
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Appearance: { getColorScheme: () => 'light' },
        Share: { sharedAction: 'sharedAction', dismissedAction: 'dismissedAction',
            share: vi.fn(async () => ({ action: 'sharedAction' })) },
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
            dismissTo: shared.routerDismissTo,
        },
    }).module;
});

vi.mock('@/modal', async () => {
    const mock = (await import('@/dev/testkit/mocks/modal')).createModalModuleMock();
    return { ...mock.module, Modal: { ...mock.module.Modal, confirm: shared.modalConfirm } };
});

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

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();

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
    const parsed = parseThemeProfilesLocalState(state).state;
    account.replaceSettings(settingsParse({ ...account.persistedSettings, themeProfiles: parsed.profiles }));
    storage.getState().applyLocalSettings({ themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: null } },
        themeProfileSelection: parsed.activeProfileIds });
    writeThemeProfileLegacyAccountScope(null);
};

const getThemeProfiles = (): ThemeProfilesLocalStateV1 => {
    const state = storage.getState();
    return resolveAccountThemeProfiles({ profiles: state.settings.themeProfiles,
        legacy: state.localSettings.themeProfiles, selection: state.localSettings.themeProfileSelection,
        legacyScope: readThemeProfileLegacyAccountScope(), scope: state.settingsScope });
};
const emptyThemeProfiles = (): ThemeProfilesLocalStateV1 => ({ activeProfileIds: { light: null, dark: null }, profiles: [] });
const maxProfiles = (): ThemeProfileV1[] => (
    Array.from({ length: THEME_PROFILE_MAX_PROFILES }, (_, index) => baseProfile(`theme_${index}`))
);

const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { ThemeProfilesSettingsScreen } = await import('./ThemeProfilesSettingsScreen');
const { ThemeProfileEditorScreen } = await import('./ThemeProfileEditorScreen');
const { ThemeProfileImportScreen } = await import('./ThemeProfileImportScreen');
const { ThemeProfileExportScreen } = await import('./ThemeProfileExportScreen');

const findPresetDropdown = async (screen: Awaited<ReturnType<typeof renderSettingsView>>) => {
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
    return screen.findAllByType(DropdownMenu as any)
        .find((node: any) => node.props?.testID === 'settings-theme-profile-add-menu');
};

const findHeaderMenuAction = async (screen: Awaited<ReturnType<typeof renderSettingsView>>, id: string) => (
    screen.findAllByProps({ testID: 'settings-theme-profile-menu' })
        .flatMap((node: any) => (node.props.actions ?? []) as Array<{ id: string; disabled?: boolean; onSelect: () => unknown }>)
        .find((action) => action.id === id)
);

async function renderProfilesScreen() {
    return renderSettingsView(React.createElement(ThemeProfilesSettingsScreen), { flushOptions: { cycles: 0 } });
}

async function renderEditorScreen(profileId: string) {
    shared.params = { profileId };
    return renderSettingsView(React.createElement(ThemeProfileEditorScreen), { flushOptions: { cycles: 0 } });
}

async function renderImportScreen() {
    return renderSettingsView(React.createElement(ThemeProfileImportScreen), { flushOptions: { cycles: 0 } });
}

async function renderExportScreen() {
    return renderSettingsView(React.createElement(ThemeProfileExportScreen), { flushOptions: { cycles: 0 } });
}

// RoundButton's synchronous press adapter deliberately returns void. Wait for the Action's
// observable feedback rather than treating the platform press as a completed Account CAS.
async function saveEditor(screen: Awaited<ReturnType<typeof renderEditorScreen>>) {
    const dismissed = shared.routerDismissTo.mock.calls.length;
    const errors = vi.mocked(Modal.alert).mock.calls.length;
    await screen.pressByTestIdAsync('settings-theme-profile-save');
    await vi.waitFor(() => expect(shared.routerDismissTo.mock.calls.length > dismissed
        || vi.mocked(Modal.alert).mock.calls.length > errors).toBe(true));
}

async function submitImport(screen: Awaited<ReturnType<typeof renderImportScreen>>) {
    const returned = shared.routerBack.mock.calls.length;
    const errors = vi.mocked(Modal.alert).mock.calls.length;
    await screen.pressByTestIdAsync('settings-theme-profile-import-submit');
    await vi.waitFor(() => expect(shared.routerBack.mock.calls.length > returned
        || vi.mocked(Modal.alert).mock.calls.length > errors
        || screen.findByTestId('settings-theme-profile-import-warnings') !== null
        || screen.findByTestId('settings-theme-profile-import-json.error') !== null).toBe(true));
}

let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>>;
beforeEach(async () => {
    account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
    writeThemeProfileLegacyAccountScope(null);
    installBrowserClipboardBoundary(async text => { await shared.clipboardSetStringAsync(text); });
    storage.getState().applyLocalSettings({ ...localSettingsDefaults, themePreference: 'light', themeProfiles: emptyThemeProfiles() });
});
afterEach(async () => {
    standardCleanup();
    await account.dispose();
    shared.routerPush.mockClear();
    shared.routerBack.mockClear();
    shared.routerDismissTo.mockClear();
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
    storage.getState().applyLocalSettings({
        ...localSettingsDefaults,
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
        expect(storage.getState().localSettings.themePreference).toBe('light');
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
        // Keep the real document beneath the animation boundary: the save spinner
        // legitimately injects its shared style sheet while the transition waits.
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM();
        Object.assign(dom.window.document.documentElement, { animate: vi.fn() });
        Object.assign(dom.window.document, {
            startViewTransition: (update: () => Promise<void>) => ({
                ready: Promise.resolve().then(async () => {
                    storage.getState().applyLocalSettings({ themePreference: 'dark', uiFontScale: 1.2 });
                    account.replaceSettings(settingsParse({ ...account.persistedSettings,
                        themeProfiles: [{ ...edited, overrides: { light: {}, dark: { 'background.canvas': '#654321' } } }, baseProfile('arrived-during-transition')]
                    }), { version: (storage.getState().settingsVersion ?? 0) + 1 });
                    await update();
                }),
            }),
        });
        vi.stubGlobal('document', dom.window.document);
        onTestFinished(() => { vi.unstubAllGlobals(); dom.window.close(); });

        await saveEditor(screen);

        expect(getThemeProfiles().profiles.map(profile => profile.id)).toEqual(['ocean', 'arrived-during-transition']);
        expect(storage.getState().localSettings).toMatchObject({ themePreference: 'dark', uiFontScale: 1.2 });
        expect(shared.setTheme).toHaveBeenLastCalledWith('dark');
        const darkUpdate = shared.updateTheme.mock.calls.findLast(([name]) => name === 'dark')?.[1];
        expect(darkUpdate?.(darkTheme).colors.background.canvas).toBe('#654321');
        // Web roots subscribe to the resolved theme; only native uses this imperative adapter.
        expect(shared.setRootViewBackgroundColor).not.toHaveBeenCalled();
        expect(shared.setStatusBarStyle).toHaveBeenLastCalledWith('light', true);
    });
    it('renders token groups and defaults the editing variant to the active app mode', async () => {
        storage.getState().applyLocalSettings({ themePreference: 'dark' });
        setThemeProfiles({ activeProfileIds: { light: null, dark: 'ocean' }, profiles: [baseProfile('ocean')] });

        const screen = await renderEditorScreen('ocean');

        expect(screen.findByTestId('settings-theme-profile-editor')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-color-token-dark-background.canvas')).not.toBeNull();
        expect(screen.findRowByTitle('Canvas background')?.props.subtitle).toBe('App, root, screen, and settings-list backdrop color.');
        expect(screen.findRowByTitle('settingsAppearance.themeProfiles.groups.composer')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-editor-mode:dark')).toBeNull();
        expect(screen.findRowByTitle('settingsAppearance.themeProfiles.editorMode')).toBeNull();
    });


    it('keeps a legacy draft on its original theme when account fetch remaps its route id', async () => {
        const local = { ...baseProfile('ocean'), name: 'Local ocean' };
        storage.setState({ settingsScope: null });
        storage.getState().applyLocalSettings({ themeProfileSelection: null,
            themeProfiles: parseThemeProfilesLocalState({ profiles: [local], activeProfileIds: { light: 'ocean', dark: null } }).state,
        });
        writeThemeProfileLegacyAccountScope(account.scope);
        expect(loadLocalSettings().themeProfiles).toEqual(storage.getState().localSettings.themeProfiles);
        const screen = await renderEditorScreen('ocean');
        await act(async () => { storage.setState({ settingsScope: account.scope }); });
        await act(async () => { screen.changeTextByTestId('settings-theme-profile-name', 'Unsaved local draft'); });
        const cloud = { ...baseProfile('ocean'), name: 'Cloud ocean', overrides: { light: { 'background.canvas': '#abcdef' }, dark: {} } };
        await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, themeProfiles: [cloud] }),
            { version: (storage.getState().settingsVersion ?? 0) + 1 }); });
        expect(screen.findByTestId('settings-theme-profile-name')?.props.value).toBe('Unsaved local draft');
        await saveEditor(screen);
        expect(account.persistedSettings.themeProfiles.find(profile => profile.id === cloud.id)?.name).toBe('Cloud ocean');
        expect(account.persistedSettings.themeProfiles.find(profile => profile.name === 'Unsaved local draft')?.id).not.toBe(cloud.id);
        expect(account.persistedSettings.themeProfiles.some(profile => profile.name === 'Unsaved local draft'),
            JSON.stringify({ errors: vi.mocked(Modal.alert).mock.calls,
                backup: storage.getState().localSettings.themeProfiles, account: account.persistedSettings.themeProfiles })).toBe(true);
    });

    it('preserves a legacy draft and refuses its save after the captured legacy source retires', async () => {
        const local = { ...baseProfile('ocean'), name: 'Local ocean' };
        storage.getState().applyLocalSettings({ themeProfileSelection: null,
            themeProfiles: parseThemeProfilesLocalState({ profiles: [local], activeProfileIds: { light: 'ocean', dark: null } }).state,
        });
        writeThemeProfileLegacyAccountScope(account.scope);
        expect(loadLocalSettings().themeProfiles).toEqual(storage.getState().localSettings.themeProfiles);
        const screen = await renderEditorScreen('ocean');
        await act(async () => { screen.changeTextByTestId('settings-theme-profile-name', 'Unsaved local draft'); });
        const cloud = { ...baseProfile('ocean'), name: 'Cloud ocean' };
        await act(async () => {
            account.replaceSettings(settingsParse({ ...account.persistedSettings,
                themeProfiles: [cloud, { ...local, id: 'ocean_2' }] }));
            storage.getState().applyLocalSettings({ themeProfiles: emptyThemeProfiles(), themeProfileSelection: { light: 'ocean_2', dark: null } });
        });
        expect(screen.findByTestId('settings-theme-profile-name')?.props.value).toBe('Unsaved local draft');
        const before = account.persistedSettings.themeProfiles;
        await saveEditor(screen);
        expect(account.persistedSettings.themeProfiles).toEqual(before);
        expect(shared.routerDismissTo).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-theme-profile-name')?.props.value).toBe('Unsaved local draft');
    });

    it('applies draft colors to the live interface preview before save', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [baseProfile('ocean')] });
        const screen = await renderEditorScreen('ocean');
        shared.updateTheme.mockClear();

        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 170)); });

        const swatch = screen.findByTestId('settings-theme-color-swatch-light-background.canvas');
        expect(swatch?.props.color).toBeUndefined();
        expect(flattenTestStyle(swatch?.props.style).backgroundColor).toBe('#123456');
        expect(shared.updateTheme).toHaveBeenCalled();
    });

    it('opens a new unsaved theme draft and saves it as a custom profile', async () => {
        const screen = await renderEditorScreen('new');

        expect(screen.findByTestId('settings-theme-profile-name')).not.toBeNull();
        expect(getThemeProfiles().profiles).toEqual([]);

        await saveEditor(screen);

        const saved = getThemeProfiles();
        expect(saved.profiles).toHaveLength(1);
        expect(saved.activeProfileIds).toEqual({ light: saved.profiles[0]?.id, dark: null });
        expect(saved.profiles[0]?.id).toMatch(/^theme_/);
    });

    it('starts a new draft as the light or dark theme the app is using, and leaves the editor once it is saved and used', async () => {
        storage.getState().applyLocalSettings({ themePreference: 'dark' });
        const screen = await renderEditorScreen('new');
        await saveEditor(screen);

        const saved = getThemeProfiles();
        // "Starts from: Dark" must not save as a light theme just because it has no colors yet.
        expect(saved.profiles[0]).toMatchObject({ assetAppearance: 'dark' });
        expect(saved.activeProfileIds).toEqual({ light: null, dark: saved.profiles[0]?.id });
        expect(shared.routerDismissTo).toHaveBeenCalledWith('/settings/appearance/themes');
    });

    it('saves the selected asset appearance and assigns that theme slot without changing appearance mode', async () => {
        const screen = await renderEditorScreen('new');
        await screen.pressByTestIdAsync('settings-theme-profile-asset-appearance:dark');
        await saveEditor(screen);

        const saved = getThemeProfiles().profiles[0] as (ThemeProfileV1 & { assetAppearance?: string }) | undefined;
        expect(saved?.assetAppearance).toBe('dark');
        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: saved?.id });
        expect(storage.getState().localSettings.themePreference).toBe('light');
    });

    it('blocks saving when the profile name is invalid', async () => {
        const screen = await renderEditorScreen('new');

        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-name', '   ');
        });

        expect(screen.findByTestId('settings-theme-profile-name.error')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')?.props.disabled).toBe(true);
    });

    it('keeps a saved new-route draft editable when its first save fills the library', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: maxProfiles().slice(0, -1) });
        const screen = await renderEditorScreen('new');
        await saveEditor(screen);
        expect(getThemeProfiles().profiles, JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toHaveLength(THEME_PROFILE_MAX_PROFILES);
        await act(async () => { screen.changeTextByTestId('settings-theme-profile-name', 'Edited after first save'); });
        expect(screen.findByTestId('settings-theme-profile-limit-error')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')?.props.disabled).toBe(false);
        await saveEditor(screen);
        expect(getThemeProfiles().profiles).toHaveLength(THEME_PROFILE_MAX_PROFILES);
        expect(getThemeProfiles().profiles.some(profile => profile.name === 'Edited after first save')).toBe(true);
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

    it('admits removal if the theme becomes selected while deletion confirmation is open', async () => {
        account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }));
        const profile = baseProfile('ocean');
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: [profile] });
        const screen = await renderEditorScreen('ocean');
        const deleteAction = await findHeaderMenuAction(screen, 'delete');
        shared.modalConfirm.mockImplementationOnce(async () => {
            setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [profile] });
            return true;
        });

        await act(async () => { await deleteAction!.onSelect(); });

        expect(getThemeProfiles().activeProfileIds.light).toBe('ocean');
        expect(getThemeProfiles().profiles).toHaveLength(1);
        expect(shared.routerBack).not.toHaveBeenCalled();
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
        await saveEditor(screen);

        const saved = getThemeProfiles();
        expect(saved.activeProfileIds).toEqual({ light: 'ocean', dark: null });
        expect(saved.profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
        expect(shared.updateTheme).toHaveBeenCalled();
    });

    it('previews and activates a dark custom theme in its inferred mode even when the app is currently light', async () => {
        storage.getState().applyLocalSettings({ themePreference: 'light' });
        setThemeProfiles({
            activeProfileIds: { light: null, dark: null },
            profiles: [baseProfile('noir', { light: {}, dark: { 'background.canvas': '#0B0B0D' } })],
        });
        const screen = await renderEditorScreen('noir');
        shared.setTheme.mockClear();

        await vi.waitFor(() => expect(shared.setTheme).toHaveBeenCalledWith('dark'));

        await saveEditor(screen);

        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: 'noir' });
    });

    it('treats built-in presets as read-only and cloneable', async () => {
        storage.getState().applyLocalSettings({ themePreference: 'dark' });
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
        await submitImport(screen);

        expect(getThemeProfiles().profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
        expect(shared.routerBack).toHaveBeenCalled();
    });

    it('imports a theme JSON file picked from disk', async () => {
        const json = exportThemeProfileToJson(baseProfile('shared', { light: { 'background.canvas': '#123456' }, dark: {} }));
        shared.nativePickFiles.mockResolvedValueOnce([{ kind: 'web', file: new File([json], 'theme.json', { type: 'application/json' }) }]);
        const screen = await renderImportScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-import-file');
        await submitImport(screen);

        expect(getThemeProfiles().profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
    });

    it('imports a native theme JSON file through Expo File', async () => {
        const json = exportThemeProfileToJson(baseProfile('shared', { light: { 'background.canvas': '#123456' }, dark: {} }));
        fs.files.set('file:///picked/theme.json', [...new TextEncoder().encode(json)]);
        shared.nativePickFiles.mockResolvedValueOnce([{ kind: 'native', uri: 'file:///picked/theme.json', name: 'theme.json', mimeType: 'application/json' }]);
        const screen = await renderImportScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-import-file');
        await submitImport(screen);

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
        await submitImport(screen);

        expect(screen.findByTestId('settings-theme-profile-import-warnings')).not.toBeNull();
        expect(getThemeProfiles().profiles).toHaveLength(1);
        expect(shared.routerBack).not.toHaveBeenCalled();
    });

    it('shows an error for invalid import JSON', async () => {
        const screen = await renderImportScreen();

        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-import-json', '{not json}');
        });
        await submitImport(screen);

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

        const { Platform, Share } = await import('react-native');
        const previousPlatform = Platform.OS;
        Platform.OS = 'ios';
        const share = vi.spyOn(Share, 'share').mockImplementation(async content => {
            if (!('url' in content) || !content.url) throw new Error('Expected an iOS share URL');
            shared.nativeSharedJson = new TextDecoder().decode(new Uint8Array(fs.files.get(content.url)!));
            await shared.sharingShareAsync(content.url);
            return { action: Share.sharedAction };
        });
        onTestFinished(() => { Platform.OS = previousPlatform; share.mockRestore(); });
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
