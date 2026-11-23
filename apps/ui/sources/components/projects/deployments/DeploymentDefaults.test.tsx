import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { act, renderHook, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import type { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { SETTINGS_PAGE_CATALOG } = await import('@/components/settings/catalog/pageCatalog');
const { SETTINGS_PAGE_DECLARATIONS } = await import('@/components/settings/catalog/settingsPageDeclarations');
const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { Item } = await import('@/components/ui/lists/Item');
const { IconButton } = await import('@/components/ui/buttons/IconButton');
const original = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(original, true); router.resetParams(); vi.unstubAllGlobals(); });

it('reads an off-focus Home’s runner preference for deployments instead of the focused Home’s choice', async () => {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
    const { DeploySuggestionRunnerSetting } = await import('@/components/settings/deployments/DeploySuggestionRunnerSetting');
    const { LlmTaskRunnerPicker } = await import('@/components/settings/llmTasks/LlmTaskRunnerPicker');
    const desired = { v: 1, mode: 'auto', permissionMode: 'read_only' } as const;
    const home = await createSecretSettingsTestHarness({ mode: 'plain', settings: settingsParse({ deploySuggestionRunnerV1: desired }) });
    const scope = (await captureLazyActionAccountContext(home.scope.serverId));
    storage.setState({ settingsScope: null, settingsVersion: null, settings: settingsParse({ deploySuggestionRunnerV1: null }) });
    function Harness() {
        const execution = useMountedActionExecution(scope.accountLifetime.scope);
        return <DeploySuggestionRunnerSetting serverId={scope.serverId} execution={execution} testIDPrefix="off-focus-runner" />;
    }
    const screen = await renderSettingsView(<InjectedAuthProvider credentials={home.credentials}><Harness /></InjectedAuthProvider>);
    try {
        await vi.waitFor(() => expect(screen.findAllByType(LlmTaskRunnerPicker)[0]?.props.value).toEqual(desired));
    } finally { await screen.unmount(); scope.dispose(); await home.dispose(); }
});

describe('deployment defaults pages', () => {
    it.each(['plain', 'e2ee'] as const)('opens the searchable Account preference and saves through Settings Actions (%s)', async mode => {
        const pages = SETTINGS_PAGE_CATALOG.flatMap(root => root.children?.flatMap(group => group.children ?? []) ?? []);
        expect(pages.find(page => page.id === 'deployments')?.route).toBe('/settings/deployments');
        expect(SETTINGS_PAGE_DECLARATIONS.flatMap(page => Object.values(page.settings))
            .some(setting => setting.anchor === 'deployments.creationDefaults')).toBe(true);
        const baseline = settingsParse({ deploymentDefaultsV1: { buildMachineId: 'builder', controllerMachineId: 'controller', retainPreviousDeployments: 0 },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } });
        const account = await createSecretSettingsTestHarness({ mode, settings: baseline });
        try {
            const { WorkspaceRouteBody: AccountDefaults } = await import('@/app/(app)/settings/deployments');
            const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><AccountDefaults /></InjectedAuthProvider>);
            const retention = () => screen.findAllByType(FieldValueItem).find(row => row.props.testID === 'deployment-defaults.retention')!;
            await act(async () => { retention().props.onCommit('2'); });
            expect(account.persistedSettings.deploymentDefaultsV1.retainPreviousDeployments).toBe(0);
            await act(async () => account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } } })));
            await act(async () => { retention().props.onCommit('2'); });
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1).toEqual({
                buildMachineId: 'builder', controllerMachineId: 'controller', retainPreviousDeployments: 2 }));
            const builder = () => screen.findAllByType(SessionMachineField).find(row => row.props.testID === 'deployment-defaults.builder')!;
            await act(async () => builder().props.defaultChoice!.onChoose());
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1).toEqual({ controllerMachineId: 'controller', retainPreviousDeployments: 2 }));
            const database = () => screen.findAllByType(SegmentedChoiceItem).find(row => row.props.testIDPrefix === 'deployment-defaults.previewDatabase')!;
            expect(database()).toBeDefined();
            await act(async () => database().props.onChange('branch'));
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1.previewDatabase).toBe('branch'));
            const count = () => screen.findAllByType(FieldValueItem).find(row => row.props.testID === 'deployment-defaults.backupRetention.daily')!;
            await act(async () => count().props.onCommit('14'));
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1.backupRetention).toEqual({ kind: 'keep', daily: 14 }));
            // The row shows the value it holds; there is no per-row "Use Happier's default" segment (UI refinements 11-18).
            expect(database().props.options.map((option: { id: string }) => option.id)).toEqual(['none', 'own', 'branch']);
            const alerts = () => screen.findAllByType(SegmentedChoiceItem).find(row => row.props.testIDPrefix === 'deployment-defaults.alertChannels')!;
            expect(alerts()).toBeDefined();
            await act(async () => alerts().props.onChange('off'));
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1.alertChannels).toEqual([]));
            expect(alerts().props.options).toContainEqual(expect.objectContaining({ id: 'configured' }));
            const priorPresentations = vi.mocked(Modal.show).mock.calls.length;
            await act(async () => { alerts().props.onChange('configured'); });
            await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledTimes(priorPresentations + 1));
            // The platform modal boundary carries the real owner form.
            const readPresentedForm = () => vi.mocked(Modal.show).mock.calls.at(-1)![0].props!.form as Parameters<typeof presentActionInputForm>[0]['form'];
            await act(async () => { const form = readPresentedForm(); form.replaceInput({ channelId: 'health-push' }); await form.submit(); });
            await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledTimes(priorPresentations + 2));
            await act(async () => { const form = readPresentedForm(); form.replaceInput({ channel: { channelId: 'health-push' } }); await form.submit(); });
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1.alertChannels).toEqual([{ channelId: 'health-push' }]));
            const addAlert = () => screen.findAllByType(Item).find(row => row.props.testID === 'deployment-defaults.alertChannels.add');
            expect(addAlert()).toBeDefined();
            await act(async () => { void addAlert()!.props.onPress(); });
            await act(async () => { const form = readPresentedForm(); form.replaceInput({ channelId: 'happier.channel.slack/alerts' }); await form.submit(); });
            const secondChannel = { channelId: 'happier.channel.slack/alerts', destination: { connectionId: 'production',
                endpoint: { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' } } };
            await act(async () => { const form = readPresentedForm(); form.replaceInput({ channel: secondChannel }); await form.submit(); });
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1.alertChannels)
                .toEqual([{ channelId: 'health-push' }, secondChannel]));
            const removeAlert = screen.findAllByType(IconButton).find(row => row.props.testID === 'deployment-defaults.alertChannels.remove.0');
            expect(removeAlert).toBeDefined();
            await act(async () => { removeAlert!.props.onPress(); });
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1.alertChannels).toEqual([secondChannel]));
            // One reset at the foot returns every value to Happier's default.
            await screen.pressByTestIdAsync('deployment-defaults.reset.button');
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1).toEqual({}));
            expect(screen.findByTestId('deployment-defaults.reset.button')).toBeNull();
        } finally { standardCleanup(); await account.dispose(); }
    });

});

it('refreshes an open deployment defaults page after an off-focus Account wake', async () => {
    const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { useDeploymentAccountDefaults } = await import('./useDeploymentAccountDefaults');
    const settings = settingsParse({ deploymentDefaultsV1: { retainPreviousDeployments: 2 } });
    const home = await createSecretSettingsTestHarness({ mode: 'plain', settings });
    const context = await captureLazyActionAccountContext(home.scope.serverId);
    saveAccountSettings(home.scope, settings, 1);
    storage.setState({ settingsScope: null, settingsVersion: null });
    const screen = await renderHook(() => useDeploymentAccountDefaults(context.accountLifetime));
    try {
        await vi.waitFor(() => expect(screen.getCurrent().preferences?.retainPreviousDeployments).toBe(2));
        await act(async () => {
            home.replaceSettings(settingsParse({ ...settings, deploymentDefaultsV1: { retainPreviousDeployments: 4 } }),
                { version: 2, publish: false });
            publishHomeAccountChange(home.scope.serverId, ['self'], { changeKinds: ['account'], accountSettingsAffects: true });
        });
        await vi.waitFor(() => expect(screen.getCurrent().preferences?.retainPreviousDeployments).toBe(4));
    } finally { await screen.unmount(); context.dispose(); await home.dispose(); }
});
