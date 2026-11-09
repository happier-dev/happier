import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 as service, MCP_OAUTH_CALLBACK_URL_V1 as callbackUrl } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), params: {} as Record<string, string> }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => boundary.params }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The daemon transport is the boundary; mounted Action admission, status and editors stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(boundary.rpc));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
const { Modal } = await import('@/modal');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { McpServerDetailPage } = await import('./McpServerDetailPage');
const { ValueRefEditorModal } = await import('@/components/ui/forms/valueRefs/ValueRefEditorModal');
const { McpServerWhereAndTools } = await import('./McpServerDetailBody');
const { McpSignInSection } = await import('../signIn/McpSignInSection');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { McpServerEditorScreen } = await import('../McpServerEditorScreen');
const { McpServerCatalogRowMutationV1Schema } = await import('@happier-dev/protocol/mcp/servers/serverRowsV1');
const { Dimensions } = await import('react-native');
const { resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');

const base = McpServerCatalogEntryV1Schema.parse({ id: 'linear', name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {} } });
const unavailable = { resolveReference: (ref: string) => resolveSavedSecretReference(null, [], ref) };
let catalogServer = base;
let catalogRevision = 1;
let catalogBindings: readonly import('@happier-dev/protocol/mcp/servers/settingsV1').McpServerRuleV1[] = [];
let disposeActionLoader: (() => void) | undefined;
let restoreAppliedRuntime: (() => void) | undefined;

async function page(server = base) {
  catalogServer = server;
  let draft = server;
  const commit = vi.fn();
  const tree = await renderScreen(<McpServerDetailPage server={server} draftServer={draft} catalogRevision={null} secrets={[]} secretAvailability={unavailable}
    scope={getStorage().getState().settingsScope} configurationSaveState="idle" onCommitConfiguration={commit} onRemove={() => {}} onDuplicate={() => {}} approvalNotice={null}
    onChangeServer={updater => { draft = updater(draft); }} />);
  return { tree, commit, draft: () => draft };
}
beforeEach(async () => {
  await harness.reset();
  // Each HTTP fixture starts a new catalog; a previous acknowledged revision must not leak into it.
  resetMcpServerCatalogEngineForTests();
  resetMcpServerCatalogSnapshotsForTests();
  const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
  resetScopedHomeActionExecutorsForTests();
  disposeActionLoader = await installRealActionExecutorModuleLoader();
  boundary.rpc.mockReset();
  boundary.params = {};
  catalogBindings = [];
  catalogRevision = 1;
  vi.mocked(Modal.show).mockClear();
  const serverId = await harness.addHome({ name: 'MCP recovery', serverUrl: 'https://mcp-detail-recovery.test',
    serverIdentityId: 'srv_mcp_detail_recovery', accountId: 'owner', currentAccount: true });
  const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
  const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
  const machine = createMachineFixture({ id: 'mcp-machine', activeAt: Date.now(),
    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
  const state = getStorage().getState();
  getStorage().setState({ settingsScope: scope, profileScope: scope, isDataReady: true,
    settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: {
      'mcp.servers.signIn.start': ['ui'], 'mcp.servers.test': ['ui'], 'mcp.servers.update': ['ui'],
    } }) } });
  harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
    actionsSettingsV1: getStorage().getState().settings.actionsSettingsV1,
  } }, version: 0 } });
  getStorage().getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  observeMachinePresenceForTest(scope, [machine.id]);
  expect(getStorage().getState().machineDisplayById[machine.id]?.id).toBe(machine.id);
  harness.answer(serverId, '/v1/account/entity-rows/mcp', { select: () => ({ body: {
    status: 'present', revision: catalogRevision, content: { t: 'plain', v: { v: 1, servers: [catalogServer], bindings: catalogBindings } },
  } }) });
});
afterEach(async () => {
  await standardCleanup();
  restoreAppliedRuntime?.();
  restoreAppliedRuntime = undefined;
  disposeActionLoader?.();
  disposeActionLoader = undefined;
});

describe('saved MCP detail recovery wiring', () => {
  it('keeps the saved editor draft and all management controls through narrow/wide updates, then saves the same draft', async () => {
    boundary.params = { serverId: base.id };
    catalogServer = McpServerCatalogEntryV1Schema.parse({ ...base, transport: 'stdio', remote: undefined,
      stdio: { command: 'old-command', args: ['--serve'] } });
    const scope = getStorage().getState().settingsScope!;
    let writes = 0;
    harness.answer(scope.serverId, 'POST /v1/account/entity-rows/mcp', { select: input => {
      const mutation = McpServerCatalogRowMutationV1Schema.parse(input);
      if (!mutation.content || mutation.content.t !== 'plain') throw new Error('Plain fixture received no plain content');
      catalogServer = McpServerCatalogEntryV1Schema.parse(mutation.content.v.servers[0]);
      writes += 1;
      catalogRevision += 1;
      return { body: { status: 'updated', revision: catalogRevision, cursor: catalogRevision } };
    } });
    const current = await renderScreen(<McpServerEditorScreen />);
    await waitForHomeGovernance(() => expect(current.findAllByType(FieldTextInput)
      .find(field => field.props.testID === 'mcp.server.editor.command')?.props.value).toBe('old-command'));
    const command = () => current.findAllByType(FieldTextInput).find(field => field.props.testID === 'mcp.server.editor.command')!;
    await act(async () => { command().props.onChangeText('my-unsaved-command'); });
    expect(writes).toBe(0);
    const windowSize = Dimensions.get('window');
    const dimensions = vi.spyOn(Dimensions, 'get');
    try {
      for (const width of [390, 1440]) {
        dimensions.mockReturnValue({ ...windowSize, width });
        await current.update(<McpServerEditorScreen />);
        expect(command().props.value).toBe('my-unsaved-command');
        expect(current.findByType(McpServerDetailPage).props.draftServer.stdio.command).toBe('my-unsaved-command');
        expect(current.findByTestId('mcp.server.where')).not.toBeNull();
        expect(current.findByTestId('mcp.server.tools')).not.toBeNull();
        expect(current.findByTestId('mcp.server.config')).not.toBeNull();
        expect(current.findByTestId('mcp.server.machines')).not.toBeNull();
        expect(current.findByTestId('mcp.server.editor.remove')).not.toBeNull();
      }
      await act(async () => { command().props.onBlur?.(); });
      await waitForHomeGovernance(() => expect(writes).toBe(1));
      expect(catalogServer.stdio?.command).toBe('my-unsaved-command');
      expect(command().props.value).toBe('my-unsaved-command');
    } finally { dimensions.mockRestore(); }
  });

  it('excludes Agents without MCP delivery from the saved server availability sentence', async () => {
    const scope = getStorage().getState().settingsScope!;
    const machine = createMachineFixture({ id: 'mcp-machine', activeAt: Date.now(),
      metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex', 'coderabbit'] } } });
    getStorage().getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    observeMachinePresenceForTest(scope, [machine.id]);
    recordMachineRequestFailed({ ...scope, machineId: machine.id });
    catalogBindings = [{ id: 'everywhere', serverId: base.id, target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }];
    const current = await page();
    await waitForHomeGovernance(() => expect(current.tree.findByType(McpServerWhereAndTools).props.detail.reach.status).toBe('ready'));
    expect(current.tree.getTextContent()).toContain('capabilities.where.cantTake');
    expect(current.tree.getTextContent()).toContain('agentInput.agent.coderabbit');
  });

  it('explicit Test reaches an unreachable enabled machine and settles its deadline failure without an automatic probe', async () => {
    const scope = getStorage().getState().settingsScope!;
    const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const previous = applied.getAppliedActiveServerSnapshot();
    const available = applied.isAppliedActiveServerRuntimeAvailable();
    restoreAppliedRuntime = () => applied.publishAppliedActiveServerSnapshot(previous, available);
    // The Test result owner needs the genuinely applied Account lifetime, not
    // merely the credential-bound settings scope used by the editor.
    applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual(scope);
    const machine = createMachineFixture({ id: 'mcp-machine', active: false, activeAt: 1,
      metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } });
    getStorage().getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    observeMachinePresenceForTest(scope, [machine.id]);
    catalogBindings = [{ id: 'everywhere', serverId: base.id, target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }];
    // The real RPC boundary marks a dispatched timeout as uncertain; code alone carries no dispatch evidence.
    boundary.rpc.mockRejectedValue(markRpcRequestDisposition(Object.assign(new Error('RPC request timed out'), {
      code: MACHINE_RPC_TIMEOUT_ERROR_CODE,
    }), 'outcomeUnknown'));
    recordMachineRequestFailed({ ...scope, machineId: machine.id });
    const current = await page();
    await waitForHomeGovernance(() => {
      const detail = current.tree.findByType(McpServerWhereAndTools).props.detail;
      expect(detail.execution.ready).toBe(true);
      expect(detail.reach.status).toBe('ready');
    });
    expect(current.tree.findByType(McpServerWhereAndTools).props.detail.onMachines).toMatchObject([{ machineId: machine.id, online: false }]);
    expect(boundary.rpc).not.toHaveBeenCalled();
    await current.tree.pressByTestIdAsync('mcp.server.machines:action');
    await waitForHomeGovernance(() => {
      const detail = current.tree.findByType(McpServerWhereAndTools).props.detail;
      expect(detail.tests.running.size).toBe(0);
    });
    expect(boundary.rpc).toHaveBeenCalledOnce();
    expect(boundary.rpc.mock.calls[0]![0]).toMatchObject({ machineId: machine.id });
    expect(current.tree.findByType(McpServerWhereAndTools).props.detail.tests.results[machine.id])
      .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
  });

  it('offers an inline own-app form with a masked optional secret and submits through sign-in', async () => {
    const start = vi.fn(async () => {});
    const clientSecret = crypto.randomUUID();
    const tree = await renderScreen(<McpSignInSection name="Docs" signIn={{ view: { state: 'client_refused' },
      start, busy: false, cancel: async () => {}, complete: async () => false, signOut: async () => false }} />);
    await tree.pressByTestIdAsync('mcp.server.signin:own-app');
    const clientId = tree.findAllByType(FieldTextInput).find(field => field.props.testID === 'mcp.server.signin:client-id');
    const secret = tree.findAllByType(FieldTextInput).find(field => field.props.testID === 'mcp.server.signin:client-secret');
    expect(secret?.props.secureTextEntry).toBe(true);
    await act(async () => { clientId?.props.onChangeText('person-app'); secret?.props.onChangeText(clientSecret); });
    await tree.pressByTestIdAsync('mcp.server.signin:own-app-sign-in');
    expect(start.mock.calls.length).toBe(1);
    expect(JSON.stringify(start.mock.calls[0]) === JSON.stringify([{ client: { clientId: 'person-app', clientSecret } }])).toBe(true);
    await tree.update(<McpSignInSection name="Docs" signIn={{ view: { state: 'connected', identity: null, scopes: [], lastUsedAt: null },
      start, busy: false, cancel: async () => {}, complete: async () => false, signOut: async () => false }} />);
    expect(tree.findAllByTestId('mcp.server.signin:own-app-form')).toHaveLength(0);
    expect(tree.findAllByTestId('mcp.server.signin:connected')).not.toHaveLength(0);
  });
  it('the real missing-key banner opens the ValueRef editor and saves the repaired reference', async () => {
    const server = McpServerCatalogEntryV1Schema.parse({ ...base, env: { TOKEN: { t: 'savedSecret', secretId: 'missing' } } });
    const current = await page(server);
    await current.tree.pressByTestIdAsync('mcp.server.banner.action');
    expect(Modal.show).toHaveBeenCalled();
    const opened = vi.mocked(Modal.show).mock.calls.at(-1)![0];
    expect(opened.component).toBe(ValueRefEditorModal);
    const props = opened.props as React.ComponentProps<typeof ValueRefEditorModal>;
    expect(props.initialKey).toBe('TOKEN');
    expect(props.onSubmit({ key: 'TOKEN', valueRef: { t: 'savedSecret', secretId: 'replacement' } })).toBe(true);
    expect(current.draft().env.TOKEN).toEqual({ t: 'savedSecret', secretId: 'replacement' });
    expect(current.commit).toHaveBeenCalled();
  });

  it('client refusal keeps the API-key alternative and saves through the existing header editor', async () => {
    const current = await page(McpServerCatalogEntryV1Schema.parse({ ...base, remote: { ...base.remote, auth: { kind: 'oauth' } } }));
    boundary.rpc.mockImplementation(async request => {
      const operation = request.payload.command.operation;
      if (operation === 'describeService') return { status: 'described', service, descriptor: { id: service.localId, title: 'MCP sign-in', authentication: {
        defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl, pkce: 'required', outcomeReconciliation: 'none' }],
      } }, accounts: [], operationTransport: { kind: 'v4' }, occurrenceId: 'recovery-runtime', sourceCustody: { kind: 'host' } };
      if (operation === 'beginConnect') throw Object.assign(new Error('client_refused'), { code: 'client_refused' });
      throw new Error(`Unexpected recovery RPC operation: ${operation}`);
    });
    await waitForHomeGovernance(() => {
      const detail = current.tree.findByType(McpServerWhereAndTools).props.detail;
      expect(detail.execution.ready).toBe(true);
      expect(detail.signIn.view).toMatchObject({ state: 'not_connected' });
    });
    await current.tree.pressByTestIdAsync('mcp.server.signin:not-connected:action');
    await waitForHomeGovernance(() => expect(current.tree.findByType(McpServerWhereAndTools).props.detail.signIn.view).toMatchObject({ state: 'client_refused' }));
    await current.tree.pressByTestIdAsync('mcp.server.signin:client-refused:action');
    expect(Modal.show).toHaveBeenCalled();
    const opened = vi.mocked(Modal.show).mock.calls.at(-1)![0];
    expect(opened.component).toBe(ValueRefEditorModal);
    const props = opened.props as React.ComponentProps<typeof ValueRefEditorModal>;
    expect(props.kind).toBe('header');
    expect(props.onSubmit({ key: 'Authorization', valueRef: { t: 'savedSecret', secretId: 'api-key' } })).toBe(true);
    expect(current.draft().remote).toEqual({ url: base.remote!.url, headers: { Authorization: { t: 'template', template: 'Bearer {api_key}', vars: { api_key: { t: 'savedSecret', secretId: 'api-key' } } } } });
    expect(current.commit).toHaveBeenCalled();
  });
});
