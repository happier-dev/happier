import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { renderSessionSettingsEntryView as renderBaseSettingsView, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

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

const initialStorage = storage.getState();

async function renderSettingsView(element: React.ReactElement, options?: Parameters<typeof renderBaseSettingsView>[1]) {
    storage.setState({ settings: settingsParse(shared.settingsState), localSettings: localSettingsParse(shared.settingsState) });
    return renderBaseSettingsView(element, options);
}

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
await vi.hoisted(async () => {
    const { installSessionSettingsEntryModuleMocks } = await import('./sessionSettingsEntryTestHelpers');
    installSessionSettingsEntryModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            const viewport = { width: 1200, height: 900, scale: 1, fontScale: 1 };
            return createReactNativeWebMock({
                Appearance: { getColorScheme: () => 'light' },
                Dimensions: { get: () => viewport },
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
    });
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

// Transform the real route during collection, not inside an interaction's execution budget.
await initializeAuthRouteRuntimeForTests();
const appearance = await import('@/app/(app)/settings/appearance/widgets');

afterEach(() => {
    standardCleanup();
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    Object.assign(shared.settingsState, {
        widgetFrameStyleHome: 'card',
        widgetFrameStyleBoard: 'card',
        widgetFrameStyleCompanion: 'plain',
        uiSurfaceFinish: 'soft',
        uiSurfaceFinishOverrides: {},
    });
});

describe('Appearance › Widgets and surfaces (lab WK)', () => {
    it('renders the real finish preview and changes global or inherited per-role choices through visible segments', async () => {
        const screen = await renderSettingsView(React.createElement(appearance.default), { flushOptions: { cycles: 0 } });
        expect(screen.findHostByTestId('settings-appearance-finish-preview-card')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-appearance-finish:flat');
        await vi.waitFor(() => expect(storage.getState().localSettings.uiSurfaceFinish).toBe('flat'));
        await screen.pressByTestIdAsync('settings-appearance-finish-customize');
        await screen.pressByTestIdAsync('settings-appearance-finish-card:soft');
        await vi.waitFor(() => expect(storage.getState().localSettings.uiSurfaceFinishOverrides).toEqual({ card: 'soft' }));
        await act(async () => screen.update(React.createElement(appearance.default)));
        await screen.pressByTestIdAsync('settings-appearance-finish-card:auto');
        await vi.waitFor(() => expect(storage.getState().localSettings.uiSurfaceFinishOverrides).toEqual({}));
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
        await vi.waitFor(() => expect(storage.getState().localSettings.widgetFrameStyleBoard).toBe('plain'));
        expect(storage.getState().localSettings.widgetFrameStyleHome).toBe('card');
        expect(storage.getState().localSettings.widgetFrameStyleCompanion).toBe('plain');
    });
});
