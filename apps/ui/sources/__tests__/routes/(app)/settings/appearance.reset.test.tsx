import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { projectThemeLibraryEntry, projectThemeMiniaturePalette } from '@/theme/profiles/themeProfilePresentation';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { Theme } from '@/theme';

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

const parsedCustomTheme = parseThemeProfileDocument(createThemeProfileDraft({
    id: '11111111-1111-4111-8111-111111111111', name: 'Mine', now: '2026-09-23T00:00:00.000Z',
}));
if (!parsedCustomTheme.ok) throw new Error('Invalid custom theme fixture');
const customTheme = parsedCustomTheme.document;

function nonDefaultAppearanceState(): Record<string, unknown> {
    return {
        themePreference: 'dark',
        themeProfileSelection: { light: null, dark: { kind: 'built-in', presetId: 'nightDark' } },
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
    setTheme: vi.fn(),
    themes: null as Record<'light' | 'dark', Theme> | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const viewport = { width: 1200, height: 900, scale: 1, fontScale: 1 };
    return createReactNativeWebMock({
        Appearance: { getColorScheme: () => 'light' },
        Dimensions: { get: () => viewport },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        runtime: { setAdaptiveThemes: vi.fn(), setTheme: shared.setTheme, setRootViewBackgroundColor: vi.fn(),
            getTheme: (name: 'light' | 'dark') => shared.themes?.[name],
            updateTheme: (name: 'light' | 'dark', update: (theme: Theme) => Theme) => {
                if (shared.themes) shared.themes[name] = update(shared.themes[name]);
            } },
    });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        getLanguageNativeName: () => 'English',
        SUPPORTED_LANGUAGES: { en: true, fr: true },
    };
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: shared.confirm } }).module;
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

let browser: Awaited<ReturnType<typeof import('@/dev/testkit/harness/browserRuntimeHarness')['installBrowserRuntimeForTests']>>;
beforeEach(async () => {
    browser = await (await import('@/dev/testkit/harness/browserRuntimeHarness')).installBrowserRuntimeForTests({
        url: 'https://ui.fixture.test/settings',
    });
});

afterEach(async () => {
    standardCleanup();
    setReducedMotionPreferenceOverride(null);
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    browser.restore();
    shared.confirm.mockReset();
    shared.confirm.mockImplementation(async () => true);
});

const { default: AppearanceSettingsScreen } = await import('@/app/(app)/settings/appearance');
const { ThemeProfileRuntimeSync } = await import('@/theme/ThemeProfileRuntimeSync');

async function mountReset(actionsSettingsV1: unknown = { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } }) {
    setReducedMotionPreferenceOverride(true);
    const fixture = nonDefaultAppearanceState();
    account = await createSecretSettingsTestHarness({ token: createAccountTokenForTests('account-a', { currentAccount: true }),
        settings: settingsParse({ ...fixture, actionsSettingsV1 }), sharedEnabled: false });
    const entry = projectThemeLibraryEntry(customTheme);
    account.artifacts.replaceStoredRow(createPlainArtifactHttpFixture({ id: entry.id, title: entry.name,
        sourceServerId: account.scope.serverId, ownerAccountId: account.scope.accountId, access: 'owner', isDecrypted: true,
        rawHeader: { v: 1, kind: 'theme_profile.v1', title: entry.name, mode: entry.mode, themeSource: entry.source,
            compatibility: entry.compatibility, palette: projectThemeMiniaturePalette(customTheme.profile) },
        body: JSON.stringify(customTheme.raw), headerVersion: 1, bodyVersion: 1, seq: 1,
        createdAt: 0, updatedAt: 0 }, account.scope.accountId));
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await queue.awaitQueue();
    storage.getState().applyLocalSettings(localSettingsParse(fixture));
    const { lightTheme, darkTheme } = await import('@/theme');
    shared.themes = { light: lightTheme, dark: darkTheme };
    const screen = await renderSettingsView(
        <InjectedAuthProvider credentials={account.credentials}><ThemeProfileRuntimeSync />
            {React.createElement(AppearanceSettingsScreen)}</InjectedAuthProvider>,
        { flushOptions: { cycles: 0 } },
    );
    const reset = screen.findByTestId('settings-appearance-reset');
    if (!reset) throw new Error('Expected the Reset action in the page header');
    return () => { reset.props.onPress?.(); };
}

describe('Appearance reset', () => {
    it('returns every appearance preference to its default without caller confirmation and keeps custom themes', async () => {
        const reset = await mountReset();
        shared.setTheme.mockClear();
        let localPublications = 0;
        onTestFinished(storage.subscribe((next, previous) => {
            if (next.localSettings !== previous.localSettings) localPublications++;
        }));
        await act(async () => { reset(); });

        expect(shared.confirm).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(account?.settingsWrites.length).toBeGreaterThan(0));
        const { sync } = await import('@/sync/sync');
        const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
        await queue.awaitQueue();
        expect(localPublications).toBe(1);
        expect(shared.setTheme).toHaveBeenCalledTimes(1);
        const state = storage.getState().localSettings;
        expect(state.themePreference).toBe(localSettingsDefaults.themePreference);
        expect(state.themeProfileSelection).toEqual({ light: null, dark: null });
        expect(account?.artifacts.readPlainBody(customTheme.profile.id)).toBe(JSON.stringify(customTheme.raw));
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
        shared.confirm.mockResolvedValueOnce(false);
        await act(async () => { account!.replaceSettings(settingsParse({ ...account!.persistedSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.invoke': { approvalRequiredSurfaces: ['ui'] } } },
        })); reset(); });
        await vi.waitFor(() => expect(shared.confirm).toHaveBeenCalledTimes(1));
        expect(storage.getState().localSettings).toEqual(localSettingsParse(fixture));
        expect(account!.persistedSettings.visualEffectsLevel).toBe('minimal');
        await act(async () => { reset(); });
        await vi.waitFor(() => expect(account!.persistedSettings.visualEffectsLevel).toBe('full'));
        expect(storage.getState().localSettings.themePreference).toBe(localSettingsDefaults.themePreference);
        expect(account!.artifacts.readPlainBody(customTheme.profile.id)).toBe(JSON.stringify(customTheme.raw));
        expect(account!.persistedSettings.preferredLanguage).toBe('fr');
        expect(account!.artifacts.list()).toHaveLength(1);
        expect(shared.confirm).toHaveBeenCalledTimes(2);
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
