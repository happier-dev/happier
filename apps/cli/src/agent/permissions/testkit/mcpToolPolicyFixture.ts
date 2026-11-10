import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  applyMcpServerCatalogMutationV1,
  type McpServerCatalogSnapshotV1,
} from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveSessionCapabilitiesV1, projectMcpServerMaterializationV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import type { AgentMcpToolPolicyContractInput, AgentMcpToolPolicyPermissionObservation } from '../../../../../../packages/plugin-sdk/src/testing/mcpToolPolicyContract';
import type { AgentExecutionRunHostServicesV1, AgentSessionMcpLaunchConfig } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { createProviderEnforcedPermissionHandler } from '../providerEnforced/createHandler';
import { createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createNativeAgentExecutionRunHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import { ServerBoundPermissionRpcHandlerManager } from './serverBoundPermissionRpcHandlerManager';

/** Real host policy and real stdio→HTTP MCP, shared by native protocol fixtures.
 * Session state/RPC and Saved Secret storage are external boundary fixtures;
 * the catalog mutation, materializer, bridge and permission owners stay real. */
export type McpToolPolicyFixture = Readonly<{
  fixtureServer: AgentMcpToolPolicyContractInput['fixtureServer'];
  services: PluginServices;
  toolExecution: AgentExecutionRunHostServicesV1['toolExecution'];
  beginInvocation(scope: 'once' | 'session'): string;
  permissions(): AgentMcpToolPolicyPermissionObservation[];
  callServer(key: string, tool: string, args: Readonly<Record<string, unknown>>, nativeConfig?: AgentSessionMcpLaunchConfig): ReturnType<Client['callTool']>;
}>;

export function createMcpToolPolicyFixture(pluginId: string, contributionId: string): McpToolPolicyFixture {
  const promptedIds = new Set<string>();
  let rpcFailure: unknown;
  let rejectRpc!: (error: unknown) => void;
  let rpcFailed = new Promise<never>(() => {});
  let approvalScope: 'once' | 'session' = 'once';
  const session = {
    sessionId: 'mcp-policy-contract',
    rpcHandlerManager: new ServerBoundPermissionRpcHandlerManager('mcp-policy-contract'),
    state: { requests: {}, completedRequests: {} } as AgentState,
    getAgentStateSnapshot() { return this.state; },
    getMetadataSnapshot() { return null; },
    updateAgentState(update: (state: AgentState) => AgentState) {
      this.state = update(this.state);
      for (const [id, request] of Object.entries(this.state.requests ?? {})) {
        if (promptedIds.has(id)) continue;
        promptedIds.add(id);
        queueMicrotask(() => {
          void (async () => {
            const respond = this.rpcHandlerManager.handlers.get('session.permission.respond');
            if (!respond) throw new Error('Authenticated permission response is unavailable');
            const offered = request.nativeChoices;
            const choice = offered?.choices.find(choice => choice.scope === approvalScope
              && (choice.decision === 'approved' || choice.decision === 'approved_for_session'));
            if (offered && !choice) throw new Error(`No offered ${approvalScope} MCP approval`);
            const result = await respond(offered && choice
              ? { id, nativeChoice: { requirementId: offered.requirementId, choiceId: choice.id } }
              : { id, approved: true, decision: approvalScope === 'session' ? 'approved_for_session' : 'approved',
                ...(approvalScope === 'session' ? { allowedTools: [request.tool] } : {}) });
            // Successful canonical responses return void; a typed error is not an approval.
            if (result !== undefined) throw new Error(`Authenticated permission response failed: ${JSON.stringify(result)}`);
          })().catch(error => { rpcFailure = error; rejectRpc(error); });
        });
      }
      return this.state;
    },
    async getAuthenticatedAccountId() { return 'fixture-account'; },
  };
  let catalog: McpServerCatalogSnapshotV1 = { status: 'ready', authority: 'active', revision: 1,
    diagnostics: [], catalog: { v: 1, servers: [], bindings: [] } };
  let catalogRevision = 1;
  let sequence = 0;
  let callId = 0;
  let observation: AgentMcpToolPolicyPermissionObservation[] = [];
  const calls: Array<{ server: string; tool: string; order: number }> = [];
  const identities = Object.fromEntries(['first__team', 'second-team'].map(key => [key,
    { serverId: `catalog-${key}`, serverTitle: 'Shared title' }]));
  const createHandler = () => createProviderEnforcedPermissionHandler({
    // The fixture supplies the authenticated Session transport/state boundary.
    session: session as unknown as ApiSessionClient,
    logPrefix: '[MCP leaf contract]', getWorkspaceWrites: () => 'allow',
    getMcpToolContext: () => ({ catalog, mcpServerIdentities: identities }),
  });
  let handler = createHandler();
  const controller = new AbortController();
  const services = createNativeAgentSessionServices({
    permissionHandler: {
      async handleToolCall(id, name, input, context) {
        const entered = ++sequence;
        const decision = handler.handleToolCall(id, name, input, context);
        const result = await Promise.race([decision, rpcFailed]);
        const item = Object.entries(identities).find(([key]) => name.startsWith(`mcp__${key}__`));
        if (item) observation.push({ server: item[0], serverId: item[1].serverId,
          tool: name.slice(`mcp__${item[0]}__`.length), decision: result.decision.startsWith('approved') ? 'approved' : 'denied',
          prompted: promptedIds.has(id), order: entered });
        return result;
      },
    },
    pluginId, contributionId, runtimeId: `${contributionId}/runtime`, sessionId: session.sessionId,
    occurrenceId: 'fixture-occurrence', immutableGenerationId: 'fixture-generation',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' },
    isCurrent: () => !controller.signal.aborted, signal: controller.signal,
  });
  const clients = new Map<string, Client>();
  let materialized: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>> | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  let hostServices: ReturnType<typeof createNativeAgentExecutionRunHostServices> | null = null;
  const fixtureServer: AgentMcpToolPolicyContractInput['fixtureServer'] = {
    async prepare({ cwd }) {
      rpcFailure = undefined;
      rpcFailed = new Promise<never>((_resolve, reject) => { rejectRpc = reject; });
      // Publication may fail before the first tool's handler starts awaiting it.
      void rpcFailed.catch(() => undefined);
      hostServices = createNativeAgentExecutionRunHostServices({ signal: controller.signal,
        executionRunId: 'fixture-tool-hooks', directory: cwd, happyHomeDir: cwd, machineId: 'fixture-machine',
        accountSettings: null, runtimeRegistry: null, pluginId, agentId: contributionId });
      handler = createHandler();
      session.state = { requests: {}, completedRequests: {} };
      sequence = 0; callId = 0; calls.length = 0; observation = [];
      promptedIds.clear();
      const secret = 'fixture-saved-secret-private';
      const machineAtom = 'fixture-machine-env-private';
      const inheritedMarker = 'fixture-unselected-machine-private';
      server = createServer(async (request, response) => {
        const key = request.url?.slice(1) ?? '';
        if (!(key in identities) || request.headers.authorization !== `Bearer ${secret}`) {
          response.writeHead(403); response.end(); return;
        }
        const mcp = new McpServer({ name: key, version: '1' });
        mcp.registerTool('mutate', {}, async () => {
          calls.push({ server: key, tool: 'mutate', order: ++sequence });
          return { content: [{ type: 'text', text: 'Fixture tool completed' }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.once('close', () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(request, response);
      });
      await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture MCP listener unavailable');
      const definition = McpServerCatalogV1Schema.parse({ v: 1,
        servers: Object.entries(identities).map(([key, identity]) => ({
          id: identity.serverId, name: key, title: identity.serverTitle, transport: 'http',
          remote: { url: `http://127.0.0.1:${address.port}/${key}`, headers: { Authorization: {
            t: 'template', template: 'Bearer {token}', vars: { token: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:fixture-token' } },
          } } }, env: { MCP_SELECTED_ATOM: { t: 'literal', v: '${MCP_SELECTED_ATOM}' } },
          createdAt: 1, updatedAt: 1, toolsSnapshot: { checkedAt: 1, machineId: 'fixture-machine', tools: [{ name: 'mutate', tokens: 1 }] },
        })), bindings: Object.entries(identities).map(([key, identity]) => ({
          id: `rule-${key}`, serverId: identity.serverId, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
        })),
      });
      catalogRevision = 1;
      catalog = { status: 'ready', authority: 'active', revision: catalogRevision, diagnostics: [], catalog: definition };
      const selected = resolveSessionCapabilitiesV1({
        context: { machineId: 'fixture-machine', machinePlatform: null, projectKey: null, directory: cwd, agentId: null },
        mcp: { ...definition, strictMode: true }, skills: null, selection: {}, agentAcceptsUserMcp: true,
      });
      const resource = { resourceId: 'fixture-token', ownerAccountId: 'fixture-account', displayName: 'Fixture token',
        kind: 'token' as const, encryptionMode: 'plain' as const, revision: 1, materialStatus: 'ready' as const,
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'fixture-token', mode: 'plain',
          content: { v: 1, name: 'Fixture token', kind: 'token', value: secret } }) };
      materialized = await materializeMcpServerConfigRecord({
        resolved: projectMcpServerMaterializationV1(selected, cwd), tmpDir: cwd,
        processEnv: { MCP_SELECTED_ATOM: machineAtom, MCP_INHERITED_MARKER: inheritedMarker },
        savedSecretMaterializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
          resourceCatalogState: 'ready', resources: [resource] }),
        deps: {
          resolveStdioLauncherCommand: async () => {
            const command = await resolveNodeBackedMcpServerCommand({
              distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
              sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'], preferSourceEntrypoint: true,
            });
            return { ...command, args: ['--conditions=happier-source', ...command.args] };
          },
          resolveRemoteBridgeCommand: async () => {
            const command = await resolveNodeBackedMcpServerCommand({
              distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
              sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'], preferSourceEntrypoint: true,
            });
            return { ...command, args: ['--conditions=happier-source', ...command.args] };
          },
        },
      });
      const fixture = Object.entries(identities).map(([key, identity]) => ({
        key, serverId: identity.serverId, title: identity.serverTitle, tool: 'mutate', config: materialized!.mcpServers[key],
      }));
      return { servers: [fixture[0], fixture[1]], secrets: [secret, machineAtom, inheritedMarker],
        privateConfigFiles: (await readdir(cwd, { recursive: true })).map(path => resolve(cwd, path)) };
    },
    observeCalls: () => calls,
    async setPolicy({ settings, permissionMode }) {
      if (catalog.status !== 'ready') throw new Error('Fixture catalog unavailable');
      let current = catalog.catalog;
      for (const [key, setting] of Object.entries(settings)) current = applyMcpServerCatalogMutationV1(current,
        { kind: 'tools-change', serverId: identities[key].serverId, settings: { tools: { mutate: setting } } });
      catalog = { ...catalog, revision: ++catalogRevision, catalog: current };
      handler.setPermissionMode(permissionMode);
    },
    async dispose() {
      await hostServices?.dispose(); hostServices = null;
      await handler.reset();
      for (const client of clients.values()) await client.close();
      clients.clear(); materialized?.cleanup(); materialized = null;
      if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
      server = null;
    },
  };
  return {
    fixtureServer, services,
    get toolExecution() {
      if (!hostServices) throw new Error('Fixture host tool interception owner unavailable');
      return hostServices.toolExecution;
    },
    beginInvocation(scope: 'once' | 'session') { approvalScope = scope; observation = []; return `call-${++callId}`; },
    permissions: () => {
      if (rpcFailure !== undefined) throw rpcFailure;
      return [...observation];
    },
    async callServer(key: string, tool: string, args: Readonly<Record<string, unknown>>, nativeConfig?: AgentSessionMcpLaunchConfig) {
      let client = clients.get(key);
      if (!client) {
        const config = nativeConfig ?? materialized?.mcpServers[key];
        if (!config) throw new Error('Materialized fixture MCP server unavailable');
        client = new Client({ name: 'native-boundary-fixture', version: '1' });
        await client.connect(new StdioClientTransport({ command: config.command, args: [...config.args ?? []], env: { ...config.env } }));
        clients.set(key, client);
      }
      return await client.callTool({ name: tool, arguments: args });
    },
  };
}
