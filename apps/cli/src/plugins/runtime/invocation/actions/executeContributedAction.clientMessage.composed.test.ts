import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-sources/runtime';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';

import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { executeAppliedDaemonPluginActionWithController } from '@/plugins/daemon/controlRoutes';
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
