import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    localSettingsState: { hapticsEnabled: true } as Record<string, unknown>,
    settingsState: {
        themePreference: 'adaptive',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        uiMultiPanePanelsEnabled: true,
        uiBackdropBlurEnabled: true,
        detailsPaneTabsBehavior: 'preview',
        avatarStyle: 'gradient',
        showFlavorIcons: true,
        preferredLanguage: null,
        glassBlurEnabled: true,
        glassBlurIntensity: 'regular',
    } as Record<string, unknown>,
}));

const platform = vi.hoisted(() => ({ OS: 'web' as 'web' | 'android' | 'ios' }));

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
            Platform: { get OS() { return platform.OS; } },
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
                setAdaptiveThemes: vi.fn(),
                setTheme: vi.fn(),
                setRootViewBackgroundColor: vi.fn(),
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
        const localMutableSetting: MutableSettingHook = (key) => key === 'hapticsEnabled'
            ? createMutableSettingHook(shared.localSettingsState)(key)
            : mutableSetting(key);
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: mutableSetting as typeof import('@/sync/domains/state/storage')['useSettingMutable'],
                useLocalSettingMutable: localMutableSetting as typeof import('@/sync/domains/state/storage')['useLocalSettingMutable'],
            },
        });
    },
    useDeviceType: 'desktop',
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));
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
    shared.settingsState.uiBackdropBlurEnabled = true;
    shared.localSettingsState.hapticsEnabled = true;
    platform.OS = 'web';
});

describe('Appearance settings backdrop blur', () => {
    it('renders and updates the backdrop blur toggle', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        const blurRow = screen.findByProps({ title: 'settingsAppearance.backdropBlur' });
        expect(blurRow).toBeTruthy();

        const switchNode = blurRow.props.rightElement;
        expect(switchNode?.type).toBe('Switch');
        expect(switchNode?.props?.value).toBe(true);

        await act(async () => {
            switchNode.props.onValueChange(false);
        });

        expect(shared.settingsState.uiBackdropBlurEnabled).toBe(false);
    });
});

describe('Appearance settings haptics', () => {
    it.each(['ios', 'android'] as const)('updates the device-local haptics setting on %s independently of visual effects', async (os) => {
        platform.OS = os;
        shared.localSettingsState.hapticsEnabled = false;
        shared.settingsState.uiBackdropBlurEnabled = false;
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });
        const row = screen.findByProps({ testID: 'settings-appearance-haptics' });
        const toggle = row.props.rightElement;
        expect(toggle.props.value).toBe(false);
        await act(async () => { toggle.props.onValueChange(true); });
        expect(shared.localSettingsState.hapticsEnabled).toBe(true);
        await act(async () => { toggle.props.onValueChange(false); });
        expect(shared.localSettingsState.hapticsEnabled).toBe(false);
        expect(shared.settingsState).not.toHaveProperty('hapticsEnabled');
        expect(shared.settingsState.uiBackdropBlurEnabled).toBe(false);
    });

    it('hides the haptics control on web', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });
        expect(screen.findAllByProps({ testID: 'settings-appearance-haptics' })).toHaveLength(0);
    });
});

describe('Appearance settings glass intensity', () => {
    async function renderAppearance() {
        const mod = await import('@/app/(app)/settings/appearance');
        return renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });
    }

    it('offers the blur intensity picker where glass is a real blur', async () => {
        const screen = await renderAppearance();

        expect(screen.findAllByProps({ title: 'settingsAppearance.glass.intensity' }).length).toBeGreaterThan(0);
    });

    // Android glass is a translucent tint without blur, so an intensity choice would do nothing.
    it('hides the blur intensity picker on Android', async () => {
        platform.OS = 'android';

        const screen = await renderAppearance();

        expect(screen.findAllByProps({ title: 'settingsAppearance.glass.enable' }).length).toBeGreaterThan(0);
        expect(screen.findAllByProps({ title: 'settingsAppearance.glass.intensity' })).toHaveLength(0);
    });
});
