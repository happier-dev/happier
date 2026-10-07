import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
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

const createMutableSettingHook = (settingsState: Record<string, unknown>, defaults: Record<string, unknown>): MutableSettingHook => {
    return (key: string) => [
        Object.prototype.hasOwnProperty.call(settingsState, key) ? settingsState[key] : defaults[key] ?? null,
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
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        const mutableSetting = createMutableSettingHook(shared.settingsState, { ...settingsDefaults, ...localSettingsDefaults });
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

// Load the real screen once, after the shared boundary factories have their configuration. Its
// module graph belongs to test setup; the tests' deadlines measure rendering and interaction.
const { default: AppearanceSettingsScreen } = await import('@/app/(app)/settings/appearance');

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
    it('shows every item density as a visible choice and updates the local setting', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const itemDensityChoice = screen.findByProps({ testIDPrefix: 'settings-appearance-itemDensity' });
        expect(itemDensityChoice.props.value).toBe('comfortable');
        expect(itemDensityChoice.props.options.map((option: any) => option.id)).toEqual(['comfortable', 'cozy', 'compact']);

        await act(async () => {
            itemDensityChoice.props.onChange('cozy');
        });

        expect(shared.settingsState.uiItemDensity).toBe('cozy');
    });

    it('shows every loading indicator preview and stores the selected style on this device', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));
        const row = screen.findRowByTitle('settingsAppearance.loadingIndicatorStyle');
        expect(row).not.toBeNull();
        // The existing settings harness keeps Item shallow; its rightElement is the real tile control.
        const picker = row!.props.rightElement;
        expect(picker.props.value).toBe('wave');
        expect(picker.props.options.map((option: { id: string }) => option.id)).toEqual([
            'wave', 'handwritten', 'buildAndRelease', 'relay', 'twinStems', 'slowBreath',
            'starfield', 'sweep', 'radar', 'ripple', 'aurora',
            'hWave', 'hHandwritten', 'hBuildAndRelease', 'hRelay', 'hTwinStems', 'hSlowBreath',
            'hStarfield', 'hSweep', 'hRadar', 'hRipple', 'hAurora', 'classicRing',
        ]);
        expect(picker.props.options.find((option: { id: string }) => option.id === 'radar')?.preview.props.styleId).toBe('radar');
        await act(async () => { picker.props.onChange('notAStyle'); });
        expect(shared.settingsState.loadingIndicatorStyle).toBeUndefined();
        await act(async () => { picker.props.onChange('hWave'); });
        expect(shared.settingsState.loadingIndicatorStyle).toBe('hWave');
        delete shared.settingsState.loadingIndicatorStyle;
    });

    it('chooses the loading indicator speed and pause beside the style and stores them on this device', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const speed = screen.findByProps({ testIDPrefix: 'settings-appearance-loadingIndicatorSpeed' });
        const pause = screen.findByProps({ testIDPrefix: 'settings-appearance-loadingIndicatorPause' });
        expect(speed.props.value).toBe('normal');
        expect(speed.props.options.map((option: { id: string }) => option.id)).toEqual(['slow', 'normal', 'fast']);
        expect(pause.props.value).toBe('short');
        expect(pause.props.options.map((option: { id: string }) => option.id)).toEqual(['none', 'short', 'long']);
        expect(speed.props.disabled).toBeFalsy();
        expect(pause.props.disabled).toBeFalsy();

        await act(async () => { speed.props.onChange('fast'); });
        await act(async () => { pause.props.onChange('long'); });
        expect(shared.settingsState.loadingIndicatorSpeed).toBe('fast');
        expect(shared.settingsState.loadingIndicatorPause).toBe('long');
        delete shared.settingsState.loadingIndicatorSpeed;
        delete shared.settingsState.loadingIndicatorPause;
    });

    it.each([
        ['radar', { speed: false, pause: true }],
        ['hRadar', { speed: false, pause: true }],
        ['classicRing', { speed: true, pause: true }],
    ] as const)('says when the %s style ignores a timing choice instead of offering it', async (styleId, disabled) => {
        shared.settingsState.loadingIndicatorStyle = styleId;
        try {
            const mod = await import('@/app/(app)/settings/appearance');
            const screen = await renderSettingsView(React.createElement(mod.default));

            const speed = screen.findByProps({ testIDPrefix: 'settings-appearance-loadingIndicatorSpeed' });
            const pause = screen.findByProps({ testIDPrefix: 'settings-appearance-loadingIndicatorPause' });
            expect(Boolean(speed.props.disabled)).toBe(disabled.speed);
            expect(Boolean(pause.props.disabled)).toBe(disabled.pause);
            // One reason per state: the ring's note sits on Speed and covers Pause too.
            const reasons = [speed.props.subtitle, pause.props.subtitle];
            expect(reasons).toEqual(styleId === 'classicRing'
                ? ['settingsAppearance.loadingIndicatorSpeedUnavailable', 'settingsAppearance.loadingIndicatorPauseDescription']
                : ['settingsAppearance.loadingIndicatorSpeedDescription', 'settingsAppearance.loadingIndicatorPauseUnavailable']);
        } finally {
            delete shared.settingsState.loadingIndicatorStyle;
        }
    });

    it('keeps the loading indicator previews out of the accessibility tree, since the option title already names the style', async () => {
        const { LoadingIndicatorStylePreview } = await import('@/components/settings/appearance/LoadingIndicatorStylePreview');
        const screen = await renderSettingsView(React.createElement(LoadingIndicatorStylePreview, { styleId: 'radar' }));

        const root = screen.findAllByType('View' as any)[0];
        expect(root?.props).toEqual(expect.objectContaining({
            'aria-hidden': true,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        }));
    });

    it('shows every content width as a visible choice and updates the local setting', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const contentWidthChoice = screen.findByProps({ testIDPrefix: 'settings-appearance-contentWidth' });
        expect(contentWidthChoice.props.value).toBe('compact');
        expect(contentWidthChoice.props.options.map((option: any) => option.id)).toEqual(['compact', 'medium', 'full']);

        await act(async () => {
            contentWidthChoice.props.onChange('full');
        });

        expect(shared.settingsState.uiContentWidthMode).toBe('full');
    });

    it('renders the settings navigation sidebar toggle and updates the local setting', async () => {
        const screen = await renderSettingsView(React.createElement(AppearanceSettingsScreen));

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
        const screen = await renderSettingsView(React.createElement(AppearanceSettingsScreen));

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const workspaceModeDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.mobileWorkspaceExperience');
        expect(workspaceModeDropdown).toBeUndefined();
    });

    it('keeps session list organisation on the Sessions page, not Appearance', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const titles = screen.findAllByType('Item' as any).map((node: any) => node.props.title);
        expect(titles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(titles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(titles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
    });
});
