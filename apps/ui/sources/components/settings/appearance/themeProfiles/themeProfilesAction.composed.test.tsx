import { readThemeProfileLegacyAccountScope, writeThemeProfileLegacyAccountScope } from '@/sync/domains/state/themeProfileMigrationUiState';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import axios, { type AxiosAdapter } from 'axios';
import type { Theme } from '@/theme';

import { renderHook, renderScreen, pressTestInstanceAsync } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { useThemeProfiles } from '@/sync/store/hooks';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { areThemeProfileLegacyIdsCurrent, readCanonicalThemeProfiles } from './themeProfilesSettingBinding';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE, parseThemeProfilesLocalState } from '@/theme/profiles/themeProfilePersistence';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { Modal } from '@/modal';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createClientActionReverseDispatcher } from '../../../../../../cli/src/session/actions/clientActionReverseDispatch';
import { createActionSettingsProvider } from '../../../../../../cli/src/settings/actionsSettingsProvider';

const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => {
    const { lightTheme, darkTheme } = await import('@/theme');
    const themes = { light: lightTheme, dark: darkTheme };
    // Unistyles is the platform boundary; preserve its stored-theme update semantics.
    return (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ runtime: {
        getTheme: (name: 'light' | 'dark') => themes[name],
        updateTheme: (name: 'light' | 'dark', update: (theme: Theme) => Theme) => { themes[name] = update(themes[name]); },
    } });
});
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router, params: () => routeParams.current,
}).module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('reanimated-color-picker', async () =>
    (await import('@/dev/testkit/mocks/reanimatedColorPicker')).createReanimatedColorPickerMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { ThemeProfileImportScreen } = await import('./ThemeProfileImportScreen');
const { ThemeProfileEditorScreen } = await import('./ThemeProfileEditorScreen');
const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
const { UnistylesRuntime } = await import('react-native-unistyles');
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const originalState = storage.getState();
const originalLegacyScope = readThemeProfileLegacyAccountScope();
const originalAxiosAdapter = axios.defaults.adapter;
afterEach(() => {
    standardCleanup(); storage.setState(originalState, true); axios.defaults.adapter = originalAxiosAdapter;
    writeThemeProfileLegacyAccountScope(originalLegacyScope);
    vi.unstubAllGlobals(); router.back.mockClear(); router.push.mockClear();
    routeParams.current = {};
});

const profile = parseThemeProfilesLocalState({ profiles: [{ ...createThemeProfileDraft({
    id: 'custom-action-theme', name: 'Custom theme', now: '2026-10-20T12:00:00.000Z',
}), overrides: { light: { 'background.canvas': '#F1E2D3' }, dark: {} } }],
    activeProfileIds: { light: null, dark: null } }).state.profiles[0]!;
const library = { profiles: [profile], activeProfileIds: { light: profile.id, dark: 'nightDark' } };
const anchor = 'appearance.themes.yourThemes';

async function settleAccountBootstrap() {
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    const queue = Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync;
    await queue.awaitQueue();
}

describe('theme profile library Settings Action ingress', () => {
    it('admits the real local owner under Off, rejected/approved Ask and Allowed and rejects noncanonical libraries', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
            uiFontScale: 1.15 });
        const probe = await renderHook(() => ({ profiles: useThemeProfiles(), ...useSettingActionFeedback() }));
        try {
            await act(async () => { expect(await probe.getCurrent().setSetting({ anchor }, SettingsDeclarationValueV1Schema.parse(library))).toBe(false); });
            expect(probe.getCurrent().profiles).toEqual(DEFAULT_THEME_PROFILES_LOCAL_STATE);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            await act(async () => { expect(await probe.getCurrent().setSetting({ anchor }, SettingsDeclarationValueV1Schema.parse(library))).toBe(true); });
            expect(account.persistedRawSettings.themeProfiles).toEqual(library.profiles);
            expect(probe.getCurrent().profiles).toEqual(library);
            expect(storage.getState().localSettings).toMatchObject({ themePreference: 'light', uiFontScale: 1.15 });
            expect(UnistylesRuntime.getTheme('light').colors.background.canvas).toBe('#F1E2D3');
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: { v: 1,
                actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } },
            } })); });
            let pending!: Promise<boolean>;
            await act(async () => { pending = probe.getCurrent().setSetting({ anchor }, SettingsDeclarationValueV1Schema.parse(DEFAULT_THEME_PROFILES_LOCAL_STATE)); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(probe.getCurrent().profiles).toEqual(library);
            const rejectedId = account.artifacts.list()[0]!.id;
            await decideApprovalAsInbox(account.scope.serverId, rejectedId, 'reject');
            expect(await pending).toBe(false);
            expect(probe.getCurrent().profiles).toEqual(library);
            await act(async () => { pending = probe.getCurrent().setSetting({ anchor }, SettingsDeclarationValueV1Schema.parse(DEFAULT_THEME_PROFILES_LOCAL_STATE)); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list().find(item => item.id !== rejectedId)!.id, 'approve');
            expect(await pending).toBe(true);
            expect(probe.getCurrent().profiles).toEqual(DEFAULT_THEME_PROFILES_LOCAL_STATE);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            for (const invalid of [{ ...library, extra: true }, { ...library, profiles: [BUILT_IN_THEME_PROFILES[0]!.profile] },
                { ...library, activeProfileIds: { light: 'missing', dark: null } },
                { ...library, profiles: [{ ...profile, overrides: { light: { 'background.canvas': 'var(--untrusted)' }, dark: {} } }] }]) {
                await act(async () => { expect(await probe.getCurrent().setSetting({ anchor }, SettingsDeclarationValueV1Schema.parse(invalid))).toBe(false); });
                expect(probe.getCurrent().profiles).toEqual(DEFAULT_THEME_PROFILES_LOCAL_STATE);
            }
            expect(account.persistedSettings.themeProfiles).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('rebases a library edit while retaining another device profile and keeps activation local', async () => {
        const remote = { ...profile, id: 'theme_remote-added', name: 'Remote theme' };
        const edited = { ...profile, name: 'Edited here' };
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ themeProfiles: [profile],
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        storage.getState().applyLocalSettings({ themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
            themeProfileSelection: { light: null, dark: null } });
        const originalRequest = account.request.getMockImplementation()!;
        let conflicted = false;
        account.request.mockImplementation(async (input, init) => {
            if (!conflicted && String(input).endsWith('/v2/account/settings') && init?.method === 'POST') {
                conflicted = true;
                account.replaceSettings(settingsParse({ ...account.persistedSettings, themeProfiles: [profile, remote] }),
                    { version: 2, publish: false });
            }
            return originalRequest(input, init);
        });
        const probe = await renderHook(() => ({ profiles: useThemeProfiles(), ...useSettingActionFeedback() }));
        try {
            await act(async () => { expect(await probe.getCurrent().setSetting({ anchor }, SettingsDeclarationValueV1Schema.parse({
                edit: { before: probe.getCurrent().profiles, next: {
                    profiles: [edited], activeProfileIds: { light: profile.id, dark: null },
                }, legacyProfileIds: {} },
            }))).toBe(true); });
            expect(conflicted).toBe(true);
            expect(account.persistedSettings.themeProfiles).toEqual(expect.arrayContaining([edited, remote]));
            expect(account.persistedRawSettings).not.toHaveProperty('themeProfileSelection');
            expect(storage.getState().localSettings.themeProfileSelection).toEqual({ light: profile.id, dark: null });
            expect(probe.getCurrent().profiles.profiles).toHaveLength(2);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it.each([false, true])('keeps unknown cloud profiles when a local edit starts before the first account snapshot (colliding ID: %s)', async colliding => {
        const remote = { ...profile, id: colliding ? profile.id : 'theme_remote-before-fetch', name: 'Already in the account' };
        const edited = { ...profile, name: 'Edited before fetch' };
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ themeProfiles: [remote],
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const probe = await renderHook(() => useSettingActionFeedback());
        await settleAccountBootstrap();
        storage.setState({ settings: settingsParse({ actionsSettingsV1: account.persistedSettings.actionsSettingsV1 }) });
        const before = { profiles: [profile], activeProfileIds: { light: profile.id, dark: null } };
        storage.getState().applyLocalSettings({ themeProfiles: before, themeProfileSelection: null });
        writeThemeProfileLegacyAccountScope(null);
        try {
            expect(loadLocalSettings().themeProfiles).toEqual(storage.getState().localSettings.themeProfiles);
            expect(areThemeProfileLegacyIdsCurrent(storage.getState().localSettings, before,
                { [profile.id]: profile.id }, { accountScope: account.scope, isCurrent: () => true })).toBe(true);
            const canonicalBefore = readCanonicalThemeProfiles(before);
            expect(canonicalBefore).toEqual(before);
            expect(canonicalBefore && areThemeProfileLegacyIdsCurrent(storage.getState().localSettings, canonicalBefore,
                { [profile.id]: profile.id }, { accountScope: account.scope, isCurrent: () => true })).toBe(true);
            await act(async () => {
                const applied = await probe.getCurrent().setSetting({ anchor }, SettingsDeclarationValueV1Schema.parse({
                    edit: { before, next: { ...before, profiles: [edited] }, legacyProfileIds: { [profile.id]: profile.id } },
                }));
                expect(applied, JSON.stringify({ feedback: vi.mocked(Modal.alert).mock.calls,
                    scope: storage.getState().settingsScope, expectedScope: account.scope,
                    legacyBinding: readThemeProfileLegacyAccountScope(),
                    backup: storage.getState().localSettings.themeProfiles,
                    persistedBackup: loadLocalSettings().themeProfiles, writes: account.settingsWrites.length,
                    acceptedProfiles: account.persistedSettings.themeProfiles,
                })).toBe(true);
            });
            const editedId = colliding ? `${profile.id}_2` : profile.id;
            expect(account.persistedSettings.themeProfiles).toEqual(expect.arrayContaining([{ ...edited, id: editedId }, remote]));
            expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([]);
            expect(storage.getState().localSettings.themeProfileSelection).toEqual({ light: editedId, dark: null });
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('keeps a pre-fetch legacy activation distinct from a later account activation with the same ID', async () => {
        const remote = { ...profile, name: 'Account profile with the same ID' };
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ themeProfiles: [remote],
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        const probe = await renderHook(() => ({ profiles: useThemeProfiles(), ...useSettingActionFeedback() }));
        await settleAccountBootstrap();
        await act(async () => {
            storage.setState({ settings: settingsParse({ actionsSettingsV1: account.persistedSettings.actionsSettingsV1 }) });
            storage.getState().applyLocalSettings({ themeProfiles: { profiles: [profile], activeProfileIds: { light: null, dark: null } },
                themeProfileSelection: null });
            writeThemeProfileLegacyAccountScope(null);
        });
        try {
            await act(async () => { expect(await probe.getCurrent().setSetting({ anchor: 'appearance.themeMode' },
                SettingsDeclarationValueV1Schema.parse({ themePreference: 'light', themeProfiles: {
                    ...probe.getCurrent().profiles, activeProfileIds: { light: profile.id, dark: null },
                }, legacyProfileIds: { [profile.id]: profile.id } }))).toBe(true); });
            expect(storage.getState().localSettings.themeProfileSelection?.light).toEqual({ legacyProfileId: profile.id });
            await act(async () => { account.replaceSettings(account.persistedSettings); });
            expect(probe.getCurrent().profiles.activeProfileIds.light).toBe(`${profile.id}_2`);
            await act(async () => { expect(await probe.getCurrent().setSetting({ anchor: 'appearance.themeMode' },
                SettingsDeclarationValueV1Schema.parse({ themePreference: 'light', themeProfiles: {
                    ...probe.getCurrent().profiles, activeProfileIds: { light: profile.id, dark: null },
                }, legacyProfileIds: { [`${profile.id}_2`]: profile.id } }))).toBe(true); });
            expect(storage.getState().localSettings.themeProfileSelection?.light).toBe(profile.id);
            expect(probe.getCurrent().profiles.activeProfileIds.light).toBe(profile.id);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('refuses an approved legacy edit after another acknowledged writer consumed its source', async () => {
        const remote = { ...profile, name: 'Cloud owner' };
        const migrated = { ...profile, id: `${profile.id}_2` };
        const before = { profiles: [profile], activeProfileIds: { light: profile.id, dark: null } };
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        }) });
        storage.getState().applyLocalSettings({ themeProfiles: before, themeProfileSelection: null });
        const probe = await renderHook(() => useSettingActionFeedback());
        try {
            let pending!: Promise<boolean>;
            await act(async () => { pending = probe.getCurrent().setSetting({ anchor }, SettingsDeclarationValueV1Schema.parse({
                edit: { before, next: { ...before, profiles: [{ ...profile, name: 'Waiting draft' }] },
                    legacyProfileIds: { [profile.id]: profile.id } },
            })); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            await act(async () => {
                account.replaceSettings(settingsParse({ ...account.persistedSettings, themeProfiles: [remote, migrated] }));
                storage.getState().applyLocalSettings({ themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
                    themeProfileSelection: { light: migrated.id, dark: null } });
                writeThemeProfileLegacyAccountScope(null);
            });
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            expect(await pending).toBe(false);
            expect(account.persistedSettings.themeProfiles).toEqual([remote, migrated]);
            expect(storage.getState().localSettings.themeProfileSelection?.light).toBe(migrated.id);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('keeps an import on screen until admission succeeds', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) });
        storage.getState().applyLocalSettings({ themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE });
        try {
            const screen = await renderScreen(<ThemeProfileImportScreen />);
            act(() => screen.changeTextByTestId('settings-theme-profile-import-json', exportThemeProfileToJson(profile)));
            await pressTestInstanceAsync(screen.findByTestId('settings-theme-profile-import-submit'));
            expect(router.back).not.toHaveBeenCalled();
            expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: { v: 1,
                actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } },
            } })); });
            let pending!: Promise<void>;
            await act(async () => { pending = pressTestInstanceAsync(screen.findByTestId('settings-theme-profile-import-submit')); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(router.back).not.toHaveBeenCalled();
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            await pending;
            expect(screen.findByTestId('settings-theme-profile-import-json')!.props.value).toBe(exportThemeProfileToJson(profile));
            expect(router.back).not.toHaveBeenCalled();
            expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            await pressTestInstanceAsync(screen.findByTestId('settings-theme-profile-import-submit'));
            await vi.waitFor(() => {
                expect(account.persistedSettings.themeProfiles).toHaveLength(1);
                expect(router.back).toHaveBeenCalledOnce();
            });
        } finally { standardCleanup(); await account.dispose(); }
    });

    it.each(['duplicate', 'delete'] as const)('keeps the %s editor in place when Off and commits only after admission', async operation => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) });
        const inactiveLibrary = { ...library, activeProfileIds: { light: null, dark: 'nightDark' } };
        account.replaceSettings(settingsParse({ ...account.persistedSettings, themeProfiles: inactiveLibrary.profiles }));
        storage.getState().applyLocalSettings({ themePreference: 'dark', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE,
            themeProfileSelection: inactiveLibrary.activeProfileIds });
        writeThemeProfileLegacyAccountScope(null);
        routeParams.current = { profileId: profile.id };
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        try {
            const screen = await renderScreen(<ThemeProfileEditorScreen />);
            const choose = () => screen.tree.findAll(node => node.props.testID === 'settings-theme-profile-menu'
                && typeof node.props.onSelect === 'function')[0]!.props.onSelect(operation);
            await act(async () => { await choose(); });
            expect(account.persistedSettings.themeProfiles).toEqual(inactiveLibrary.profiles);
            expect(storage.getState().localSettings.themeProfileSelection).toEqual(inactiveLibrary.activeProfileIds);
            expect(router.back).not.toHaveBeenCalled();
            expect(router.push).not.toHaveBeenCalled();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            await act(async () => { await choose(); });
            expect(account.persistedSettings.themeProfiles).toHaveLength(operation === 'delete' ? 0 : 2);
            expect(storage.getState().localSettings.themeProfileSelection).toEqual(inactiveLibrary.activeProfileIds);
            if (operation === 'delete') expect(router.back).toHaveBeenCalledOnce();
            else expect(router.push).toHaveBeenCalledOnce();
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('projects a genuine Agent/CLI local Action through the answering app to its theme reader and runtime', async () => {
        const account = await createSecretSettingsTestHarness({ serverIdentityId: 'srv_theme_profiles', settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['agent'] } },
        }) });
        await settleAccountBootstrap();
        storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE });
        const adapter: AxiosAdapter = async config => {
            const response = await account.request(String(config.url), { method: config.method?.toUpperCase(),
                headers: Object.fromEntries(Object.entries(config.headers.toJSON()).map(([key, value]) => [key, String(value)])),
                ...(config.data === undefined ? {} : { body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data) }) });
            return { config, status: response.status, statusText: response.statusText,
                headers: Object.fromEntries(response.headers), data: await response.json() };
        };
        axios.defaults.adapter = adapter;
        vi.stubGlobal('fetch', account.request);
        const receive = createUiClientActionReverseHandler({ ...account.scope, isCurrent: () => true });
        const reverse = createClientActionReverseDispatcher(() => ({ hasConnectedClientRpcHandler: () => true,
            callConnectedClientRpc: async (_method, payload, options) => {
                options.onIssued();
                const result = await receive(JSON.parse(JSON.stringify(payload)), { signal: new AbortController().signal });
                return { ok: true, result };
            } }));
        // This explicit Account policy must not inherit the host's standalone CLI environment override.
        const policy = createActionSettingsProvider({ getAccountSettings: () => account.persistedSettings, allowEnvironmentOverride: false });
        expect(policy.getActionsSettings().approvalWaivedSurfaces?.['settings.set']).toContain('agent');
        const cli = createCliActionExecutorFromCredentials({ credentials: { token: account.credentials.token,
            encryption: null, credentialProvenance: 'stored_session' }, serverId: account.scope.serverId,
            serverIdentityId: 'srv_theme_profiles', serverApiUrl: new URL(String(account.request.mock.calls[0]![0])).origin,
            clientActionExecute: reverse,
            actionsSettingsProvider: policy,
        });
        const probe = await renderHook(() => useThemeProfiles());
        try {
            await act(async () => {
                const result = await cli.execute('settings.set', { anchor, value: library }, { surface: 'agent',
                    authority: 'account_automation', actionCaller: { kind: 'host' }, actionRequestId: 'theme-library-agent' });
                expect(result.ok ? 'ok' : result.errorCode).toBe('ok');
            });
            await vi.waitFor(() => expect(probe.getCurrent()).toEqual(library));
            expect(UnistylesRuntime.getTheme('light').colors.background.canvas).toBe('#F1E2D3');
            expect(account.persistedSettings.themeProfiles).toEqual(library.profiles);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
