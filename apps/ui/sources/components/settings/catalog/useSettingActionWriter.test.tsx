import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { PROMPTS_CONTEXT_SETTINGS } from '@/components/settings/prompts/context/promptsContextSettings';
import { useSettingActionWriter } from './useSettingActionWriter';
import { useMachineSummarySetting } from '@/components/machines/summary/useMachineSummarySetting';
import { useMachinesIndexView } from '@/components/settings/machines/machinesIndexSettings';
import { useMachineStorageViewSetting } from '@/components/machines/storage/useMachineStorageViewSetting';
import { createMachineFixture, flushHookEffects, pressTestInstanceAsync, renderHook } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { useLocalSettingMutable, useSettingMutable } from '@/sync/store/hooks';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { useApplyThemeSelection } from '@/components/settings/appearance/useApplyThemeSelection';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { useDeclaredSettingsWrite } from '@/components/settings/shell/useDeclaredSettingsWrite';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Modal } from '@/modal';
import { readDirectConnectionsEnabled } from '@happier-dev/protocol/account/settings/peerMediationPreferencesV1';
import { usePaneArrangement } from '@/components/appShell/panes/arrangement/usePaneArrangement';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const routerPush = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Status-bar application is a native platform effect; theme selection and persistence stay real.
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('reanimated-color-picker', async () =>
    (await import('@/dev/testkit/mocks/reanimatedColorPicker')).createReanimatedColorPickerMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/machines', params: () => routeParams.current, router: { push: routerPush },
}).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
// Load the real screen after transport installation, before a control interaction's deadline.
const { AllMachinesIndex } = await import('@/components/machines/index/AllMachinesIndex');
const { NewSessionWizardSettingsView } = await import('@/components/settings/session/NewSessionWizardSettingsView');
const { AccountDirectConnectionsSection } = await import('@/components/settings/connections/DirectConnectionSettings');
const { SessionComposerSettingsView } = await import('@/components/settings/session/SessionComposerSettingsView');
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const originalState = storage.getState();
let previousAuth: ReturnType<typeof getCurrentAuth>;
beforeEach(() => { previousAuth = getCurrentAuth(); });
afterEach(() => { standardCleanup(); setCurrentAuth(previousAuth); storage.setState(originalState, true); routeParams.current = {}; });

describe('declared setting Action writer', () => {
    it('admits pane arrangement after the same Account runtime becomes available', async () => {
        const account = await createSecretSettingsTestHarness();
        const scope = storage.getState().settingsScope;
        storage.setState({ localSettings: { ...storage.getState().localSettings, paneArrangement: 'session' } });
        publishAppliedActiveServerRuntimeAvailability(false);
        const probe = await renderHook(usePaneArrangement);
        try {
            await act(async () => { probe.getCurrent().toggle(); });
            expect(storage.getState().localSettings.paneArrangement).toBe('session');
            await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
            expect(storage.getState().settingsScope).toBe(scope);
            await act(async () => { probe.getCurrent().toggle(); });
            await vi.waitFor(() => expect(storage.getState().localSettings.paneArrangement).toBe('editor'));
            await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
            await act(async () => { probe.getCurrent().toggle(); });
            expect(storage.getState().localSettings.paneArrangement).toBe('editor');
        } finally {
            standardCleanup();
            publishAppliedActiveServerRuntimeAvailability(true);
            await account.dispose();
        }
    });
    it('admits pane arrangement through the declared Settings Action before changing local layout', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        storage.setState({ localSettings: { ...storage.getState().localSettings, paneArrangement: 'session' } });
        const probe = await renderHook(usePaneArrangement);
        try {
            await act(async () => { probe.getCurrent().setArrangement('editor'); });
            expect(storage.getState().localSettings.paneArrangement).toBe('session');
            expect(probe.getCurrent().arrangement).toBe('session');
            await act(async () => { account.replaceSettings(settingsParse({
                ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { probe.getCurrent().setArrangement('editor'); });
            await vi.waitFor(() => expect(storage.getState().localSettings.paneArrangement).toBe('editor'));
            expect(probe.getCurrent().arrangement).toBe('editor');
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('admits the mounted compound terminal host choice under Off, Ask and Allowed', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            sessionTerminalHost: 'none', sessionUseTmux: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        const { SessionRuntimeSettingsView } = await import('@/components/settings/session/SessionRuntimeSettingsView');
        try {
            const screen = await renderScreen(<SessionRuntimeSettingsView />);
            const choose = () => screen.tree.findAll(node => node.props?.testID === 'settings-session-terminal-host-item'
                && typeof node.props?.onChange === 'function')[0]!.props.onChange('tmux');
            await act(async () => { choose(); });
            expect(storage.getState().settings).toMatchObject({ sessionTerminalHost: 'none', sessionUseTmux: false });
            expect(account.persistedSettings).toMatchObject({ sessionTerminalHost: 'none', sessionUseTmux: false });
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { choose(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.persistedSettings).toMatchObject({ sessionTerminalHost: 'none', sessionUseTmux: false });
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ sessionTerminalHost: 'tmux', sessionUseTmux: true }));
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => {
                screen.tree.findAll(node => node.props?.testID === 'settings-session-tmux-name'
                    && typeof node.props?.onChangeText === 'function')[0]!.props.onChangeText('work');
                screen.tree.findAll(node => node.props?.testID === 'settings-session-terminal-host-item'
                    && typeof node.props?.onChange === 'function')[0]!.props.onChange('herdr');
            });
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ sessionTerminalHost: 'herdr', sessionUseTmux: false, sessionTmuxSessionName: 'work' }));
            expect(account.artifacts.list()).toHaveLength(1);
            expect(storage.getState().settings.sessionTerminalHost).toBe('herdr');
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('refuses undeclared raw Account and local user deltas instead of bypassing Settings admission', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ sessionTerminalHost: 'none', sessionUseTmux: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        const before = storage.getState().localSettings.themeProfiles;
        const probe = await renderHook(() => ({ account: useApplySettings(), local: useApplyLocalSettings() }));
        try {
            await act(async () => {
                await probe.getCurrent().account({ sessionTerminalHost: 'tmux', sessionUseTmux: true });
                await probe.getCurrent().local({ themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE });
            });
            expect(storage.getState().settings).toMatchObject({ sessionTerminalHost: 'none', sessionUseTmux: false });
            expect(account.persistedSettings).toMatchObject({ sessionTerminalHost: 'none', sessionUseTmux: false });
            expect(account.settingsWrites).toEqual([]);
            expect(storage.getState().localSettings.themeProfiles).toBe(before);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps exported Account-secret deletion admitted while raw acquisition stays outside Action operands', async () => {
        const account = await createSecretSettingsTestHarness({ serverIdentityId: 'srv_quiet_secret', settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'plugins.settings.secret.delete': { approvalRequiredSurfaces: ['ui'] } },
        } }) });
        const { PluginAccountAvailabilityIntentReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/availability');
        const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        const { scopedPluginAccountSecretSettingsAdapter: adapter, resolveScopedPluginSettingsServerIdentity } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { useMountedPluginSettingsActionAdapter } = await import('@/components/settings/plugins/model/useMountedPluginSettingsActionAdapter');
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: { pluginId: 'acme.settings', desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
            release: { ref: { pluginId: 'acme.settings', version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: { schemaVersion: 2, id: 'acme.settings', version: '1.0.0', displayName: 'Settings', runtime: { apiVersion: 1 },
                    contributes: { settings: [{ id: 'preferences', title: 'Preferences', scope: 'account', target: { kind: 'plugin' },
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: { custody: 'account' } }] }] } },
                collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            packageAssets: [], uiArtifacts: [] });
        const target = { kind: 'account' as const, serverIdentityId: resolveScopedPluginSettingsServerIdentity(account.scope.serverId)! };
        const input = { pluginId: 'acme.settings', scope: { kind: 'account' as const }, target, fields: [{ key: 'token', redacted: true }], fieldId: 'token' };
        try {
            replacePluginAccountAvailabilityProjection({ scope: account.scope, snapshot: { availabilityCursor: 1,
                intentReads: [{ pluginId: 'acme.settings', response }], materializations: [], snapshots: [] } });
            const initial = await adapter.read(input);
            if (initial.status !== 'ready') throw new Error('Account secret record is unavailable');
            const acquired = await adapter.write({ ...input, expectedRevision: initial.snapshot.revision,
                mutation: { kind: 'set', value: 'synthetic-private-token' } });
            expect(acquired.status).toBe('ready');
            expect(account.artifacts.list()).toEqual([]);
            const writes = account.settingsWrites.length;
            account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: { v: 1,
                actions: { 'plugins.settings.secret.delete': { disabledSurfaces: ['ui'] } },
            } }));
            const disabled = await adapter.read(input);
            if (disabled.status !== 'ready') throw new Error('Acquired secret record is unavailable');
            expect(await adapter.write({ ...input, expectedRevision: disabled.snapshot.revision, mutation: { kind: 'delete' } }))
                .toMatchObject({ status: 'unavailable' });
            expect(account.settingsWrites).toHaveLength(writes);
            expect(account.artifacts.list()).toEqual([]);
            account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: { v: 1,
                actions: { 'plugins.settings.secret.delete': { approvalRequiredSurfaces: ['ui'] } },
            } }));
            const accountLifetime = captureActiveServerAccountScopeLifetime();
            expect(accountLifetime?.isCurrent()).toBe(true);
            const mounted = await renderHook(() => useMountedPluginSettingsActionAdapter({ adapter, accountLifetime, target }));
            const before = await mounted.getCurrent().read(input);
            if (before.status !== 'ready') throw new Error('Acquired secret record is unavailable');
            let pending!: ReturnType<typeof adapter.write>;
            await act(async () => { pending = mounted.getCurrent().write({ ...input, expectedRevision: before.snapshot.revision, mutation: { kind: 'delete' } }); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.settingsWrites).toHaveLength(writes);
            expect(account.artifacts.readPlainBody(account.artifacts.list()[0]!.id)).not.toContain('synthetic-private-token');
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            await act(async () => { expect(await pending).toEqual({ status: 'declined' }); });
            expect(await adapter.read(input)).toMatchObject({ status: 'ready', snapshot: { secretStates: { token: 'configured' } } });
            expect(account.settingsWrites).toHaveLength(writes);
            let current = true;
            await act(async () => { pending = mounted.getCurrent().write({ ...input, expectedRevision: before.snapshot.revision,
                mutation: { kind: 'delete' }, isCurrent: () => current }); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            current = false;
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
            await act(async () => { expect(await pending).toMatchObject({ status: 'unavailable' }); });
            expect(await adapter.read(input)).toMatchObject({ status: 'ready', snapshot: { secretStates: { token: 'configured' } } });
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { clearPluginAccountAvailabilityProjection(); standardCleanup(); await account.dispose(); }
    });
    it.each(['reject', 'cancel'] as const)('keeps %s quiet through both mounted feedback owners and still reports real failures', async decision => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ memoryUseInNewSessions: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        }) });
        let feedback: ReturnType<typeof useSettingActionFeedback> | undefined;
        let declared: ReturnType<typeof useDeclaredSettingsWrite> | undefined;
        function Probe() {
            feedback = useSettingActionFeedback();
            declared = useDeclaredSettingsWrite(useMountedActionExecution(account.scope));
            return null;
        }
        const setting = PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions;
        try {
            await renderScreen(<Probe />);
            vi.mocked(Modal.alert).mockClear();
            for (const index of [0, 1]) {
                let pending!: Promise<boolean>;
                await act(async () => { pending = index === 0 ? feedback!.setSetting(setting, true) : declared!(setting, true); });
                await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(index + 1));
                expect(account.settingsWrites).toEqual([]);
                await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[index]!.id, decision);
                await act(async () => { expect(await pending).toBe(false); });
                expect(Modal.alert).not.toHaveBeenCalled();
                expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            }
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            account.setRejectSettingsWrites(true);
            for (const write of [feedback!.setSetting, declared!]) {
                vi.mocked(Modal.alert).mockClear();
                await act(async () => { expect(await write(setting, true)).toBe(false); });
                expect(Modal.alert).toHaveBeenCalled();
                expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            }
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('presents an Action turned off in Settings as a calm notice that leads there, never as an error', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ memoryUseInNewSessions: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        let feedback: ReturnType<typeof useSettingActionFeedback> | undefined;
        let declared: ReturnType<typeof useDeclaredSettingsWrite> | undefined;
        function Probe() {
            feedback = useSettingActionFeedback();
            declared = useDeclaredSettingsWrite(useMountedActionExecution(account.scope));
            return null;
        }
        const setting = PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions;
        try {
            await renderScreen(<Probe />);
            for (const write of [feedback!.setSetting, declared!]) {
                vi.mocked(Modal.alert).mockClear();
                routerPush.mockClear();
                await act(async () => { expect(await write(setting, true)).toBe(false); });
                expect(Modal.alert).toHaveBeenCalledTimes(1);
                const [title, , buttons] = vi.mocked(Modal.alert).mock.calls[0]!;
                expect(title).toBe('actionConfirmations.turnedOffTitle');
                await act(async () => { buttons!.find(button => button.style !== 'cancel')!.onPress!(); });
                expect(routerPush).toHaveBeenCalledWith('/settings/actions/settings.set');
                expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            }
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('admits device-local hook edits and bulk Reset values through settings.set policy', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        let density: ReturnType<typeof useLocalSettingMutable<'uiItemDensity'>> | undefined;
        let apply: ReturnType<typeof useApplyLocalSettings> | undefined;
        function Probe() { density = useLocalSettingMutable('uiItemDensity'); apply = useApplyLocalSettings(); return null; }
        try {
            storage.getState().applyLocalSettings({ uiItemDensity: 'comfortable', uiFontScale: 1.2 });
            await renderScreen(<Probe />);
            await act(async () => { density![1]('compact'); await apply!({ uiFontScale: 1.3 }); });
            expect(storage.getState().localSettings).toMatchObject({ uiItemDensity: 'comfortable', uiFontScale: 1.2 });
            // Reset uses the same bulk writer, so defaults must be admitted too.
            await act(async () => { await apply!({ uiItemDensity: localSettingsDefaults.uiItemDensity, uiFontScale: localSettingsDefaults.uiFontScale }); });
            expect(storage.getState().localSettings).toMatchObject({ uiItemDensity: 'comfortable', uiFontScale: 1.2 });
            await act(async () => { account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            await act(async () => { await apply!({ uiItemDensity: 'compact', uiFontScale: 1.3 }); });
            expect(storage.getState().localSettings).toMatchObject({ uiItemDensity: 'compact', uiFontScale: 1.3 });
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps local edits unchanged while Ask-first holds their Action on the originating device', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        }) });
        let apply: ReturnType<typeof useApplyLocalSettings> | undefined;
        function Probe() { apply = useApplyLocalSettings(); return null; }
        try {
            storage.getState().applyLocalSettings({ uiFontScale: 1 });
            await renderScreen(<Probe />);
            let pending: void | Promise<void> = undefined;
            await act(async () => { pending = apply!({ uiFontScale: 1.3 }); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            const request = JSON.parse(account.artifacts.readPlainBody(account.artifacts.list()[0]!.id)!);
            expect(request).toMatchObject({ actionId: 'settings.set', actionArgs: { anchor: 'appearance.textSize', value: 1.3 },
                approval: { flow: 'blocking' } });
            expect(storage.getState().localSettings.uiFontScale).toBe(1);
            // A direct control has no inline decision surface, so the wait opens the existing Inbox review.
            expect(routerPush).toHaveBeenCalledWith(
                expect.stringContaining(`/inbox/approvals/${encodeURIComponent(account.artifacts.list()[0]!.id)}`));
            await act(async () => { await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve'); });
            await pending!;
            expect(storage.getState().localSettings.uiFontScale).toBe(1.3);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps signed-out local preferences usable through the same declaration admission', async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        const { AuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
        await disconnectActiveServerConnection();
        storage.setState({ settingsScope: null, settings: settingsParse({}) });
        storage.getState().applyLocalSettings({ uiFontScale: 1 });
        let apply: ReturnType<typeof useApplyLocalSettings> | undefined;
        function Probe() { apply = useApplyLocalSettings(); return null; }
        const screen = await renderScreen(<AuthProvider initialCredentials={null}><Probe /></AuthProvider>);
        expect(getCurrentAuth()).toMatchObject({ credentialAuthorityKind: 'none', isAuthenticated: false });
        await act(async () => { await apply!({ uiFontScale: 1.3 }); });
        expect(storage.getState().localSettings.uiFontScale).toBe(1.3);
        // A local write never falls back to raw persistence if policy refuses it.
        await act(async () => { storage.setState({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) }); });
        await act(async () => { await apply!({ uiFontScale: 1.1 }); });
        expect(storage.getState().localSettings.uiFontScale).toBe(1.3);
        await screen.unmount();
    });
    it.each(['narrowed', 'ask', 'account-setting'] as const)('keeps the signed-out local interaction bound (%s)', async scenario => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { AuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
        await disconnectActiveServerConnection();
        storage.setState({ settingsScope: null, settings: settingsParse(scenario === 'ask' ? {
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        } : {}) });
        const screen = await renderScreen(<AuthProvider initialCredentials={null}><React.Fragment /></AuthProvider>);
        expect(getCurrentAuth()).toMatchObject({ credentialAuthorityKind: 'none', isAuthenticated: false });
        storage.getState().applyLocalSettings({ uiFontScale: 1 });
        const before = storage.getState().settings;
        const result = await createDefaultActionExecutor().execute('settings.set', scenario === 'account-setting'
            ? { anchor: 'transcript.showToolCalls', value: false }
            : { anchor: 'appearance.textSize', value: 1.3 }, {
            surface: 'ui', actionCaller: { kind: 'host' },
            authority: scenario === 'narrowed' ? 'account_automation' : 'present_user',
        });
        expect(result).toMatchObject({ ok: false });
        expect(storage.getState().localSettings.uiFontScale).toBe(1);
        expect(storage.getState().settings).toBe(before);
        await screen.unmount();
    });
    it('does not promote a terminal local-setting caller past Ask-first', async () => {
        const terminalToken = `test.${Buffer.from(JSON.stringify({ sub: 'account-a',
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
        })).toString('base64url')}.test`;
        const account = await createSecretSettingsTestHarness({ token: terminalToken });
        const { AuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
        const screen = await renderScreen(<AuthProvider initialCredentials={account.credentials}><React.Fragment /></AuthProvider>);
        try {
            expect(getCurrentAuth()?.credentialAuthorityKind).toBe('terminal');
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const captured = await captureLazyActionAccountContext(account.scope.serverId);
            try { expect(captured.credentialAuthorityKind).toBe('terminal'); }
            finally { captured.dispose(); }
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            storage.getState().applyLocalSettings({ uiFontScale: 1 });
            const result = await createDefaultActionExecutor().execute('settings.set', {
                anchor: 'appearance.textSize', value: 1.3,
            }, { surface: 'ui', serverId: account.scope.serverId, authority: 'present_user', actionCaller: { kind: 'host' } });
            expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(storage.getState().localSettings.uiFontScale).toBe(1);
            expect(account.artifacts.list()).toHaveLength(1);
            expect(account.settingsWrites).toEqual([]);
        } finally { await screen.unmount(); await account.dispose(); }
    });
    it('admits device-local compound theme selection without losing Reset profile semantics', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        let apply: ReturnType<typeof useApplyThemeSelection> | undefined;
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { apply = useApplyThemeSelection(); write = useSettingActionWriter(); return null; }
        try {
            const initialProfiles = { profiles: [], activeProfileIds: { light: null, dark: 'nightDark' } };
            storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: initialProfiles });
            await renderScreen(<Probe />);
            await act(async () => { await apply!('dark', DEFAULT_THEME_PROFILES_LOCAL_STATE); });
            expect(storage.getState().localSettings.themePreference).toBe('light');
            expect(storage.getState().localSettings.themeProfiles).toEqual(initialProfiles);
            await act(async () => { account.replaceSettings(settingsParse({})); });
            await act(async () => { await apply!('dark', DEFAULT_THEME_PROFILES_LOCAL_STATE); });
            expect(storage.getState().localSettings).toMatchObject({ themePreference: 'dark', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE });
            await act(async () => {
                // Scalar consumers remain supported; structured input is strict and does not weaken neighbors.
                expect(await write!({ anchor: 'appearance.themeMode' }, 'light')).toMatchObject({ ok: true });
                for (const value of ['invalid', { themePreference: 'dark', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE, extra: true },
                    { themePreference: 'dark', themeProfiles: { ...DEFAULT_THEME_PROFILES_LOCAL_STATE, extra: true } }]) {
                    expect(await write!({ anchor: 'appearance.themeMode' }, SettingsDeclarationValueV1Schema.parse(value)))
                        .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
                }
                expect(await write!({ anchor: 'appearance.textSize' }, { scale: 1.3 })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
            });
            expect(storage.getState().localSettings.themePreference).toBe('light');
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('preserves signed-out theme selection and retires its mounted writer', async () => {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        const { AuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
        await disconnectActiveServerConnection();
        storage.setState({ settingsScope: null, settings: settingsParse({}) });
        storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE });
        let apply: ReturnType<typeof useApplyThemeSelection> | undefined;
        function Probe() { apply = useApplyThemeSelection(); return null; }
        const screen = await renderScreen(<AuthProvider initialCredentials={null}><Probe /></AuthProvider>);
        expect(getCurrentAuth()).toMatchObject({ credentialAuthorityKind: 'none', isAuthenticated: false });
        const retained = apply!;
        await act(async () => { await retained('dark', DEFAULT_THEME_PROFILES_LOCAL_STATE); });
        expect(storage.getState().localSettings.themePreference).toBe('dark');
        await screen.unmount();
        await retained('light', DEFAULT_THEME_PROFILES_LOCAL_STATE);
        expect(storage.getState().localSettings.themePreference).toBe('dark');
    });
    it('rechecks the theme caller guard at persistence after approval', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } },
        } }) });
        let current = true;
        const assertCurrent = () => { if (!current) throw new Error('retired theme editor'); };
        let apply: ReturnType<typeof useApplyThemeSelection> | undefined;
        function Probe() { apply = useApplyThemeSelection(assertCurrent); return null; }
        try {
            storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE });
            await renderScreen(<Probe />);
            let pending!: Promise<boolean>;
            await act(async () => { pending = apply!('dark', DEFAULT_THEME_PROFILES_LOCAL_STATE); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            current = false;
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await pending;
            expect(storage.getState().localSettings.themePreference).toBe('light');
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('retains an uncommitted theme editor draft when activation is Off', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) });
        try {
            storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE });
            routeParams.current = { profileId: 'new' };
            const { ThemeProfileEditorScreen } = await import('@/components/settings/appearance/themeProfiles/ThemeProfileEditorScreen');
            const screen = await renderScreen(<ThemeProfileEditorScreen />);
            await act(async () => { screen.tree.changeTextByTestId('settings-theme-profile-name', 'Unsaved theme'); });
            await act(async () => { await pressTestInstanceAsync(screen.findByTestId('settings-theme-profile-save')!); });
            expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([]);
            expect(screen.findByTestId('settings-theme-profile-name')?.props.value).toBe('Unsaved theme');
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps theme activation in originating custody and retains a declined draft', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } },
        } }) });
        try {
            storage.getState().applyLocalSettings({ themePreference: 'light', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE });
            routeParams.current = { profileId: 'new' };
            const { ThemeProfileEditorScreen } = await import('@/components/settings/appearance/themeProfiles/ThemeProfileEditorScreen');
            const screen = await renderScreen(<ThemeProfileEditorScreen />);
            await act(async () => { screen.tree.changeTextByTestId('settings-theme-profile-name', 'Pending theme'); });
            let saving!: Promise<void>;
            await act(async () => { saving = pressTestInstanceAsync(screen.findByTestId('settings-theme-profile-save')!); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            const request = JSON.parse(account.artifacts.readPlainBody(account.artifacts.list()[0]!.id)!);
            expect(request).toMatchObject({ approval: { flow: 'blocking' }, actionId: 'settings.set',
                actionArgs: { anchor: 'appearance.themeMode', value: { activation: { profile: { name: 'Pending theme' } } } } });
            expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([]);
            vi.mocked(Modal.alert).mockClear();
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            await saving;
            expect(storage.getState().localSettings.themeProfiles.profiles).toEqual([]);
            expect(screen.findByTestId('settings-theme-profile-name')?.props.value).toBe('Pending theme');
            expect(Modal.alert).not.toHaveBeenCalled();
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('admits Profiles and other direct Account preferences at the shared settings ingress', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            useProfiles: false, useMachinePickerSearch: false, analyticsOptOut: false, sessionTmuxTmpDir: '/custom/tmp',
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        let profile: ReturnType<typeof useSettingMutable<'useProfiles'>> | undefined;
        let apply: ReturnType<typeof useApplySettings> | undefined;
        function Probe() { profile = useSettingMutable('useProfiles'); apply = useApplySettings(); return null; }
        try {
            await renderScreen(<Probe />);
            await act(async () => {
                profile![1](true);
                await apply!({ useMachinePickerSearch: true, analyticsOptOut: true });
            });
            expect(storage.getState().settings).toMatchObject({ useProfiles: false, useMachinePickerSearch: false, analyticsOptOut: false });
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            const retained = profile![1];
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, useProfiles: true })); });
            await act(async () => { retained(current => !current); });
            await act(async () => { await vi.waitFor(() => expect(account.persistedSettings.useProfiles).toBe(false)); });
            await act(async () => { await apply!({ useMachinePickerSearch: true, analyticsOptOut: true, sessionTmuxTmpDir: null }); });
            await act(async () => { await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ useMachinePickerSearch: true, analyticsOptOut: true, sessionTmuxTmpDir: null })); });
            const writes = account.settingsWrites.length;
            await act(async () => { profile![1](() => null); });
            expect(account.settingsWrites).toHaveLength(writes);
            await act(async () => {
                // The Action consumer must reject malformed runtime values, rather than storage coercing them.
                // @ts-expect-error Deliberate runtime boundary input with the wrong scalar type.
                await apply!({ useProfiles: 'true' });
            });
            expect(account.persistedSettings.useProfiles).toBe(false);
            expect(account.settingsWrites).toHaveLength(writes);
            await act(async () => { await apply!({ useProfiles: undefined }); });
            expect(account.persistedSettings.useProfiles).toBe(false);
            expect(account.settingsWrites).toHaveLength(writes);
            account.setRejectSettingsWrites(true);
            await act(async () => { await apply!({ useProfiles: true }); });
            expect(account.persistedSettings.useProfiles).toBe(false);
            expect(storage.getState().settings.useProfiles).toBe(false);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('preserves JSON values, equivalent aliases and incumbent sparse writes without reviving a retired ingress', async () => {
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'connectedServices.quotas', true)).toBe(true);
        const account = await createSecretSettingsTestHarness({ features, settings: settingsParse({
            useProfiles: false, sessionUsageGaugeLabels: false,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        let apply: ReturnType<typeof useApplySettings> | undefined;
        function Probe() { apply = useApplySettings(); return null; }
        try {
            const screen = await renderScreen(<Probe />);
            await act(async () => { await apply!({ useProfiles: true, sessionListLayoutV1: 'recent_activity',
                usageCoachPreferencesV1: settingsParse({ usageCoachPreferencesV1: { modelSuggestion: 'off' } }).usageCoachPreferencesV1,
                sessionUsageGaugeLabels: true }); });
            await act(async () => { await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({
                useProfiles: true, sessionListSectionModeV1: 'activity', usageCoachPreferencesV1: { modelSuggestion: 'off' }, sessionUsageGaugeLabels: true,
            })); });
            const retained = apply!;
            const writes = account.settingsWrites.length;
            await act(async () => { screen.tree.update(<></>); });
            await act(async () => { await retained({ useProfiles: false }); });
            expect(account.persistedSettings.useProfiles).toBe(true);
            expect(storage.getState().settings.useProfiles).toBe(true);
            expect(account.settingsWrites).toHaveLength(writes);
            const updater = vi.fn(() => ({ useProfiles: false }));
            await act(async () => { storage.setState({ settingsScope: { serverId: account.scope.serverId, accountId: 'another-account' } }); });
            await act(async () => { await retained(updater); });
            expect(updater).not.toHaveBeenCalled();
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('routes the mounted Machine connection choice through admitted keyed Settings Actions in the exact Home', async () => {
        const preferences = { v: 1, flows: { machine_rpc: { direct: 'disabled' } },
            byMachineId: { other: { flows: { machine_rpc: { direct: 'enabled' } } } } } as const;
        const features = createRootLayoutFeaturesResponse();
        for (const featureId of ['machines.rpc.directPeer', 'machines.transfer.directPeer', 'machines.tunnel.directPeer', 'machines.liveStream.directPeer'] as const) {
            expect(tryWriteServerEnabledBitInPlace(features, featureId, true)).toBe(true);
        }
        const account = await createSecretSettingsTestHarness({ features, settings: settingsParse({
            peerMediationPreferencesV1: preferences,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        try {
            const { MachineDirectConnectionSection } = await import('@/components/settings/connections/DirectConnectionSettings');
            const screen = await renderScreen(<MachineDirectConnectionSection serverId={account.scope.serverId} machineId="machine-a" machineName="Laptop" />);
            const choose = async (choice: 'direct' | 'relay' | 'default') => {
                await act(async () => { await pressTestInstanceAsync(screen.findByTestId(`machine-direct-connection:${choice}`)!); });
            };
            await choose('direct');
            expect(account.persistedSettings.peerMediationPreferencesV1).toEqual(preferences);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            for (const choice of ['direct', 'relay', 'default'] as const) {
                await choose(choice);
                await vi.waitFor(() => expect(account.persistedSettings.peerMediationPreferencesV1.byMachineId['machine-a']?.flows.machine_rpc?.direct)
                    .toBe(choice === 'default' ? undefined : choice === 'direct' ? 'enabled' : 'disabled'));
                expect(account.persistedSettings.peerMediationPreferencesV1.flows).toEqual(preferences.flows);
                expect(account.persistedSettings.peerMediationPreferencesV1.byMachineId.other).toEqual(preferences.byMachineId.other);
            }
            await act(async () => { screen.tree.update(<MachineDirectConnectionSection serverId="another-home" machineId="machine-a" machineName="Laptop" />); });
            const before = account.settingsWrites.length;
            await choose('direct');
            expect(account.settingsWrites).toHaveLength(before);
            expect(account.persistedSettings.peerMediationPreferencesV1.byMachineId['machine-a']).toBeUndefined();
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('writes keyed Agent preferences through the public Account Action without replacing another target', async () => {
        const other = 'agent:happier.agent.claude/claude';
        const target = 'agent:happier.agent.codex/codex';
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            backendEnabledByTargetKey: { [other]: false },
        }) });
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter(); return null; }
        try {
            await renderScreen(<Probe />);
            await act(async () => {
                expect(await write!({ anchor: 'agents.enabled' }, { agentTargetKey: target, value: true })).toMatchObject({ ok: true });
                expect(await write!({ anchor: 'agents.defaultPermission' }, { agentTargetKey: target, value: 'default' })).toMatchObject({ ok: true });
                expect(await write!({ anchor: 'agents.executableSource' }, { agentTargetKey: target, value: 'managed-first' })).toMatchObject({ ok: true });
            });
            expect(account.persistedSettings.backendEnabledByTargetKey).toEqual({ [other]: false, [target]: true });
            expect(account.persistedSettings.sessionDefaultPermissionModeByTargetKey[target]).toBe('default');
            expect(account.persistedSettings.backendCliSourcePreferenceByTargetKey[target]).toBe('managed-first');
        } finally { await account.dispose(); }
    });
    it('switches All machines to Grid through admitted Settings Actions and opens the same machine page', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        const serverId = account.scope.serverId;
        const machine = createMachineFixture({ id: 'machine-a1', active: false, activeAt: 0,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Machine A1', host: 'a.local', platform: 'darwin' } });
        try {
            routerPush.mockClear();
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
                machineListStatusByServerId: { [serverId]: 'idle' } });
            storage.getState().applyLocalSettings({ machinesIndexViewV1: 'list' });
            const screen = await renderScreen(<AllMachinesIndex />);
            const tree = screen.tree;
            const viewSwitch = () => tree.findAll(node => node.props?.testIDPrefix === 'machines.index.view'
                && typeof node.props?.onSelectTab === 'function')[0]!;
            await act(async () => { viewSwitch().props.onSelectTab('grid'); });
            await vi.waitFor(() => expect(tree.findAll(node => node.props?.testID === 'machines.index.collection'
                && node.props?.presentation === 'grid').length).toBeGreaterThan(0));
            // React Native's layout callback is the renderer boundary; the Collection model stays real.
            await act(async () => {
                for (const node of tree.findAll(candidate => typeof candidate.props?.onLayout === 'function')) {
                    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 900 } } });
                }
            });
            expect(tree.findAll(node => node.props?.testID === `machines.index.card.machine:${serverId}:${machine.id}`).length).toBeGreaterThan(0);
            const card = tree.findAll(node => node.props?.testID === `machines.index.row.machine:${serverId}:${machine.id}`
                && typeof node.props?.onPress === 'function')[0]!;
            await act(async () => { await pressTestInstanceAsync(card); });
            expect(routerPush).toHaveBeenCalledWith(`/settings/machines/${machine.id}?serverId=${encodeURIComponent(serverId)}`);
            expect(storage.getState().localSettings.machinesIndexViewV1).toBe('grid');
            await act(async () => { viewSwitch().props.onSelectTab('list'); });
            await vi.waitFor(() => expect(storage.getState().localSettings.machinesIndexViewV1).toBe('list'));
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps a phone in List while admitting desktop shape and sort through the same local Action owner', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) });
        const key = `${account.scope.serverId}\u0000machine`;
        let desktop: ReturnType<typeof useMachineStorageViewSetting> | undefined;
        let phone: ReturnType<typeof useMachineStorageViewSetting> | undefined;
        function Probe() {
            desktop = useMachineStorageViewSetting(account.scope.serverId, 'machine', false);
            phone = useMachineStorageViewSetting(account.scope.serverId, 'machine', true);
            return null;
        }
        try {
            storage.getState().applyLocalSettings({ machineStorageViewV1: { [key]: { shape: 'rings', sort: { by: 'size', direction: 'desc' } } } });
            await renderScreen(<Probe />);
            await act(async () => { desktop!.remember({ shape: 'map' }); });
            expect(desktop!.shape).toBe('rings');
            expect(phone!.shape).toBe('list');
            await act(async () => { account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            await act(async () => { desktop!.remember({ shape: 'map' }); phone!.remember({ sort: { by: 'name', direction: 'asc' } }); });
            await vi.waitFor(() => expect(storage.getState().localSettings.machineStorageViewV1[key])
                .toEqual({ shape: 'map', sort: { by: 'name', direction: 'asc' } }));
            expect(desktop!.shape).toBe('map');
            expect(phone!.shape).toBe('list');
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('retains the keyed Storage operand at the mounted Settings Action ingress', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter(); return null; }
        const key = `${account.scope.serverId}\u0000machine`;
        try {
            storage.getState().applyLocalSettings({ machineStorageViewV1: {} });
            await renderScreen(<Probe />);
            const setting = { anchor: 'machines.storage.view', key };
            let result: Awaited<ReturnType<NonNullable<typeof write>>> | undefined;
            await act(async () => { result = await write!(setting, { shape: 'rings' }); });
            expect(result).toMatchObject({ ok: true });
            expect(storage.getState().localSettings.machineStorageViewV1[key]).toEqual({ shape: 'rings', sort: { by: 'size', direction: 'desc' } });
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('applies Summary and All machines choices only when their UI Settings Action is admitted', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) });
        let controls: Readonly<{ summary: ReturnType<typeof useMachineSummarySetting>; index: ReturnType<typeof useMachinesIndexView> }> | undefined;
        function Probe() { controls = { summary: useMachineSummarySetting(), index: useMachinesIndexView() }; return null; }
        try {
            storage.getState().applyLocalSettings({ uiMachineSummaryStyle: 'sparklines', uiMachineSummaryMetrics: ['cpu'], machinesIndexViewV1: 'list' });
            await renderScreen(<Probe />);
            await act(async () => {
                controls!.summary.setStyle('rings');
                controls!.summary.toggleMetric('cpu');
                controls!.index[1]('grid');
            });
            expect(storage.getState().localSettings).toMatchObject({
                uiMachineSummaryStyle: 'sparklines', uiMachineSummaryMetrics: ['cpu'], machinesIndexViewV1: 'list',
            });
            await act(async () => { account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            await act(async () => {
                controls!.summary.setStyle('rings');
                controls!.summary.toggleMetric('cpu');
                controls!.index[1]('grid');
            });
            await vi.waitFor(() => expect(storage.getState().localSettings).toMatchObject({
                uiMachineSummaryStyle: 'rings', uiMachineSummaryMetrics: [], machinesIndexViewV1: 'grid',
            }));
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('propagates an admitted Account setting result from the real Action owner', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter(); return null; }
        try {
            await renderScreen(<Probe />);
            if (!write) throw new Error('Writer missing');
            let result: Awaited<ReturnType<typeof write>> | undefined;
            await act(async () => { result = await write!(PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions, true); });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(true);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('refuses the same Account setting when the viewed Home is not its captured owner', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter({ serverId: 'another-home' }); return null; }
        try {
            await renderScreen(<Probe />);
            if (!write) throw new Error('Writer missing');
            let result: Awaited<ReturnType<typeof write>> | undefined;
            await act(async () => { result = await write!(PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions, true); });
            expect(result).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});

describe('compound and platform control Settings Action ingress', () => {
    it.each(['wizard', 'direct-connections', 'enter-web'] as const)(
        'admits the mounted %s control under Off, Ask rejected, Ask approved and Allowed', async control => {
            const features = createRootLayoutFeaturesResponse();
            for (const feature of ['machines.rpc.directPeer', 'machines.transfer.directPeer', 'machines.tunnel.directPeer', 'machines.liveStream.directPeer'] as const) {
                expect(tryWriteServerEnabledBitInPlace(features, feature, true)).toBe(true);
            }
            const account = await createSecretSettingsTestHarness({ features, settings: settingsParse({
                newSessionWizardSectionPresentationV1: { models: 'dropdown' },
                peerMediationPreferencesV1: { v: 1, flows: { machine_rpc: { direct: 'disabled' } },
                    byMachineId: { other: { flows: { machine_rpc: { direct: 'enabled' } } } } },
                agentInputEnterToSend: false, agentInputEnterToSendNative: false,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
            }) });
            const enterKey = 'agentInputEnterToSend';
            const otherEnterKey = 'agentInputEnterToSendNative';
            const readValue = (settings: Settings) => control === 'wizard'
                ? settings.newSessionWizardSectionPresentationV1.machines === 'dropdown'
                : control === 'direct-connections'
                    ? readDirectConnectionsEnabled(settings.peerMediationPreferencesV1)
                    : settings[enterKey];
            try {
                const screen = await renderScreen(control === 'wizard' ? <NewSessionWizardSettingsView />
                    : control === 'direct-connections' ? <AccountDirectConnectionsSection /> : <SessionComposerSettingsView />);
                const wizardRow = () => screen.tree.findAll(node => node.props?.testID === 'settings-new-session-wizard-machines'
                    && typeof node.props?.onChange === 'function')[0]!;
                const directSwitch = () => screen.tree.findAll(node => node.props?.testID === 'settings-account-direct-connections-switch'
                    && typeof node.props?.onValueChange === 'function')[0]!;
                const enterRow = () => screen.tree.findAll(node => node.props?.testID === 'settings-composer-enter-to-send'
                    && typeof node.props?.onPress === 'function')[0]!;
                const choose = async (enabled: boolean) => {
                    await act(async () => {
                        if (control === 'wizard') wizardRow().props.onChange(enabled ? 'dropdown' : 'auto');
                        else if (control === 'direct-connections') directSwitch().props.onValueChange(enabled);
                        else enterRow().props.onPress();
                        await flushHookEffects({ cycles: 2, turns: 2 });
                    });
                };
                const expectValue = (enabled: boolean) => {
                    expect(readValue(account.persistedSettings)).toBe(enabled);
                    expect(readValue(storage.getState().settings)).toBe(enabled);
                    if (control === 'wizard') expect(wizardRow().props.value).toBe(enabled ? 'dropdown' : 'auto');
                    else if (control === 'direct-connections') expect(directSwitch().props.value).toBe(enabled);
                    else expect(enterRow().props.rightElement.props.value).toBe(enabled);
                };
                const setPolicy = async (policy: 'ask' | 'allowed') => {
                    await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                        actionsSettingsV1: policy === 'ask'
                            ? { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } }
                            : { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
                    })); });
                };
                await choose(true);
                expectValue(false);
                expect(account.settingsWrites).toEqual([]);
                await setPolicy('ask');
                await choose(true);
                await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
                expectValue(false);
                expect(account.settingsWrites).toEqual([]);
                await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
                await act(async () => { await flushHookEffects({ cycles: 2, turns: 2 }); });
                expectValue(false);
                expect(account.settingsWrites).toEqual([]);

                await choose(true);
                await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
                // A neighboring preference changes while approval waits. The owner must
                // rebase the scalar intent, never replay a caller's stale whole record.
                await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                    newSessionWizardSectionPresentationV1: { models: 'list' },
                    peerMediationPreferencesV1: { ...account.persistedSettings.peerMediationPreferencesV1,
                        byMachineId: { other: { flows: { machine_rpc: { direct: 'disabled' } } } } },
                    [otherEnterKey]: true,
                })); });
                await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
                await vi.waitFor(() => expectValue(true));
                const expectNeighbor = () => {
                    expect(account.persistedSettings.newSessionWizardSectionPresentationV1.models).toBe('list');
                    expect(account.persistedSettings.peerMediationPreferencesV1.byMachineId.other?.flows.machine_rpc?.direct).toBe('disabled');
                    expect(account.persistedSettings[otherEnterKey]).toBe(true);
                };
                expectNeighbor();
                await setPolicy('allowed');
                await choose(false);
                await vi.waitFor(() => expectValue(false));
                expectNeighbor();
                expect(account.artifacts.list()).toHaveLength(2);
                if (control === 'wizard') expect(account.persistedSettings.newSessionWizardSectionPresentationV1).not.toHaveProperty('machines');
            } finally {
                await standardCleanup();
                await account.dispose();
            }
        },
    );
});
