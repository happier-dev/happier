import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-sources/runtime';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ANSWERING_CLIENT_RPC_PREFIX_V1, SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';

import { ApiMachineClient } from '@/api/apiMachine';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import type { TrackedSession } from '@/daemon/types';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { executeAppliedDaemonPluginActionWithController, PLUGIN_ACTION_EXECUTE_PATH } from '@/plugins/daemon/controlRoutes';
import { createDaemonPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader } from './createCommittedContributedActionDeps';
import { createClientActionMachineRpcExecutor } from './clientActionMachineRpc';

// Credential files are outside the owning process. Client dispatch never
// activates a daemon entrypoint or prepares a packaged plugin artifact.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(),
  readStoredCredentials: async () => null,
}));

describe('committed client Message Action delivery', () => {
  it.each([
    { clientId: undefined, clients: ['app-b'], expected: 'app-b' },
    { clientId: 'app-b', clients: ['app-a', 'app-b'], expected: 'app-b' },
    { clientId: undefined, clients: ['app-a', 'app-b'], expected: 'client_ambiguous' },
  ])('delivers the Tasks launcher and committed reference through canonical client choice: $expected', async ({ clientId, clients, expected }) => {
    const { selectRpcTarget } = await import('../../../../../../server/sources/app/api/socket/rpc/rpcTargetSelection');
    const effects: string[] = [];
    const pluginId = PLUGIN_MANIFEST.id;
    const action = { pluginId, localId: 'tasks/open-create-v1' };
    const actionRequestId = 'original-client-message-action';
    const messageActionReference = { v: 1 as const, sessionId: 'committed-session', messageId: 'committed-message', observedRevision: 'revision-1' };
    const bundled = loadCurrentBundledPluginLocatorResult();
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: {
      loadedPlugins: bundled.loadedPlugins.filter(plugin => plugin.pluginId === pluginId)
        .map(plugin => ({ ...plugin, manifest: normalizePluginManifestV2(PLUGIN_MANIFEST) })), diagnosticsByPluginId: {},
    }, provenance: 'first_party' }));
    const executeClientAction = createClientActionMachineRpcExecutor(() => ({
      // A reconnect advertisement is incomplete; the live answering route still exists.
      hasConnectedClientRpcHandler: () => false,
      // Substitute only the Machine-to-UI network hop. The real producer's
      // serialized DTO must pass the answering client's exact closed schema.
      callConnectedClientRpc: async (_method, raw, options) => {
        expect(options.answeringClient).toEqual({ requireSingle: true, ...(clientId ? { clientId } : {}) });
        const request = UiContributedActionExecuteRequestV1Schema.parse(JSON.parse(JSON.stringify(raw)));
        expect(request).toMatchObject({ action, input: {}, actionRequestId, messageActionReference, surface: 'cli' });
        const targets = clients.map(id => ({ id, timeout: () => ({ emitWithAck: async () => {
          effects.push(id); return { ok: true, result: { delivered: request.messageActionReference ?? null } };
        } }) }));
        const selected = selectRpcTarget({ targets, answeringClient: options.answeringClient });
        if (selected.type === 'ambiguous') return { ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS', answeringClients: selected.clients };
        if (selected.type !== 'target') return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
        options.onIssued();
        return { ok: true, result: await selected.target.timeout(0).emitWithAck('rpc-request', {}) };
      },
    }));
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { contributes, pluginIds: [pluginId], executeClientAction } });
    try {
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), invokeContributedAction: createCommittedContributedActionInvoker({
        acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry(),
      }) });
      const result = await executor.execute('action.invoke', { action, input: {}, messageActionReference,
        ...(clientId ? { clientId } : {}) }, { surface: 'cli', actionRequestId });
      if (expected === 'client_ambiguous') {
        expect(result).toMatchObject({ ok: false, errorCode: 'client_ambiguous', details: {
          clients: clients.map(id => ({ id, deviceLabel: null })), recovery: { inputField: 'clientId' },
        } });
        expect(effects).toEqual([]);
      } else {
        expect(result).toEqual({ ok: true, result: { delivered: messageActionReference } });
        expect(effects).toEqual([expected]);
      }
      expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'tasks/list-v1' },
        input: {}, clientId: 'app-b' }, { surface: 'cli' }))
        .toMatchObject({ ok: false, errorCode: 'client_routing_not_applicable' });
      // An unsupported target cannot silently discard the new reference and
      // report a successful invocation with no Message context.
      expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'tasks/list-v1' },
        input: {}, messageActionReference }, { surface: 'cli' }))
        .toMatchObject({ ok: false, errorCode: 'plugin_message_action_unavailable' });
    } finally { await fixture.dispose(); }
  });
});

it('returns the mounted saved-view receipt to the Agent and reports malformed reverse input before dispatch', async () => {
  const action = { pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 };
  const actionId = formatQualifiedPluginActionId(action);
  const mountId = 'current-triage-mount';
  const input = { mountId, operation: { kind: 'selectSavedView', viewId: 'saved-view' } };
  const sessionId = 'current-session';
  const bundled = loadCurrentBundledPluginLocatorResult();
  const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: {
    loadedPlugins: bundled.loadedPlugins.filter(plugin => plugin.pluginId === action.pluginId)
      .map(plugin => ({ ...plugin, manifest: normalizePluginManifestV2(PLUGIN_MANIFEST) })), diagnosticsByPluginId: {},
  }, provenance: 'first_party' }));
  const received: unknown[] = [];
  const executeClientAction = createClientActionMachineRpcExecutor(() => ({
    callConnectedClientRpc: async (_method, raw, options) => {
      const request = UiContributedActionExecuteRequestV1Schema.parse(JSON.parse(JSON.stringify(raw)));
      received.push(request);
      options.onIssued();
      return { ok: true, result: { ok: true, result: { status: 'applied' } } };
    },
  }));
  const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { contributes, pluginIds: [action.pluginId], executeClientAction } });
  const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => fixture.controller.tryAcquireRuntimeRegistry() });
  const base = createActionExecutor({ ...createUnavailableActionTransportDeps(), listContributedActionDefinitions: list,
    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list) });
  const executor = createDaemonPluginActionExecutor({ base, requestPluginActionExecution: async request =>
    request.actionId === 'action.spec.get' ? { matched: true, result: await base.execute('action.spec.get', request.input, {
      surface: request.surface, authority: 'account_automation', actionCaller: { kind: 'host' },
    }) }
      : await executeAppliedDaemonPluginActionWithController(request, fixture.controller),
  });
  const bridge = createActionToolExecutorBridge({ executor, surface: 'agent' });
  const server = new McpServer({ name: 'mounted-client-action', version: '1' });
  registerHappierMcpBuiltInTools(server, { sessionId, surface: 'agent', deps: { ...bridge,
    changeTitle: async () => { throw new Error('Unexpected title change'); } } });
  const client = new Client({ name: 'mounted-client-agent', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const invoke = async (input: string) => {
      const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
      const content = reply.content.find(block => block.type === 'text');
      if (content?.type !== 'text') throw new Error('Missing Agent tool response');
      return { isError: reply.isError, value: JSON.parse(content.text) };
    };
    expect(await invoke(JSON.stringify(input))).toMatchObject({ value: { status: 'applied' } });
    // Exercise the request builder with a non-finite value before the substituted
    // control transport can serialize it. The tool accepts JSON-encoded operands.
    expect(await invoke('{"mountId":"current-triage-mount","operation":{"kind":"selectSavedView","viewId":1e400}}'))
      .toMatchObject({ isError: true, value: {
        errorCode: 'plugin_action_input_invalid', details: { issues: [{ code: 'custom', path: ['input'] }] },
      } });
    expect(received).toEqual([expect.objectContaining({
      action, input, surface: 'agent', defaultSessionId: sessionId, actionRequestId: expect.any(String),
    })]);
  } finally {
    await client.close(); await server.close(); await fixture.dispose();
  }
});

it('delivers an Agent saved-view Action through authenticated daemon control while its browser mount is live', async () => {
  const action = { pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 };
  const actionId = formatQualifiedPluginActionId(action);
  const mountId = '_r_16_';
  const input = { mountId, operation: { kind: 'selectSavedView', viewId: 'c6027590-2b4c-42ea-8528-0d16be2a4d98' } };
  const accountId = 'signed-in-account';
  const { createPluginAccountBundledSelectionV1, resolvePluginAccountExecutionSelectionV1 } =
    await import('@happier-dev/protocol/plugins/availability');
  const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
  const selected = resolvePluginAccountExecutionSelectionV1({ pluginId: action.pluginId, intentRead: null,
    bundled: createPluginAccountBundledSelectionV1({ packageName: '@happier-dev/plugins-triage', manifest }),
  });
  if (selected.kind !== 'available') throw new Error('Missing bundled Account selection');
  let browserOccurrence = selected.custodyId;
  const machineId = 'agent-machine';
  const sessionId = 'current-session';
  const memberSessionId = 'member-session';
  const trackedSessions: TrackedSession[] = [
    { trackingKey: legacyPidSessionTrackingKey(4242), startedBy: 'daemon', pid: 4242, happySessionId: sessionId },
    {
      trackingKey: legacyPidSessionTrackingKey(4243), startedBy: 'daemon', pid: 4243, happySessionId: memberSessionId,
      requesterWorkAttributionV1: { serverId: 'test-home', accountId: 'team-member', machineId, installationId: 'installation' },
    },
  ];
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const machine = new ApiMachineClient(token, { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0,
    daemonState: null, daemonStateVersion: 0 });
  let browserMount: string | null = mountId;
  let selectedView: string | null = null;
  let browserRefusesAction = false;
  // Socket boundary: the registered browser acknowledges only the mount it holds.
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
    expect(payload).toMatchObject({ method: `${machineId}:${ANSWERING_CLIENT_RPC_PREFIX_V1}${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`,
      answeringClient: { requireSingle: true } });
    const request = UiContributedActionExecuteRequestV1Schema.parse(Reflect.get(payload as object, 'params'));
    expect(request).toMatchObject({ action, input });
    if (browserMount === null) return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
    expect(request.input).toMatchObject({ mountId: browserMount });
    if (!browserRefusesAction && request.expectedContributorOccurrenceId !== browserOccurrence) {
      return { ok: true, result: { ok: false, errorCode: 'contributed_action_unavailable',
        error: 'current_ui_action_unavailable', actionHandlerInvocation: 'notStarted' } };
    }
    if (browserRefusesAction) return { ok: true, result: { ok: false, errorCode: 'contributed_action_unavailable',
      error: 'current_ui_action_unavailable', actionHandlerInvocation: 'notStarted' } };
    selectedView = input.operation.viewId;
    return { ok: true, result: { ok: true, result: { status: 'applied' } } };
  } });
  Reflect.set(machine, 'socket', socket);
  const executeClientAction = createClientActionMachineRpcExecutor(() => ({
    callConnectedClientRpc: machine.callConnectedClientRpc.bind(machine),
    resolveAccountPluginExecutionSelection: async (pluginId, _signal, principal) => {
      expect(pluginId).toBe(action.pluginId);
      expect(principal).toBe(accountId);
      return selected;
    },
  }));
  const bundled = loadCurrentBundledPluginLocatorResult();
  const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: {
    loadedPlugins: bundled.loadedPlugins.filter(plugin => plugin.pluginId === action.pluginId)
      .map(plugin => ({ ...plugin, manifest: normalizePluginManifestV2(PLUGIN_MANIFEST) })), diagnosticsByPluginId: {},
  }, provenance: 'first_party' }));
  const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { contributes, pluginIds: [action.pluginId], executeClientAction } });
  const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => fixture.controller.tryAcquireRuntimeRegistry() });
  const executeInDaemon = createActionExecutor({ ...createUnavailableActionTransportDeps(), listContributedActionDefinitions: list,
    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
    invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry() }),
  });
  const controlToken = 'fixture-control';
  const app = createDaemonControlApp({
    getChildren: () => trackedSessions, machineId, controlToken,
    stopSession: async () => ({ status: 'not_found' }),
    spawnSession: async () => ({ type: 'success', sessionId }),
    requestShutdown() {}, onHappySessionWebhook() {},
    pluginChangeService: { requestPluginChange: vi.fn(), decidePluginChange: vi.fn(),
      statusPluginChange: async () => ({ kind: 'expired' }), listPendingPluginChanges: async () => ({ changes: [] }), shutdown: async () => {} },
    externalActionApi: { currentServerId: 'test-home', currentAccountId: accountId, verifyPat: vi.fn(),
      executor: executeInDaemon, resolveTarget: vi.fn() },
  });
  const executor = createDaemonPluginActionExecutor({ base: executeInDaemon, requestPluginActionExecution: async request => {
    const response = await app.inject({ method: 'POST', url: PLUGIN_ACTION_EXECUTE_PATH, payload: request,
      headers: { 'x-happier-daemon-token': controlToken } });
    expect(response.statusCode).toBe(200);
    return response.json();
  } });
  const tools = createActionToolExecutorBridge({ executor, surface: 'agent' });
  const invoke = (defaultSessionId = sessionId, actionRequestId?: string) =>
    tools.executeActionByToolName('action_execute', { actionId, input: JSON.stringify(input) },
      defaultSessionId, { actionRequestId });
  try {
    // A Machine-pinned request still works when the App has that exact producer.
    browserOccurrence = fixture.registry.readPluginOccurrenceId?.(action.pluginId) ?? '';
    expect(await executeClientAction({ v: 1, action, input, surface: 'agent', defaultSessionId: sessionId,
      expectedContributorOccurrenceId: browserOccurrence }, { principalAccountId: accountId }))
      .toEqual({ ok: true, result: { status: 'applied' } });
    selectedView = null;
    browserOccurrence = selected.custodyId;

    const receipt = await invoke();
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true, result: { status: 'applied' } });
    expect(selectedView).toBe(input.operation.viewId);

    selectedView = null;
    const wrappedReceipt = await executor.execute('action.invoke', { action, input }, {
      surface: 'agent', defaultSessionId: sessionId,
    });
    expect(wrappedReceipt, JSON.stringify(wrappedReceipt)).toMatchObject({ ok: true, result: { status: 'applied' } });
    expect(selectedView).toBe(input.operation.viewId);

    selectedView = null;
    socket.emitWithAck.mockClear();
    expect(await invoke(memberSessionId)).toMatchObject({ ok: false, errorCode: 'plugin_action_client_target_unavailable' });
    expect(await executor.execute('action.invoke', { action, input }, {
      surface: 'mcp', defaultSessionId: memberSessionId,
    })).toMatchObject({ ok: false, errorCode: 'plugin_action_client_target_unavailable' });
    expect(await invoke('untracked-session')).toMatchObject({ ok: false, errorCode: 'plugin_action_client_target_unavailable' });
    expect(socket.emitWithAck).not.toHaveBeenCalled();
    expect(selectedView).toBeNull();

    expect(await executor.execute('action.invoke', { action, input }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { status: 'applied' } });
    expect(selectedView).toBe(input.operation.viewId);

    browserRefusesAction = true;
    selectedView = null;
    expect(await invoke(sessionId, 'mounted-action-request')).toMatchObject({
      ok: false, errorCode: 'contributed_action_unavailable', error: 'current_ui_action_unavailable', requestId: 'mounted-action-request',
    });
    expect(selectedView).toBeNull();

    browserMount = null;
    selectedView = null;
    socket.emitWithAck.mockClear();
    expect(await invoke()).toMatchObject({ ok: false, errorCode: 'plugin_action_client_target_unavailable' });
    expect(socket.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, expect.anything());
    expect(selectedView).toBeNull();
  } finally {
    await app.close();
    await fixture.dispose();
  }
});
