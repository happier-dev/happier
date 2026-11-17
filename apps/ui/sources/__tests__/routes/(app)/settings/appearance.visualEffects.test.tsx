import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderSettingsView as renderBaseSettingsView, standardCleanup } from '@/dev/testkit';
import 'fake-indexeddb/auto';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { Modal } from '@/modal';
import { resetSessionSettingsEntryState, sessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

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

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;

async function renderSettingsView(element: React.ReactElement, options?: Parameters<typeof renderBaseSettingsView>[1]) {
    account = await createSecretSettingsTestHarness({ token: createAccountTokenForTests('account-a', { currentAccount: true }),
        sharedEnabled: false, settings: settingsParse(shared.settingsState) });
    storage.setState({ localSettings: localSettingsParse(shared.settingsState) });
    const credentials = account.credentials;
    const wrapper = ({ children }: React.PropsWithChildren) => <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
    return renderBaseSettingsView(element, { ...options, wrapper });
}

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

// Load route graphs during collection; interaction deadlines measure the mounted contract.
await import('@/app/(app)/settings/appearance');
await import('@/app/(app)/settings/appearance/motion');
await import('@/app/(app)/settings/appearance/widgets');

beforeEach(() => { vi.mocked(Modal.confirm).mockClear(); });

afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    storage.setState(initialStorage, true);
    resetSessionSettingsEntryState();
    shared.settingsState.visualEffectsLevel = 'full';
    shared.settingsState.animatedNumbers = true;
    shared.settingsState.contextGaugeStyle = 'gauge';
    shared.settingsState.alwaysShowContextSize = false;
    shared.settingsState.preferredLanguage = null;
    delete shared.settingsState.actionsSettingsV1;
    delete shared.settingsState.uiSurfaceFinishOverrides;
});

describe('Appearance settings — Visual Effects section', () => {
    it('admits per-role surface finish without replacing neighboring roles, and Auto removes only that role', async () => {
        shared.settingsState.uiSurfaceFinishOverrides = { card: 'flat', floating: 'soft' };
        shared.settingsState.actionsSettingsV1 = { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } };
        const mod = await import('@/app/(app)/settings/appearance/widgets');
        const screen = await renderSettingsView(React.createElement(mod.default));
        await screen.pressByTestIdAsync('settings-appearance-finish-customize');
        const choose = (value: string) => screen.findByProps({ testIDPrefix: 'settings-appearance-finish-card' }).props.onChange(value);
        await act(async () => { choose('soft'); });
        expect(storage.getState().localSettings.uiSurfaceFinishOverrides).toEqual({ card: 'flat', floating: 'soft' });
        await act(async () => { account!.replaceSettings(settingsParse({ ...account!.persistedSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        })); });
        // Own UI Ask uses the native review, not an Inbox approval (02102e614e1).
        const confirmation = createDeferred<boolean>();
        vi.mocked(Modal.confirm).mockImplementationOnce(() => confirmation.promise);
        await act(async () => { choose('soft'); });
        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledOnce());
        expect(storage.getState().localSettings.uiSurfaceFinishOverrides).toEqual({ card: 'flat', floating: 'soft' });
        await act(async () => { confirmation.resolve(false); });
        expect(storage.getState().localSettings.uiSurfaceFinishOverrides).toEqual({ card: 'flat', floating: 'soft' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await act(async () => { choose('soft'); });
        await vi.waitFor(() => expect(storage.getState().localSettings.uiSurfaceFinishOverrides).toEqual({ card: 'soft', floating: 'soft' }));
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
        await act(async () => { account!.replaceSettings(settingsParse({ ...account!.persistedSettings,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        })); });
        await act(async () => { choose('auto'); });
        await vi.waitFor(() => expect(storage.getState().localSettings.uiSurfaceFinishOverrides).toEqual({ floating: 'soft' }));
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
        expect(account!.artifacts.list()).toEqual([]);
    });
    it.each([
        { key: 'visualEffectsLevel', initial: 'full', next: 'minimal', route: 'motion' },
        { key: 'animatedNumbers', initial: true, next: false, route: 'motion' },
        { key: 'contextGaugeStyle', initial: 'gauge', next: 'hidden', route: 'appearance' },
    ] as const)('admits $key under Off, Ask rejection/approval and Allowed', async ({ key, initial, next, route }) => {
        shared.settingsState.preferredLanguage = 'fr';
        shared.settingsState.actionsSettingsV1 = { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } };
        const mod = route === 'motion' ? await import('@/app/(app)/settings/appearance/motion')
            : await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));
        const choose = (value: string | boolean) => {
            if (key === 'animatedNumbers') screen.findByProps({ title: 'settingsAppearance.visualEffects.animatedNumbers' })
                .props.rightElement.props.onValueChange(value);
            else screen.findByProps({ testIDPrefix: `settings-appearance-${key}` }).props.onChange(value);
        };
        await act(async () => { choose(next); });
        expect(storage.getState().settings[key]).toBe(initial);
        expect(account!.persistedSettings[key]).toBe(initial);
        expect(account!.settingsWrites).toEqual([]);
        await act(async () => { account!.replaceSettings(settingsParse({ ...account!.persistedSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        })); });
        const confirmation = createDeferred<boolean>();
        vi.mocked(Modal.confirm).mockImplementationOnce(() => confirmation.promise);
        await act(async () => { choose(next); });
        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledOnce());
        expect(account!.persistedSettings[key]).toBe(initial);
        expect(account!.settingsWrites).toEqual([]);
        await act(async () => { confirmation.resolve(false); });
        expect(account!.persistedSettings[key]).toBe(initial);
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await act(async () => { choose(next); });
        await vi.waitFor(() => expect(account!.persistedSettings[key]).toBe(next));
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
        await act(async () => { account!.replaceSettings(settingsParse({ ...account!.persistedSettings,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        })); });
        await act(async () => { choose(initial); });
        await vi.waitFor(() => expect(account!.persistedSettings[key]).toBe(initial));
        expect(account!.persistedSettings.preferredLanguage).toBe('fr');
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
        expect(account!.artifacts.list()).toEqual([]);
    });
    it('keeps badge controls behind their disclosure and saves the existing preference after opening it', async () => {
        shared.settingsState.tabBarFriendsBadgeEnabled = true;
        const { default: Appearance } = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(<Appearance />);
        const badgeRow = () => screen.findAllByProps({ title: 'tabs.friends' });

        expect(badgeRow()).toHaveLength(0);
        await screen.pressByTestIdAsync('settings-appearance-badges-toggle');
        expect(badgeRow()).not.toHaveLength(0);
        const toggle = badgeRow()[0]?.props.rightElement;
        await act(async () => { toggle.props.onValueChange(false); });
        await vi.waitFor(() => expect(account?.persistedSettings.tabBarFriendsBadgeEnabled).toBe(false));
    });

    it('renders the effects-level selector and persists a new level', async () => {
        const mod = await import('@/app/(app)/settings/appearance/motion');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        const levelSelect = screen.findByProps({ testIDPrefix: 'settings-appearance-visualEffectsLevel' });
        expect(levelSelect.props.value).toBe('full');

        await act(async () => {
            levelSelect.props.onChange('minimal');
        });
        await vi.waitFor(() => expect(account?.persistedSettings.visualEffectsLevel).toBe('minimal'));
    });

    it('renders the animated-numbers toggle and persists changes', async () => {
        const mod = await import('@/app/(app)/settings/appearance/motion');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        const row = screen.findByProps({ title: 'settingsAppearance.visualEffects.animatedNumbers' });
        const switchNode = row.props.rightElement;
        expect(switchNode?.props?.value).toBe(true);

        await act(async () => {
            switchNode.props.onValueChange(false);
        });
        await vi.waitFor(() => expect(account?.persistedSettings.animatedNumbers).toBe(false));
    });

    it('renders the context-display selector and persists a new style', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default), {
            flushOptions: { cycles: 0 },
        });

        const contextSelect = screen.findByProps({ testIDPrefix: 'settings-appearance-contextGaugeStyle' });
        expect(contextSelect.props.value).toBe('gauge');

        await act(async () => {
            contextSelect.props.onChange('hidden');
        });
        await vi.waitFor(() => expect(account?.persistedSettings.contextGaugeStyle).toBe('hidden'));
    });

    it('renders the always-show-context-size toggle and persists changes', async () => {
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
        await vi.waitFor(() => expect(account?.persistedSettings.alwaysShowContextSize).toBe(true));
    });
});

describe('Appearance: the four everyday decisions, then a page per rarely changed family', () => {
    it('opens glass, moments, widgets and motion on their own pages, each row saying what is chosen now', async () => {
        const { default: Appearance } = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(<Appearance />, { flushOptions: { cycles: 0 } });

        // Motion's own rows are no longer on Appearance itself.
        expect(screen.findAllByProps({ testIDPrefix: 'settings-appearance-visualEffectsLevel' })).toHaveLength(0);
        expect(screen.findAllByProps({ title: 'widgetFrame.surfaceHome' })).toHaveLength(0);

        for (const [testID, route] of [
            ['settings-appearance-glass', '/settings/appearance/glass'],
            ['settings-appearance-moments', '/settings/appearance/moments'],
            ['settings-appearance-widgets', '/settings/appearance/widgets'],
            ['settings-appearance-motion', '/settings/appearance/motion'],
        ] as const) {
            const row = screen.findByProps({ testID });
            expect(String(row.props.detail ?? '').length, testID).toBeGreaterThan(0);
            await screen.pressByTestIdAsync(testID);
            expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenLastCalledWith(route);
        }
    });

    it('arranges Home on Home: Customize home opens Home in its Customize mode instead of a second editor', async () => {
        const { subscribeHomeCustomizeRequest } = await import('@/components/hub/header/homeCustomizeRequest');
        const { default: Appearance } = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(<Appearance />, { flushOptions: { cycles: 0 } });
        const opened = vi.fn();
        const unsubscribe = subscribeHomeCustomizeRequest(opened);
        try {
            await screen.pressByTestIdAsync('settings-appearance-customize-home');
            expect(opened).toHaveBeenCalledOnce();
            expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenLastCalledWith('/home');
        } finally {
            unsubscribe();
        }
    });

    it('sets the Machine summary on its own Appearance page, with the style tiles and one switch per metric', async () => {
        const { default: Appearance } = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(<Appearance />, { flushOptions: { cycles: 0 } });
        await screen.pressByTestIdAsync('settings-appearance-machine-summary');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenLastCalledWith('/settings/appearance/machines');

        const { default: MachineSummaryPage } = await import('@/app/(app)/settings/appearance/machines');
        const page = await renderSettingsView(<MachineSummaryPage />, { flushOptions: { cycles: 0 } });
        expect(page.findAllByProps({ testIdPrefix: 'settings-appearance-machineSummary-style' }).length).toBeGreaterThan(0);
        expect(page.findAllByProps({ testID: 'settings-appearance-machineSummary-show-cpu' }).length).toBeGreaterThan(0);
    });
});
