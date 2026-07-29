import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    settingsState: {
        themePreference: 'adaptive',
        visualEffectsLevel: 'full',
        animatedNumbers: true,
        contextGaugeStyle: 'gauge',
        alwaysShowContextSize: false,
        preferredLanguage: null,
    } as Record<string, unknown>,
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
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));
vi.mock('@/theme', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/theme')>();
    return {
        ...actual,
        darkTheme: { ...actual.darkTheme, colors: { ...actual.darkTheme.colors, groupped: { background: '#000' } } },
        lightTheme: { ...actual.lightTheme, colors: { ...actual.lightTheme.colors, groupped: { background: '#fff' } } },
    };
});

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
    shared.settingsState.visualEffectsLevel = 'full';
    shared.settingsState.animatedNumbers = true;
    shared.settingsState.contextGaugeStyle = 'gauge';
    shared.settingsState.alwaysShowContextSize = false;
});

describe('Appearance settings — Visual Effects section', () => {
    it('renders the effects-level selector and persists a new level', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        const levelSelect = screen.findByProps({ selectedId: 'full' });
        expect(levelSelect).toBeTruthy();

        await act(async () => {
            levelSelect.props.onSelect('minimal');
        });
        expect(shared.settingsState.visualEffectsLevel).toBe('minimal');
    });

    it('renders the animated-numbers toggle and persists changes', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        const row = screen.findByProps({ title: 'settingsAppearance.visualEffects.animatedNumbers' });
        const switchNode = row.props.rightElement;
        expect(switchNode?.props?.value).toBe(true);

        await act(async () => {
            switchNode.props.onValueChange(false);
        });
        expect(shared.settingsState.animatedNumbers).toBe(false);
    });

    it('renders the context-display selector and persists a new style', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        const contextSelect = screen.findByProps({ selectedId: 'gauge' });
        expect(contextSelect).toBeTruthy();

        await act(async () => {
            contextSelect.props.onSelect('hidden');
        });
        expect(shared.settingsState.contextGaugeStyle).toBe('hidden');
    });

    it('folds the always-show-context-size toggle into the visual effects section', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        const row = screen.findByProps({ title: 'settingsAppearance.alwaysShowContextSize' });
        const switchNode = row.props.rightElement;
        expect(switchNode?.props?.value).toBe(false);

        await act(async () => {
            switchNode.props.onValueChange(true);
        });
        expect(shared.settingsState.alwaysShowContextSize).toBe(true);
    });
});
