import { writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { installBrowserClipboardBoundary } from '@/dev/testkit';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import 'fake-indexeddb/auto';

import { flattenTestStyle, flushHookEffects, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { Modal } from '@/modal';
import { darkTheme } from '@/theme';
import { BUNDLED_THEME_TYPEFACES } from '@/constants/bundledFonts';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import { parseThemeProfilesLocalState, readThemeProfileReferenceSelection } from '@/theme/profiles/themeProfilePersistence';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { THEME_ARTIFACT_KIND, ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { ThemeProfileRuntimeSync } from '@/theme/ThemeProfileRuntimeSync';
import { getThemeTryOnOwner } from '@/theme/profiles/themeTryOnRuntime';
import { getThemePresetSourceReferenceId } from './themeProfilePresetOptions';
import { projectThemeLibraryEntry, projectThemeMiniaturePalette } from '@/theme/profiles/themeProfilePresentation';
import { readThemeProfileArtifactDocument } from '@/theme/profiles/themeProfileArtifactProjection';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { ThemeProfileEditorView } from './ThemeProfileEditorView';
import type { ThemeProfileEditorViewProps } from './themeProfileEditorViewTypes';

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
    // The device's color scheme: an OS boundary the platform reports and re-reports when it changes.
    colorScheme: 'light' as 'light' | 'dark',
    colorSchemeListeners: new Set<() => void>(),
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
    const { useSyncExternalStore } = await import('react');
    const subscribe = (listener: () => void) => { shared.colorSchemeListeners.add(listener); return () => { shared.colorSchemeListeners.delete(listener); }; };
    return createReactNativeWebMock({
        Appearance: { getColorScheme: () => shared.colorScheme,
            addChangeListener: (listener: () => void) => ({ remove: subscribe(listener) }) },
        useColorScheme: () => useSyncExternalStore(subscribe, () => shared.colorScheme),
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

// Portal measurement is a browser boundary; retain the real picker/controller beneath it.
vi.mock('@/components/ui/popover/Popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

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
                if (typeof params?.path === 'string') return `${key}: ${params.path}`;
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
    account.artifacts.clear();
    const rows = parsed.profiles.map(profile => {
        const parsedDocument = parseThemeProfileDocument(profile);
        if (!parsedDocument.ok) throw new Error(parsedDocument.error);
        const document = parsedDocument.document;
        const entry = projectThemeLibraryEntry(document);
        const rawHeader = { v: 1, kind: THEME_ARTIFACT_KIND, title: entry.name, mode: entry.mode, themeSource: entry.source,
            compatibility: entry.compatibility, palette: projectThemeMiniaturePalette(profile) };
        const row: Extract<DecryptedArtifact, { isDecrypted: true }> = { id: profile.id, title: profile.name,
            body: JSON.stringify(document.raw), rawHeader, headerVersion: 0, bodyVersion: 0, seq: 0,
            createdAt: Date.parse(profile.createdAt), updatedAt: Date.parse(profile.updatedAt),
            isDecrypted: true, ownerAccountId: account.scope.accountId, access: 'owner', sourceServerId: account.scope.serverId };
        account.artifacts.replaceStoredRow(createPlainArtifactHttpFixture(row, account.scope.accountId));
        return row;
    });
    for (const id of Object.keys(storage.getState().artifacts)) storage.getState().deleteArtifact(id);
    storage.getState().applyArtifacts(rows, {}, [THEME_ARTIFACT_KIND]);
    for (const seeded of rows) {
        const admitted = storage.getState().artifacts[seeded.id];
        if (admitted && readThemeProfileArtifactDocument(admitted, account.scope)) continue;
        const header = ThemeProfileArtifactHeaderSchema.safeParse(admitted?.rawHeader ?? admitted?.header);
        const document = admitted?.isDecrypted && typeof admitted.body === 'string'
            ? parseThemeProfileDocument(JSON.parse(admitted.body)) : null;
        throw new Error(JSON.stringify({ seeded: seeded.id, id: admitted?.id, owner: admitted?.ownerAccountId,
            expectedOwner: account.scope.accountId, access: admitted?.access, sourceServerId: admitted?.sourceServerId,
            expectedServer: account.scope.serverId, decrypted: admitted?.isDecrypted, bodyType: typeof admitted?.body,
            header: header.success ? 'valid' : header.error.issues,
            document: document?.ok ? { id: document.document.profile.id } : document }));
    }
    const reference = (id: string | null) => id === null ? null
        : isBuiltInThemeProfilePresetId(id) ? { kind: 'built-in' as const, presetId: id }
            : { kind: 'artifact' as const, id };
    storage.getState().applyLocalSettings({ themeProfileSelection: {
        light: reference(parsed.activeProfileIds.light), dark: reference(parsed.activeProfileIds.dark),
    } });
    writeThemeProfileLegacyAccountScope(null);
};

const getThemeProfiles = (): ThemeProfilesLocalStateV1 => {
    const state = storage.getState();
    // Inspect persisted documents at the Home boundary: the live library intentionally
    // retains headers without hydrating every sibling body after a refresh.
    const profiles = account.artifacts.list().flatMap(row => {
        if (row.ownerAccountId !== account.scope.accountId || row.access !== 'owner') return [];
        const body = account.artifacts.readPlainBody(row.id);
        if (body === null) return [];
        const parsed = parseThemeProfileDocument(JSON.parse(body));
        return parsed.ok ? [parsed.document.profile] : [];
    });
    const references = readThemeProfileReferenceSelection(state.localSettings.themeProfileSelection);
    const idFor = (reference: typeof references.light) => reference?.kind === 'built-in' ? reference.presetId
        : reference?.kind === 'artifact' && profiles.some(profile => profile.id === reference.id) ? reference.id : null;
    return { profiles, activeProfileIds: { light: idFor(references.light), dark: idFor(references.dark) } };
};
const emptyThemeProfiles = (): ThemeProfilesLocalStateV1 => ({ activeProfileIds: { light: null, dark: null }, profiles: [] });
const fiftyProfiles = (): ThemeProfileV1[] => (
    Array.from({ length: 50 }, (_, index) => baseProfile(`theme_${index}`))
);

const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { ThemeProfilesSettingsScreen } = await import('./ThemeProfilesSettingsScreen');
const { ThemeProfileEditorScreen } = await import('./ThemeProfileEditorScreen');
const { ThemeProfileImportScreen } = await import('./ThemeProfileImportScreen');
const { ThemeProfileExportScreen } = await import('./ThemeProfileExportScreen');

/** Start from: the editor's visual tiles of the themes a draft can take its colours from. */
const chooseStartFrom = async (screen: Awaited<ReturnType<typeof renderSettingsView>>, id: string) => {
    const reference = isBuiltInThemeProfilePresetId(id) ? { kind: 'built-in' as const, presetId: id } : { kind: 'artifact' as const, id };
    await screen.pressByTestIdAsync(`settings-theme-profile-start:${getThemePresetSourceReferenceId(reference)}`);
};
const chooseModeSlot = async (screen: Awaited<ReturnType<typeof renderSettingsView>>, mode: 'light' | 'dark') => {
    await screen.pressByTestIdAsync(`settings-theme-slot:${mode}`);
    await measureMountedCollections(screen, { width: 1200, height: 6000 });
};
const findTileMenuAction = (screen: Awaited<ReturnType<typeof renderSettingsView>>, tileId: string, id: string) => (
    screen.findAllByProps({ testID: `settings-theme-tile-menu-${tileId}` })
        .flatMap((node: any) => (node.props.actions ?? []) as Array<{ id: string; onSelect: () => unknown }>)
        .find((action) => action.id === id)
);

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
    const screen = await renderSettingsView(React.createElement(React.Fragment, null, React.createElement(ThemeProfileRuntimeSync), React.createElement(ThemeProfilesSettingsScreen)), { flushOptions: { cycles: 0 } });
    await measureMountedCollections(screen, { width: 1200, height: 6000 });
    return screen;
}

async function renderEditorScreen(profileId: string) {
    shared.params = { profileId };
    return renderSettingsView(React.createElement(React.Fragment, null, React.createElement(ThemeProfileRuntimeSync), React.createElement(ThemeProfileEditorScreen)), { flushOptions: { cycles: 0 } });
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
    expect(vi.mocked(Modal.alert).mock.calls.slice(errors)).toEqual([]);
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
    shared.colorScheme = 'light';
    storage.getState().applyLocalSettings({
        ...localSettingsDefaults,
        themePreference: 'light',
        themeProfiles: emptyThemeProfiles(),
        uiFontScale: 1,
    });
});

describe('Theme profile settings screen', () => {
    it('opens the connected-device picker from either in-use slot without changing the selection', async () => {
        const screen = await renderProfilesScreen();
        const selection = storage.getState().localSettings.themeProfileSelection;
        expect(screen.findByTestId('settings-theme-slot-light-devices')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-slot-dark-devices')).not.toBeNull();
        expect(screen.findByTestId('theme-device-picker')).toBeNull();
        await screen.pressByTestIdAsync('settings-theme-slot-light-devices');
        expect(screen.findByTestId('theme-device-picker')).not.toBeNull();
        expect(storage.getState().localSettings.themeProfileSelection).toBe(selection);
        const overlay = screen.tree.findAll(node => node.props.phonePresentation === 'sheet'
            && typeof node.props.onRequestClose === 'function')[0];
        await act(async () => { overlay!.props.onRequestClose(); });
        expect(screen.findByTestId('theme-device-picker')).toBeNull();
        await screen.pressByTestIdAsync('settings-theme-slot-dark-devices');
        expect(screen.findByTestId('theme-device-picker')).not.toBeNull();
        expect(storage.getState().localSettings.themeProfileSelection).toBe(selection);
    });

    it('says which mode this device shows now, following the system when the appearance follows it', async () => {
        storage.getState().applyLocalSettings({ themePreference: 'adaptive' });
        const screen = await renderProfilesScreen();
        const slotText = (mode: 'light' | 'dark') => screen.findByTestId(`settings-theme-slot-${mode}-footer`)!
            .findAll((node) => typeof node.type === 'string').flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' ');
        const showingNow = 'settingsAppearance.themeProfiles.showingNow';
        expect(slotText('light')).toContain(showingNow);
        expect(slotText('dark')).not.toContain(showingNow);
        await act(async () => {
            shared.colorScheme = 'dark';
            shared.colorSchemeListeners.forEach((listener) => listener());
        });
        expect(slotText('dark')).toContain(showingNow);
        expect(slotText('light')).not.toContain(showingNow);
    });

    it('offers each mode its themes as visual tiles, with your own themes in their mode', async () => {
        setThemeProfiles({
            activeProfileIds: { light: null, dark: null },
            profiles: [{ ...baseProfile('noir', { light: {}, dark: { 'background.canvas': '#0B0B0D' } }), assetAppearance: 'dark' }],
        });
        const screen = await renderProfilesScreen();

        expect(screen.findByTestId('settings-theme-profiles-screen')).not.toBeNull();
        // The grid opens on the mode this device shows; the other mode is one press away.
        expect(tileIds(screen, 'settings-theme-dark')).toEqual([]);
        expect(tileIds(screen, 'settings-theme-light')).toEqual([
            'light',
            'premiumLight',
            'paperLight',
            'catppuccinLatte',
            'githubLight',
        ]);
        await chooseModeSlot(screen, 'dark');
        // Your themes lead the grid, then the built-ins.
        expect(tileIds(screen, 'settings-theme-dark')).toEqual([
            getThemePresetSourceReferenceId({ kind: 'artifact', id: 'noir' }),
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
        ]);
        expect(screen.findAllByProps({ testID: 'settings-theme-dark:dark' }).some(node => node.props.accessibilityState?.checked === true)).toBe(true);
        // Choosing a slot changes only which mode the grid shows: no selection or appearance write.
        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: null });
        expect(storage.getState().localSettings.themePreference).toBe('light');
    });

    it('assigns a built-in theme to the other mode without changing appearance or storing a custom profile', async () => {
        const screen = await renderProfilesScreen();
        await chooseModeSlot(screen, 'dark');

        await screen.pressByTestIdAsync('settings-theme-dark:premiumDark');

        expect(getThemeProfiles().profiles).toEqual([]);
        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: 'premiumDark' });
        expect(storage.getState().localSettings.themePreference).toBe('light');
    });

    it('returns a mode to its default theme from the default tile', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: 'premiumDark' }, profiles: [] });
        const screen = await renderProfilesScreen();
        await chooseModeSlot(screen, 'dark');

        expect(screen.findAllByProps({ testID: 'settings-theme-dark:premiumDark' }).some(node => node.props.accessibilityState?.checked === true)).toBe(true);
        await screen.pressByTestIdAsync('settings-theme-dark:dark');

        expect(getThemeProfiles().activeProfileIds).toEqual({ light: null, dark: null });
    });

    it('offers a new theme when you have none of your own', async () => {
        const screen = await renderProfilesScreen();

        expect(screen.findByTestId('settings-theme-profile-custom-empty')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-theme-profile-create-empty');

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

    it('offers a new theme beyond the former 50-profile limit', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: fiftyProfiles() });
        const screen = await renderProfilesScreen();
        const addMenu = await findAddThemeMenu(screen);

        expect(addMenu!.props.items.find((item: { id: string }) => item.id === 'create')?.disabled).not.toBe(true);
        await act(async () => {
            addMenu!.props.onSelect('create');
        });
        expect(shared.routerPush).toHaveBeenCalledWith({
            pathname: '/settings/appearance/themes/[profileId]',
            params: { profileId: 'new' },
        });
    });

    it('duplicates any theme into a new one, and exports it, from the theme\'s menu', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'premiumLight', dark: null }, profiles: [] });
        const screen = await renderProfilesScreen();

        // A built-in cannot be edited in place: its menu duplicates it into a new theme of your own.
        expect(findTileMenuAction(screen, 'premiumLight', 'edit')).toBeUndefined();
        await act(async () => { await findTileMenuAction(screen, 'premiumLight', 'duplicate')!.onSelect(); });
        expect(shared.routerPush).toHaveBeenLastCalledWith({
            pathname: '/settings/appearance/themes/[profileId]',
            params: { profileId: 'new', from: 'premiumLight' },
        });
        await act(async () => { await findTileMenuAction(screen, 'premiumLight', 'export')!.onSelect(); });
        expect(shared.routerPush).toHaveBeenLastCalledWith({
            pathname: '/settings/appearance/themes/export',
            params: { profileId: 'premiumLight' },
        });
    });

    it('starts a duplicated theme from the theme it was duplicated from', async () => {
        shared.params = { profileId: 'new', from: 'paperLight' };
        const screen = await renderSettingsView(React.createElement(React.Fragment, null, React.createElement(ThemeProfileRuntimeSync), React.createElement(ThemeProfileEditorScreen)), { flushOptions: { cycles: 0 } });

        expect(screen.findByTestId('settings-theme-profile-start:paperLight')?.props.accessibilityState?.selected).toBe(true);
    });
});

describe('Theme profile editor', () => {
    it('labels an installed Store starting preset by its source', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: [{
            ...baseProfile('store-preset'), name: 'Installed palette', source: {
                kind: 'store', contributionId: 'night', provenance: { sourceId: 'openvsx', itemId: 'publisher.palette',
                    format: 'git', sourceUrl: 'https://open-vsx.org', ref: { kind: 'version', version: '1.0' }, importedAt: 1 },
            },
        }] });
        const screen = await renderEditorScreen('new');
        expect(screen.getTextContent()).toContain('Installed palette');
        expect(screen.getTextContent()).toContain('settingsAppearance.themeProfiles.sourceStore');
    });

    it('opens current CSS directly from the theme recovery route', async () => {
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
        vi.stubGlobal('window', dom.window);
        vi.stubGlobal('document', dom.window.document);
        onTestFinished(() => { vi.unstubAllGlobals(); dom.window.close(); });
        shared.params = { profileId: 'new', from: 'paperLight', view: 'css' };
        const screen = await renderSettingsView(React.createElement(React.Fragment, null, React.createElement(ThemeProfileRuntimeSync), React.createElement(ThemeProfileEditorScreen)), { flushOptions: { cycles: 0 } });
        expect(screen.findByTestId('settings-theme-profile-css')).not.toBeNull();
    });

    it('retains unsupported presentation through an unrelated edit and deliberate style changes', async () => {
        const raw = { ...baseProfile('862d417f-f6f9-480d-a7c0-82735194d027'), schemaVersion: 2,
            seeds: { canvas: '#101010', accent: '#abcdef', futureTone: 0.4 },
            style: { radius: 'round', fontFamily: 'A Future Font', futureInset: 12 },
            futurePresentation: { texture: 'paper' } };
        const parsed = parseThemeProfileDocument(raw);
        if (!parsed.ok) throw new Error(parsed.error);
        await getSyncSingleton().withThemeProfileLibrary(library => library.save({ document: parsed.document }));
        const screen = await renderEditorScreen(raw.id);
        await act(async () => { screen.changeTextByTestId('settings-theme-profile-name', 'Deliberate rename'); });
        await saveEditor(screen);
        const saved = () => JSON.parse(account.artifacts.readPlainBody(raw.id)!);
        expect(saved()).toMatchObject({ schemaVersion: 2, name: 'Deliberate rename', style: raw.style,
            seeds: raw.seeds, futurePresentation: raw.futurePresentation });
        await screen.pressByTestIdAsync('settings-theme-profile-view:style');
        const choice = BUNDLED_THEME_TYPEFACES[1]!;
        const typefaceMenu = screen.findAllByType(DropdownMenu).find(node =>
            node.props.items?.some((item: { id: string }) => item.id === choice.id));
        expect(typefaceMenu).toBeDefined();
        await act(async () => { await typefaceMenu!.props.onSelect(choice.id); });
        await saveEditor(screen);
        expect(saved().style).toEqual({ ...raw.style, fontFamily: choice.id });
        await act(async () => { await typefaceMenu!.props.onSelect(''); });
        await saveEditor(screen);
        expect(saved().style).toEqual({ radius: 'round', futureInset: 12 });
        const reset = await findHeaderMenuAction(screen, 'reset');
        await act(async () => { await reset!.onSelect(); });
        await saveEditor(screen);
        expect(saved().style).toEqual({ futureInset: 12 });
        expect(saved().seeds).toEqual({ futureTone: 0.4 });
        expect(saved().futurePresentation).toEqual(raw.futurePresentation);
    });
    it('saves its addressed draft without animating its live preview or replacing unrelated arrivals', async () => {
        const edited = baseProfile('ocean', { light: {}, dark: { 'background.canvas': '#123456' } });
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: [edited] });
        const screen = await renderEditorScreen('ocean');
        shared.setRootViewBackgroundColor.mockClear();
        shared.setStatusBarStyle.mockClear();
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM('', { pretendToBeVisual: true });
        const transition = vi.fn();
        Object.assign(dom.window.document.documentElement, { animate: vi.fn() });
        Object.assign(dom.window.document, { startViewTransition: transition });
        vi.stubGlobal('document', dom.window.document);
        onTestFinished(() => { vi.unstubAllGlobals(); dom.window.close(); });
        await act(async () => {
            storage.getState().applyLocalSettings({ themePreference: 'dark', uiFontScale: 1.2 });
            setThemeProfiles({ activeProfileIds: getThemeProfiles().activeProfileIds,
                profiles: [{ ...edited, overrides: { light: {}, dark: { 'background.canvas': '#654321' } } }, baseProfile('arrived-during-transition')] });
        });
        await vi.waitFor(() => expect(getThemeTryOnOwner().read()).not.toBeNull());

        await saveEditor(screen);

        expect(transition).not.toHaveBeenCalled();
        expect(getThemeProfiles().profiles.map(profile => profile.id)).toEqual(['ocean', 'arrived-during-transition']);
        expect(storage.getState().localSettings).toMatchObject({ themePreference: 'dark', uiFontScale: 1.2 });
        expect(shared.setTheme).toHaveBeenLastCalledWith('dark');
        const darkUpdate = [...shared.updateTheme.mock.calls].reverse().find(([name]) => name === 'dark')?.[1];
        expect(darkUpdate?.(darkTheme).colors.background.canvas).toBe('#123456');
        // Web roots subscribe to the resolved theme; only native uses this imperative adapter.
        expect(shared.setRootViewBackgroundColor).not.toHaveBeenCalled();
        expect(shared.setStatusBarStyle).toHaveBeenLastCalledWith('light', true);
    });
    it('renders token groups for a dark saved asset while the app is dark', async () => {
        storage.getState().applyLocalSettings({ themePreference: 'dark' });
        setThemeProfiles({ activeProfileIds: { light: null, dark: 'ocean' }, profiles: [{ ...baseProfile('ocean'), assetAppearance: 'dark' }] });

        const screen = await renderEditorScreen('ocean');

        expect(screen.findByTestId('settings-theme-profile-editor')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-color-token-dark-background.canvas')).not.toBeNull();
        expect(screen.findRowByTitle('Canvas background')?.props.subtitle).toBe('App, root, screen, and settings-list backdrop color.');
        expect(screen.findRowByTitle('settingsAppearance.themeProfiles.groups.composer')).not.toBeNull();
        expect(screen.findByTestId('settings-theme-editor-mode:dark')).toBeNull();
        expect(screen.findRowByTitle('settingsAppearance.themeProfiles.editorMode')).toBeNull();
    });


    it('keeps an addressed draft through inventory publications and preserves another saved theme', async () => {
        const original = { ...baseProfile('ocean'), name: 'Original ocean' };
        setThemeProfiles({ profiles: [original], activeProfileIds: { light: 'ocean', dark: null } });
        const screen = await renderEditorScreen('ocean');
        await act(async () => { screen.changeTextByTestId('settings-theme-profile-name', 'Unsaved ocean'); });
        const sibling = { ...baseProfile('arrived'), name: 'Arrived theme' };
        await act(async () => {
            setThemeProfiles({ profiles: [{ ...original, name: 'Published ocean' }, sibling],
                activeProfileIds: { light: 'ocean', dark: null } });
        });
        expect(screen.findByTestId('settings-theme-profile-name')?.props.value).toBe('Unsaved ocean');
        await saveEditor(screen);
        expect(getThemeProfiles().profiles.find(profile => profile.id === 'ocean')?.name).toBe('Unsaved ocean');
        expect(getThemeProfiles().profiles.find(profile => profile.id === 'arrived')).toMatchObject(sibling);
    });

    it.each(['artifact', 'built-in'] as const)('keeps unsaved CSS and editor controls through hidden %s source recovery', async (source) => {
        setThemeProfiles({ profiles: [baseProfile('ocean')], activeProfileIds: { light: null, dark: null } });
        shared.params = source === 'artifact' ? { profileId: 'ocean' } : { profileId: 'new', from: 'premiumLight' };
        const surface = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
            <ThemeProfileEditorScreen />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderSettingsView(surface(true));
        const view = () => screen.findAllByType(ThemeProfileEditorView)[0]!.props as ThemeProfileEditorViewProps;
        await act(async () => {
            view().details!.onNameChange('Unsaved draft');
            view().colors.onQueryChange('canvas');
            view().css.onChange('[data-happier-surface="app"] { color: red; }');
        });
        const cssResetKey = view().css.resetKey;
        await screen.update(surface(false));
        await act(async () => setThemeProfiles({ profiles: [{ ...baseProfile('ocean'), name: 'Published ocean' }],
            activeProfileIds: { light: 'premiumLight', dark: null } }));
        await screen.update(surface(true));
        expect(view().details?.name).toBe('Unsaved draft');
        expect(view().colors.query).toBe('canvas');
        expect(view().css.value).toBe('[data-happier-surface="app"] { color: red; }');
        expect(view().css.resetKey).toBe(cssResetKey);
    });

    it.each(['artifact', 'built-in'] as const)('waits for presentation before initializing a new draft from a hidden %s source', async (source) => {
        setThemeProfiles({ profiles: [{ ...baseProfile('ocean'), css: '.retained { color: red; }' }],
            activeProfileIds: { light: null, dark: null } });
        shared.params = { profileId: 'new', from: source === 'artifact'
            ? getThemePresetSourceReferenceId({ kind: 'artifact', id: 'ocean' }) : 'premiumLight' };
        const surface = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
            <ThemeProfileEditorScreen />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderSettingsView(surface(false));
        expect(screen.findByTestId('settings-theme-profile-name')).toBeNull();
        await screen.update(surface(true));
        const view = screen.findAllByType(ThemeProfileEditorView)[0]!.props as ThemeProfileEditorViewProps;
        expect(view.details?.name).toBeDefined();
        if (source === 'artifact') expect(view.css.value).toBe('.retained { color: red; }');
    });

    it('publishes edited draft through shared try-on and leaves a newer agent preview on editor exit', async () => {
        setThemeProfiles({ activeProfileIds: { light: 'ocean', dark: null }, profiles: [baseProfile('ocean')] });
        const owner = getThemeTryOnOwner();
        onTestFinished(() => { const current = owner.read(); if (current) owner.revert(current.previewRef); });
        const screen = await renderEditorScreen('ocean');
        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
        });
        await vi.waitFor(() => expect(owner.read()?.document?.profile.overrides.light['background.canvas']).toBe('#123456'));
        expect(getThemeProfiles().profiles.find(profile => profile.id === 'ocean')?.overrides.light['background.canvas']).toBeUndefined();
        const parsed = parseThemeProfileDocument(baseProfile('agent', { light: {}, dark: { 'background.canvas': '#654321' } }));
        if (!parsed.ok) throw new Error(parsed.error);
        const replacement = owner.begin({ document: parsed.document, mode: 'dark', origin: { kind: 'agent' } });
        await screen.unmount();
        expect(owner.read()).toBe(replacement);
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
        expect(getThemeTryOnOwner().read()?.document.profile.overrides.light['background.canvas']).toBe('#123456');
    });

    it('opens an addressed retained agent draft without saving it first', async () => {
        const { getThemeTryOnOwner } = await import('@/theme/profiles/themeTryOnRuntime');
        const parsed = parseThemeProfileDocument({ ...baseProfile('agent-draft'), name: 'Agent draft', futurePresentation: { retained: true } });
        if (!parsed.ok) throw new Error('Invalid agent draft');
        const preview = getThemeTryOnOwner().begin({ document: parsed.document, mode: 'dark', origin: { kind: 'agent' } });
        shared.params = { profileId: 'new', previewRef: preview.previewRef };
        const screen = await renderSettingsView(<ThemeProfileEditorScreen />);
        expect(screen.findByTestId('settings-theme-profile-name')?.props.value).toBe('Agent draft');
        expect(getThemeProfiles().profiles).toEqual([]);
        await screen.unmount();
    });

    it('opens a new unsaved theme draft and saves it as a custom profile', async () => {
        const screen = await renderEditorScreen('new');

        expect(screen.findByTestId('settings-theme-profile-name')).not.toBeNull();
        expect(getThemeProfiles().profiles).toEqual([]);

        await saveEditor(screen);

        const saved = getThemeProfiles();
        expect(saved.profiles).toHaveLength(1);
        expect(saved.activeProfileIds).toEqual({ light: saved.profiles[0]?.id, dark: null });
        expect(saved.profiles[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

    it('keeps a saved new-route draft editable in a large library', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: fiftyProfiles().slice(0, -1) });
        const screen = await renderEditorScreen('new');
        await saveEditor(screen);
        expect(getThemeProfiles().profiles, JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toHaveLength(50);
        await act(async () => { screen.changeTextByTestId('settings-theme-profile-name', 'Edited after first save'); });
        expect(screen.findByTestId('settings-theme-profile-limit-error')).toBeNull();
        expect(screen.findByTestId('settings-theme-profile-save')?.props.disabled).toBe(false);
        await saveEditor(screen);
        expect(getThemeProfiles().profiles).toHaveLength(50);
        expect(getThemeProfiles().profiles.some(profile => profile.name === 'Edited after first save')).toBe(true);
    });

    it('saves a new draft beyond the former 50-profile limit', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: fiftyProfiles() });
        const screen = await renderEditorScreen('new');

        expect(screen.findByTestId('settings-theme-profile-save')?.props.disabled).toBe(false);
        await saveEditor(screen);
        expect(getThemeProfiles().profiles).toHaveLength(51);
        expect(getThemeProfiles().activeProfileIds.light).toBe(getThemeProfiles().profiles[50]?.id);
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

    it('preserves a newly selected theme when the delete Action is refused', async () => {
        account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
            actions: { [THEME_ACTION_IDS.delete]: { disabledSurfaces: ['ui'] } },
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

    it('names the assigned slot before deletion and leaves the stored reference for base fallback', async () => {
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
        expect(readThemeProfileReferenceSelection(storage.getState().localSettings.themeProfileSelection).dark)
            .toEqual({ kind: 'artifact', id: 'ocean' });
    });

    it('replaces a clean draft from a selected preset without confirmation', async () => {
        setThemeProfiles({
            activeProfileIds: { light: null, dark: null },
            profiles: [baseProfile('ocean', { light: { 'background.canvas': '#ABCDEF' }, dark: {} })],
        });
        const screen = await renderEditorScreen('new');

        await chooseStartFrom(screen, 'ocean');

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

        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
        });
        await chooseStartFrom(screen, 'ocean');

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

        await vi.waitFor(() => expect(screen.findByTestId('settings-theme-contrast-warning-light-text.primary')).not.toBeNull());
        expect(screen.findByTestId('settings-theme-profile-save')).not.toBeNull();
        expect(await findHeaderMenuAction(screen, 'deactivate')).toBeDefined();
        await screen.pressByTestIdAsync('settings-theme-contrast-fix-light-text.primary');
        expect(screen.findByTestId('settings-theme-contrast-warning-light-text.primary')).toBeNull();
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

    it('saves and keeps its addressed theme through the shared runtime owner', async () => {
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

    it('previews a saved dark asset and assigns its slot without changing the device appearance preference', async () => {
        storage.getState().applyLocalSettings({ themePreference: 'light' });
        setThemeProfiles({
            activeProfileIds: { light: null, dark: null },
            profiles: [baseProfile('noir', { light: {}, dark: { 'background.canvas': '#0B0B0D' } })],
        });
        const screen = await renderEditorScreen('noir');

        await vi.waitFor(() => expect(getThemeTryOnOwner().read()?.mode).toBe('dark'));

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

    it('duplicates a built-in preset beyond the former 50-profile limit using its translated name', async () => {
        setThemeProfiles({ activeProfileIds: { light: null, dark: null }, profiles: fiftyProfiles() });
        const screen = await renderEditorScreen('premiumDark');

        expect(screen.findAllByProps({ testID: 'settings-theme-profile-header' }).find((node: any) => node.props.title)?.props.title).toBe('settingsAppearance.themeProfiles.presets.premiumDark');

        const duplicate = await findHeaderMenuAction(screen, 'duplicate');
        expect(duplicate?.disabled).not.toBe(true);
        await act(async () => {
            await duplicate!.onSelect();
        });

        expect(getThemeProfiles().profiles).toHaveLength(51);
        expect(getThemeProfiles().profiles[50]?.name).toBe('settingsAppearance.themeProfiles.presets.premiumDark copy');
    });
    it('saves corner shape and a bundled typeface from Style while preserving Appearance preferences', async () => {
        const before = storage.getState().localSettings;
        const screen = await renderEditorScreen('new');

        await screen.pressByTestIdAsync('settings-theme-profile-view:style');
        await screen.pressByTestIdAsync('settings-theme-profile-corners:round');
        const choice = BUNDLED_THEME_TYPEFACES[1]!;
        const typefaceMenu = screen.findAllByType(DropdownMenu).find(node =>
            node.props.items?.some((item: { id: string }) => item.id === choice.id));
        expect(typefaceMenu).toBeDefined();
        await act(async () => { await typefaceMenu!.props.onSelect(choice.id); });
        await saveEditor(screen);

        expect(getThemeProfiles().profiles.at(-1)?.style).toEqual({ radius: 'round', fontFamily: choice.id });
        expect(storage.getState().localSettings.uiFontScale).toBe(before.uiFontScale);
    });

    it('draws the live preview from the draft, not from the theme the app shows', async () => {
        const screen = await renderEditorScreen('new');
        const previewPaints = () => (screen.findByTestId('settings-theme-profile-preview')?.findAll(() => true) ?? [])
            .map((node: any) => node.props?.style)
            .flatMap((style: unknown) => (Array.isArray(style) ? style : [style]))
            .map((style: any) => style?.backgroundColor)
            .filter((color: unknown): color is string => typeof color === 'string');

        expect(previewPaints()).not.toContain('#123456');
        await act(async () => {
            screen.changeTextByTestId('settings-theme-color-input-light-background.canvas', '#123456');
        });
        expect(previewPaints()).toContain('#123456');
    });
});

describe('Theme profile import and export screens', () => {
    it('imports a copy without overwriting the Artifact identified in its file', async () => {
        const original = baseProfile('9d43780a-16c8-4ebf-84e3-a2ef782ad06f');
        setThemeProfiles({ profiles: [original], activeProfileIds: { light: null, dark: null } });
        expect(getThemeProfiles().profiles.map(profile => profile.id)).toContain(original.id);
        const screen = await renderImportScreen();
        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-import-json', JSON.stringify({
                kind: 'happier.themeProfile', schemaVersion: 1, profile: { ...original, name: 'Imported copy' },
            }));
        });
        await submitImport(screen);
        const saved = getThemeProfiles().profiles;
        expect(saved).toHaveLength(2);
        expect(saved.find(profile => profile.id === original.id)?.name).toBe(original.name);
        expect(saved.find(profile => profile.name === 'Imported copy')?.id).not.toBe(original.id);
    });
    it('retains newer presentation through file import, Artifact save and export', async () => {
        const future = { ...baseProfile('future'), schemaVersion: 2,
            seeds: { canvas: '#101010', accent: '#abcdef', futureTone: 0.4 },
            style: { radius: 'round', fontFamily: 'A Future Font', futureInset: 12 },
            futurePresentation: { texture: 'paper' } };
        const screen = await renderImportScreen();
        await act(async () => {
            screen.changeTextByTestId('settings-theme-profile-import-json', JSON.stringify({
                kind: 'happier.themeProfile', schemaVersion: 1, profile: future,
            }));
        });
        await submitImport(screen);
        const saved = Object.values(storage.getState().artifacts).flatMap(row => {
            const document = readThemeProfileArtifactDocument(row, account.scope)?.document;
            return document ? [document] : [];
        });
        expect(saved).toHaveLength(1);
        expect(saved[0]!.raw).toMatchObject({ schemaVersion: 2, seeds: future.seeds,
            style: future.style, futurePresentation: future.futurePresentation });
        shared.params = { profileId: saved[0]!.profile.id };
        const exported = await renderExportScreen();
        await vi.waitFor(() => expect(exported.findByTestId('settings-theme-profile-export-json')).not.toBeNull());
        const file = JSON.parse(exported.findByTestId('settings-theme-profile-export-json')!.props.value);
        expect(file.profile).toMatchObject({ schemaVersion: 2, seeds: future.seeds,
            style: future.style, futurePresentation: future.futurePresentation });
    });

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

    it('imports a browser theme with its selected parent through the shared resolver', async () => {
        const child = JSON.stringify({ name: 'Child', type: 'dark', include: './base.json',
            colors: { 'editor.foreground': '#abcdef' } });
        const parent = JSON.stringify({ colors: { 'editor.background': '#112233' } });
        shared.nativePickFiles.mockResolvedValueOnce([
            { kind: 'web', file: new File([child], 'child.json') },
            { kind: 'web', file: new File([parent], 'base.json') },
        ]);
        const screen = await renderImportScreen();
        await screen.pressByTestIdAsync('settings-theme-profile-import-file');
        await vi.waitFor(() => expect(screen.findByTestId('settings-theme-profile-import-json')?.props.value).toBe(child));
        await submitImport(screen);
        expect(getThemeProfiles().profiles[0]?.overrides.dark).toMatchObject({
            'background.canvas': '#112233', 'text.primary': '#abcdef',
        });
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
        const json = JSON.stringify({ include: './base.json', name: 'Child', type: 'light', colors: { 'editor.foreground': '#abcdef' } });
        fs.files.set('file:///picked/base.json', [...new TextEncoder().encode(JSON.stringify({ colors: { 'editor.background': '#123456' } }))]);
        fs.files.set('file:///picked/theme.json', [...new TextEncoder().encode(json)]);
        shared.nativePickFiles.mockResolvedValueOnce([{ kind: 'native', uri: 'file:///picked/theme.json', name: 'theme.json', mimeType: 'application/json' }]);
        const screen = await renderImportScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-import-file');
        await submitImport(screen);

        expect(getThemeProfiles().profiles[0]?.overrides.light['background.canvas']).toBe('#123456');
        expect(getThemeProfiles().profiles[0]?.overrides.light['text.primary']).toBe('#abcdef');
    });

    it('reports an unavailable included theme file without importing a partial theme', async () => {
        const json = JSON.stringify({ include: './missing.json', name: 'Child', type: 'light', colors: { 'editor.background': '#123456' } });
        shared.nativePickFiles.mockResolvedValueOnce([{ kind: 'web', file: new File([json], 'child.json', { type: 'application/json' }) }]);
        const screen = await renderImportScreen();

        await screen.pressByTestIdAsync('settings-theme-profile-import-file');
        await submitImport(screen);

        expect(screen.getTextContent()).toContain('./missing.json');
        expect(getThemeProfiles().profiles).toHaveLength(0);
        expect(shared.routerBack).not.toHaveBeenCalled();
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
