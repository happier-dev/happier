import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fastify from 'fastify';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration, reloadConfiguration } from '@/configuration';
import { bindRequesterSessionCredentialScope, writeStoredCredentialsForServerId } from '@/persistence';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import type { HappyMcpSessionClient } from './startHappyServer';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { resolveRunnerMcpServers, type RunnerMcpServersBridgeResult } from './runtime/resolveRunnerMcpServers';
import { connectSessionMcpClient } from './runtime/sessionMcpLocalClient';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { accountSettingsParse } from '@happier-dev/protocol';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const boundary = vi.hoisted(() => ({
  daemonPost: vi.fn(async (path: string) => path === '/plugins/catalog/read'
    ? { kind: 'available', plugins: [], tools: [] }
    : { matched: true, result: { ok: true, result: { completed: true } } }),
}));
// Daemon HTTP is the only substituted system boundary; the MCP SDK,
// registration, Action bridge, executor and control-client parser remain real.
vi.mock('@/daemon/controlHttp', () => ({ daemonPost: boundary.daemonPost }));
afterEach(() => boundary.daemonPost.mockClear());

import { createHappierMcpServer } from './createHappierMcpServer';
import { filterPluginToolsForActiveAgentComposition, registerHappierSessionAgentToolRpc } from './startHappyServer';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { PLUGIN_ACTION_EXECUTE_PATH } from '@/plugins/daemon/controlRoutes';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

function sessionClient(sessionId: string): HappyMcpSessionClient {
  return {
    sessionId,
    getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {},
    getWorkDepth: () => 0,
    getHostTurnWorkDepth: turnId => turnId === 'plugin-tool-turn' ? 0 : undefined,
    getActiveTurnPermissionWitness: () => ({ turnId: 'plugin-tool-turn',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
  };
}

describe('createHappierMcpServer plugin tools', () => {
  it('discovers and invokes Account Actions with current requester custody through the native MCP bridge', async () => {
    await withTempDir('happier-requester-discovery-', async homeDir => {
      const originalEnv = process.env;
      process.env = { ...originalEnv, HAPPIER_HOME_DIR: homeDir, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' };
      reloadConfiguration();
      const app = fastify();
      const endpoint = 'https://requester-discovery.test';
      const homeServerIdentityId = 'srv_requester-home';
      const features = registerAccountHomeHttp(app, { accountId: 'requester-owner', serverId: homeServerIdentityId });
      const { pluginId } = await registerAuthoredAccountActionRelease(app, 'requester-owner');
      await app.ready();
      const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
      await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: 'requester-home',
        createIfMissing: true, observation: 'exact', descriptor: { v: 1, homeServerIdentityId,
          canonicalServerUrl: endpoint, revision: 1, endpoints: [{ kind: 'https', url: endpoint }] } });
      const credentials = bindRequesterSessionCredentialScope({ token: 'requester-custody', encryption: null,
        credentialProvenance: 'stored_session' as const }, { serverId: 'requester-home', serverHttpBaseUrl: endpoint,
        requesterSession: { sessionId: 'requester-session', homeServerIdentityId, attribution: {
          serverId: 'requester-home', accountId: 'requester-owner', machineId: 'requester-machine', installationId: 'requester-installation',
        } } });
      let current = true;
      const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 0, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: runWithServerHttpBaseUrl(endpoint, () => resolveAccountSettingsScopeKeyForToken(credentials.token)),
        mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, revision: 0, diagnostics: [],
          catalog: { v: 1 as const, servers: [], bindings: [] } } };
      const operationContext = runWithServerHttpBaseUrl(endpoint, () => createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: endpoint, isCurrent: async () => current }));
      const session = { ...sessionClient('requester-session'),
        getServerBinding: () => ({ serverId: 'requester-home', serverUrl: endpoint }),
        getServerFeaturesSnapshot: () => ({ status: 'ready' as const, provenance: 'authenticated' as const, features }),
        enqueueSessionEventCommitted: async () => ({ persisted: true as const, delivered: true as const }) };
      let closeClient: () => Promise<void> = async () => {};
      let bridge: RunnerMcpServersBridgeResult | undefined;
      try {
        // No profile credential exists: the admitted requester context owns currentness.
        // A standalone caller requires a stored sign-in. The requester bridge
        // below must use its admitted custody and still refuse later retirement.
        const retiredCustodyRuntime = createHappierMcpServer(session, {
          credentials, accountSettings: snapshot.settings, pluginToolCatalog: [], isCredentialCurrent: () => false,
        });
        try {
          expect(await retiredCustodyRuntime.executeTool({
            toolName: 'action_spec_search', args: { query: 'Echo personal' },
          })).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
        } finally { await retiredCustodyRuntime.mcp.close(); }
        bridge = await resolveRunnerMcpServers({ session, credentials, accountCredentials: credentials,
          accountSettings: snapshot.settings, accountSettingsSnapshot: snapshot, operationContext,
          machineId: 'requester-machine', directory: homeDir, env: {}, tmpDir: null });
        if (!('url' in bridge.happierMcpServer)) throw new Error('Expected native MCP bridge');
        let client: Client;
        if ('localContext' in bridge.happierMcpServer && bridge.happierMcpServer.localContext) {
          const connected = await connectSessionMcpClient(bridge.happierMcpServer.localContext);
          client = connected.client;
          closeClient = connected.close;
        } else {
          client = new Client({ name: 'requester-discovery', version: '1' });
          closeClient = () => client.close();
          await client.connect(new StreamableHTTPClientTransport(new URL(String(bridge.happierMcpServer.url))));
        }
        const search = CallToolResultSchema.parse(await client.callTool({ name: 'action_spec_search', arguments: { query: 'Echo personal' } }));
        expect(search.isError, JSON.stringify(search)).toBe(false);
        expect(search.structuredContent).toMatchObject({ actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: `${pluginId}/actions/echo`, executionPlacement: 'account' }),
        ]) });
        registerHappierSessionAgentToolRpc(session, { credentials, accountSettings: snapshot.settings,
          isCredentialCurrent: operationContext.isCurrent });
        const rpcSearch = () => session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
          { toolName: 'action_spec_search', args: { query: 'Echo personal' } });
        expect(await rpcSearch()).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([
          expect.objectContaining({ id: `${pluginId}/actions/echo` }),
        ]) } });
        const invoke = () => client.callTool({ name: 'action_execute', arguments: {
          actionId: 'action.invoke', input: { action: { pluginId, localId: 'echo' }, input: { key: 'requester' } },
        } });
        const invoked = CallToolResultSchema.parse(await invoke());
        expect(invoked.isError, JSON.stringify(invoked)).toBe(false);
        expect(invoked.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text',
          text: expect.stringContaining('requester') })]));
        current = false;
        const retired = CallToolResultSchema.parse(await invoke());
        expect(retired.isError, JSON.stringify(retired)).toBe(true);
        expect(retired.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text',
          text: expect.stringContaining('plugin_action_generation_retired') })]));
        expect(await rpcSearch()).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
      } finally {
        await closeClient(); bridge?.happierMcpServer.stop(); restore(); await app.close();
        process.env = originalEnv; reloadConfiguration();
      }
    });
  });

  it('executes an authored Account Action from the native Agent tool entry without a Machine', async () => {
    await withTempDir('happier-agent-account-', async homeDir => {
      const originalEnv = process.env;
      process.env = { ...originalEnv, HAPPIER_HOME_DIR: homeDir };
      reloadConfiguration();
      const app = fastify();
      const endpoint = 'http://session-account.test';
      const accountId = 'session-account-owner';
      const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
      let observeAccountRequests = false;
      app.addHook('preHandler', async request => {
        if (observeAccountRequests && (request.url.startsWith('/v1/artifacts')
          || request.url.startsWith('/v1/account/') || request.url.startsWith('/v2/account/'))) {
          expect(request.headers.authorization === `Bearer ${token}`).toBe(true);
        }
      });
      const features = registerAccountHomeHttp(app, { accountId, serverId: 'session-account' });
      const { pluginId } = await registerAuthoredAccountActionRelease(app, accountId);
      await app.ready();
      const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
      const credentials = { token,
        encryption: null, credentialProvenance: 'stored_session' as const };
      await writeStoredCredentialsForServerId('session-account', credentials);
      observeAccountRequests = true;
      const fileReads = vi.spyOn(fs, 'readFile');
      const accessKeyReads = () => fileReads.mock.calls.filter(([path]) => String(path) === join(configuration.serversDir, 'session-account', 'access.key'));
      const lifetime = new AbortController();
      const { mcp, executeTool } = createHappierMcpServer({ ...sessionClient('session-account-agent'),
        getServerBinding: () => ({ serverId: 'session-account', serverUrl: endpoint }),
        getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features }),
      }, { credentials, pluginToolCatalog: [], toolExecutionSignal: lifetime.signal });
      boundary.daemonPost.mockClear();
      try {
        const result = await executeTool({ toolName: 'action_execute', args: {
          actionId: 'action.invoke', input: { action: { pluginId, localId: 'echo' }, input: { key: 'agent' } },
        } });
        expect(result).toMatchObject({ ok: true, result: { key: 'agent', surface: 'agent' } });
        expect(accessKeyReads()).toHaveLength(0);
        await writeStoredCredentialsForServerId('session-account', { ...credentials, token: 'replacement-account' });
        const captured = await executeTool({ toolName: 'action_execute', args: {
          actionId: 'action.invoke', input: { action: { pluginId, localId: 'echo' }, input: { key: 'captured' } },
        } });
        expect(captured).toMatchObject({ ok: true, result: { key: 'captured', surface: 'agent' } });
        expect(accessKeyReads()).toHaveLength(0);
        lifetime.abort();
        expect(await executeTool({ toolName: 'action_execute', args: {
          actionId: 'action.invoke', input: { action: { pluginId, localId: 'echo' }, input: { key: 'cancelled' } },
        } })).toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(boundary.daemonPost).not.toHaveBeenCalled();
      } finally { lifetime.abort(); fileReads.mockRestore(); restore(); await mcp.close(); await app.close(); process.env = originalEnv; reloadConfiguration(); }
    });
  });

  it('advertises and dispatches a daemon-projected tool through real session-agent MCP wiring', async () => {
    const entry = {
      toolId: 'acme.review.plugin/review-tool', actionId: 'acme.review.plugin/actions/review-start',
      name: 'acme_review_start', title: 'Review', description: 'Start a plugin-defined review workflow',
      inputSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { completed: { type: 'boolean' } }, required: ['completed'], additionalProperties: false },
      toolExposure: { agent: 'direct' },
      surfaces: ['agent', 'mcp', 'cli'],
    } satisfies ProjectedPluginToolCatalogEntry;
    const { mcp } = createHappierMcpServer(sessionClient('sess_agent_plugin_tool_1'), { pluginToolCatalog: [entry] });
    const client = new Client({ name: 'session-plugin-tools-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const advertised = listed.tools.find(tool => tool.name === entry.name);
      expect(advertised).toMatchObject({ inputSchema: entry.inputSchema });
      // Registration composes completed output with the canonical approval
      // envelope; the real SDK validates the completed structured result below.
      expect(advertised?.outputSchema).toBeDefined();
      const result = CallToolResultSchema.parse(await client.callTool({ name: entry.name, arguments: { scope: 'diff' } }));
      expect(result).toEqual({ content: [{ type: 'text', text: '{"completed":true}' }],
        structuredContent: { completed: true }, isError: false });
      const action = parseQualifiedPluginActionId(entry.actionId);
      if (!action) throw new Error('Expected qualified plugin Action');
      expect(boundary.daemonPost).toHaveBeenCalledWith(PLUGIN_ACTION_EXECUTE_PATH, expect.objectContaining({
        actionId: buildQualifiedPluginContributionKey(action), input: { scope: 'diff' }, surface: 'agent', startedBy: 'agent',
        defaultSessionId: 'sess_agent_plugin_tool_1',
      }), expect.objectContaining({ mutation: true, timeoutMs: null, signal: expect.any(AbortSignal) }));
    } finally { await client.close(); await mcp.close(); }
  });

  it('advertises only selected tools for a composition-managed plugin to the actual MCP client', async () => {
    const catalog = [{
      toolId: 'acme.composition/selected-tool', actionId: 'acme.composition/actions/selected-action',
      name: 'acme_composition_selected', title: 'Selected', description: 'The selected composition tool.',
      toolExposure: { agent: 'direct' },
      inputSchema: { type: 'object', additionalProperties: false }, safety: 'safe', surfaces: ['agent'],
    }, {
      toolId: 'acme.composition/unselected-tool', actionId: 'acme.composition/actions/unselected-action',
      name: 'acme_composition_unselected', title: 'Unselected', description: 'The unselected composition tool.',
      toolExposure: { agent: 'direct' },
      inputSchema: { type: 'object', additionalProperties: false }, safety: 'safe', surfaces: ['agent'],
    }, {
      toolId: 'acme.unmanaged/always-visible-tool', actionId: 'acme.unmanaged/actions/always-visible-action',
      name: 'acme_unmanaged_visible', title: 'Unmanaged', description: 'A tool without composition ownership.',
      toolExposure: { agent: 'direct' },
      inputSchema: { type: 'object', additionalProperties: false }, safety: 'safe', surfaces: ['agent'],
    }] as const satisfies readonly ProjectedPluginToolCatalogEntry[];
    for (const selected of [true, false]) {
      const { mcp } = createHappierMcpServer(sessionClient('sess_agent_composition_tool_1'), {
        pluginToolCatalog: filterPluginToolsForActiveAgentComposition(catalog, {
          managedPluginIds: ['acme.composition'],
          selectedTools: selected ? [{ pluginId: 'acme.composition', localId: 'selected-tool' }] : [],
          selectedToolBindings: selected ? [{ tool: catalog[0], expectedContributorOccurrenceId: 'occurrence-g' }] : [],
        }),
      });
      const client = new Client({ name: 'composition-tools-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await mcp.connect(serverTransport);
        await client.connect(clientTransport);
        const names = (await client.listTools()).tools.map(tool => tool.name);
        expect(names.includes('acme_composition_selected')).toBe(selected);
        expect(names).not.toContain('acme_composition_unselected');
        expect(names).toContain('acme_unmanaged_visible');
      } finally { await client.close(); await mcp.close(); }
    }
  });
});
