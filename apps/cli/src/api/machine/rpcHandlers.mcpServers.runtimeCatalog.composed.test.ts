import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { DaemonMcpServersTestResponseSchema, DetectedMcpServerV1Schema, type DetectedMcpServerV1 } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { McpServerCatalogRowMutationV1Schema, openMcpServerCatalogContentV1, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { DaemonMcpServersPreviewResponseSchema } from '@happier-dev/protocol/mcp/servers/previewV1';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { probeMcpStdioServerTools, type McpServerProbeResult } from '@/mcp/servers/probeMcpStdioServerTools';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { configuration } from '@/configuration';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { detectProviderMcpServers } from '@/mcp/providerDetection/detectProviderMcpServers';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability/actions';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { PromptBundleArtifactHeaderV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';

// Home transport/cache-file I/O and process probing are real system boundaries.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
vi.mock('@/api/client/serverHttpBaseUrl', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/serverHttpBaseUrl')>(),
  resolveServerHttpBaseUrl: () => 'https://home.example.test',
}));

const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true,
  servers: [{ id: 'srv-row', name: 'row-server', transport: 'stdio', stdio: { command: 'fixture', args: [] },
    env: { KEEP: { t: 'literal', v: 'present' }, REMOVE: { t: 'literal', v: 'removed' } },
    configOverrides: [{ target: { t: 'workspace', machineId: 'm1', workspaceRoot: 'C:\\workspace' },
      envPatch: { REMOVE: null, EXTRA: { t: 'literal', v: 'override' } } }], createdAt: 1, updatedAt: 1 }],
  bindings: [{ id: 'binding-row', serverId: 'srv-row', enabled: true,
    target: { t: 'workspace', machineId: 'm1', workspaceRoot: 'C:\\workspace' },
    createdAt: 1, updatedAt: 1 }],
});
const catalog = { v: 1 as const, servers: settings.servers, bindings: settings.bindings };

function register(input: Readonly<{ unavailable?: boolean; retire?: boolean; retireDuringMaterialization?: boolean; project?: boolean;
  realProbe?: boolean; env?: NodeJS.ProcessEnv;
  featureToggles?: Record<string, boolean>;
  rules?: typeof catalog.bindings;
  retireDuringDetection?: boolean; reenterDuringHandoff?: boolean;
  detected?: readonly DetectedMcpServerV1[];
  discoveryRegistry?: ResolvedExecutablePluginRuntimeRegistry;
  detectionReady?: () => Promise<void>;
  probeResult?: () => Promise<McpServerProbeResult> }> = {}) {
  const diagnostics: unknown[] = [];
  const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'm1', encryptionMode: 'plain', logger: (message, data) => {
    if (message === '[RPC] Request completed') diagnostics.push(data);
  } });
  const handlers = new Map<string, (raw: unknown) => Promise<unknown>>([
    RPC_METHODS.DAEMON_MCP_SERVERS_TEST, RPC_METHODS.DAEMON_MCP_SERVERS_DETECT, RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
  ].map(method => [method, (raw: unknown) => rpcHandlerManager.invokeLocal(method, raw)] as const));
  let reentered = false;
  let probeObservedReentry = false;
  let observedProtectedEnv: unknown;
  const probe = vi.fn(async (request: Parameters<typeof probeMcpStdioServerTools>[0]) => {
    const { config } = request;
    probeObservedReentry = reentered;
    const configPath = config.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
    if (configPath) observedProtectedEnv = JSON.parse(await readFile(configPath, 'utf8')).env;
    if (input.realProbe) return probeMcpStdioServerTools(request);
    return input.probeResult ? input.probeResult() : { tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }] };
  });
  let handoffScheduled = false;
  const stopHandoffObservation = input.reenterDuringHandoff ? subscribeActiveAccountSettingsSnapshot((_previous, next) => {
    if (handoffScheduled || next?.mcpServerCatalog?.status !== 'ready') return;
    handoffScheduled = true;
    // The real admission/readable/prepare/load Promise handoff runs between
    // these microtasks. Re-entry preserves scope, but retires its lifetime.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      setActiveAccountSettingsSnapshot({ ...next, scopeKey: 'retired-account' });
      setActiveAccountSettingsSnapshot({ ...next, mcpServerCatalog: { status: 'ready', authority: 'active', revision: 4,
        catalog: { v: 1, servers: [], bindings: [] }, diagnostics: [] } });
      reentered = true;
    }))));
  }) : () => undefined;
  const retireAccount = () => {
    const active = getActiveAccountSettingsSnapshot();
    if (active) setActiveAccountSettingsSnapshot({ ...active, scopeKey: 'replacement-account', settingsVersion: 5 });
  };
  const env: NodeJS.ProcessEnv = input.env ?? {};
  if (input.retireDuringMaterialization) {
    // OS environment expansion is a boundary during real async materialization.
    Object.defineProperty(env, 'RETIRE_ACCOUNT', { get: () => { retireAccount(); return 'expanded'; } });
  }
  vi.mocked(axios.get).mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
      key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) } };
    if (path === '/v1/artifacts') return { status: 200, data: new URL(String(url)).searchParams.has('kind')
      ? { items: [], hasUnclassified: false } : [] };
    if (path === '/v1/account/entity-rows/mcp') {
      if (input.retire) retireAccount();
      const rowCatalog = input.project ? { ...catalog, bindings: catalog.bindings.map(rule => ({ ...rule,
        target: { t: 'project' as const, projectKey: 'project' } })) } : input.retireDuringMaterialization ? { ...catalog, servers: catalog.servers.map(server => ({ ...server,
        env: { ...server.env, KEEP: { t: 'literal' as const, v: '${RETIRE_ACCOUNT}' } },
      })) } : catalog;
      return { status: 200, data: input.unavailable ? { status: 'account-mode-mismatch' }
        : { status: 'present', revision: 3, content: { t: 'plain', v: { ...rowCatalog, bindings: input.rules ?? rowCatalog.bindings } } } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: { featureToggles: input.featureToggles ?? {} } } } };
    throw new Error(`Unexpected HTTP path: ${path}`);
  });
  vi.mocked(axios.post).mockImplementation(async url => new URL(String(url)).pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
    ? { status: 200, data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', rows: [], coverage: 'complete' }) }
    : { status: 200, data: { status: 'updated', revision: 4, cursor: 1 } });
  registerMachineMcpServersRpcHandlers({
    rpcHandlerManager,
    deps: {
      env, readCredentials: async () => ({ token: 'rpc-mcp-account', encryption: null }),
      bootstrapAccountSettingsContext: request => bootstrapAccountSettingsContext({ ...request,
        honorAccountSettingsModeEnv: false, deps: { resolveCachePath: resolveAccountSettingsCachePath,
          readCache: async () => null, writeCache: async () => undefined,
          fetchFromServer: async () => ({ settingsVersion: 4, settingsContent: { t: 'plain', v: { featureToggles: input.featureToggles ?? {} } } }),
        },
      }),
      probeMcpStdioServerTools: probe,
      detectProviderMcpServers: async request => {
        await input.detectionReady?.();
        if (input.retireDuringDetection) retireAccount();
        if (input.discoveryRegistry) return detectProviderMcpServers({ ...request, runtimeRegistry: input.discoveryRegistry });
        return { servers: input.detected ?? [], warnings: [] };
      },
    },
  });
  return { handlers, rpcHandlerManager, diagnostics, probe, stopHandoffObservation, didReenter: () => reentered,
    probeObservedReentry: () => probeObservedReentry, readObservedProtectedEnv: () => observedProtectedEnv };
}

describe('Machine MCP catalog admission', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['claude', 'codex'] } }); });
  afterAll(async () => { await runtime?.dispose(); });
  beforeEach(() => { resetInMemoryAccountSettingsContextForTests(); vi.mocked(axios.get).mockReset(); });
  afterEach(() => resetInMemoryAccountSettingsContextForTests());

  it('previews first-party skills through the admitted Home feature and Account preference owners', async () => {
    // Fetch is the external Home boundary; settings, feature decisions, reach and delivery stay real.
    const featureHttp = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      features: { automations: { enabled: true }, workflows: { enabled: true }, deployments: { enabled: true } }, capabilities: {},
    })));
    resetServerFeaturesClientForTests();
    try {
      const owner = register({ featureToggles: { automations: true, deployments: true } });
      const preview = DaemonMcpServersPreviewResponseSchema.parse(await owner.rpcHandlerManager.invokeLocal(
        RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, { machineId: 'm1', agentId: 'codex' },
      ));
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error('preview unavailable');
      for (const id of ['happier:deploy', 'happier:workflows']) {
        expect(preview.skills.items.find(item => item.id === id)).toMatchObject({ selected: true, selectable: true, state: 'delivered' });
      }
      expect(new URL(String(featureHttp.mock.calls[0]?.[0])).pathname).toBe('/v1/features');
      resetInMemoryAccountSettingsContextForTests();
      const disabled = register({ featureToggles: { automations: false, deployments: false } });
      const off = DaemonMcpServersPreviewResponseSchema.parse(await disabled.rpcHandlerManager.invokeLocal(
        RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, { machineId: 'm1', agentId: 'codex' },
      ));
      expect(off.ok).toBe(true);
      if (!off.ok) throw new Error('preview unavailable');
      for (const id of ['happier:deploy', 'happier:workflows']) {
        expect(off.skills.items.find(item => item.id === id)).toMatchObject({ selected: false, selectable: false, reason: 'managed_off' });
      }
    } finally {
      featureHttp.mockRestore();
      resetServerFeaturesClientForTests();
    }
  });

  it('settles the retained preview through its real RPC entry and strict response consumer', async () => {
    const { rpcHandlerManager, diagnostics } = register({ detected: [DetectedMcpServerV1Schema.parse({
      provider: 'codex', name: 'native-tools', transport: 'stdio', stdio: { command: 'native-fixture', args: [] },
      envKeys: [], enabled: true, loadedInHappierSessions: true, source: { kind: 'user', path: '/native/codex/config.toml' },
    })] });
    const result = DaemonMcpServersPreviewResponseSchema.parse(await rpcHandlerManager.invokeLocal(
      RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, { machineId: 'm1', directory: 'C:\\workspace', agentId: 'codex' },
    ));
    expect(result).toMatchObject({ ok: true, builtIn: [{ name: 'happier' }],
      managed: [{ serverId: 'srv-row', selected: true }],
      detected: [{ name: 'native-tools', provider: 'codex', sourceKind: 'detected', selected: true, selectable: false }],
      mcp: { items: [{ id: 'srv-row', selected: true }] } });
    expect(JSON.stringify(result)).not.toContain('removed');
    expect(diagnostics).toEqual([expect.objectContaining({ method: RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, outcomeCode: 'ok' })]);
    rpcHandlerManager.unregisterHandler(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW);
    expect(await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
      { machineId: 'm1', directory: 'C:\\workspace', agentId: 'claude' }))
      .toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  });

  it('previews only the selected Agent without waiting for or reporting another Agent discovery failure', async () => {
    // Plugin-native discovery callbacks are the external integration boundary;
    // keep the host filter, registration, resolver and strict consumer real.
    // The fake carries only the declared sources and the host discovery entry
    // point that detection reads from the production `runtimeRegistry` input.
    const discoveryRegistry = {
      contributes: { mcpDiscoverySources: [
        { pluginId: 'codex', definition: { id: 'native-config', title: 'Codex MCP', loadedInHappierSessions: true, metadata: { agentId: 'codex' } } },
        { pluginId: 'claude', definition: { id: 'other-config', title: 'Claude MCP', loadedInHappierSessions: true, metadata: { agentId: 'claude' } } },
      ] },
      discoverMcpServersForDetection: async ({ localId }: Readonly<{ localId: string }>) => {
        if (localId !== 'native-config') throw new Error('Unrelated Agent discovery unavailable');
        return { endpoints: [{ id: 'native', name: 'native-tools', kind: 'http' as const, url: 'https://native.example.test/mcp' }] };
      },
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const { rpcHandlerManager } = register({ discoveryRegistry });
    const result = DaemonMcpServersPreviewResponseSchema.parse(await rpcHandlerManager.invokeLocal(
      RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, { machineId: 'm1', agentId: 'codex' },
    ));
    expect(result).toMatchObject({ ok: true, detected: [{ name: 'native-tools', provider: 'codex' }] });
    expect(result).not.toHaveProperty('warnings');
  });

  it('reads current skill rules on each finite preview without retained Settings/history maintenance', async () => {
    const { rpcHandlerManager } = register();
    const request = { machineId: 'm1', agentId: 'codex' };
    const initial = vi.mocked(axios.get).getMockImplementation()!;
    let enabled = true;
    const paths: string[] = [];
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      paths.push(path);
      if (path !== PROMPT_LIBRARY_ROWS_ROUTE_V1) return initial(...args);
      return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: enabled ? 1 : 2, content: { t: 'plain', v: key === 'skill-rules'
          ? { key, value: { v: 1, rules: [{ id: 'fixture-rule', skillId: 'happier:happier', enabled,
            target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2 }] } }
          : emptyPromptLibraryRecordV1(key) },
      })) } };
    });
    const first = DaemonMcpServersPreviewResponseSchema.parse(await rpcHandlerManager.invokeLocal(
      RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, request,
    ));
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, skills: { items: [expect.objectContaining({
      id: 'happier:happier', selected: true,
    })] } });
    enabled = false;
    const second = DaemonMcpServersPreviewResponseSchema.parse(await rpcHandlerManager.invokeLocal(
      RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, request,
    ));
    expect(second).toMatchObject({ ok: true, skills: { items: [expect.objectContaining({
      id: 'happier:happier', selected: false,
    })] } });
    expect(paths.filter(path => path === PROMPT_LIBRARY_ROWS_ROUTE_V1)).toHaveLength(2);
    expect(paths.filter(path => path === '/v2/account/settings' || path.includes('/settings/history'))).toEqual([]);
  });

  it('does not serialize independent plugin and native discovery behind the Artifact inventory', async () => {
    let nativeObserved = false;
    let pluginObserved = false;
    const { rpcHandlerManager } = register({ detectionReady: async () => { nativeObserved = true; } });
    const get = vi.mocked(axios.get).getMockImplementation()!;
    const post = vi.mocked(axios.post).getMockImplementation()!;
    let inventoryEntered!: () => void;
    let releaseInventory!: () => void;
    const entered = new Promise<void>(resolve => { inventoryEntered = resolve; });
    const released = new Promise<void>(resolve => { releaseInventory = resolve; });
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === '/v1/artifacts') {
        inventoryEntered();
        await released;
      }
      return get(...args);
    });
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) pluginObserved = true;
      return post(...args);
    });
    const preview = rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
      { machineId: 'm1', agentId: 'codex' });
    try {
      await entered;
      await vi.waitFor(() => {
        expect(pluginObserved).toBe(true);
        expect(nativeObserved).toBe(true);
      });
    } finally { releaseInventory(); await preview; }
    expect(DaemonMcpServersPreviewResponseSchema.parse(await preview)).toMatchObject({ ok: true });
  });

  it('starts the read-only Artifact inventory while Account catalog admission is still pending', async () => {
    const { rpcHandlerManager } = register();
    const get = vi.mocked(axios.get).getMockImplementation()!;
    let enteredCatalog!: () => void;
    let releaseCatalog!: () => void;
    const entered = new Promise<void>(resolve => { enteredCatalog = resolve; });
    const released = new Promise<void>(resolve => { releaseCatalog = resolve; });
    let inventoryObserved = false;
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === '/v1/account/entity-rows/mcp') { enteredCatalog(); await released; }
      if (path === '/v1/artifacts') inventoryObserved = true;
      return get(...args);
    });
    const preview = rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
      { machineId: 'm1', agentId: 'codex' });
    try {
      await entered;
      await vi.waitFor(() => expect(inventoryObserved).toBe(true));
    } finally { releaseCatalog(); await preview; }
    expect(DaemonMcpServersPreviewResponseSchema.parse(await preview)).toMatchObject({ ok: true });
  });

  it('projects selected skill content through the existing Artifact batch read without per-skill requests', async () => {
    const { rpcHandlerManager } = register();
    const get = vi.mocked(axios.get).getMockImplementation()!;
    const post = vi.mocked(axios.post).getMockImplementation()!;
    const artifacts = ['selected-skill', 'off-skill'].map(id => ({ id, ownerAccountId: 'account', access: 'owner' as const,
      encryptionMode: 'plain' as const, publicAudience: 'none' as const, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: encodePlainArtifactStoredContent(PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2',
        title: id, bundleSchemaId: 'skills.skill_md_v1' })),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{
        path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${id}-content\n---\nRead it.`).toString('base64'),
      }] }) }),
    }));
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === '/v1/artifacts') {
        const items = artifacts.map(({ body: _body, ...header }) => header);
        return { status: 200, data: new URL(String(args[0])).searchParams.has('kind')
          ? { items, hasUnclassified: false } : items };
      }
      // Isolated item routes are unavailable; a read preview must use the admitted batch.
      if (path.startsWith('/v1/artifacts/')) return { status: 503, data: {} };
      return get(...args);
    });
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname !== '/v1/artifacts/read') return post(...args);
      const request = ArtifactReadBatchInputV1Schema.parse(args[1]);
      expect(request.artifactIds).toEqual(['selected-skill']);
      return { status: 200, data: ArtifactReadBatchResponseV1Schema.parse({ items: request.artifactIds.map(artifactId => ({
        artifactId, ok: true, artifact: artifacts.find(item => item.id === artifactId), recipientCensus: null,
      })) }) };
    });
    const result = DaemonMcpServersPreviewResponseSchema.parse(await rpcHandlerManager.invokeLocal(
      RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, { machineId: 'm1', agentId: 'codex', capabilitySelection: {
        skills: { v: 1, forceIncludeSkillIds: ['selected-skill'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
      } },
    ));
    expect(result).toMatchObject({ ok: true, skills: { items: expect.arrayContaining([
      expect.objectContaining({ id: 'selected-skill', name: 'selected-skill-content', state: 'delivered' }),
      expect.objectContaining({ id: 'off-skill', state: 'off' }),
    ]) } });
  });

  it('keeps an unavailable Account catalog as a refusal without preview data', async () => {
    const { rpcHandlerManager, diagnostics } = register({ unavailable: true });
    const result = DaemonMcpServersPreviewResponseSchema.parse(await rpcHandlerManager.invokeLocal(
      RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, { machineId: 'm1', directory: 'C:\\workspace', agentId: 'claude' },
    ));
    expect(result).toMatchObject({ ok: false, errorCode: 'internal_error' });
    expect(result).not.toHaveProperty('managed');
    expect(result).not.toHaveProperty('skills');
    expect(diagnostics).toEqual([expect.objectContaining({ outcomeCode: 'internal_error' })]);
  });

  it('withdraws a cancelled retained preview without returning private entries', async () => {
    let enterDetection!: () => void;
    let releaseDetection!: () => void;
    const entered = new Promise<void>(resolve => { enterDetection = resolve; });
    const released = new Promise<void>(resolve => { releaseDetection = resolve; });
    const { rpcHandlerManager, diagnostics } = register({ detectionReady: async () => { enterDetection(); await released; } });
    const controller = new AbortController();
    const request = rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
      { machineId: 'm1', directory: 'C:\\workspace', agentId: 'claude' }, { signal: controller.signal });
    const settled = request.then(value => ({ status: 'returned' as const, value }), error => ({ status: 'thrown' as const, error }));
    try {
      await Promise.race([entered, settled.then(() => { throw new Error('Preview settled before the held discovery boundary'); })]);
      controller.abort();
      releaseDetection();
      expect(await settled).toMatchObject({ status: 'thrown', error: { name: 'AbortError' } });
      expect(diagnostics).toEqual([expect.objectContaining({ method: RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW,
        outcomeCode: 'request_cancelled' })]);
      expect(rpcHandlerManager.getActiveHandlerExecutions()).toEqual([]);
    } finally { releaseDetection(); await settled; }
  });

  it.each([
    { rules: [] },
    { rules: [{ ...catalog.bindings[0]!, target: { t: 'machine' as const, machineId: 'elsewhere' } }] },
    { rules: [{ ...catalog.bindings[0]!, target: { t: 'allMachines' as const }, agentId: 'codex' }] },
  ])('previews explicit Session inclusion through the registered producer independent of defaults %j', ({ rules }) => {
    const { handlers } = register({ rules });
    const preview = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW);
    if (!preview) throw new Error('Missing preview registration');
    return preview({ machineId: 'm1', directory: '/repo', agentId: 'claude', capabilitySelection: {
      mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['srv-row'], forceExcludeServerIds: [] },
    } }).then(raw => {
      expect(DaemonMcpServersPreviewResponseSchema.parse(raw)).toMatchObject({ ok: true,
        managed: [{ serverId: 'srv-row', selected: true, selectable: true, reasonCode: 'forced_included' }] });
    });
  });

  it('keeps released preview input and gives the valid current carrier precedence without malformed fallback', async () => {
    const { handlers } = register();
    const preview = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW)!;
    const target = { machineId: 'm1', directory: 'C:\\workspace', agentId: 'claude' };
    const legacy = { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['srv-row'] };
    expect(await preview({ ...target, selection: legacy })).toMatchObject({ ok: true,
      managed: [{ serverId: 'srv-row', selected: false, reasonCode: 'forced_excluded' }] });
    expect(await preview({ ...target, selection: legacy, capabilitySelection: {
      mcp: { ...legacy, forceExcludeServerIds: [] },
      skills: { v: 1, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
    } })).toMatchObject({ ok: true, managed: [{ serverId: 'srv-row', selected: true }] });
    expect(await preview({ ...target, selection: legacy, capabilitySelection: { mcp: 'invalid' } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_request' });
  });

  it('forwards the authoritative Project key to the existing preview producer without a directory-derived association', async () => {
    const { handlers } = register({ project: true });
    const preview = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW)!;
    const target = { machineId: 'm1', directory: 'C:\\workspace', agentId: 'claude' };
    expect(await preview({ ...target, projectKey: 'project' })).toMatchObject({ ok: true,
      managed: [{ serverId: 'srv-row', selected: true }] });
    expect(await preview({ ...target, projectKey: 'other' })).toMatchObject({ ok: true,
      managed: [{ serverId: 'srv-row', selected: false }] });
    const unassociated = await preview(target);
    expect(unassociated, JSON.stringify(unassociated)).toMatchObject({ ok: true, managed: [{ serverId: 'srv-row', selected: false }] });
    expect(await preview({ ...target, projectKey: 1 })).toMatchObject({ ok: false, errorCode: 'invalid_request' });
  });

  it('tests a saved row server with Windows binding roots and nullable env patches', async () => {
    const { handlers, probe, readObservedProtectedEnv } = register();
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace\\child', serverId: 'srv-row', bindingId: 'binding-row',
    });
    expect(result).toMatchObject({ ok: true, toolCount: 1, toolNamesSample: ['echo'], durationMs: expect.any(Number) });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({
      env: expect.objectContaining({ HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: expect.any(String) }),
    }) }));
    expect(readObservedProtectedEnv()).toEqual({ KEEP: 'present', EXTRA: 'override' });
  });

  it('returns a typed refusal for unavailable catalog facts before probing', async () => {
    const { handlers, probe } = register({ unavailable: true });
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses a retired finite Account capture rather than using another active catalog', async () => {
    const { handlers, probe } = register({ retire: true });
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(probe).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement-account');
  });

  it('refuses OS probe dispatch when literal-only materialization retires the captured Account', async () => {
    const { handlers, probe } = register({ retireDuringMaterialization: true });
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
    });
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement-account');
    expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses private preview results when machine detection retires the captured Account', async () => {
    const { handlers } = register({ retireDuringDetection: true });
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW)!({
      machineId: 'm1', directory: 'C:\\workspace', agentId: 'claude',
    });
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement-account');
    expect(result).toMatchObject({ ok: false, errorCode: 'internal_error' });
    expect(result).not.toHaveProperty('managed');
  });

  it('keeps original Account lifetime custody across an admitted-load handoff', async () => {
    const { handlers, probe, stopHandoffObservation, didReenter, probeObservedReentry } = register({ reenterDuringHandoff: true });
    try {
      const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
        t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
      });
      expect(didReenter()).toBe(true);
      // If the incumbent dispatched, establish that it blessed the old facts
      // after re-entry rather than merely observing an already-issued effect.
      if (probe.mock.calls.length > 0) expect(probeObservedReentry()).toBe(true);
      expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
      expect(probe).not.toHaveBeenCalled();
    } finally {
      stopHandoffObservation();
    }
  });

  it.each(['updated', 'conflict'] as const)('tests an installed plugin id through registration and snapshot CAS (%s)', async writeStatus => {
    const pluginId = `acme.mcp-test.${writeStatus}`;
    const serverId = `plugin:${pluginId}/tools`;
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      happyHomeDir: configuration.happyHomeDir,
      resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir })),
      plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { mcp: { servers: [
          { id: 'tools', title: 'Tools', kind: 'dynamic', sessionScope: 'session' },
        ] } } }),
        files: { 'daemon.mjs': `export function activate(api) {
          api.mcp.registerServer('tools', {
            async listTools() { return { items: [{ name: 'echo', inputSchema: { type: 'object' } }] }; }, async callTool() { return {}; },
            async listResources() { return { items: [] }; }, async listResourceTemplates() { return { items: [] }; },
            async readResource(request) { return { contents: [{ uri: request.uri, text: '' }] }; },
            async subscribeResource() { return { dispose() {} }; }, async listPrompts() { return { items: [] }; },
            async getPrompt() { return { messages: [] }; }, async dispose() {}
          });
        }` },
      }] });
    let held: McpServerCatalogV1 = { v: 1, servers: [], bindings: [], pluginServers: {
      [serverId]: { tools: { default: 'ask', overrides: { write: 'off' } } },
    } };
    let revision = 3;
    const { rpcHandlerManager, probe } = register({ realProbe: true,
      env: { ...process.env, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' } });
    const get = vi.mocked(axios.get).getMockImplementation()!;
    const post = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (...args) => new URL(String(args[0])).pathname === '/v1/account/entity-rows/mcp'
      ? { status: 200, data: { status: 'present', revision, content: { t: 'plain', v: held } } } : get(...args));
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname !== '/v1/account/entity-rows/mcp') return post(...args);
      const mutation = McpServerCatalogRowMutationV1Schema.parse(args[1]);
      expect(mutation.expectedRevision).toBe(revision);
      if (writeStatus === 'conflict') return { status: 409, data: { status: 'conflict', revision: revision + 1 } };
      const opened = openMcpServerCatalogContentV1({ content: mutation.content, mode: 'plain', material: null });
      if (opened.status !== 'opened') throw new Error('Expected current catalog write');
      held = opened.catalog;
      revision += 1;
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
    try {
      const result = DaemonMcpServersTestResponseSchema.parse(await rpcHandlerManager.invokeLocal(
        RPC_METHODS.DAEMON_MCP_SERVERS_TEST, { t: 'byId', serverId, machineId: 'm1', directory: '/tmp' },
      ));
      expect(result).toMatchObject(writeStatus === 'updated' ? { ok: true, toolCount: 1, toolNamesSample: ['echo'] }
        : { ok: false, errorCode: 'materialization_failed', error: 'mcp_tools_snapshot_conflict' });
      expect(probe).toHaveBeenCalled();
      expect(held.servers).toEqual([]);
      expect(held.pluginServers?.[serverId]?.tools).toEqual({ default: 'ask', overrides: { write: 'off' } });
      if (writeStatus === 'updated') expect(held.pluginServers?.[serverId]?.toolsSnapshot).toMatchObject({
        machineId: 'm1', checkedAt: expect.any(Number), tools: [{ name: 'echo', tokens: expect.any(Number) }],
      });
      else expect(held.pluginServers?.[serverId]?.toolsSnapshot).toBeUndefined();
    } finally { await fixture.dispose(); }
  });

  it('refuses private tool names after same-Account reentry while the OS probe is in flight', async () => {
    let markProbeStarted = () => {};
    const probeStarted = new Promise<void>(resolve => { markProbeStarted = resolve; });
    let releaseProbe = () => {};
    const probeResult = new Promise<McpServerProbeResult>(resolve => {
      releaseProbe = () => resolve({ tools: [{ name: 'retired-account-private-tool', inputSchema: { type: 'object' } }] });
    });
    const { handlers } = register({ probeResult: async () => { markProbeStarted(); return probeResult; } });
    const request = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
    });
    try {
      await probeStarted;
      const original = getActiveAccountSettingsSnapshot();
      if (!original) throw new Error('Probe did not capture an Account');
      setActiveAccountSettingsSnapshot({ ...original, scopeKey: 'retired-account' });
      setActiveAccountSettingsSnapshot({ ...original });
      releaseProbe();
      const result = await request;
      expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
      expect(JSON.stringify(result)).not.toContain('retired-account-private-tool');
    } finally {
      releaseProbe();
      await request;
    }
  });
});
