import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { renderSessionSettingsEntryView as renderSettingsView, resetSessionSettingsEntryState, sessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    settingsState: {
        themePreference: 'light',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        uiMultiPanePanelsEnabled: true,
        detailsPaneTabsBehavior: 'preview',
        avatarStyle: 'gradient',
        showFlavorIcons: true,
        preferredLanguage: null,
        themeProfiles: { activeProfileIds: { light: null, dark: null }, profiles: [] },
    } as Record<string, unknown>,
    setAdaptiveThemes: vi.fn(),
    setTheme: vi.fn(),
    setRootViewBackgroundColor: vi.fn(),
    setStatusBarStyle: vi.fn(),
    setSystemBackgroundColorAsync: vi.fn(),
    startViewTransition: vi.fn(),
    documentElementAnimate: vi.fn(),
}));

let transitionDom: JSDOM | undefined;

async function renderAppearance(element: React.ReactElement, options?: Parameters<typeof renderSettingsView>[1]) {
    await act(async () => {
        storage.setState({
            localSettings: localSettingsParse(shared.settingsState),
            settings: settingsParse(shared.settingsState),
        });
    });
    return renderSettingsView(element, options);
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
    });
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: shared.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: shared.setSystemBackgroundColorAsync }));

const { storage } = await import('@/sync/domains/state/storageStore');
const initialStorage = storage.getState();
await initializeAuthRouteRuntimeForTests();

// Resolve the real route graph during collection; cold transforms are not the reveal contract.
const { APPEARANCE_SETTINGS } = await import('@/components/settings/appearance/appearanceSettings');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { default: GlassAppearanceScreen } = await import('@/app/(app)/settings/appearance/glass');

// Load route graphs during collection; interaction deadlines measure the mounted contract.
await import('@/app/(app)/settings/appearance/glass');
await import('@/app/(app)/settings/appearance');

afterEach(() => {
    standardCleanup();
    transitionDom?.window.close();
    transitionDom = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    shared.settingsState.themePreference = 'light';
    shared.settingsState.themeProfiles = { activeProfileIds: { light: null, dark: null }, profiles: [] };
    delete shared.settingsState.themeProfileSelection;
    shared.setAdaptiveThemes.mockClear();
    shared.setTheme.mockClear();
    shared.setRootViewBackgroundColor.mockClear();
    shared.setStatusBarStyle.mockClear();
    shared.setSystemBackgroundColorAsync.mockClear();
    shared.startViewTransition.mockClear();
    shared.startViewTransition.mockImplementation((update: () => void) => {
        update();
        return { ready: Promise.resolve() };
    });
    shared.documentElementAnimate.mockClear();
});

describe('Appearance settings theme preference', () => {
    it.each([
        APPEARANCE_SETTINGS.settings.glassSidebar,
        APPEARANCE_SETTINGS.settings.glassElements,
    ])('reveals the requested glass layer row on Glass and backdrop from settings search: $anchor', async (setting) => {
        const requested = setting.anchor;
        const screen = await renderAppearance(
            <DestinationInstanceHost tabId="appearance-search" ref={{ kind: 'settings', params: { pageId: 'appearance/glass', setting: requested } }} pathname="/settings/appearance/glass" navigation={{ push: sessionSettingsEntryState.routerPushSpy, replace: vi.fn(), back: vi.fn() }} focused visible>
                <GlassAppearanceScreen />
            </DestinationInstanceHost>,
        );

        expect(screen.findByTestId('appearance-customize')).toBeNull();
        expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props.nativeID === `setting-${requested}`)).toHaveLength(1);
        expect(screen.findAllHostsByTestId(`setting-reveal.${requested}`)).toHaveLength(1);
        expect(screen.findAllHostsByTestId(`setting-reveal.${APPEARANCE_SETTINGS.settings.glassChrome.anchor}`)).toHaveLength(0);
    });

    it('summarizes which theme each mode uses and how many themes exist, without an embedded preview', async () => {
        shared.settingsState.themePreference = 'dark';
        shared.settingsState.themeProfileSelection = { light: null, dark: { kind: 'built-in', presetId: 'nightDark' } };
        const { default: Appearance } = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(<Appearance />);

        expect(screen.findByTestId('settings-theme-profile-preview')).toBeNull();
        const themesRow = screen.findRow('settings-appearance-themeProfiles') as any;
        const summary = await renderScreen(themesRow.props.subtitle);
        expect(summary.getTextContent()).toContain('common.default');
        expect(summary.getTextContent()).toContain('settingsAppearance.themeProfiles.presets.nightDark');
        expect(themesRow.props.detail).toBe(`settingsAppearance.themesCount(builtIn=${BUILT_IN_THEME_PROFILES.length + 2},custom=0)`);
    });

    const findThemeModeTiles = (screen: Awaited<ReturnType<typeof renderSettingsView>>) =>
        screen.findByProps({ testIdPrefix: 'settings-appearance-themeMode' });

    it('shows the mode as tiles in every mode', async () => {
        for (const mode of ['dark', 'adaptive'] as const) {
            shared.settingsState.themePreference = mode;
            const mod = await import('@/app/(app)/settings/appearance');
            const screen = await renderAppearance(React.createElement(mod.default), {
                flushOptions: { cycles: 0 },
            });

            expect(findThemeModeTiles(screen).props.value).toBe(mode);
            expect(findThemeModeTiles(screen).props.options.map((option: any) => option.id)).toEqual(['adaptive', 'light', 'dark']);
        }
    });

    it('applies status bar style immediately when selecting dark mode', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        await act(async () => {
            await findThemeModeTiles(screen).props.onChange('dark');
        });

        await vi.waitFor(() => {
            expect(storage.getState().localSettings.themePreference).toBe('dark');
            expect(shared.setTheme).toHaveBeenCalledWith('dark');
            expect(shared.setStatusBarStyle).toHaveBeenCalledWith('light', true);
        });
    });

    it('wraps web theme changes in a view transition', async () => {
        transitionDom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
        Object.defineProperty(transitionDom.window.document.documentElement, 'animate', {
            configurable: true, value: shared.documentElementAnimate,
        });
        Object.defineProperty(transitionDom.window.document, 'startViewTransition', {
            configurable: true, value: shared.startViewTransition,
        });
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: transitionDom.window.document,
        });

        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        await act(async () => {
            await findThemeModeTiles(screen).props.onChange('dark');
        });

        await vi.waitFor(() => expect(shared.startViewTransition).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(shared.documentElementAnimate).toHaveBeenCalledWith(
            { clipPath: ['inset(0 0 100% 0)', 'inset(0)'] },
            expect.objectContaining({ pseudoElement: '::view-transition-new(root)' }),
        ));
    });

    it('switching mode keeps the theme already assigned to that mode', async () => {
        shared.settingsState.themePreference = 'light';
        shared.settingsState.themeProfiles = { activeProfileIds: { light: null, dark: 'premiumDark' }, profiles: [] };
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        await act(async () => {
            await findThemeModeTiles(screen).props.onChange('dark');
        });

        await vi.waitFor(() => {
            const { themeProfiles, themePreference } = storage.getState().localSettings;
            expect(themePreference).toBe('dark');
            expect(themeProfiles.activeProfileIds).toEqual({ light: null, dark: 'premiumDark' });
        });
    });

    it('opens theme profile management from the theme group', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderAppearance(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        await act(async () => {
            screen.pressByTestId('settings-appearance-themeProfiles');
        });

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/appearance/themes');
    });
});
