import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture, flushHookEffects, renderHook, renderInCollectionLayout, renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { storage } from '@/sync/domains/state/storageStore';
import type { CollectionConditionEdit, CollectionConditionModel } from '@happier-dev/plugin-ui/components';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { ConnectedServicesDefaultAuthByAgentIdV1Schema } from '@happier-dev/protocol/account/settings/connected-services';
import { machineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import type { ConnectSheetAccountRequest } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

const navigation = vi.hoisted(() => ({ params: {} as Record<string, string>, pathname: '/settings/agents', push: vi.fn(), replace: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => navigation.params, pathname: () => navigation.pathname,
    router: { push: navigation.push, replace: navigation.replace },
}).module);
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
const account = createProviderSettingsAccountHarness();
const { AgentSettingsScreen } = await import('./AgentSettingsScreen');
const { AgentCollectionRail, AgentCollectionList } = await import('./collection/AgentCollectionList');
const { AgentSettingsIndex } = await import('./AgentSettingsIndex');
const { useAgentsAdministrationTargetSelection, useAgentAdministrationCatalog } = await import('./collection/useAgentAdministrationCatalog');
const { useOpenSessionReadinessRepair } = await import('@/components/sessions/readiness/SessionReadinessChecklist');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { AgentDetailHeader } = await import('./detail/AgentDetailHeader');
const { useSettingPreview } = await import('@/sync/store/settingsPreview');
const { useConnectedAccountPurposeDefaults } = await import('@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults');

afterEach(async () => { standardCleanup(); navigation.params = {}; navigation.pathname = '/settings/agents'; navigation.push.mockClear(); navigation.replace.mockClear(); daemon.reset(); await account.reset(); vi.unstubAllGlobals(); });

it.each(['none', 'offline'] as const)('keeps the Agents root reachable with %s Machine availability and returns there from an explicit detail', async availability => {
    await account.restore({ serverIdentityId: 'srv_agent_home', machines: availability === 'offline'
        ? [createMachineFixture({ id: 'offline-agent-home', active: false, activeAt: 0 })] : [] });
    if (availability === 'offline') await account.selectMachine(account.serverId, 'offline-agent-home', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    const screen = await renderInCollectionLayout(<AppPaneProvider><AgentSettingsIndex /></AppPaneProvider>, 'split');
    // Beside the column the root is the Agents home, never an automatic detail.
    await vi.waitFor(() => expect(screen.findHostByTestId('settings-agents-home')).not.toBeNull());
    expect(screen.findAllByType('Redirect')).toHaveLength(0);
    expect(daemon.state.requests).toHaveLength(0);
    await screen.update(<AppPaneProvider><AgentCollectionRail /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.findHostByTestId('settings-agents-collection.row.codex')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-agents-collection.row.codex');
    expect(navigation.push).toHaveBeenCalledWith('/(app)/settings/agents/codex?pluginId=happier.agent.codex');
    navigation.pathname = '/settings/agents/codex';
    navigation.params = { agentId: 'codex', pluginId: 'happier.agent.codex' };
    await screen.update(<AppPaneProvider><AgentCollectionRail /></AppPaneProvider>);
    await screen.pressByTestIdAsync('settings-agents-collection.all');
    expect(navigation.replace).toHaveBeenCalledWith('/(app)/settings/agents');
    expect(daemon.state.requests).toHaveLength(0);
});

it('keeps Agent preference previews live without rendering for unrelated settings arrivals', async () => {
    await account.restore({ serverIdentityId: 'srv_agent_previews', machines: [] });
    vi.stubGlobal('isTauri', true);
    navigation.params = { agentId: 'codex' };
    let commits = 0;
    const screen = await renderScreen(<AppPaneProvider><React.Profiler id="agent-preferences" onRender={() => { commits++; }}>
        <AgentSettingsScreen />
    </React.Profiler></AppPaneProvider>);
    const preview = await renderHook(() => ({
        enabled: useSettingPreview('backendEnabledByTargetKey'),
        permission: useSettingPreview('sessionDefaultPermissionModeByTargetKey'),
        cliSource: useSettingPreview('backendCliSourcePreferenceByTargetKey'),
    }));
    const permission = () => screen.find(node => node.props.testID === 'settings.agents.detail.permissionMode'
        && (node.props.value !== undefined || node.props.selectedId !== undefined)).props;
    await vi.waitFor(() => expect(screen.findByType(AgentDetailHeader).props.enabled?.value).toBe(true));
    const targetKey = screen.findByType(AgentDetailHeader).props.projection.backendTargetKey as string;
    await act(async () => {
        preview.getCurrent().enabled({ [targetKey]: false });
        preview.getCurrent().permission({ [targetKey]: 'read-only' });
        preview.getCurrent().cliSource({ [targetKey]: 'managed-first' });
    });
    expect(screen.findByType(AgentDetailHeader).props.enabled?.value).toBe(false);
    expect(permission().value ?? permission().selectedId).toBe('read-only');
    expect(screen.find(node => node.props.testID === 'settings-provider-cli-source-preference' && node.props.options).props.value).toBe('managed-first');
    await act(async () => {
        preview.getCurrent().enabled(undefined);
        preview.getCurrent().permission(undefined);
        preview.getCurrent().cliSource(undefined);
        storage.getState().applySettingsLocal({ sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'yolo' } });
    });
    expect(screen.findByType(AgentDetailHeader).props.enabled?.value).toBe(true);
    expect(permission().value ?? permission().selectedId).toBe('yolo');
    await flushHookEffects();
    const baseline = commits;
    for (let index = 0; index < 25; index++) await act(async () => {
        storage.getState().applySettingsLocal({ showLineNumbers: !storage.getState().settings.showLineNumbers });
    });
    expect(commits - baseline).toBe(0);
});

it('reads legacy Connected Account defaults by key with stable unrelated arrivals and live previews', async () => {
    await account.restore({ serverIdentityId: 'srv_legacy_purpose_previews', machines: [] });
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useConnectedAccountPurposeDefaults(undefined, { enabled: false });
    });
    const preview = await renderHook(() => ({
        primary: useSettingPreview('connectedServicesDefaultAuthByAgentIdV1'),
        additional: useSettingPreview('connectedServicesAdditionalDefaultAuthByAgentIdV1'),
    }));
    const legacy = hook.getCurrent().legacySettings;
    counter.reset();
    for (let index = 0; index < 25; index++) await act(async () => {
        storage.getState().applySettingsLocal({ showLineNumbers: !storage.getState().settings.showLineNumbers });
    });
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    expect(hook.getCurrent().legacySettings).toBe(legacy);
    const primary = ConnectedServicesDefaultAuthByAgentIdV1Schema.parse({ v: 1, bindingsByAgentId: { codex: {
        v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', profileId: 'work' } },
    } } });
    const additional = ConnectedServicesDefaultAuthByAgentIdV1Schema.parse({ v: 1, bindingsByAgentId: { codex: {
        v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', profileId: 'personal' } },
    } } });
    await act(async () => {
        preview.getCurrent().primary(primary);
        preview.getCurrent().additional(additional);
    });
    expect(hook.getCurrent().legacySettings.connectedServicesDefaultAuthByAgentIdV1).toEqual(primary);
    expect(hook.getCurrent().legacySettings.connectedServicesAdditionalDefaultAuthByAgentIdV1).toEqual(additional);
    await act(async () => { preview.getCurrent().primary(undefined); preview.getCurrent().additional(undefined); });
    expect(hook.getCurrent().legacySettings).toEqual(legacy);
});

it.each(['rail', 'page'] as const)('narrows the actual Agents %s through shared status and Machine conditions without reacquisition', async variant => {
    daemon.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () =>
        DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            v: 2, generation: 1, agentsById: Object.fromEntries((['codex', 'claude'] as const).map(id => {
                const declaration = BUNDLED_CANONICAL_AGENT_DECLARATIONS[id];
                if (!declaration) throw new Error(`Missing bundled declaration ${id}`);
                return [id, { id, title: id, identity: declaration.identity, cli: declaration.cli,
                    capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }];
            })),
        } }));
    const { serverId } = await account.restore({ serverIdentityId: 'srv_agent_conditions', settings: {
        backendEnabledByTargetKey: { [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: false },
    }, machines: [createMachineFixture({ id: 'conditions-machine', activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, displayName: 'Workstation' } })] });
    await account.selectMachine(serverId, 'conditions-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    function Collection() {
        const catalog = useAgentAdministrationCatalog();
        return <AgentCollectionList variant={variant} catalog={catalog} />;
    }
    // Positioned overlays listen to the genuine browser window boundary.
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const screen = await renderScreen(<AppPaneProvider><Collection /></AppPaneProvider>);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-agents-collection.row.claude')).not.toBeNull());
        await screen.pressByTestIdAsync('settings-agents-collection-filter-open');
        const editor = () => {
            const node = screen.findAll(candidate => candidate.props.testID === 'settings-agents-collection-editor' && candidate.props.model)[0];
            if (!node) throw new Error('The actual shared condition editor must be mounted');
            return node.props as { model: CollectionConditionModel; onChange: (edit: CollectionConditionEdit) => void };
        };
        expect(editor().model.availableFields.map(field => field.id)).toEqual(['status', 'machine']);
        expect(editor().model.availableFields.find(field => field.id === 'machine')?.valueOptions)
            .toContainEqual({ value: 'conditions-machine', label: 'Workstation' });
        const requests = daemon.state.requests.length;
        await act(async () => editor().onChange({ type: 'add', condition: { fieldId: 'status', operator: 'is', values: ['disabled'] } }));
        expect(screen.findHostByTestId('settings-agents-collection.row.codex')).not.toBeNull();
        expect(screen.findHostByTestId('settings-agents-collection.row.claude')).toBeNull();
        expect(screen.findHostByTestId('settings-agents-collection-filter-token:status')).not.toBeNull();
        // Unrelated arrivals retain the actual editor model and narrowed rows without more Machine demand.
        const retainedModel = editor().model;
        await act(async () => {
            for (let index = 0; index < 100; index++) storage.setState({ artifactsLoaded: !storage.getState().artifactsLoaded });
        });
        expect(editor().model).toBe(retainedModel);
        expect(screen.findHostByTestId('settings-agents-collection.row.claude')).toBeNull();
        await act(async () => editor().onChange({ type: 'add', condition: { fieldId: 'machine', operator: 'is', values: ['not-held'] } }));
        expect(screen.findHostByTestId('settings-agents-collection.row.codex')).toBeNull();
        await act(async () => editor().onChange({ type: 'clear' }));
        expect(screen.findHostByTestId('settings-agents-collection.row.claude')).not.toBeNull();
        expect(screen.findHostByTestId('settings-agents-collection.row.codex')).not.toBeNull();
        expect(daemon.state.requests).toHaveLength(requests);
    } finally { await screen.unmount(); vi.unstubAllGlobals(); }
});

it('keeps held installation counts without a selected Machine or successful local check and marks incomplete totals', async () => {
    const metadata = { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex', 'custom-acp'] } };
    await account.restore({ serverIdentityId: 'srv_unselected_held_summary', machines: [
        createMachineFixture({ id: 'known-offline', active: false, activeAt: 0, metadata }),
        createMachineFixture({ id: 'unknown-offline', active: false, activeAt: 0 }),
        createMachineFixture({ id: 'revoked-held', active: false, activeAt: 0, revokedAt: 1, metadata }),
    ] });
    const requests = daemon.state.requests.length;
    const screen = await renderScreen(<AppPaneProvider><AgentCollectionRail /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.tree.root.findAllByProps({ testID: 'settings-agents-collection.row.codex' })
        .find(node => typeof node.props.subtitle === 'string')?.props.subtitle)
        .toBe('≥ projects.identity.machineCount(count=1)'));
    expect(screen.getTextContent()).toContain('≥ projects.identity.machineCount(count=1)');
    expect(daemon.state.requests).toHaveLength(requests);
});

it('renders held published installation counts through the real rail and Item subtitle owner', async () => {
    const declaration = BUNDLED_CANONICAL_AGENT_DECLARATIONS.codex;
    if (!declaration) throw new Error('The bundled Codex declaration must exist');
    // The physical daemon boundary advertises the real bundled identity/CLI; catalog and row decisions stay real.
    daemon.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () =>
        DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            v: 2, generation: 1, agentsById: { codex: {
                id: 'codex', title: 'Codex', identity: declaration.identity, cli: declaration.cli,
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            } },
        } }));
    // A native Agent's held count must not depend on probing unrelated ACP definitions.
    const metadata = { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex', 'custom-acp'] } };
    const { serverId, accountId } = await account.restore({ serverIdentityId: 'srv_held_summary', machines: [
        createMachineFixture({ id: 'summary-active', activeAt: Date.now(), metadata }),
        createMachineFixture({ id: 'summary-cold', active: false, activeAt: 0, metadata }),
    ] });
    await account.selectMachine(serverId, 'summary-active', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    const screen = await renderScreen(<AppPaneProvider><AgentCollectionRail /></AppPaneProvider>);
    await vi.waitFor(() => {
        const row = screen.tree.root.findAllByProps({ testID: 'settings-agents-collection.row.codex' })
            .find(node => typeof node.props.subtitle === 'string');
        expect(row?.props.subtitle).toBe('projects.identity.machineCount(count=2)');
    });
    expect(screen.getTextContent()).toContain('projects.identity.machineCount(count=2)');
    const requests = daemon.state.requests.length;
    const heldScope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId };
    const heldFact: MachineAgentInventoryItem = { agentId: 'codex', title: 'Codex', installed: true,
        version: '2.1.4', latestVersion: null, update: { supported: false, command: null },
        signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
        install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] };
    await act(async () => {
        for (const machineId of ['summary-active', 'summary-cold']) machineAgentInventoryStore.publish(
            serverAccountScopedResourceKey(heldScope, 'machine-agents', machineId),
            { status: 'ready', items: [heldFact], lastCheckedAt: 2 });
    });
    expect(screen.tree.root.findAllByProps({ testID: 'settings-agents-collection.row.codex' })
        .find(node => typeof node.props.subtitle === 'string')?.props.subtitle)
        .toBe('projects.identity.machineCount(count=2) · 2.1.4');
    expect(daemon.state.requests).toHaveLength(requests);
    expect(daemon.state.requests.filter(request => request.machineId === 'summary-cold')).toEqual([]);
});

it('opens native repair on the Bot exact Home and Machine instead of the saved settings Machine', async () => {
    const { serverId, accountId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'settings-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    const scope = { serverId, accountId };
    const repair = await renderHook(() => useOpenSessionReadinessRepair(scope));
    repair.getCurrent()({ actionId: 'machines.agents.signIn.start', input: { machineId: 'bot-machine', agentId: 'codex', method: 'native' } });
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/(app)/settings/agents/[agentId]',
        params: { agentId: 'codex', machineId: 'bot-machine', serverIdentityId: 'srv_readiness' } });
});

it('opens the expired operation account reconnect continuation on the exact Home and Machine', async () => {
    const { serverId, accountId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    const repair = await renderHook(() => useOpenSessionReadinessRepair({ serverId, accountId }));
    const trigger = { getBoundingClientRect: () => ({ left: 20, top: 30, width: 80, height: 40 }) };
    repair.getCurrent()({ actionId: 'connectedServices.authentication.beginReconnect', input: {
        machineId: 'bot-machine', account: { service: { pluginId: 'acme.external', localId: 'account' }, accountId: 'work' },
    } }, { currentTarget: trigger });
    const { Modal } = await import('@/modal');
    expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({ request: expect.objectContaining({
        scope: { serverId, accountId }, service: { pluginId: 'acme.external', localId: 'account' },
        account: { service: { pluginId: 'acme.external', localId: 'account' }, accountId: 'work' }, intent: 'reconnect',
        initialMachineTarget: { serverIdentityId: 'srv_readiness', machineId: 'bot-machine' },
    }) }) }));
    expect(navigation.push).not.toHaveBeenCalled();
});

it('consumes the reconnect route target before its authentication continuation can choose the saved Machine', async () => {
    const { serverId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'settings-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts);
    navigation.params = { service: 'happier.agent.codex/openai-codex', accountId: 'work', machineId: 'bot-machine', serverIdentityId: 'srv_readiness' };
    const { ConnectedServiceConnectRoute } = await import('@/components/settings/connectedServices/setup/ConnectedServiceConnectRoute');
    await renderScreen(<AppPaneProvider><ConnectedServiceConnectRoute /></AppPaneProvider>);
    const { Modal } = await import('@/modal');
    // This is the typed sheet request at the modal presentation boundary.
    const request = vi.mocked(Modal.show).mock.calls.at(-1)?.[0].props?.request as ConnectSheetAccountRequest | undefined;
    if (!request) throw new Error('Expected reconnect sheet request');
    expect(request).toMatchObject({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
        initialMachineTarget: { serverIdentityId: 'srv_readiness', machineId: 'bot-machine' } });
    const { useMachineAdministrationTargetSelection } = await import('@/sync/domains/machines/administration/useTargetSelection');
    const selection = await renderHook(() => useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts, { initialTarget: request.initialMachineTarget }));
    await vi.waitFor(() => expect(selection.getCurrent().selectedTarget)
        .toEqual({ serverIdentityId: 'srv_readiness', machineId: 'bot-machine' }));
});

it('refuses reconnect continuation after its execution Account changes under the existing Credentials header', async () => {
    await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    navigation.params = { service: 'happier.agent.codex/openai-codex', accountId: 'work', machineId: 'bot-machine',
        serverIdentityId: 'srv_readiness', expectedAccountId: 'another-account' };
    const { ConnectedServiceConnectRoute } = await import('@/components/settings/connectedServices/setup/ConnectedServiceConnectRoute');
    const { PageHeader } = await import('@/components/ui/layout/PageHeader');
    const screen = await renderScreen(<AppPaneProvider><ConnectedServiceConnectRoute /></AppPaneProvider>);
    expect(screen.tree.root.findAllByProps({ testID: 'connected-account-purpose-unavailable' }).length).toBeGreaterThan(0);
    expect(screen.findByType(PageHeader).props.alwaysShowTitle).toBe(true);
});

it('consumes the exact sign-in route target without requiring an install request', async () => {
    const { serverId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'settings-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    navigation.params = { agentId: 'codex', machineId: 'bot-machine', serverIdentityId: 'srv_readiness' };
    const selected = await renderHook(() => useAgentsAdministrationTargetSelection());
    await renderScreen(<AppPaneProvider><AgentSettingsScreen /></AppPaneProvider>);
    await vi.waitFor(() => expect(selected.getCurrent().selectedTarget).toEqual({ serverIdentityId: 'srv_readiness', machineId: 'bot-machine' }));
    await act(async () => selected.getCurrent().selectTarget({ serverIdentityId: 'srv_readiness', machineId: 'settings-machine' }));
    expect(selected.getCurrent().selectedTarget?.machineId).toBe('settings-machine');
});

it('keeps an unknown repair Machine unavailable instead of using the saved settings target', async () => {
    const { serverId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'settings-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    const selected = await renderHook(() => useAgentsAdministrationTargetSelection({ machineId: 'missing-bot', serverIdentityId: 'srv_readiness' }));
    expect(selected.getCurrent().selectedTarget).toEqual({ serverIdentityId: 'srv_readiness', machineId: 'missing-bot' });
    expect(selected.getCurrent().state.kind).toBe('missing');
    expect(selected.getCurrent().resolveExecutionTarget()).toBeNull();
});

it('qualifies equal Machine ids by the repair Home', async () => {
    const { serverId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'same-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'same-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    const peer = await account.addHome({ name: 'Bot Home', serverUrl: 'https://bot-home.test',
        serverIdentityId: 'srv_bot_home', accountId: 'account-a', active: false });
    await account.publishMachines(peer, [createMachineFixture({ id: 'same-machine', activeAt: Date.now() })]);
    const selected = await renderHook(() => useAgentsAdministrationTargetSelection({ machineId: 'same-machine', serverIdentityId: 'srv_bot_home' }));
    await vi.waitFor(() => expect(selected.getCurrent().selectedTarget).toEqual({ serverIdentityId: 'srv_bot_home', machineId: 'same-machine' }));
    await vi.waitFor(() => expect(selected.getCurrent().resolveExecutionTarget()?.target).toEqual({ serverIdentityId: 'srv_bot_home', machineId: 'same-machine' }));
});
