import '../../../../ui/sources/dev/vitestSetup';
import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { voiceAgentCatalogSelectionValueV1 } from '@happier-dev/protocol/voice/settings/voiceAgentSelection';
import { listSelectableBundledAgentExecutionTargets } from '@happier-dev/agents/definitions';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createClientActionReverseDispatcher } from './clientActionReverseDispatch';
import { createMachineFixture, createPlainMachineRowFixture, createPlainMachineReadHttpResponseFixture } from '../../../../ui/sources/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '../../../../ui/sources/dev/testkit/cleanup/standardCleanup';

vi.mock('socket.io-client', async original =>
  (await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('../../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
const machineRpc = vi.hoisted(() => vi.fn());
// The daemon network transport is the boundary; catalog, parsing, selection and mutation stay real.
vi.mock('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async original => ({
  ...await original<typeof import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')>(),
  machineRpcWithServerScope: machineRpc,
}));
const { createVoiceSettingsAccountTestHarness } = await import('../../../../ui/sources/voice/settings/panels/voiceSettingsAccountTestHarness');
const { settingsParse } = await import('../../../../ui/sources/sync/domains/settings/settings');
const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
const { createUiClientActionReverseHandler } = await import('../../../../ui/sources/sync/ops/actions/clientActionReverseDispatch');
const { captureLazyActionAccountContext } = await import('../../../../ui/sources/sync/ops/actions/actionAccountContext');
const { resolveVoiceExecutionMachineIdFromState } = await import('../../../../ui/sources/voice/settings/executionMachine');
const { recordMachineRequestSucceeded } = await import('../../../../ui/sources/sync/domains/machines/reachability/machineReachability');
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } = await import('../../../../ui/sources/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { DAEMON_AGENT_CATALOG_SECTIONS } = await import('../../../../ui/sources/agents/backendCatalog/agentCatalogSections');
const { getEnabledAgentIds } = await import('../../../../ui/sources/agents/catalog/enabled');
const { getResolvedBackendCatalogEntries } = await import('../../../../ui/sources/agents/backendCatalog/getResolvedBackendCatalogEntries');

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); machineRpc.mockReset(); clearDaemonMergedProjectionCacheForTests(); resetInMemoryAccountSettingsContextForTests(); });

describe('public CLI Settings Action and answering Voice client parity', () => {
  it.each(['ready', 'unavailable'] as const)('saves every bundled and installed picker choice on the automatic computer while ACP is %s', async acpStatus => {
    const account = await createVoiceSettingsAccountTestHarness(settingsParse({
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'settings.set': ['cli'] } },
      voice: { providerId: 'local_conversation' }, favoriteMachines: ['neighbor'],
    }), { mode: 'plain' });
    onTestFinished(account.dispose);
    const machine = createMachineFixture({ id: 'voice-picker-machine', activeAt: Date.now() });
    const request = account.request.getMockImplementation()!;
    account.request.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === ACP_CATALOG_ROWS_ROUTE_V1) return acpStatus === 'ready'
        ? Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } })
        : Response.json({ error: 'unavailable' }, { status: 503 });
      if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: machine.id, accountId: account.scope.accountId, machine })]);
      return createPlainMachineReadHttpResponseFixture(path, init, account.scope.accountId) ?? request(input, init);
    });
    // Both public hosts read the same synthetic Home through their real HTTP adapters.
    const forwardHeaders = (raw: Parameters<typeof AxiosHeaders.from>[0]) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(AxiosHeaders.from(raw).toJSON())) {
        if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
      }
      return headers;
    };
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const response = await account.request(String(url), { method: 'GET', headers: forwardHeaders(config?.headers) });
      return { status: response.status, data: await response.json() };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const response = await account.request(String(url), { method: 'POST', headers: forwardHeaders(config?.headers), body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    });
    storage.getState().applyMachines([machine], true, { sourceServerId: account.scope.serverId });
    recordMachineRequestSucceeded({ ...account.scope, machineId: machine.id });
    expect(resolveVoiceExecutionMachineIdFromState(storage.getState())).toBe(machine.id);
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projectionDigest: '7'.repeat(64), projection: { v: 2, generation: 7, agentsById: {
        ...Object.fromEntries(listSelectableBundledAgentExecutionTargets().map(({ agentId, target }) => [agentId,
          { id: agentId, identity: target.identity, title: agentId, isBuiltIn: true }])),
        'acme.review': { id: 'acme.review', identity: { pluginId: 'acme.review', localId: 'review' }, title: 'Acme Review', isBuiltIn: false, channel: 'plugin' },
      }, installedPackagesById: {}, actionsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] } });
    machineRpc.mockImplementation(async ({ method, machineId }) => {
      expect(method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
      expect(machineId).toBe(machine.id);
      return projection;
    });
    const captured = await captureLazyActionAccountContext(account.scope.serverId);
    onTestFinished(captured.dispose);
    const catalog = await loadDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: account.scope.serverId,
      accountLifetime: captured.accountLifetime, sections: DAEMON_AGENT_CATALOG_SECTIONS, reuseFreshReady: true });
    expect(catalog?.kind).toBe('ready');
    if (catalog?.kind !== 'ready') throw new Error('Expected the selected computer catalog');
    const choices = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds(account.settings),
      backendEnabledByTargetKey: account.settings.backendEnabledByTargetKey, ...catalog.inputs,
    }).map(entry => voiceAgentCatalogSelectionValueV1(entry.agentCatalogEntry));
    expect(choices).toContain('agent:happier.agent.claude/claude');
    expect(choices).toContain('agent:acme.review/review');
    const receive = createUiClientActionReverseHandler({ serverId: account.scope.serverId, accountId: account.scope.accountId,
      isCurrent: () => captured.accountLifetime.isCurrent() });
    let clientDeliveries = 0;
    const executor = createCliActionExecutor({ token: account.credentials.token, credentials: { token: account.credentials.token, encryption: null },
      mode: 'plain', ctx: null, sessionId: 'voice-parity', serverId: account.scope.serverId,
      serverHttpBaseUrl: captured.endpointUrl,
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: account.settings }),
      clientActionExecute: createClientActionReverseDispatcher(() => ({ hasConnectedClientRpcHandler: () => true,
        callConnectedClientRpc: async (_method, payload, options) => {
          clientDeliveries += 1;
          options.onIssued();
          return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
        },
      })),
    });
    const context = { surface: 'cli' as const, authority: 'account_automation' as const };
    for (const value of choices) {
      expect(resolveVoiceExecutionMachineIdFromState(storage.getState())).toBe(machine.id);
      const writes = account.writes.length;
      const deliveries = clientDeliveries;
      const result = await executor.execute('settings.set', { anchor: 'voiceConversations.agent', value }, context);
      expect(clientDeliveries - deliveries).toBe(1);
      expect(result, JSON.stringify({ value, result })).toMatchObject({ ok: true, result: { value } });
      expect(account.writes).toHaveLength(writes + 1);
      expect(await executor.execute('settings.get', { anchor: 'voiceConversations.agent' }, context))
        .toMatchObject({ ok: true, result: { value } });
      expect(clientDeliveries - deliveries).toBe(1);
    }
    const writes = account.writes.length;
    expect(await executor.execute('settings.set', { anchor: 'voiceConversations.agent', value: 'agent:acme.missing/missing' }, context))
      .toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
    expect(account.writes).toHaveLength(writes);
    expect(account.persistedSettings.favoriteMachines).toEqual(['neighbor']);
    expect(machineRpc).toHaveBeenCalledTimes(1);
  });
});
