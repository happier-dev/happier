import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { applyMcpServerCatalogMutationV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { readMcpPluginItemMetadataFromProjectionV1 } from '@happier-dev/protocol/mcp/servers/pluginItemsV1';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { DetectedMcpServerV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createEphemeralPluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';
import { resolveSessionMcpPreview } from '../preview/resolveSessionMcpPreview';
import { probeMcpStdioServerTools } from '../servers/probeMcpStdioServerTools';
import { createNativeAgentExecutionRunHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';

describe('plugin MCP registration → rules → launch → public service', () => {
  it.each([{ register: true, sessionScope: 'session' as const }, { register: false, sessionScope: 'session' as const },
    { register: true, sessionScope: 'global' as const }])('delivers selected declarations (%j)', async ({ register, sessionScope }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-p7c-composed-'));
    const happyHomeDir = join(root, 'home'), pluginRoot = join(root, 'plugin');
    const pluginId = 'acme.mcp-fixture';
    const serverId = mcpPluginItemIdV1({ pluginId, localId: 'tools' });
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({ id: pluginId,
      activation: { events: [{ kind: 'startup' }] }, contributes: { mcp: { servers: [{ id: 'tools', title: 'Fixture tools',
        kind: 'dynamic', sessionScope }] } } })));
    // Actual author ABI: removing this registration is the deciding mis-wiring.
    const wireRegistration = register && process.env.HAPPIER_P7C_MISWIRE_MCP_REGISTRATION !== '1';
    await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
      ${wireRegistration ? `api.mcp.registerServer('tools', {
        async listTools() { return { items: [{ name: 'echo', inputSchema: { type: 'object' } }] }; },
        async callTool(input) { return { echoed: input }; },
        async listResources() { return { items: [] }; }, async listResourceTemplates() { return { items: [] }; },
        async readResource(request) { return { contents: [{ uri: request.uri, text: '' }] }; },
        async subscribeResource() { return { dispose() {} }; }, async listPrompts() { return { items: [] }; },
        async getPrompt() { return { messages: [] }; }, async dispose() {}
      });` : ''}
    }`);
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0', devWatch: false });
    // Real installed-plugin discovery/catalog; bundled Resource producers are outside this fixture.
    const contributes = createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir }));
    const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes });
    const lease = createEphemeralPluginRuntimeRegistryLease(registry);
    const credentials = { token: 'p7c-account', encryption: null, credentialProvenance: 'stored_session' as const };
    const settings = accountSettingsParse({});
    const catalog = applyMcpServerCatalogMutationV1(McpServerCatalogV1Schema.parse({ v: 1, servers: [{
      id: 'catalog-tools', name: 'tools', transport: 'stdio', stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'catalog-rule', serverId: 'catalog-tools', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] }),
      { kind: 'plugin-defaults', serverIds: [serverId] }, { nowMs: 1, newId: () => 'unused', pluginItemIds: [serverId] });
    const off = applyMcpServerCatalogMutationV1(catalog, { kind: 'rules-change', serverIds: [serverId],
      change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } } },
      { nowMs: 2, newId: () => 'unused', pluginItemIds: [serverId] });
    const controller = new AbortController();
    const input = { session: { sessionId: 'fixture-session', getServerBinding: () => ({ serverId: 'fixture-home', serverUrl: 'https://fixture.test' }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'fixture-session', encryptionMode: 'plain' }), updateMetadata() {},
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }), getRuntimeLifetimeSignal: () => controller.signal },
      credentials, localWorkflow: true, accountSettings: settings, accountSettingsSnapshot: { source: 'network' as const, settings, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
        mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, catalog: off, revision: 1, diagnostics: [] } },
      machineId: 'fixture-machine', directory: root, agentId: 'claude', agentAcceptsUserMcp: true,
      pluginRuntimeRegistryLease: lease, includeHappierMcpServer: false as const, tmpDir: root,
      mcpToolControl: { off: 'hidden' as const, approval: 'native' as const },
      detectedMcpServers: [true, false].map(loadedInHappierSessions => DetectedMcpServerV1Schema.parse({
        provider: 'claude', name: loadedInHappierSessions ? 'tools' : 'tools_3', transport: 'stdio',
        stdio: { command: 'echo', args: [] }, envKeys: [], enabled: true, loadedInHappierSessions,
        source: { kind: 'user', path: '/native/config' },
      })),
    };
    let stop: (() => void | Promise<void>) | undefined;
    try {
      const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry: registry.contributes, generation: 1 }));
      expect(readMcpPluginItemMetadataFromProjectionV1(projection)).toEqual([expect.objectContaining({ id: serverId,
        source: { kind: 'plugin', pluginId, pluginName: pluginId } })]);
      const preview = await resolveSessionMcpPreview({ settings: { ...off, strictMode: false }, machineId: input.machineId,
        directory: root, agentId: 'claude', detectedServers: input.detectedMcpServers,
        mcpPluginItems: await registry.projectMcpServerItems!(off) });
      expect(preview.managed.find(item => item.serverId === serverId)).toMatchObject({ name: 'tools_3', selected: false });
      const unselected = await resolveRunnerMcpServers(input);
      expect(Object.keys(unselected.mcpServers)).toEqual(['tools_2']); await unselected.happierMcpServer.stop();
      vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
      const selected = resolveRunnerMcpServers({ ...input, sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: true,
        forceIncludeServerIds: [serverId], forceExcludeServerIds: [] } } });
      if (!register) { await expect(selected).rejects.toMatchObject({ code: 'plugin_mcp_generation_retired' }); return; }
      const result = await selected; stop = result.happierMcpServer.stop;
      // A freshly installed declaration has reach, but no pluginServers row.
      // The real launch consumer must retain the normal Ask default.
      expect(catalog.pluginServers).toBeUndefined();
      expect(result.mcpToolPolicy?.tools_3).toEqual({ unlisted: 'ask', tools: {} });
      expect(result.mcpServerIdentities?.tools_3).toMatchObject({ serverId, plugin: { pluginId, localId: 'tools' } });
      expect(result.mcpServers.tools_3?.command).toBeTruthy();
      const tools = await probeMcpStdioServerTools({ config: result.mcpServers.tools_3! });
      expect(tools.tools.map(tool => tool.name)).toEqual(['echo']);
      const services = createNativeAgentExecutionRunHostServices({ signal: controller.signal, executionRunId: 'fixture-run',
        directory: root, machineId: 'fixture-machine', accountSettings: settings, runtimeRegistry: registry,
        pluginId, agentId: 'claude', happyHomeDir, readResolvedMcpServers: () => result.resolvedServers ?? [] });
      try { expect(await services.mcp.resolveServers()).toEqual(result.resolvedServers?.map(({ scope: _scope, title: _title, ...server }) => server)); }
      finally { await services.dispose(); }
      const attachments: Readonly<{ dispose(): void | Promise<void> }>[] = [];
      const detached = registry.materializePluginMcpServers!({ scope: { kind: 'execution_run', executionRunId: 'fixture-detached' },
        directory: root, servers: [{ id: serverId, name: 'tools', transport: { kind: 'http', url: 'http://127.0.0.1' },
          scope: { executionRunId: 'fixture-detached', directory: root } }], addDisposable: attachment => attachments.push(attachment) });
      try {
        if (sessionScope === 'session') await expect(detached).rejects.toMatchObject({ code: 'plugin_mcp_session_mismatch' });
        else expect(await detached).toEqual([expect.objectContaining({ id: serverId,
          scope: { executionRunId: 'fixture-detached', directory: root } })]);
      } finally { await Promise.all(attachments.map(attachment => attachment.dispose())); }
    } finally {
      await stop?.(); controller.abort(); vi.unstubAllEnvs(); await lease.release(); await registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
