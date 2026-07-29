import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    settingsState: {
        themePreference: 'adaptive',
        themeProfiles: { activeProfileIds: { light: null, dark: null }, profiles: [] },
        uiFontScale: 1,
        uiContentWidthMode: 'compact',
        uiItemDensity: 'comfortable',
        uiMultiPanePanelsEnabled: true,
        detailsPaneTabsBehavior: 'preview',
        settingsNavSidebarEnabled: true,
        avatarStyle: 'gradient',
        showFlavorIcons: true,
        preferredLanguage: null,
    } as Record<string, unknown>,
    setAdaptiveThemes: vi.fn(),
    setTheme: vi.fn(),
    setRootViewBackgroundColor: vi.fn(),
    setStatusBarStyle: vi.fn(),
    startViewTransition: vi.fn((update: () => void) => {
        update();
        return { ready: Promise.resolve() };
    }),
    documentElementAnimate: vi.fn(),
}));

type MutableSettingHook = (key: string) => [unknown, (next: unknown) => void];

const createMutableSettingHook = (settingsState: Record<string, unknown>): MutableSettingHook => {
    return (key: string) => [
        Object.prototype.hasOwnProperty.call(settingsState, key) ? settingsState[key] : null,
        (next: unknown) => {
            settingsState[key] = next;
        },
    ];
};

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Appearance: { getColorScheme: () => 'light' },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: { blue: '#00f', orange: '#f90', indigo: '#6366f1' },
                    status: { connecting: '#09f' },
                },
            },
            runtime: {
                setAdaptiveThemes: shared.setAdaptiveThemes,
                setTheme: shared.setTheme,
                setRootViewBackgroundColor: shared.setRootViewBackgroundColor,
            },
        });
    },
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return {
            ...createTextModuleMock(),
            getLanguageNativeName: () => 'English',
            SUPPORTED_LANGUAGES: { en: true },
        };
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        const mutableSetting = createMutableSettingHook(shared.settingsState);
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: mutableSetting as typeof import('@/sync/domains/state/storage')['useSettingMutable'],
                useLocalSettingMutable: mutableSetting as typeof import('@/sync/domains/state/storage')['useLocalSettingMutable'],
            },
        });
    },
    useDeviceType: 'desktop',
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: shared.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));
vi.mock('@/theme', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/theme')>();
    return {
        ...actual,
        darkTheme: {
            ...actual.darkTheme,
            colors: {
                ...actual.darkTheme.colors,
                groupped: { background: '#000' },
            },
        },
        lightTheme: {
            ...actual.lightTheme,
            colors: {
                ...actual.lightTheme.colors,
                groupped: { background: '#fff' },
            },
        },
    };
});

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
    Reflect.deleteProperty(globalThis, 'document');
    shared.settingsState.themePreference = 'adaptive';
    shared.settingsState.themeProfiles = { activeProfileIds: { light: null, dark: null }, profiles: [] };
    shared.settingsState.uiContentWidthMode = 'compact';
    shared.settingsState.uiItemDensity = 'comfortable';
    shared.setAdaptiveThemes.mockClear();
    shared.setTheme.mockClear();
    shared.setRootViewBackgroundColor.mockClear();
    shared.setStatusBarStyle.mockClear();
    shared.startViewTransition.mockImplementation((update: () => void) => {
        update();
        return { ready: Promise.resolve() };
    });
    shared.documentElementAnimate.mockClear();
});

describe('Appearance settings item density', () => {
    const findDropdownByTriggerTestId = (
        screen: Awaited<ReturnType<typeof renderSettingsView>>,
        testID: string,
    ) => screen.findAllByType('DropdownMenu' as any)
        .find((node: any) => node.props?.itemTrigger?.itemProps?.testID === testID);

    it('renders one current-theme dropdown outside adaptive mode and slot dropdowns in adaptive mode', async () => {
        shared.settingsState.themePreference = 'light';
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const currentThemeDropdown = findDropdownByTriggerTestId(screen, 'settings-theme-selector-trigger');
        const lightDropdown = findDropdownByTriggerTestId(screen, 'settings-theme-light-selector-trigger');
        const darkDropdown = findDropdownByTriggerTestId(screen, 'settings-theme-dark-selector-trigger');
        expect(currentThemeDropdown).toBeTruthy();
        expect(lightDropdown).toBeUndefined();
        expect(darkDropdown).toBeUndefined();
        expect(currentThemeDropdown?.props?.selectedId).toBe('light');
        expect(currentThemeDropdown?.props?.items.map((item: any) => item.id)).toEqual([
            'adaptive',
            'light',
            'dark',
            ...BUILT_IN_THEME_PROFILES.map((definition) => definition.profile.id),
        ]);

        shared.settingsState.themePreference = 'adaptive';
        const adaptiveScreen = await renderSettingsView(React.createElement(mod.default));
        const adaptiveLightDropdown = findDropdownByTriggerTestId(adaptiveScreen, 'settings-theme-light-selector-trigger');
        const adaptiveDarkDropdown = findDropdownByTriggerTestId(adaptiveScreen, 'settings-theme-dark-selector-trigger');
        expect(adaptiveLightDropdown).toBeTruthy();
        expect(adaptiveDarkDropdown).toBeTruthy();
        expect(adaptiveLightDropdown?.props?.items.map((item: any) => item.id)).toEqual([
            'light',
            ...BUILT_IN_THEME_PROFILES
                .filter((definition) => definition.preferredMode === 'light')
                .map((definition) => definition.profile.id),
        ]);
    });

    it('assigns a curated dark theme from the current-theme dropdown and switches to dark mode', async () => {
        shared.settingsState.themePreference = 'light';
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const themeDropdown = findDropdownByTriggerTestId(screen, 'settings-theme-selector-trigger');

        await act(async () => {
            themeDropdown!.props.onSelect('premiumDark');
        });

        const themeProfiles = shared.settingsState.themeProfiles as { activeProfileIds: { light: string | null; dark: string | null }; profiles: Array<{ id: string; overrides: { dark: Record<string, string> } }> };
        expect(shared.settingsState.themePreference).toBe('dark');
        expect(themeProfiles.activeProfileIds).toEqual({ light: null, dark: 'premiumDark' });
        expect(themeProfiles.profiles).toEqual([]);
        expect(shared.setTheme).toHaveBeenCalledWith('dark');
    });

    it('applies status bar style immediately when switching to dark mode', async () => {
        shared.settingsState.themePreference = 'light';
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const themeDropdown = findDropdownByTriggerTestId(screen, 'settings-theme-selector-trigger');
        expect(themeDropdown).toBeTruthy();
        expect(themeDropdown?.props?.selectedId).toBe('light');

        await act(async () => {
            themeDropdown!.props.onSelect('dark');
        });

        expect(shared.settingsState.themePreference).toBe('dark');
        expect(shared.setTheme).toHaveBeenCalledWith('dark');
        expect(shared.setStatusBarStyle).toHaveBeenCalledWith('light', true);
    });

    it('wraps web theme changes in a view transition', async () => {
        shared.settingsState.themePreference = 'light';
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: {
                documentElement: {
                    animate: shared.documentElementAnimate,
                },
                startViewTransition: shared.startViewTransition,
            } as unknown as Document,
        });

        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const themeDropdown = findDropdownByTriggerTestId(screen, 'settings-theme-selector-trigger');
        expect(themeDropdown).toBeTruthy();
        expect(themeDropdown?.props?.selectedId).toBe('light');

        await act(async () => {
            themeDropdown!.props.onSelect('dark');
        });

        expect(shared.settingsState.themePreference).toBe('dark');
        expect(shared.startViewTransition).toHaveBeenCalledOnce();
        expect(shared.documentElementAnimate).toHaveBeenCalledWith(
            { clipPath: ['inset(0 0 100% 0)', 'inset(0)'] },
            expect.objectContaining({
                pseudoElement: '::view-transition-new(root)',
            }),
        );
    });

    it('renders the item density dropdown and updates the local setting', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const itemDensityDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.itemDensity');
        expect(itemDensityDropdown).toBeTruthy();
        expect(itemDensityDropdown?.props?.selectedId).toBe('comfortable');

        const itemIds = itemDensityDropdown?.props?.items?.map((item: any) => item.id) ?? [];
        expect(itemIds).toEqual(['comfortable', 'cozy', 'compact']);

        await act(async () => {
            itemDensityDropdown!.props.onSelect('cozy');
        });

        expect(shared.settingsState.uiItemDensity).toBe('cozy');
    });

    it('renders the content width dropdown and updates the local setting', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const contentWidthDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.contentWidth');
        expect(contentWidthDropdown).toBeTruthy();
        expect(contentWidthDropdown?.props?.selectedId).toBe('compact');

        const itemIds = contentWidthDropdown?.props?.items?.map((item: any) => item.id) ?? [];
        expect(itemIds).toEqual(['compact', 'medium', 'full']);

        await act(async () => {
            contentWidthDropdown!.props.onSelect('full');
        });

        expect(shared.settingsState.uiContentWidthMode).toBe('full');
    });

    it('renders the settings navigation sidebar toggle and updates the local setting', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const row = screen.findRow('settings-appearance-settings-nav-sidebar-enabled') as any;
        expect(row).toBeTruthy();
        expect(row.props?.rightElement).toBeTruthy();
        expect(row.props.rightElement.props?.value).toBe(true);

        await act(async () => {
            row.props.rightElement.props.onValueChange(false);
        });

        expect(shared.settingsState.settingsNavSidebarEnabled).toBe(false);
    });

    it('does not surface the mobile workspace experience setting from appearance settings', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workspaceModeDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.mobileWorkspaceExperience');
        expect(workspaceModeDropdown).toBeUndefined();
    });
});
