import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { PluginProjectionV2Schema, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen, flushHookEffects } from '@/dev/testkit';
import * as React from 'react';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { NewSessionEngineOptionDetailProps } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';

// Native window measurement/portals are outside the inventory wiring under test.
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
  return createInlinePopoverModuleMock(importOriginal);
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Use the real reachability adapter over the single runtimeFetch boundary below.
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { useNewSessionPreflightModelsState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState');
const { NewSessionEngineOptionDetail } = await import('@/components/sessions/new/components/NewSessionEngineOptionDetail');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const baseline = storage.getState();
let serverId: string;
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

function describeAgent(agentId: string) {
  return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
    projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
      installedPackagesById: {}, actionsById: {},   resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
      agentsById: { [agentId]: { id: agentId, identity: { pluginId: 'acme.voice', localId: 'agent' }, title: 'Acme Agent',
        connectedAccounts: [{ purpose: 'models', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, credentialKinds: ['oauth'] }] } },
    }),
  });
}

beforeEach(async () => {
  await homes.reset();
  // The loaded real Socket SDK retains this network factory. Reset its ports,
  // not its identity, so Action replies reach the current case's responder.
  network.resetRequests();
  serverId = await homes.addHome({ name: 'Inventory Home', serverUrl: 'https://inventory-actions.test', accountId: 'account-a' });
  await network.addHome('https://inventory-actions.test', 'account-a');
  const connectedAccountsV4 = [{
    ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'acct-work' },
    status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true,
    configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    displayName: 'Work account', scopes: [],
  }];
  // Connected Account inventory reads the captured Account's public profile,
  // not the focused UI store. Publish that same fact at its actual HTTP port.
  homes.answer(serverId, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: 'account-a', connectedAccountsV4 }) });
  homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
  homes.answer(serverId, CONNECTED_PRESENTATION_ROWS_ROUTE_V1, { body: { status: 'present', revision: 1,
    content: { t: 'plain', v: { v: 1, entries: [{ v: 1, subject: { kind: 'account', account: connectedAccountsV4[0]!.ref }, label: 'Work account' }] } } } });
  homes.answer(serverId, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, { body: { status: 'present', revision: 1,
    content: { t: 'plain', v: { v: 1, entries: [] } } } });
  // Home HTTP and Socket.IO are the genuine boundaries; all inventory,
  // projection parsing, capability probing and Action admission owners run.
  network.setHttpResponder(async (input, init) => {
    if (new URL(String(input)).pathname.startsWith('/v1/machines/')) return null;
    return homes.request(input, init);
  });
  accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://inventory-actions.test', accountId: 'account-a',
    request: network.request });
  // Retain the same captured saved-Home port after the Account bootstrap wrapper.
  (await import('@/utils/system/runtimeFetch')).setRuntimeFetch(network.request);
  clearDaemonMergedProjectionCacheForTests();
  const state = storage.getState();
  storage.setState({ settings: { ...state.settings, backendEnabledByTargetKey: {} },
    profile: { ...profileDefaults, ...state.profile, ...AccountProfileSchema.parse({ id: 'account-a', connectedAccountsV4 }) },
  });
});
afterEach(async () => {
  const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
  await serverScopedRpcSocketPool.stopAll();
  await accountConnection?.dispose();
  accountConnection = undefined;
  storage.setState(baseline, true);
  await standardCleanup();
});
afterAll(async () => { await network.dispose(); });

describe('defaultActionExecutor canonical agent inventory corridor', () => {
  it('lists connected services when its production callback is called without context', async () => {
    const source = ts.createSourceFile('defaultActionExecutor.ts', readFileSync(
      new URL('./defaultActionExecutor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const initializers: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'spawnConnectedServicesList') {
        initializers.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(initializers).toHaveLength(1);
    // Dispatch supplies context, so execute the exact private production callback
    // with its real inventory owner rather than adding an export or mocking dispatch.
    const { listSpawnConnectedServicesForActions } = await import('./agentInventoryActionDeps');
    // The VM is an untyped source-evaluation boundary; the production port owns its signature.
    const list = runInNewContext(`(${initializers[0]!.getText(source)})`, {
      listSpawnConnectedServicesForActions,
    }) as NonNullable<ActionExecutorDeps['spawnConnectedServicesList']>;
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, describeAgent('acme-voice-agent'));

    await expect(list({ agentId: 'acme-voice-agent', machineId: 'machine-1', serverId })).resolves.toMatchObject({
      agentId: 'acme-voice-agent', supportedServiceIds: ['happier.agent.codex/openai-codex'],
      items: [expect.objectContaining({ value: 'happier.agent.codex/openai-codex:profile:acct-work', label: 'Work account' })],
    });
  });

  it('consumes a slow native catalog after the probe budget without an earlier transport refusal', async () => {
    const agentId = 'acme-runtime-agent';
    const connectedServices = { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'acct-work' },
    } } as const;
    let entered = false;
    const release = createDeferred<void>();
    const observation = AgentModelsProbeObservationSchema.parse({ agentId, source: 'dynamic', supportsFreeform: false,
      availableModels: [{ id: 'native/gpt-6.1-sol', name: 'Sol' }] });
    network.setRpcResponder(async request => {
      if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return describeAgent(agentId);
      if (request.method !== RPC_METHODS.CAPABILITIES_INVOKE) throw new Error(`Unexpected method: ${request.method}`);
      const payload = request.payload as { id?: string; params?: { connectedServices?: unknown; timeoutMs?: number } };
      if (request.targetId !== 'machine-1' || payload.id !== `cli.${agentId}`
        || JSON.stringify(payload.params?.connectedServices) !== JSON.stringify(connectedServices)) {
        return { ok: true, result: AgentModelsProbeObservationSchema.parse({ agentId, source: 'unavailable', availableModels: [], supportsFreeform: false }) };
      }
      entered = true;
      await release.promise;
      return { ok: true, result: observation };
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const executor = createDefaultActionExecutor();
    const input = { agentId, machineId: 'machine-1', probe: { cwd: '/repo', connectedServices,
      timeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS, transportTimeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } };
    const pending = executor.execute('agents.models.list', input, { surface: 'ui', serverId });
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      // The daemon owns probe settlement (including credential materialization/cleanup).
      // Its answer must survive a caller clock that reaches the same budget first.
      await vi.advanceTimersByTimeAsync(NEW_SESSION_MODEL_PROBE_TIMEOUT_MS + 1);
      release.resolve();
      const result = await pending;
      expect(result).toMatchObject({ ok: true, result: {
        source: 'dynamic', probeObservation: observation, items: [{ modelId: 'native/gpt-6.1-sol', label: 'Sol' }],
      } });
      if (!result.ok || !result.result || typeof result.result !== 'object' || Array.isArray(result.result)) {
        throw new Error('Expected the admitted catalog result');
      }
      const consumed = AgentModelsProbeObservationSchema.parse((result.result as Record<string, unknown>).probeObservation);
      const { buildSessionModelPickerSections } = await import('@/components/sessions/modelPicker/buildSessionModelPickerSections');
      const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, agentTargetKey: 'agent:acme.voice/agent',
        nativeModels: consumed.availableModels.map(model => ({ value: model.id, label: model.name })),
        providerGroups: [], hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true });
      expect(sections.flatMap(section => section.options).map(option => option.value)).toContainEqual({
        agentTargetKey: 'agent:acme.voice/agent', providerConnectionId: null, modelId: 'native/gpt-6.1-sol',
      });
      let misboundSettled = false;
      const misbound = executor.execute('agents.models.list', { ...input, machineId: 'wrong-machine' }, { surface: 'ui', serverId })
        .finally(() => { misboundSettled = true; });
      await vi.waitFor(() => expect(misboundSettled).toBe(true));
      expect(await misbound).toMatchObject({ ok: true, result: { source: 'unavailable', items: [] } });
    } finally {
      release.resolve();
      await pending;
      vi.useRealTimers();
    }
  });
  it('discovers a role engine through its exact machine and connected default, matching Action model options', async () => {
    resetDynamicModelProbeCacheForTests();
    const { writeAgentConnectedAccountPurposeDefault } = await import('@happier-dev/protocol/account/settings/connected-services');
    const { applyAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
    const { RoleEngineField } = await import('@/components/roles/engine/RoleEngineField');
    const identity = { pluginId: 'happier.agent.codex', localId: 'codex' } as const;
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
    const described = describeAgent('codex');
    described.projection.agentsById.codex!.identity = identity;
    described.projection.agentsById.codex!.title = 'Codex';
    const declarations = [{ purpose: 'primary', service }] as const;
    described.projection.agentsById.codex!.connectedAccounts = [...declarations];
    const settings = storage.getState().settings;
    const written = writeAgentConnectedAccountPurposeDefault({ settings,
      agentId: 'codex', consumer: identity, purpose: 'primary', declarations,
      target: { kind: 'account', account: { service, accountId: 'acct-work' } },
    });
    homes.answer(serverId, `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, { body: { status: 'present', revision: 1,
      content: { t: 'plain', v: { key: 'purposes', value: written.connectedAccountPurposeBindingsV1 } } } });
    applyAcpCatalogSnapshot({ serverId, accountId: 'account-a' }, { status: 'ready', revision: 1,
      record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [] }) }, true);
    const connectedServices = { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
      source: 'connected', selection: 'profile', profileId: 'acct-work' } } } as const;
    const observation = AgentModelsProbeObservationSchema.parse({ agentId: 'codex', source: 'dynamic', supportsFreeform: false,
      availableModels: [{ id: 'gpt-6.1-sol', name: 'Sol', modelOptions: [{ id: 'reasoning_effort', name: 'Reasoning',
        type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] }] });
    network.setRpcResponder(async request => {
      if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return described;
      if (request.method !== RPC_METHODS.CAPABILITIES_INVOKE) throw new Error(`Unexpected method: ${request.method}`);
      const payload = request.payload as { method: string; params?: { connectedServices?: unknown; cwd?: string } };
      const exact = request.targetId === 'role-machine' && payload.params?.cwd === '/role-repo'
        && JSON.stringify(payload.params?.connectedServices) === JSON.stringify(connectedServices);
      return { ok: true, result: payload.method === 'probeConfigOptions' ? { configOptions: [] }
        : payload.method === 'probeModes' ? { availableModes: [] }
        : { ...observation, availableModels: exact ? observation.availableModels : [] } };
    });
    const screen = await renderScreen(React.createElement(RoleEngineField, { engine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
      label: 'Codex', testID: 'role-engine', machineId: 'role-machine', directory: '/role-repo', onChange() {} }));
    await screen.pressByTestIdAsync('role-engine');
    const readDetail = (): { props: NewSessionEngineOptionDetailProps } => screen.tree.root.findByType(NewSessionEngineOptionDetail);
    await vi.waitFor(() => expect(readDetail().props.capabilityProbeContext?.capabilityParams).toMatchObject({ connectedServices }));
    const detail = readDetail();
    const models = await renderHook(() => useNewSessionPreflightModelsState({ backendTarget: { kind: 'backend', backendId: 'codex' },
      runtimeCarrierAgentId: 'codex', selectedMachineId: detail.props.selectedMachineId,
      capabilityServerId: detail.props.capabilityServerId, cwd: detail.props.cwd, probeContext: detail.props.capabilityProbeContext }));
    try {
      await vi.waitFor(() => expect(models.getCurrent().modelOptions.map(option => option.value), JSON.stringify(network.requests.map(
        ({ targetId, method, payload }) => ({ targetId, method, payload })))).toContain('gpt-6.1-sol'));
      expect(models.getCurrent().modelOptions.find(option => option.value === 'gpt-6.1-sol')?.modelOptions)
        .toMatchObject([{ id: 'reasoning_effort', options: [{ value: 'low' }, { value: 'high' }] }]);
      const result = await createDefaultActionExecutor().execute('action.options.resolve', { optionsSourceId: 'agents.models.available',
        draftInput: { agentId: 'codex', machineId: 'role-machine', probe: { cwd: '/role-repo', connectedServices } } }, { surface: 'ui', serverId });
      expect(result).toMatchObject({ ok: true, result: { options: [{ value: 'gpt-6.1-sol', label: 'Sol' }] } });
      const { beginConnectedAccountCatalogLoad, applyConnectedAccountCatalogSnapshot } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
      await act(async () => beginConnectedAccountCatalogLoad({ serverId, accountId: 'account-a' }, 'purposes'));
      expect(readDetail().props.selectedMachineId).toBeNull();
      await act(async () => applyConnectedAccountCatalogSnapshot({ serverId, accountId: 'account-a' }, 'purposes', {
        status: 'ready', revision: 2, record: { key: 'purposes', value: { v: 1, bindings: [] } },
      }, true));
      expect(readDetail().props.selectedMachineId).toBe('role-machine');
      expect(readDetail().props.capabilityProbeContext?.capabilityParams).not.toHaveProperty('connectedServices');
    } finally { await models.unmount(); }
  });
  it('uses the same configured native catalog for direct and spawn options and refuses a foreign definition', async () => {
    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'own-acp' } as const;
    const backendTargetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:own-acp';
    const described = describeAgent('custom-acp');
    described.projection.agentsById['custom-acp'] = { id: 'custom-acp', identity: agentTarget.identity,
      title: 'Configured ACP', connectedAccounts: [], providerOwnedEnvironmentKeys: [] };
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, described);
    homes.answer(serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: { status: 'present', revision: 1, content: { t: 'plain', v:
      AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'own-acp', name: 'own-acp', title: 'Own ACP',
        launch: { kind: 'command', command: 'native-acp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] }) } } });
    const nativeObservation = AgentModelsProbeObservationSchema.parse({ agentId: 'custom-acp', source: 'dynamic',
      supportsFreeform: false, availableModels: [{ id: 'default', name: 'Default' }, { id: 'native/catalog-model', name: 'Native model' }] });
    network.respond(RPC_METHODS.CAPABILITIES_INVOKE, { ok: true, result: nativeObservation });
    const executor = createDefaultActionExecutor();
    const expected = nativeObservation.availableModels.map(model => ({ value: model.id, label: model.name }));
    const direct = await executor.execute('action.options.resolve', { optionsSourceId: 'agents.models.available',
      draftInput: { backendTargetKey, machineId: 'machine-1', probe: { cwd: '/repo' } } }, { surface: 'ui', serverId });
    expect(direct).toMatchObject({ ok: true, result: { options: expected } });
    const spawn = { actionId: 'session.spawn_new', fieldPath: 'modelSelection', agentTarget,
      executionTarget: { serverId, machineId: 'machine-1' }, directory: { kind: 'path', path: '/repo' } };
    expect(await executor.execute('action.options.resolve', spawn, { surface: 'ui', serverId }))
      .toMatchObject({ ok: true, result: { options: expected } });
    expect(await executor.execute('action.options.resolve', { ...spawn, agentTarget: { ...agentTarget, definitionId: 'foreign-acp' } },
      { surface: 'ui', serverId })).toMatchObject({ ok: true, result: { options: [] } });
  });

  it.each(['opencode', 'external'] as const)('keeps the draft binding in %s picker discovery and search without borrowing it after clearing', async kind => {
    resetDynamicModelProbeCacheForTests();
    const agentId = kind === 'opencode' ? 'opencode' : 'acme-runtime-agent';
    const identity = kind === 'opencode' ? { pluginId: 'happier.agent.opencode', localId: 'opencode' }
      : { pluginId: 'acme.voice', localId: 'agent' };
    const key = `agent:${identity.pluginId}/${identity.localId}`;
    const connectedServices = { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
      source: 'connected', selection: 'profile', profileId: 'acct-work' } } } as const;
    const described = describeAgent(agentId);
    described.projection.agentsById[agentId]!.identity = identity;
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, described);
    // Native catalog output crosses the real Socket/Action/discovery owners.
    // The daemon boundary distinguishes explicit draft auth from saved or absent auth.
    network.setRpcResponder(async request => {
      if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return described;
      if (request.method !== RPC_METHODS.CAPABILITIES_INVOKE) throw new Error(`Unexpected method: ${request.method}`);
      const payload = request.payload as { params?: { connectedServices?: unknown } };
      const selected = JSON.stringify(payload.params?.connectedServices) === JSON.stringify(connectedServices);
      return { ok: true, result: AgentModelsProbeObservationSchema.parse({ agentId, source: 'dynamic', supportsFreeform: false,
        availableModels: [{ id: selected ? 'native/gpt-6.1-sol' : 'native/other-account', name: selected ? 'GPT-6.1-Sol' : 'Other account' }] }) };
    });
    const entry: ResolvedBackendCatalogEntry = { agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId,
      overrides: { identity, connectedAccounts: described.projection.agentsById[agentId]!.connectedAccounts } }),
      backendTarget: { kind: 'backend', backendId: agentId }, backendTargetKey: key, kind: kind === 'opencode' ? 'builtInAgent' : 'pluginBackend',
      backendId: agentId, agentId, catalogAgentId: kind === 'opencode' ? 'opencode' : null, builtInAgentId: null,
      iconAgentId: null, title: agentId, subtitle: null, cliAuthBackgroundCheckSafe: false };
    const { useNewSessionAgentPickerControls } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionAgentPickerControls');
    const { buildSessionAgentPickerDetailContent } = await import('@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent');
    const { resolveNewSessionOperationalBackendTarget } = await import('@/components/sessions/new/modules/newSessionCapabilityProbeContext');
    const { buildSessionModelPickerSections } = await import('@/components/sessions/modelPicker/buildSessionModelPickerSections');
    const { filterSelectionListSections } = await import('@/components/ui/selectionList');
    const { sessionModelSelectionKey } = await import('@/components/sessions/modelPicker/sessionModelSelectionKey');
    const initialPickerProps: { binding: ConnectedServiceBindingsV2 | null } = { binding: connectedServices };
    const picker = await renderHook((props: { binding: ConnectedServiceBindingsV2 | null }) => useNewSessionAgentPickerControls({
      useProfiles: false, selectedProfileId: null, profileMap: new Map(), resolvedBackendEntries: [entry,
        { ...entry, backendTargetKey: 'agent:other.agent/agent', agentId: 'other.agent/agent' }],
      getCompatibleProfileBackendEntries: () => [], isBackendEntrySelectable: () => true, selectedBackendEntry: entry,
      selectedBackendTargetKey: key, setBackendTarget: () => {}, modelMode: 'default', setModelMode: () => {},
      acpSessionModeId: null, setAcpSessionModeId: () => {}, sessionConfigOptionOverrides: null, setSessionConfigOptionOverrides: () => {},
      selectedMachineId: 'machine-1', capabilityServerId: serverId, projectionCurrent: true, selectedPath: '/repo',
      readSettings: () => storage.getState().settings, selectedConnectedServices: props.binding,
    }), { initialProps: initialPickerProps });
    const readDetail = () => {
      const option = picker.getCurrent().agentPickerOptions?.find(option => option.id === key);
      const detail = option?.renderDetailContent?.({ onRequestClose() {} });
      if (!React.isValidElement<Parameters<typeof buildSessionAgentPickerDetailContent>[0]>(detail)) throw new Error('Missing picker detail');
      return buildSessionAgentPickerDetailContent({ ...detail.props, settings: storage.getState().settings });
    };
    const detailScreen = await renderScreen(readDetail());
    const readEngine = (): { props: NewSessionEngineOptionDetailProps } => detailScreen.tree.root.findByType(NewSessionEngineOptionDetail);
    const models = await renderHook((props: { detail: ReturnType<typeof readEngine> }) => useNewSessionPreflightModelsState({
      backendTarget: resolveNewSessionOperationalBackendTarget(props.detail.props), runtimeCarrierAgentId: agentId,
      selectedMachineId: 'machine-1', capabilityServerId: serverId, cwd: '/repo', probeContext: props.detail.props.capabilityProbeContext,
    }), { initialProps: { detail: readEngine() } });
    try {
      await flushHookEffects();
      expect(models.getCurrent().modelOptions.map(model => model.value)).toContain('native/gpt-6.1-sol');
      const sections = buildSessionModelPickerSections({ declarationContext: { kind: 'account' }, agentTargetKey: key, nativeModels: models.getCurrent().modelOptions,
        providerGroups: [], hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true });
      const searchable = sections.map(section => ({ kind: 'static' as const, id: section.id,
        options: section.options.map(option => ({ id: sessionModelSelectionKey(option.value), label: option.label,
          subtitle: option.description, onPress() {} })) }));
      expect(filterSelectionListSections(searchable, 'gpt-6.1-sol').flatMap(section => section.kind === 'static' ? section.options : []).map(option => option.id))
        .toContain(sessionModelSelectionKey({ agentTargetKey: key, providerConnectionId: null, modelId: 'native/gpt-6.1-sol' }));
      await picker.rerender({ binding: null });
      await detailScreen.update(readDetail());
      await models.rerender({ detail: readEngine() });
      await flushHookEffects();
      expect(models.getCurrent().modelOptions.map(model => model.value)).not.toContain('native/gpt-6.1-sol');
      expect(models.getCurrent().modelOptions.map(model => model.value)).toContain('native/other-account');
    } finally { await models.unmount(); await picker.unmount(); }
  });

  it('resolves native model choices from the selected account through the real option-source and probe transport', async () => {
    const agentId = 'acme-runtime-agent';
    const connectedServices = { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'acct-work' },
    } } as const;
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, describeAgent(agentId));
    network.respond(RPC_METHODS.CAPABILITIES_INVOKE, { ok: true, result: AgentModelsProbeObservationSchema.parse({
      availableModels: [{ id: 'selected-account/model', name: 'Selected account model' }],
      supportsFreeform: false, source: 'dynamic',
    }) });
    const executor = createDefaultActionExecutor();
    const request = { actionId: 'session.spawn_new', fieldPath: 'modelSelection', optionsSourceId: 'agents.models.available',
      executionTarget: { serverId, machineId: 'machine-1' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.voice', localId: 'agent' } },
      directory: { kind: 'path', path: '/repo' }, profileId: 'launch-work', connectedServices,
    };
    const result = await executor.execute('action.options.resolve', request, { surface: 'ui', serverId });
    expect(result).toMatchObject({ ok: true, result: { options: [{ value: 'selected-account/model', label: 'Selected account model' }] } });
    expect(network.requests).toContainEqual(expect.objectContaining({ targetId: 'machine-1',
      method: RPC_METHODS.CAPABILITIES_INVOKE, payload: expect.objectContaining({ id: `cli.${agentId}`, method: 'probeModels',
        params: expect.objectContaining({ cwd: '/repo', profileId: 'launch-work', connectedServices }) }) }));
    // A different declaration cannot borrow this Agent's catalog via its runtime id.
    const misbound = await executor.execute('action.options.resolve', { ...request,
      agentTarget: { kind: 'agent', identity: { pluginId: 'uninstalled.agent', localId: 'agent' } },
    }, { surface: 'ui', serverId });
    expect(misbound).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('does not offer bundled connected accounts when the machine declares no purposes', async () => {
    const described = describeAgent('codex');
    described.projection.agentsById.codex = {
      id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, title: 'Codex', connectedAccounts: [], providerOwnedEnvironmentKeys: [],
    };
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, described);
    expect(await createDefaultActionExecutor().execute('sessions.spawn.connected_services.list',
      { agentId: 'codex', machineId: 'machine-1' }, { surface: 'ui', serverId })).toMatchObject({
      ok: true, result: { agentId: 'codex', supportedServiceIds: [], items: [] },
    });
  });

  it('reports no connected bindings for a configured ACP target through discovery and spawn options', async () => {
    const target = { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
      definitionId: 'qa-fix48-acp' } as const;
    const backendTargetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:qa-fix48-acp';
    const described = describeAgent('custom-acp');
    described.projection.agentsById['custom-acp'] = {
      id: 'custom-acp', identity: target.identity, title: 'Custom ACP', connectedAccounts: [], providerOwnedEnvironmentKeys: [],
    };
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, described);
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('sessions.spawn.connected_services.list',
      { backendTargetKey, machineId: 'machine-1' }, { surface: 'ui', serverId })).toMatchObject({
      ok: true, result: { agentId: 'custom-acp', supportedServiceIds: [], items: [] },
    });
    expect(await executor.execute('action.options.resolve', {
      actionId: 'session.spawn_new', fieldPath: 'connectedServices', optionsSourceId: 'sessions.spawn.connected_services.available',
      executionTarget: { serverId, machineId: 'machine-1' }, agentTarget: target,
    }, { surface: 'ui', serverId })).toMatchObject({ ok: true, result: { options: [] } });
  });

  it('carries typed model launch failures through the runner hook, Action and cache, retaining last-good data and clearing recovered diagnostics', async () => {
    resetDynamicModelProbeCacheForTests();
    const spawnFailure = { reason: 'other', errno: 'ENOENT' } as const;
    const respond = (result: unknown) => network.respond(RPC_METHODS.CAPABILITIES_INVOKE,
      { ok: true, result: AgentModelsProbeObservationSchema.parse(result) });
    respond({ availableModels: [], supportsFreeform: false, source: 'unavailable', refreshError: true, spawnFailure });
    const render = (enabled = true) => renderHook((props: { enabled: boolean; cwd: string }) => useNewSessionPreflightModelsState({
      backendTarget: { kind: 'backend', backendId: 'acme-voice-agent' }, runtimeCarrierAgentId: 'acme-voice-agent',
      selectedMachineId: 'machine-1', capabilityServerId: serverId, cwd: props.cwd, enabled: props.enabled,
    }), { initialProps: { enabled, cwd: '/repo' } });
    const hook = await render();
    try {
      await vi.waitFor(() => expect(hook.getCurrent().probe).toMatchObject({ failed: true, refreshedAt: null, spawnFailure }));
      expect(hook.getCurrent().preflightModels?.unavailable).toBe(true);
      const cached = await render(false);
      try { expect(cached.getCurrent().probe).toMatchObject({ failed: true, spawnFailure }); }
      finally { await cached.unmount(); }

      respond({ availableModels: [{ id: 'live-model', name: 'Live model' }], supportsFreeform: false,
        source: 'dynamic', refreshError: false, observedAt: Date.now() });
      await act(async () => { hook.getCurrent().probe.onRefresh?.(); });
      await vi.waitFor(() => expect(hook.getCurrent().probe.failed).toBe(false));
      expect(hook.getCurrent().probe.spawnFailure).toBeNull();
      const observedAt = hook.getCurrent().probe.refreshedAt;
      const previous = hook.getCurrent().preflightModels;
      expect(previous?.availableModels.map(model => model.id)).toEqual(['live-model']);

      respond({ availableModels: [], supportsFreeform: false, source: 'dynamic', refreshError: false, spawnFailure });
      await act(async () => { hook.getCurrent().probe.onRefresh?.(); });
      await vi.waitFor(() => expect(hook.getCurrent().probe).toMatchObject({ failed: true, refreshedAt: observedAt, spawnFailure }));
      expect(hook.getCurrent().preflightModels).toBe(previous);
      await hook.rerender({ enabled: false, cwd: '/other' });
      expect(hook.getCurrent().probe.spawnFailure).toBeNull();
      expect(hook.getCurrent().preflightModels).toBeNull();
    } finally { await hook.unmount(); }
  });

  it('answers sessions.spawn.connected_services.list for a novel external qualified Agent instead of unsupported_action', async () => {
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, describeAgent('acme-voice-agent'));
    const res = await createDefaultActionExecutor().execute('sessions.spawn.connected_services.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' }, { surface: 'voice', serverId });
    expect(res).toMatchObject({ ok: true, result: { agentId: 'acme-voice-agent', supportedServiceIds: ['happier.agent.codex/openai-codex'],
      items: [expect.objectContaining({ value: 'happier.agent.codex/openai-codex:profile:acct-work', label: 'Work account' })] } });
    expect(network.requests).toContainEqual(expect.objectContaining({ serverUrl: 'https://inventory-actions.test', targetId: 'machine-1',
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE }));
  });

  it('answers agents.session_modes.list by probing the selected machine instead of unsupported_action', async () => {
    network.respond(RPC_METHODS.CAPABILITIES_INVOKE, { ok: true, result: { agentId: 'acme-voice-agent',
      availableModes: [{ id: 'build', name: 'Build', description: 'Full access' }, { id: 'plan', name: 'Plan' }], source: 'dynamic' } });
    const res = await createDefaultActionExecutor().execute('agents.session_modes.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' }, { surface: 'voice', serverId });
    expect(res).toEqual({ ok: true, result: { agentId: 'acme-voice-agent',
      items: [{ id: 'build', label: 'Build', description: 'Full access' }, { id: 'plan', label: 'Plan' }], source: 'dynamic' } });
    expect(network.requests).toContainEqual(expect.objectContaining({ serverUrl: 'https://inventory-actions.test', targetId: 'machine-1',
      method: RPC_METHODS.CAPABILITIES_INVOKE, payload: expect.objectContaining({ method: 'probeModes' }) }));
  });

  it('answers agents.config_options.list with the selected external Agent model’s declarations', async () => {
    const effort = (values: string[]) => ({ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'private-current',
      options: values.map(value => ({ value, name: value })) });
    network.setRpcResponder(async request => {
      if (request.method !== RPC_METHODS.CAPABILITIES_INVOKE || request.targetId !== 'machine-1') throw new Error('Unexpected inventory transport');
      const payload = request.payload as { method: string };
      return { ok: true, result: payload.method === 'probeConfigOptions'
        ? { agentId: 'acme-voice-agent', source: 'dynamic', configOptions: [effort(['session-only']),
          { id: 'format', name: 'Format', type: 'select', currentValue: 'private-format', options: [{ value: 'text', name: 'Text' }] }] }
        : AgentModelsProbeObservationSchema.parse({ agentId: 'acme-voice-agent', source: 'dynamic', supportsFreeform: false,
          availableModels: [{ id: 'small', name: 'Small', modelOptions: [effort(['low', 'high'])] },
            { id: 'large', name: 'Large', modelOptions: [effort(['medium', 'ultra'])] }] }) };
    });
    const executor = createDefaultActionExecutor();
    const input = { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' };
    for (const [modelId, choices] of [['small', ['low', 'high']], ['large', ['medium', 'ultra']]] as const) {
      const result = await executor.execute('agents.config_options.list', { ...input, modelId }, { surface: 'voice', serverId });
      expect(result).toMatchObject({ ok: true, result: { items: [
        { id: 'reasoning_effort', options: choices.map(value => ({ value })) }, { id: 'format', options: [{ value: 'text' }] },
      ] } });
      expect(JSON.stringify(result)).not.toContain('private-');
    }
    const options = await executor.execute('action.options.resolve', { actionId: 'execution.run.start', fieldPath: 'configOptions',
      draftInput: { ...input, modelId: 'small' } }, { surface: 'voice', serverId });
    expect(options).toMatchObject({ ok: true, result: { options: [{ value: 'reasoning_effort' }, { value: 'format' }] } });
  });

  it('resolves the connected-services options source through the same canonical action options owner', async () => {
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, describeAgent('acme-runtime-agent'));
    const res = await createDefaultActionExecutor().execute('action.options.resolve', {
      actionId: 'session.spawn_new', fieldPath: 'connectedServices', optionsSourceId: 'sessions.spawn.connected_services.available',
      executionTarget: { serverId, machineId: 'machine-1' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.voice', localId: 'agent' } },
    }, { surface: 'voice', serverId });
    expect(res).toMatchObject({ ok: true, result: { options: [expect.objectContaining({ value: 'happier.agent.codex/openai-codex:profile:acct-work' })] } });
    expect(network.requests).toContainEqual(expect.objectContaining({ serverUrl: 'https://inventory-actions.test', targetId: 'machine-1',
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE }));
  });
});
