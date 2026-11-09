import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { lightTheme, darkTheme, type Theme } from '@/theme';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { resetPersistentUiStateForTest } from '@/dev/testkit/cleanup/persistentUiState';
import { registerNativeThemePreferenceTransitionController } from '@/components/settings/appearance/themePreferenceTransition';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { Modal } from '@/modal';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { readPersonalizeChoices, type PersonalizeChoices, type PersonalizeStepId } from './personalizeFlowModel';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const boundary = vi.hoisted(() => ({ setTheme: vi.fn(), setStatusBarStyle: vi.fn(),
    themes: null as Record<'light' | 'dark', Theme> | null,
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        Appearance: { getColorScheme: () => 'light' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: { setTheme: boundary.setTheme,
        getTheme: (name: 'light' | 'dark') => boundary.themes?.[name],
        updateTheme: (name: 'light' | 'dark', update: (theme: Theme) => Theme) => {
            if (boundary.themes) boundary.themes[name] = update(boundary.themes[name]);
        },
    } });
});
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: boundary.setStatusBarStyle }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { usePersonalizeFlow } = await import('./usePersonalizeFlow');
let ACCOUNT_A = { serverId: '', accountId: 'alice' };
let ACCOUNT_B = { serverId: '', accountId: 'bob' };
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

function readSavedProgress(): { savedSteps: string[]; resumeAt: string | null } {
    return JSON.parse(getPersistenceStorage().getString('ui-state:personalize-progress-v1:progress')
        ?? '{"savedSteps":[],"resumeAt":null}');
}

beforeEach(async () => {
    await resetPersistentUiStateForTest();
    await homes.reset();
    await homes.addHome({ name: 'Personalize Home', serverUrl: 'https://personalize-flow.test',
        accountId: ACCOUNT_A.accountId, currentAccount: true });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://personalize-flow.test',
        accountId: ACCOUNT_A.accountId,
        credentials: { token: createAccountTokenForTests(ACCOUNT_A.accountId, { currentAccount: true }) }, request: homes.request });
    ACCOUNT_A = { serverId: connection.serverId, accountId: 'alice' };
    ACCOUNT_B = { serverId: connection.serverId, accountId: 'bob' };
    storage.setState({ settings: settingsDefaults, settingsScope: ACCOUNT_A, profileScope: ACCOUNT_A,
        localSettings: { ...localSettingsDefaults, themePreference: 'light' } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    boundary.themes = { light: lightTheme, dark: darkTheme };
    boundary.setTheme.mockClear();
    boundary.setStatusBarStyle.mockClear();
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    vi.restoreAllMocks();
});

describe('Personalize mounted visit', () => {
    it.each([
        ['look', { glass: 'solid' }],
        ['conversation', { transcriptLayout: 'linear', thinking: 'hidden' }],
        ['tools', { toolChrome: 'cards', toolDetail: 'full', toolTap: 'open' }],
        ['work', { listLayout: 'recent_activity', listDensity: 'cozy' }],
        ['attention', { attention: 'top' }],
        ['notifications', { notifyNeedsYou: false, notifyFinished: false, notifyPreview: false }],
    ] satisfies readonly (readonly [PersonalizeStepId, Partial<PersonalizeChoices>])[])
    ('admits the %s choices before advancing or marking the step saved', async (step, patch) => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ ...settingsDefaults,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) });
        try {
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: step, onExit: vi.fn() }));
            const before = readPersonalizeChoices(storage.getState().settings, storage.getState().localSettings);
            await act(async () => { hook.getCurrent().update(patch); });
            await act(async () => { expect(await hook.getCurrent().next()).toBe(false); });
            expect(hook.getCurrent().page).toBe(step);
            expect(readSavedProgress().savedSteps).toEqual([]);
            expect(readPersonalizeChoices(storage.getState().settings, storage.getState().localSettings)).toEqual(before);

            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } } })); });
            await act(async () => { expect(await hook.getCurrent().next()).toBe(true); });
            expect(readPersonalizeChoices(storage.getState().settings, storage.getState().localSettings)).toMatchObject(patch);
            expect(readSavedProgress().savedSteps).toEqual([step]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('keeps a compound step pending until approval and keeps its draft after rejection', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ ...settingsDefaults,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } } }) });
        try {
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'work', onExit: vi.fn() }));
            await act(async () => { hook.getCurrent().update({ listLayout: 'recent_activity' }); });
            let pending!: Promise<boolean>;
            await act(async () => { pending = hook.getCurrent().next(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(hook.getCurrent()).toMatchObject({ page: 'work', status: 'saving' });
            expect(readSavedProgress().savedSteps).toEqual([]);
            expect(readPersonalizeChoices(storage.getState().settings, storage.getState().localSettings).listLayout).toBe('projects');
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            await act(async () => { expect(await pending).toBe(false); });
            expect(hook.getCurrent()).toMatchObject({ page: 'work', status: 'idle', draft: { listLayout: 'recent_activity' } });

            await act(async () => { pending = hook.getCurrent().next(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
            await act(async () => { expect(await pending).toBe(true); });
            expect(readPersonalizeChoices(storage.getState().settings, storage.getState().localSettings).listLayout).toBe('recent_activity');
            expect(readSavedProgress().savedSteps).toEqual(['work']);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('remembers a skipped page without changing preferences when Settings writes are Off', async () => {
        storage.setState({ settings: settingsParse({ ...settingsDefaults,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) });
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        const localSettings = storage.getState().localSettings;
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        await act(async () => { hook.getCurrent().skip(); });
        expect(hook.getCurrent().page).toBe('style');
        const savedDeviceSettings = writes.mock.calls.filter(([key]) => key === 'local-settings');
        expect(savedDeviceSettings).toHaveLength(0);
        expect(storage.getState().localSettings.themePreference).toBe(localSettings.themePreference);
        expect(storage.getState().localSettings.themeProfileSelection).toEqual(localSettings.themeProfileSelection);
        expect(readSavedProgress().resumeAt).toBe('style');
        expect(storage.getState().localSettings.themePreference).toBe('light');
    });

    it('keeps the live visit usable after Strict Mode replays mount effects', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }), {
            wrapper: React.StrictMode,
        });
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        expect(hook.getCurrent().draft.theme).toBe('dark');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        await act(async () => { expect(await hook.getCurrent().next()).toBe(true); });
        expect(hook.getCurrent().page).toBe('style');
    });

    it.each(['conversation', 'summary'] as const)('retires %s on Account switch before any Next or completion write', async initialPage => {
        const onExit = vi.fn();
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage, onExit }));
        await act(async () => { hook.getCurrent().update({ thinking: 'hidden' }); });
        const held = hook.getCurrent();
        await act(async () => { storage.setState({ settingsScope: ACCOUNT_B, settings: { ...settingsDefaults, sessionListDensity: 'cozy' } }); });
        expect(onExit).toHaveBeenCalledTimes(1);
        const accountB = storage.getState().settings;
        const localB = storage.getState().localSettings;
        await act(async () => { expect(await held.next()).toBe(false); expect(await hook.getCurrent().next()).toBe(false); });
        expect(storage.getState().settings).toBe(accountB);
        expect(storage.getState().localSettings).toBe(localB);
    });

    it('keeps account profiles through theme preview, latest-state restore, and commit', async () => {
        const profile = { ...createThemeProfileDraft({ id: 'account-ocean', name: 'Account ocean', now: '2026-10-20T12:00:00.000Z' }),
            overrides: { light: { 'background.canvas': '#aabbcc' }, dark: { 'background.canvas': '#112233' } } };
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ themeProfiles: [profile] }) });
        try {
            storage.getState().applyLocalSettings({ themeProfileSelection: { light: profile.id, dark: profile.id } });
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
            await act(async () => { hook.getCurrent().selectTheme('dark'); });
            expect(boundary.themes?.dark.colors.background.canvas).toBe('#112233');
            expect(storage.getState().localSettings.themePreference).toBe('light');
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                themeProfiles: [{ ...profile, overrides: { light: { 'background.canvas': '#ddeeff' }, dark: { 'background.canvas': '#112233' } } }],
            })); });
            await act(async () => { hook.getCurrent().skip(); });
            expect(boundary.themes?.light.colors.background.canvas).toBe('#ddeeff');
            await hook.unmount();
            const next = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
            await act(async () => { next.getCurrent().selectTheme('dark'); });
            await act(async () => { expect(await next.getCurrent().next()).toBe(true); });
            expect(storage.getState().localSettings.themeProfileSelection).toEqual({ light: profile.id, dark: profile.id });
            expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('previews a tile without persistence, and Skip restores the saved theme', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        expect(boundary.setTheme).toHaveBeenLastCalledWith('dark');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        await act(async () => { hook.getCurrent().skip(); });
        expect(hook.getCurrent().draft.theme).toBe('light');
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
        expect(hook.getCurrent().page).toBe('style');
    });

    it('leaving an unconfirmed Look restores the saved runtime theme', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        await hook.unmount();
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
    });

    it('awaits the theme commit before advancing or recording progress', async () => {
        let commit!: () => void;
        const unregister = registerNativeThemePreferenceTransitionController({ run: mutation => new Promise<void>(resolve => {
            commit = () => { mutation(); resolve(); };
        }) });
        try {
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
            await act(async () => { hook.getCurrent().selectTheme('dark'); });
            let pending: Promise<boolean> | boolean;
            await act(async () => { pending = hook.getCurrent().next(); });
            expect(hook.getCurrent().page).toBe('look');
            expect(readSavedProgress().savedSteps).toEqual([]);
            await act(async () => { commit(); expect(await pending).toBe(true); });
            expect(hook.getCurrent().page).toBe('style');
            expect(storage.getState().localSettings.themePreference).toBe('dark');
            expect(readSavedProgress().savedSteps).toEqual(['look']);
        } finally { unregister(); }
    });

    it('keeps the draft and step on a storage rejection, then retries through the theme owner', async () => {
        const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit: vi.fn() }));
        await act(async () => { hook.getCurrent().selectTheme('dark'); });
        vi.mocked(Modal.alert).mockClear();
        // The native device persistence adapter is a genuine system boundary; all store/flow/theme logic stays real.
        const deviceStorage = getPersistenceStorage();
        const write = deviceStorage.set.bind(deviceStorage);
        let refusedThemeWrite = false;
        const persist = vi.spyOn(deviceStorage, 'set').mockImplementation((key, value) => {
            if (!refusedThemeWrite && key === 'local-settings' && typeof value === 'string') {
                const next: unknown = JSON.parse(value);
                if (next && typeof next === 'object' && 'themePreference' in next && next.themePreference === 'dark') {
                    refusedThemeWrite = true;
                    throw new Error('device storage refused');
                }
            }
            write(key, value);
        });
        await act(async () => { expect(await hook.getCurrent().next()).toBe(false); });
        expect(refusedThemeWrite).toBe(true);
        expect(Modal.alert).toHaveBeenCalledOnce();
        expect(hook.getCurrent()).toMatchObject({ page: 'look', draft: { theme: 'dark' } });
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(readSavedProgress().savedSteps).toEqual([]);
        persist.mockRestore();
        await act(async () => { expect(await hook.getCurrent().next()).toBe(true); });
        expect(hook.getCurrent().page).toBe('style');
        expect(storage.getState().localSettings.themePreference).toBe('dark');
        expect(readSavedProgress().savedSteps).toEqual(['look']);
    });

    it('rejects a theme mutation delayed until after its launching Account retires', async () => {
        let commit!: () => void;
        const unregister = registerNativeThemePreferenceTransitionController({ run: mutation => new Promise<void>((resolve, reject) => {
            commit = () => { try { mutation(); resolve(); } catch (error) { reject(error); } };
        }) });
        try {
            const onExit = vi.fn();
            const hook = await renderHook(() => usePersonalizeFlow({ initialPage: 'look', onExit }));
            await act(async () => { hook.getCurrent().selectTheme('dark'); });
            let pending: Promise<boolean> | boolean;
            await act(async () => { pending = hook.getCurrent().next(); });
            await act(async () => { storage.setState({ settingsScope: ACCOUNT_B }); });
            const localB = storage.getState().localSettings;
            await act(async () => { commit(); expect(await pending).toBe(false); });
            expect(onExit).toHaveBeenCalledTimes(1);
            expect(storage.getState().localSettings).toBe(localB);
        } finally { unregister(); }
    });
});
