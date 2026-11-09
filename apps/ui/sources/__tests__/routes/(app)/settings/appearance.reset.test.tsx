import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { localSettingsDefaults, localSettingsParse } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { ThemeProfilesLocalStateSchema } from '@/theme/profiles/themeProfilePersistence';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

const CUSTOM_PROFILE = ThemeProfilesLocalStateSchema.parse({
    activeProfileIds: { light: null, dark: null },
    profiles: [createThemeProfileDraft({ id: 'custom-1', name: 'Mine', now: '2026-09-23T00:00:00.000Z' })],
}).profiles[0]!;

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
        systemTabBarEnabled: false,
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
    confirm: vi.fn(async (): Promise<boolean> => true),
}));

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
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

afterEach(async () => {
    standardCleanup();
    setReducedMotionPreferenceOverride(null);
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    shared.confirm.mockReset();
    shared.confirm.mockImplementation(async () => true);
});

const { default: AppearanceSettingsScreen } = await import('@/app/(app)/settings/appearance');

async function mountReset(actionsSettingsV1: unknown = { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } }) {
    setReducedMotionPreferenceOverride(true);
    const fixture = nonDefaultAppearanceState();
    account = await createSecretSettingsTestHarness({ token: createAccountTokenForTests('account-a', { currentAccount: true }),
        settings: settingsParse({ ...fixture, themeProfiles: [CUSTOM_PROFILE], actionsSettingsV1 }), sharedEnabled: false });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await queue.awaitQueue();
    storage.setState({ localSettings: localSettingsParse(fixture) });
    const screen = await renderSettingsView(
        <InjectedAuthProvider credentials={account.credentials}>{React.createElement(AppearanceSettingsScreen)}</InjectedAuthProvider>,
        { flushOptions: { cycles: 0 } },
    );
    const reset = screen.findByTestId('settings-appearance-reset');
    if (!reset) throw new Error('Expected the Reset action in the page header');
    return () => { reset.props.onPress?.(); };
}

describe('Appearance reset', () => {
    it('returns every appearance preference to its default without caller confirmation and keeps custom themes', async () => {
        const reset = await mountReset();
        await act(async () => { reset(); });

        expect(shared.confirm).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(account?.settingsWrites.length).toBeGreaterThan(0));
        const { sync } = await import('@/sync/sync');
        const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
        await queue.awaitQueue();
        const state = storage.getState().localSettings;
        expect(state.themePreference).toBe(localSettingsDefaults.themePreference);
        expect(state.themeProfileSelection).toEqual({ light: null, dark: null });
        expect(state.themeProfiles).toEqual(nonDefaultAppearanceState().themeProfiles);
        expect(account?.persistedSettings.themeProfiles).toEqual([CUSTOM_PROFILE]);
        for (const key of [
            'uiFontScale', 'uiContentWidthMode', 'uiItemDensity', 'uiMultiPanePanelsEnabled',
            'detailsPaneTabsBehavior', 'settingsNavSidebarEnabled', 'systemTabBarEnabled',
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
            expect(storage.getState().settings[key], key).toEqual(settingsDefaults[key]);
            expect(account?.persistedSettings[key], `${key} persisted`).toEqual(settingsDefaults[key]);
        }
        // Legacy backdrop blur is not shown on Appearance; Reset preserves it.
        expect(state.uiBackdropBlurEnabled).toBe(false);
        // Language has its own page and is not an appearance preference.
        expect(storage.getState().settings.preferredLanguage).toBe('fr');
        expect(account?.persistedSettings.preferredLanguage).toBe('fr');
    });

    it('admits the entire reset once: Off changes nothing, Ask rejects or approves both stores together', async () => {
        const reset = await mountReset({ v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } } });
        await act(async () => { reset(); });
        const fixture = nonDefaultAppearanceState();
        expect(storage.getState().localSettings).toEqual(localSettingsParse(fixture));
        expect(account?.settingsWrites).toEqual([]);
        await act(async () => { account!.replaceSettings(settingsParse({ ...account!.persistedSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.invoke': { approvalRequiredSurfaces: ['ui'] } } },
        })); reset(); });
        await vi.waitFor(() => expect(account!.artifacts.list()).toHaveLength(1));
        expect(storage.getState().localSettings).toEqual(localSettingsParse(fixture));
        expect(account!.persistedSettings.visualEffectsLevel).toBe('minimal');
        await decideApprovalAsInbox(account!.scope.serverId, account!.artifacts.list()[0]!.id, 'reject');
        expect(storage.getState().localSettings).toEqual(localSettingsParse(fixture));
        await act(async () => { reset(); });
        await vi.waitFor(() => expect(account!.artifacts.list()).toHaveLength(2));
        await decideApprovalAsInbox(account!.scope.serverId, account!.artifacts.list()[1]!.id, 'approve');
        await vi.waitFor(() => expect(account!.persistedSettings.visualEffectsLevel).toBe('full'));
        expect(storage.getState().localSettings.themePreference).toBe(localSettingsDefaults.themePreference);
        expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([CUSTOM_PROFILE]);
        expect(account!.persistedSettings.preferredLanguage).toBe('fr');
        expect(account!.artifacts.list()).toHaveLength(2);
        expect(shared.confirm).not.toHaveBeenCalled();
    });

    it('runs the same declared reset from the Agent surface without a mounted button callback', async () => {
        await mountReset({ v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['agent'] } });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        let result: unknown;
        await act(async () => { result = await createDefaultActionExecutor().execute('settings.invoke', { anchor: 'appearance.reset' },
            { serverId: account!.scope.serverId, surface: 'agent', authority: 'account_automation' }); });
        expect(result).toMatchObject({ ok: true, result: { anchor: 'appearance.reset', status: 'completed' } });
        expect(storage.getState().localSettings.themePreference).toBe(localSettingsDefaults.themePreference);
        expect(account!.persistedSettings.visualEffectsLevel).toBe(settingsDefaults.visualEffectsLevel);
        expect(account!.persistedSettings.preferredLanguage).toBe('fr');
    });
});
