import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CUSTOM_PROFILE = createThemeProfileDraft({ id: 'custom-1', name: 'Mine', now: '2026-09-23T00:00:00.000Z' });

function nonDefaultAppearanceState(): Record<string, unknown> {
    return {
        themePreference: 'dark',
        themeProfiles: { activeProfileIds: { light: null, dark: 'nightDark' }, profiles: [CUSTOM_PROFILE] },
        uiFontScale: 1.3,
        uiContentWidthMode: 'full',
        uiItemDensity: 'compact',
        uiMultiPanePanelsEnabled: false,
        uiBackdropBlurEnabled: false,
        detailsPaneTabsBehavior: 'persistent',
        settingsNavSidebarEnabled: false,
        loadingIndicatorStyle: 'hWave',
        loadingIndicatorSpeed: 'fast',
        loadingIndicatorPause: 'none',
        avatarStyle: 'brutalist',
        showFlavorIcons: false,
        tabBarGitBadgeMode: 'off',
        tabBarFriendsBadgeEnabled: false,
        tabBarSessionsBadgeEnabled: false,
        tabBarInboxBadgeEnabled: false,
        tabBarOpenTabsBadgeEnabled: false,
        tabBarShowLabels: true,
        tabBarSize: 'large',
        glassBlurEnabled: false,
        glassBlurIntensity: 'strong',
        visualEffectsLevel: 'minimal',
        contextGaugeStyle: 'hidden',
        animatedNumbers: false,
        alwaysShowContextSize: true,
        preferredLanguage: 'fr',
    };
}

const shared = vi.hoisted(() => ({
    settingsState: {} as Record<string, unknown>,
    confirm: vi.fn(async (): Promise<boolean> => true),
}));

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Appearance: { getColorScheme: () => 'light' } });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            runtime: { setAdaptiveThemes: vi.fn(), setTheme: vi.fn(), setRootViewBackgroundColor: vi.fn() },
        });
    },
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return {
            ...createTextModuleMock(),
            getLanguageNativeName: () => 'English',
            SUPPORTED_LANGUAGES: { en: true, fr: true },
        };
    },
    modalModule: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: shared.confirm } }).module;
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const mutableSetting = (key: string) => [
            shared.settingsState[key] ?? null,
            (next: unknown) => { shared.settingsState[key] = next; },
        ];
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                // Theme selection persists through the store writer; keep it on the same boundary fixture.
                storage: createStorageStoreMock({
                    applyLocalSettings: (delta) => { Object.assign(shared.settingsState, delta); },
                }),
                useSettingMutable: mutableSetting as unknown as typeof import('@/sync/domains/state/storage')['useSettingMutable'],
                useLocalSettingMutable: mutableSetting as unknown as typeof import('@/sync/domains/state/storage')['useLocalSettingMutable'],
            },
        });
    },
    useDeviceType: 'desktop',
});

// Boundary fixture: the settings writers persist to the synced store; here they write the same keyed state.
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => (delta: Record<string, unknown>) => { Object.assign(shared.settingsState, delta); },
    useApplyLocalSettings: () => (delta: Record<string, unknown>) => { Object.assign(shared.settingsState, delta); },
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({ useReducedMotionPreference: () => true }));

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
    shared.confirm.mockReset();
    shared.confirm.mockImplementation(async () => true);
});

async function pressReset() {
    shared.settingsState = nonDefaultAppearanceState();
    const mod = await import('@/app/(app)/settings/appearance');
    const screen = await renderSettingsView(React.createElement(mod.default), { flushOptions: { cycles: 0 } });
    const reset = screen.findByTestId('settings-appearance-reset');
    if (!reset) throw new Error('Expected the Reset action in the page header');
    await act(async () => {
        await reset.props.onPress?.();
    });
}

describe('Appearance reset', () => {
    it('after confirmation returns every appearance preference on the page to its default and keeps custom themes', async () => {
        await pressReset();

        expect(shared.confirm).toHaveBeenCalledOnce();
        const state = shared.settingsState;
        expect(state.themePreference).toBe(localSettingsDefaults.themePreference);
        expect(state.themeProfiles).toEqual({ activeProfileIds: { light: null, dark: null }, profiles: [CUSTOM_PROFILE] });
        for (const key of [
            'uiFontScale', 'uiContentWidthMode', 'uiItemDensity', 'uiMultiPanePanelsEnabled',
            'detailsPaneTabsBehavior', 'settingsNavSidebarEnabled',
            'loadingIndicatorStyle', 'loadingIndicatorSpeed', 'loadingIndicatorPause',
        ] as const) {
            expect(state[key], key).toEqual(localSettingsDefaults[key]);
        }
        for (const key of [
            'avatarStyle', 'showFlavorIcons', 'tabBarGitBadgeMode', 'tabBarFriendsBadgeEnabled',
            'tabBarSessionsBadgeEnabled', 'tabBarInboxBadgeEnabled', 'tabBarOpenTabsBadgeEnabled',
            'tabBarShowLabels', 'tabBarSize', 'glassBlurEnabled', 'glassBlurIntensity', 'visualEffectsLevel',
            'contextGaugeStyle', 'animatedNumbers', 'alwaysShowContextSize',
        ] as const) {
            expect(state[key], key).toEqual(settingsDefaults[key]);
        }
        // Legacy backdrop blur is not shown on Appearance; Reset preserves it.
        expect(state.uiBackdropBlurEnabled).toBe(false);
        // Language has its own page and is not an appearance preference.
        expect(state.preferredLanguage).toBe('fr');
    });

    it('changes nothing when the confirmation is declined', async () => {
        shared.confirm.mockImplementation(async () => false);

        await pressReset();

        expect(shared.settingsState).toEqual(nonDefaultAppearanceState());
    });
});
