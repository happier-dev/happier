import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Use the real reachability adapter over the single runtimeFetch boundary below.
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const baseline = storage.getState();
let serverId: string;
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

function describeAgent(agentId: string) {
  return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
    projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
      installedPackagesById: {}, actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
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
  storage.setState({ settings: { ...state.settings, acpCatalogSettingsV1: { v: 2, backends: [] }, backendEnabledByTargetKey: {} },
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

  it('answers agents.config_options.list by probing the selected machine instead of unsupported_action', async () => {
    network.respond(RPC_METHODS.CAPABILITIES_INVOKE, { ok: true, result: { agentId: 'acme-voice-agent', configOptions: [{
      id: 'reasoning-effort', name: 'Reasoning effort', type: 'select', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High', description: 'Slower' }],
    }], source: 'dynamic' } });
    const res = await createDefaultActionExecutor().execute('agents.config_options.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' }, { surface: 'voice', serverId });
    expect(res).toEqual({ ok: true, result: { agentId: 'acme-voice-agent', items: [{ id: 'reasoning-effort', label: 'Reasoning effort', type: 'select',
      options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High', description: 'Slower' }], }], source: 'dynamic' } });
    expect(network.requests).toContainEqual(expect.objectContaining({ serverUrl: 'https://inventory-actions.test', targetId: 'machine-1',
      method: RPC_METHODS.CAPABILITIES_INVOKE, payload: expect.objectContaining({ method: 'probeConfigOptions' }) }));
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
