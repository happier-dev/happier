import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    settingsState: {
        themePreference: 'adaptive',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        uiMultiPanePanelsEnabled: true,
        uiBackdropBlurEnabled: true,
        detailsPaneTabsBehavior: 'preview',
        settingsNavSidebarEnabled: true,
        avatarStyle: 'gradient',
        showFlavorIcons: true,
        preferredLanguage: null,
        widgetFrameStyleHome: 'card',
        widgetFrameStyleBoard: 'card',
        widgetFrameStyleCompanion: 'plain',
        uiSurfaceFinish: 'soft',
        uiSurfaceFinishOverrides: {},
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

// The shared legacy harness's partial stub omits useIsTablet; restore real responsive logic.
vi.doUnmock('@/utils/platform/responsive');
// Visible segments live in Item's accessory: exercise its real rendering, not the legacy stub.
vi.doUnmock('@/components/ui/lists/Item');
vi.doUnmock('@/components/ui/lists/ItemGroup');
vi.doUnmock('@/components/ui/lists/ItemList');

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

// Transform the real route during collection, not inside an interaction's execution budget.
const appearance = await import('@/app/(app)/settings/appearance');

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
    Object.assign(shared.settingsState, {
        widgetFrameStyleHome: 'card',
        widgetFrameStyleBoard: 'card',
        widgetFrameStyleCompanion: 'plain',
        uiSurfaceFinish: 'soft',
        uiSurfaceFinishOverrides: {},
    });
});

describe('Appearance → Widgets (lab WK)', () => {
    it('renders the real finish preview and changes global or inherited per-role choices through visible segments', async () => {
        const screen = await renderSettingsView(React.createElement(appearance.default), { flushOptions: { cycles: 0 } });
        expect(screen.findHostByTestId('settings-appearance-finish-preview-card')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-appearance-finish:flat');
        expect(shared.settingsState.uiSurfaceFinish).toBe('flat');
        await screen.pressByTestIdAsync('settings-appearance-finish-customize');
        await screen.pressByTestIdAsync('settings-appearance-finish-card:soft');
        expect(shared.settingsState.uiSurfaceFinishOverrides).toEqual({ card: 'soft' });
        // The hook boundary projects the new stored value on the next render, as the real store does.
        await act(async () => screen.update(React.createElement(appearance.default)));
        await screen.pressByTestIdAsync('settings-appearance-finish-card:auto');
        expect(shared.settingsState.uiSurfaceFinishOverrides).toEqual({});
    });
    it('offers Card | Plain per surface with the current defaults, and writes the one surface changed', async () => {
        const screen = await renderSettingsView(React.createElement(appearance.default), {
            flushOptions: { cycles: 0 },
        });

        const home = screen.findByProps({ title: 'widgetFrame.surfaceHome' });
        const board = screen.findByProps({ title: 'widgetFrame.surfaceBoard' });
        const companion = screen.findByProps({ title: 'widgetFrame.surfaceCompanion' });
        expect([home.props.value, board.props.value, companion.props.value]).toEqual(['card', 'card', 'plain']);
        expect(board.props.options.map((option: { id: string }) => option.id)).toEqual(['card', 'plain']);

        await act(async () => {
            board.props.onChange('plain');
        });
        expect(shared.settingsState.widgetFrameStyleBoard).toBe('plain');
        expect(shared.settingsState.widgetFrameStyleHome).toBe('card');
        expect(shared.settingsState.widgetFrameStyleCompanion).toBe('plain');
    });
});
