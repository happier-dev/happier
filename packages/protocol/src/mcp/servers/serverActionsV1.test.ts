import { describe, expect, it } from 'vitest';
import { MCP_SERVER_ACTION_SPECS_V1 } from '../../actions/specs/mcpServers.js';
import { MCP_SERVER_ACTION_IDS_V1 } from './serverActionIdsV1.js';
import { createMcpServerActionExecuteV1, projectMcpServerActionFailureV1, MCP_SERVER_ACTION_INPUT_SCHEMAS_V1,
  MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from './serverActionsV1.js';
import { applyMcpServerCatalogMutationV1, commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from './serverCatalogV1.js';
import type { McpServerCatalogV1 } from './serverRowsV1.js';
import { reachRulesToDraftsV1 } from '../../reach/reachRulesChangeV1.js';
import { mcpPluginItemIdV1 } from './settingsV1.js';
import { projectMcpToolLaunchPolicyV1 } from './tools/resolveMcpToolDecisionV1.js';
import { AgentSessionConfigurationUpdateV1Schema } from '../../runtime/agentSessionV1.js';
import { createRegistryHostV1 } from '../../registries/registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '../../registries/registrySourcesV1.js';
import { MCP_REGISTRY_V01_READ_FIXTURE } from '../../registries/formats/fixtures/mcpRegistryV01Fixture.js';
import { createPersonalSavedSecretActionExecuteV1 } from '../../account/settings/personalSavedSecretActionsV1.js';
import { parseMcpServerImportV1 } from './import/parseMcpServerImportV1.js';
import { DaemonMcpServersTestRequestSchema } from './daemonRpcV1.js';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, RpcError } from '../../rpc/errors.js';

it('preserves admitted RPC refusals without exposing transport messages', () => {
  const message = 'private transport diagnostic';
  for (const [cause, errorCode] of [
    [new RpcError(message, RPC_ERROR_CODES.OUTCOME_UNKNOWN), RPC_ERROR_CODES.OUTCOME_UNKNOWN],
    [new RpcError(message, RPC_ERROR_CODES.FORBIDDEN), RPC_ERROR_CODES.FORBIDDEN],
    [Object.assign(new Error(message), { code: MACHINE_RPC_TIMEOUT_ERROR_CODE }), MACHINE_RPC_TIMEOUT_ERROR_CODE],
  ] as const) {
    expect(projectMcpServerActionFailureV1(cause)).toEqual({ ok: false, errorCode, error: errorCode });
  }
  expect(projectMcpServerActionFailureV1(new RpcError(message, 'untrusted-private-code')))
    .toEqual({ ok: false, errorCode: 'mcp_catalog_operation_failed', error: 'mcp_catalog_operation_failed' });
  expect(projectMcpServerActionFailureV1(new Error(message), 'host_admission')).toMatchObject({
    ok: false, errorCode: 'mcp_sign_in_host_admission_failed', error: 'mcp_sign_in_host_admission_failed',
    details: { stage: 'host_admission' },
  });
});

describe('canonical MCP Action owner', () => {
  it('discovers and individually creates the four static Cloudflare suggestions without network or grants', async () => {
    const spec = MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.create')!;
    const options = spec.inputHints?.fields.find(field => field.path === 'suggestionId')?.options;
    expect(options?.map(option => option.value)).toEqual([
      'cloudflare-api', 'cloudflare-docs', 'cloudflare-browser', 'cloudflare-containers',
    ]);
    const expected = [
      ['cloudflare-api', 'Cloudflare API', 'https://mcp.cloudflare.com/mcp', true],
      ['cloudflare-docs', 'Cloudflare Docs', 'https://docs.mcp.cloudflare.com/mcp', false],
      ['cloudflare-browser', 'Cloudflare Browser Run', 'https://browser.mcp.cloudflare.com/mcp', true],
      ['cloudflare-containers', 'Cloudflare Containers', 'https://containers.mcp.cloudflare.com/mcp', true],
    ] as const;
    for (const [suggestionId, title, url, oauth] of expected) {
      let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] }; let revision = 0; let ids = 0;
      const execute = createMcpServerActionExecuteV1({
        ruleWriteContext: () => ({ nowMs: 10, newId: () => `id-${++ids}` }),
        readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
          readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
        mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
          writeCatalog: async candidate => {
            if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
            catalog = candidate.catalog; return { status: 'updated', revision: ++revision, cursor: revision };
          } }),
        machine: async () => { throw new Error('Suggestion create cannot start code'); },
        registryActionExecute: async () => { throw new Error('Suggestions cannot fetch registry data'); },
        connectedServiceAction: async () => { throw new Error('Suggestion create cannot grant sign-in'); },
      });
      const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
      const input = { expectedRevision: 0, suggestionId,
        where: { kind: 'write', write: { place: { t: 'machine', machineId: 'chosen-machine' }, state: 'on' } } } as const;
      const schema = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.create'];
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, suggestionId: 'unknown' }).success).toBe(false);
      expect(schema.safeParse({ ...input, remote: { auth: { kind: 'oauth' } } }).success).toBe(false);
      const review = spec.approvalPresentation!.projectInput(input);
      expect(review).toMatchObject({ servers: [{ title, address: url, ...(oauth ? { signIn: 'OAuth' } : {}) }], where: input.where });
      if (!oauth) expect(JSON.stringify(review)).not.toContain('OAuth');
      expect(await execute({ actionId: 'mcp.servers.create', input, context })).toEqual({ ok: true,
        result: { status: 'updated', revision: 1, cursor: 1, serverId: 'id-1' } });
      expect(catalog.servers).toHaveLength(1);
      expect(catalog.servers[0]).toMatchObject({ id: 'id-1', name: suggestionId, title, transport: 'http',
        remote: { url, headers: {} }, env: {}, createdAt: 10, updatedAt: 10 });
      expect(catalog.servers[0]?.remote?.auth).toEqual(oauth ? { kind: 'oauth' } : undefined);
      expect(catalog.servers[0]?.origin).toBeUndefined();
      expect(projectMcpToolLaunchPolicyV1({ policy: catalog.servers[0]?.tools, snapshot: undefined,
        permissionMode: 'default' })).toEqual({ unlisted: 'ask', tools: {} });
      expect(catalog.bindings).toMatchObject([{ serverId: 'id-1', enabled: true, target: input.where.write.place }]);
      expect(await execute({ actionId: 'mcp.servers.create', input, context })).toMatchObject({ ok: false, errorCode: 'mcp_catalog_conflict' });
      expect(catalog.servers).toHaveLength(1);
    }
  });
  it('duplicates by source identity under catalog CAS with unique names, default reach and no sign-in transfer', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [{ id: 'source-rule', serverId: 'source', enabled: false,
      target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }], servers: [{ id: 'source', name: 'issues', title: 'Issues',
      transport: 'http', remote: { url: 'https://mcp.example.test', auth: { kind: 'oauth' },
        headers: { Authorization: { t: 'savedSecret', secretId: 'private-secret-ref' } } }, env: {},
      configOverrides: [{ target: { t: 'machine', machineId: 'machine' }, remote: { url: 'https://other.example.test' } }],
      tools: { default: 'ask', overrides: { write: 'off' } }, createdAt: 1, updatedAt: 1 },
      { id: 'collision', name: 'issues_copy', transport: 'stdio', stdio: { command: 'tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] };
    let revision = 7; let ids = 0; let conflict = false;
    const execute = createMcpServerActionExecuteV1({
      ruleWriteContext: () => ({ nowMs: 10, newId: () => `new-${++ids}` }),
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        writeCatalog: async candidate => {
          if (conflict || candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog; return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      machine: async () => { throw new Error('Duplicate must not transfer sign-in or launch code'); },
      connectedServiceAction: async () => { throw new Error('Duplicate must not read or copy OAuth state'); },
    });
    const context = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'session' } as const;
    const input = { serverId: 'source' };
    const schema = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.duplicate'];
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, entry: catalog.servers[0], expectedRevision: 7 }).success).toBe(false);
    const first = await execute({ actionId: 'mcp.servers.duplicate', input, context });
    expect(first).toEqual({ ok: true, result: { serverId: 'new-1' } });
    expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.duplicate'].parse(first.ok ? first.result : null)).toEqual({ serverId: 'new-1' });
    expect(JSON.stringify(first)).not.toContain('private-');
    expect(catalog.servers[2]).toEqual({ ...catalog.servers[0], id: 'new-1', name: 'issues_copy_2', title: 'Issues copy', createdAt: 10, updatedAt: 10 });
    expect(catalog.bindings.filter(rule => rule.serverId === 'new-1')).toMatchObject([{ enabled: true, target: { t: 'allMachines' } }]);
    const second = await execute({ actionId: 'mcp.servers.duplicate', input, context });
    expect(second.ok).toBe(true);
    expect(catalog.servers[3]?.name).toBe('issues_copy_3');
    conflict = true;
    expect(await execute({ actionId: 'mcp.servers.duplicate', input, context })).toMatchObject({ ok: false, errorCode: 'mcp_catalog_conflict' });
    expect(catalog.servers).toHaveLength(4);
    expect(await execute({ actionId: 'mcp.servers.duplicate', input: { serverId: 'missing' }, context }))
      .toMatchObject({ ok: false, errorCode: 'mcp_server_not_found' });
  });
  it('authors tests only for saved servers while accepting released draft requests at daemon ingress', () => {
    const action = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.test'];
    const saved = { t: 'byId', machineId: 'machine', directory: '/repo', serverId: 'one' };
    expect(action.parse(saved)).toEqual(saved);
    expect(DaemonMcpServersTestRequestSchema.parse(saved)).toEqual(saved);
    // ui-web-v0.2.17-preview.19, McpServerTestPanel.tsx:136–141.
    const draft = { t: 'draft', machineId: 'machine', directory: '/repo', binding: null,
      server: { id: 'one', name: 'one', transport: 'stdio', stdio: { command: 'tool', args: [] },
        env: {}, createdAt: 1, updatedAt: 1 } };
    expect(DaemonMcpServersTestRequestSchema.safeParse(draft).success).toBe(true);
    expect(action.safeParse(draft).success).toBe(false);
  });

  it('keeps saved SSE OAuth rows readable without offering an unsupported install link', async () => {
    const catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'one', name: 'one', transport: 'sse',
      remote: { url: 'https://mcp.example.test/events', headers: {}, auth: { kind: 'oauth' } },
      env: {}, createdAt: 1, updatedAt: 1 }] };
    const execute = createMcpServerActionExecuteV1({
      resolveWebappUrl: () => 'https://web.example.test',
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) }),
      mutate: async () => { throw new Error('Read cannot mutate'); },
      machine: async () => { throw new Error('Read cannot start sign-in'); },
    });
    const receipt = await execute({ actionId: 'mcp.servers.read', input: { serverId: 'one' }, context: { surface: 'ui' } });
    const output = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].parse(receipt.ok ? receipt.result : null);
    expect(output).toMatchObject({ status: 'present', server: catalog.servers[0] });
    expect(output).not.toHaveProperty('installLink');
  });

  it('reads an install link through the output schema and the shared importer without exporting values', async () => {
    const catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'one', name: 'one', transport: 'http',
      remote: { url: 'https://mcp.example.test', headers: { Authorization: { t: 'literal', v: 'private-header' } } },
      env: { TOKEN: { t: 'savedSecret', secretId: 'private-secret-ref' } }, createdAt: 1, updatedAt: 1 }] };
    const execute = createMcpServerActionExecuteV1({
      resolveWebappUrl: () => 'https://web.example.test',
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) }),
      mutate: async () => { throw new Error('Read cannot mutate'); },
      machine: async () => { throw new Error('Read cannot launch a Machine'); },
    });
    const receipt = await execute({ actionId: 'mcp.servers.read', input: { serverId: 'one' }, context: { surface: 'ui' } });
    expect(receipt).toMatchObject({ ok: true, result: { status: 'present', installLink: expect.any(String) } });
    const output = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].parse(receipt.ok ? receipt.result : null);
    if (!('installLink' in output) || typeof output.installLink !== 'string') throw new Error('Missing install link');
    expect(new URL(output.installLink).origin).toBe('https://web.example.test');
    const imported = parseMcpServerImportV1(output.installLink);
    expect(imported.errors).toEqual([]);
    expect(imported.servers).toMatchObject([{ name: 'one', transport: 'http', remote: { url: 'https://mcp.example.test' } }]);
    expect(imported.inputs.map(input => input.title).sort()).toEqual(['Authorization', 'TOKEN']);
    expect(JSON.stringify(imported)).not.toContain('private-');
  });

  it('preserves an acknowledged secret when the catalog write outcome is unknown', async () => {
    const catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
    const secretWrites: unknown[] = [];
    const secrets = createPersonalSavedSecretActionExecuteV1({ list: async () => [],
      create: async input => { secretWrites.push(input); return { secretId: 'private-resource', secretRef: 'acknowledged-ref' }; },
      update: async () => { throw new Error('Unexpected update'); }, delete: async () => { throw new Error('Unexpected delete'); } });
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'present', revision: 0, content: { t: 'plain', v: catalog } }) }),
      personalSavedSecretActionExecute: request => secrets(request.actionId, request.input),
      mutate: (change) => commitMcpServerCatalogMutationV1({ catalog, revision: 0, change, scope: null,
        writeCatalog: async () => { throw Object.assign(new Error('Transport reply unavailable'), { code: 'outcome_unknown' }); } }),
      machine: async () => { throw new Error('Unexpected Machine'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const run = (values: unknown) => execute({ actionId: 'mcp.servers.import', context, input: {
      source: { kind: 'paste', text: JSON.stringify({ servers: { one: { command: 'tool', env: { API_KEY: 'private-source-token' } } } }) },
      dryRun: false, values,
    } });
    const result = await run({ 'one:env:API_KEY': { t: 'saveSecret', name: 'Imported key' } }).catch(() => ({ ok: false, errorCode: 'unprojected-failure' }));
    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown', details: { movedSecrets: [{
      inputId: 'one:env:API_KEY', secretId: 'private-resource', secretRef: 'acknowledged-ref',
    }] } });
    expect(JSON.stringify(result)).not.toContain('private-source-token');
    await run({ 'one:env:API_KEY': { t: 'savedSecret', secretId: 'acknowledged-ref' } }).catch(() => undefined);
    expect(secretWrites).toHaveLength(1);
  });
  it('requires explicit import and Found values before writing and accepts an admitted machine choice', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] }; let revision = 0; let ids = 0;
    const execute = createMcpServerActionExecuteV1({
      ruleWriteContext: () => ({ nowMs: 10, newId: () => `id-${++ids}` }),
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        writeCatalog: async candidate => {
          if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog; return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      machine: async () => { throw new Error('Import preparation cannot run third-party code'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const imported = { actionId: 'mcp.servers.import' as const, context,
      input: { expectedRevision: 0, dryRun: false, source: { kind: 'paste', text: JSON.stringify({ servers: { one: {
        command: 'tool', env: { API_KEY: '${API_KEY}' },
      } } }) } } };
    // The host already projects family errors through this real owner. Missing
    // dispatch is an observable typed operation failure, rather than a test setup failure.
    expect(await execute(imported).catch(projectMcpServerActionFailureV1)).toMatchObject({ ok: false, errorCode: 'missing_values',
      details: { missingValues: [{ inputId: 'one:env:API_KEY' }] } });
    expect(catalog.servers).toEqual([]);
    const adopted = { actionId: 'mcp.found.adopt' as const, context, input: { expectedRevision: 0, machineId: 'machine-1', items: [{
      provider: 'claude', name: 'one', transport: 'stdio', stdio: { command: 'tool', args: [] }, envKeys: ['API_KEY'],
      enabled: true, source: { kind: 'user', path: '/config.json' },
    }] } };
    expect(await execute(adopted).catch(projectMcpServerActionFailureV1)).toMatchObject({ ok: false, errorCode: 'missing_values' });
    expect(revision).toBe(0);
    expect(await execute({ ...adopted, input: { ...adopted.input, values: {
      'one:env:API_KEY': { t: 'literal', v: '${API_KEY}' },
    } } }).catch(projectMcpServerActionFailureV1)).toMatchObject({ ok: true, result: { ok: true, revision: 1 } });
    expect(catalog.servers[0]).toMatchObject({ env: { API_KEY: { t: 'literal', v: '${API_KEY}' } },
      origin: { kind: 'machine', machineId: 'machine-1', agentId: 'claude' } });
    expect(catalog.bindings).toMatchObject([{ enabled: true, target: { t: 'allMachines' } }]);
  });
  it('creates a pinned registry server only after required value choices through the real catalog owner', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] }; let revision = 0;
    let registryResponse: unknown = { ...MCP_REGISTRY_V01_READ_FIXTURE, server: {
      ...MCP_REGISTRY_V01_READ_FIXTURE.server, icons: [
        { src: 'https://example.test/light.png', theme: 'light' },
        { src: 'https://example.test/dark.png', theme: 'dark' },
      ],
    } };
    const host = createRegistryHostV1({ host: 'web', readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1,
      http: { getJson: async () => ({ ok: true, value: registryResponse, fetchedAt: 10 }),
        getText: async () => { throw new Error('Unexpected read'); }, getBytes: async () => { throw new Error('Unexpected read'); } } });
    const execute = createMcpServerActionExecuteV1({
      ...{ registryActionExecute: async (request: { actionId: Parameters<typeof host.execute>[0]; input: unknown }) => host.execute(request.actionId, request.input) },
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        writeCatalog: async candidate => { if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog; return { status: 'updated', revision: ++revision, cursor: revision }; } }),
      machine: async () => { throw new Error('Registry create does not start code'); },
    });
    const input = { expectedRevision: 0, from: { registry: { sourceId: 'builtin:mcp-registry', itemId: 'com.playwrightgen/playwrightgen', version: '1.0.0' } } };
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.servers.create', input, context })).toMatchObject({ ok: false, errorCode: 'missing_values' });
    expect(catalog.servers).toEqual([]);
    const createInput = { ...input, inputs: { Authorization: { t: 'template' as const, template: 'Bearer {api_key}',
      vars: { api_key: { t: 'savedSecret' as const, secretId: 'chosen-personal-ref' } } } } };
    const created = await execute({ actionId: 'mcp.servers.create', input: createInput, context });
    expect(created).toMatchObject({ ok: true, result: { status: 'updated', serverId: catalog.servers[0]!.id } });
    expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.create'].parse(created.ok ? created.result : null))
      .toMatchObject({ serverId: catalog.servers[0]!.id });
    expect(await execute({ actionId: 'mcp.servers.create', input: createInput, context }))
      .toMatchObject({ ok: false, errorCode: 'mcp_catalog_conflict' });
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.servers[0]).toMatchObject({ transport: 'http', origin: { kind: 'registry', provenance: { itemId: input.from.registry.itemId,
      ref: { kind: 'version', version: '1.0.0' } } }, remote: { headers: { Authorization: { t: 'template' } } } });
    expect(catalog.servers[0]?.origin).toMatchObject({ iconUrl: 'https://example.test/light.png', iconDarkUrl: 'https://example.test/dark.png' });
    const reopened = await loadMcpServerCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: JSON.parse(JSON.stringify(catalog)) } }) });
    expect(reopened).toMatchObject({ status: 'ready', catalog: { servers: [{ origin: {
      iconUrl: 'https://example.test/light.png', iconDarkUrl: 'https://example.test/dark.png',
    } }] } });
    expect(catalog.bindings).toMatchObject([{ enabled: true, target: { t: 'allMachines' } }]);
    const registryVersion = (version: string) => ({ ...MCP_REGISTRY_V01_READ_FIXTURE, server: {
      ...MCP_REGISTRY_V01_READ_FIXTURE.server, version, remotes: [{ type: 'streamable-http',
        url: 'https://example.test/{tenant}?key={api_key}', variables: {
          tenant: { isRequired: true }, api_key: { isRequired: true, isSecret: true },
        } }],
    } });
    const serverId = catalog.servers[0]!.id;
    registryResponse = registryVersion('2.0.0');
    const updateInput = { serverId, from: { registry: { ...input.from.registry, version: '2.0.0' } } };
    expect(await execute({ actionId: 'mcp.servers.update', context, input: { ...updateInput, expectedRevision: 1,
      inputs: { tenant: { t: 'literal', v: 'acme' }, api_key: { t: 'savedSecret', secretId: 'url-secret-ref' } },
    } })).toMatchObject({ ok: true });
    registryResponse = registryVersion('3.0.0');
    expect(await execute({ actionId: 'mcp.servers.update', context, input: { ...updateInput, expectedRevision: 2,
      from: { registry: { ...input.from.registry, version: '3.0.0' } },
    } })).toMatchObject({ ok: true });
    expect(catalog.servers[0]?.remote?.urlTemplate).toMatchObject({ vars: {
      tenant: { t: 'literal', v: 'acme' }, api_key: { t: 'savedSecret', secretId: 'url-secret-ref' },
    } });
  });
  it('lists the checked tool snapshot, settings and cost without disclosing server configuration', async () => {
    expect(MCP_SERVER_ACTION_SPECS_V1.some(spec => spec.id === 'mcp.servers.tools.list')).toBe(true);
    const snapshot = { checkedAt: 2, machineId: 'checked-machine', protocolVersion: '2025-11-25',
      serverInfo: { name: 'fixture', version: '1' }, instructions: 'Use these tools.', tools: [
        { name: 'read', title: 'Read', annotations: { readOnlyHint: true }, tokens: 12 },
        { name: 'mutate', description: 'Change data', tokens: 8 },
      ] };
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{
      id: 'server', name: 'server', transport: 'http', remote: { url: 'https://example.test/private',
        headers: { Authorization: { t: 'literal', v: 'private-value' } } }, env: {}, createdAt: 1, updatedAt: 1,
      tools: { default: 'allow_read_only', overrides: { mutate: 'off' } }, toolsSnapshot: snapshot,
    }] };
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision: 9, content: { t: 'plain', v: catalog } }) }),
      mutate: async () => { throw new Error('Tool reads do not write'); },
      machine: async () => { throw new Error('Tool reads do not start servers'); },
    });
    const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const result = await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' }, context });
    expect(result).toMatchObject({ ok: true, result: { serverId: 'server', revision: 9, snapshot,
      settings: { default: 'allow_read_only', tools: { mutate: 'off' } }, tokens: 20,
      tools: [{ name: 'read', setting: 'inherit', source: 'server_default' },
        { name: 'mutate', setting: 'off', source: 'tool' }],
      perAgent: { status: 'unavailable', agents: [] },
    } });
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(JSON.stringify(result)).not.toContain('https://example.test/private');
    const withAgentFacts = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision: 9, content: { t: 'plain', v: catalog } }) }),
      readToolAgentFacts: async () => ({ machineId: 'facts-machine', agents: [{ agentId: 'unproven' }, { agentId: 'on-demand',
        mcpToolControl: { off: 'blocked', approval: 'host' }, mcpToolLoading: 'on_demand' },
      { agentId: 'native-hidden', mcpToolControl: { off: 'hidden', approval: 'native' } }] }),
      mutate: async () => { throw new Error('Tool reads do not write'); },
      machine: async () => { throw new Error('Tool reads do not start servers'); },
    });
    expect(await withAgentFacts({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' }, context }))
      .toMatchObject({ ok: true, result: { perAgent: { status: 'ready', machineId: 'facts-machine', agents: [
        { agentId: 'unproven', approval: null, off: null, loading: 'every_turn', tokens: 20 },
        { agentId: 'on-demand', approval: 'host', off: 'blocked', loading: 'on_demand', tokens: 20 },
        { agentId: 'native-hidden', approval: 'native', off: 'hidden', loading: 'every_turn', tokens: 12 },
      ] } } });
    catalog = { ...catalog, servers: catalog.servers.map(({ toolsSnapshot: _snapshot, ...server }) => server) };
    expect(await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' }, context }))
      .toMatchObject({ ok: true, result: { tools: [], tokens: null } });
  });

  it('patches tool settings through the catalog CAS and resends its previous patch for Undo', async () => {
    expect(MCP_SERVER_ACTION_SPECS_V1.some(spec => spec.id === 'mcp.servers.tools.set')).toBe(true);
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'server', name: 'server', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1,
      tools: { default: 'ask', overrides: { keep: 'off', existing: 'ask' } },
    }] };
    const original = catalog;
    let revision = 9;
    let refuseWrite = false;
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        writeCatalog: async candidate => {
          if (refuseWrite || candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog;
          return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      machine: async () => { throw new Error('Tool settings are Account-owned'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const set = await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: 'server',
      tools: { added: 'allow', existing: 'inherit' } }, context });
    expect(set).toEqual({ ok: true, result: { revision: 10, previous: { tools: { added: 'inherit', existing: 'ask' } } } });
    expect(catalog.servers[0]?.tools).toEqual({ default: 'ask', overrides: { keep: 'off', added: 'allow' } });
    if (!set.ok) throw new Error('Tool update refused');
    const committed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse(set.result);
    await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: 'server', ...committed.previous }, context });
    const assertRestored = () => {
      expect(catalog.servers[0]!.updatedAt).toBeGreaterThan(original.servers[0]!.updatedAt);
      expect(catalog).toEqual({ ...original, servers: [{ ...original.servers[0]!, updatedAt: catalog.servers[0]!.updatedAt }] });
    };
    assertRestored();
    const setDefault = await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: 'server', default: 'allow_all' }, context });
    expect(catalog.servers[0]?.tools).toEqual({ default: 'allow_all', overrides: { keep: 'off', existing: 'ask' } });
    if (!setDefault.ok) throw new Error('Default update refused');
    const previousDefault = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse(setDefault.result).previous;
    await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: 'server', ...previousDefault }, context });
    assertRestored();
    const objectNameSet = await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: 'server',
      tools: JSON.parse('{"__proto__":"off","constructor":"allow"}') }, context });
    if (!objectNameSet.ok) throw new Error('Object-name tool update refused');
    expect(catalog.servers[0]?.tools?.overrides).toEqual({ keep: 'off', existing: 'ask',
      ...JSON.parse('{"__proto__":"off","constructor":"allow"}') });
    const listed = await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' }, context });
    expect(listed).toMatchObject({ ok: true, result: { settings: { tools: JSON.parse('{"__proto__":"off","constructor":"allow"}') } } });
    const projected = projectMcpToolLaunchPolicyV1({ policy: catalog.servers[0]?.tools, snapshot: undefined, permissionMode: 'yolo' });
    const update = { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
      permissionIntent: { value: 'yolo', updatedAtMs: 0 }, options: {}, mcpToolPolicy: { server: projected } };
    expect(AgentSessionConfigurationUpdateV1Schema.parse(update)).toEqual(update);
    expect(Object.hasOwn(projected.tools, '__proto__')).toBe(true);
    expect(projected.tools['__proto__']).toBe('off');
    const previousObjectNames = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.set'].parse(objectNameSet.result).previous;
    await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: 'server', ...previousObjectNames }, context });
    assertRestored();
    const beforeConflict = catalog;
    refuseWrite = true;
    expect(await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: 'server', tools: { added: 'allow' } }, context }))
      .toEqual({ ok: false, errorCode: 'mcp_catalog_conflict', error: 'mcp_catalog_conflict' });
    expect(catalog).toBe(beforeConflict);
  });

  it('changes named server rules in one catalog CAS and returns the committed value and Undo input', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'linear', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'old-rule', serverId: 'server', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    let revision = 9;
    const originalRules = catalog.bindings.map(({ serverId: _serverId, ...rule }) => rule);
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        ctx: { nowMs: 2, newId: () => 'new-rule' },
        writeCatalog: async candidate => {
          if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog;
          return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      machine: async () => { throw new Error('Rules are Account-owned'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const result = await execute({ actionId: 'mcp.rules.set', input: {
      items: [{ name: 'linear' }], change: { kind: 'write', write: { place: { t: 'machine', machineId: 'machine' }, state: 'off' } },
    }, context });
    const currentRules = catalog.bindings.map(({ serverId: _serverId, ...rule }) => rule);
    expect(result).toEqual({ ok: true, result: { ok: true, revision: 10,
      items: [{ serverId: 'server', rules: currentRules, previous: originalRules }] } });
    expect(currentRules).toEqual([...originalRules, { id: 'new-rule', target: { t: 'machine', machineId: 'machine' },
      enabled: false, createdAt: 2, updatedAt: 2 }]);
    const undo = await execute({ actionId: 'mcp.rules.set', input: {
      items: [{ serverId: 'server' }], change: { kind: 'replace', rules: reachRulesToDraftsV1(originalRules) },
    }, context });
    expect(undo).toMatchObject({ ok: true, result: { ok: true, revision: 11, items: [{ rules: originalRules }] } });
    const beforeMissing = catalog;
    expect(await execute({ actionId: 'mcp.rules.set', input: {
      items: [{ name: 'missing' }], change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } },
    }, context })).toEqual({ ok: true, result: { ok: false, code: 'not_found' } });
    expect(catalog).toBe(beforeMissing);
  });
  it('declares the complete closed family and requires explicit destructive cleanup input', () => {
    expect(new Set(MCP_SERVER_ACTION_SPECS_V1.map(spec => spec.id))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    expect(new Set(Object.keys(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    expect(new Set(Object.keys(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    const deletion = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.delete'];
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server' }).success).toBe(false);
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server', removeBindings: true, shell: 'unsafe' }).success).toBe(false);
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server', removeBindings: true }).success).toBe(true);
    const byIdTest = { t: 'byId', machineId: 'machine', directory: '/repo', serverId: 'server' };
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.test'].safeParse(byIdTest).success).toBe(true);
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.test'].safeParse({ ...byIdTest,
      unownedLaunch: 'unsafe' }).success).toBe(false);
    for (const id of ['mcp.servers.create', 'mcp.servers.delete', 'mcp.servers.test'] as const) {
      expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === id)?.safety).toBe('danger');
    }
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.test')?.executionPlacement).toBe('machine');
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.list')?.executionPlacement).toBe('account');
  });

  it('refuses unsupported plugin items atomically even when their reserved rules are readable', async () => {
    const missingPluginItemId = mcpPluginItemIdV1({ pluginId: 'acme.unknown', localId: 'item' });
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'linear', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'reserved-rule', serverId: missingPluginItemId, enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    const original = catalog;
    let revision = 9;
    // Only row persistence is replaced; the loader, Action, reducer and CAS
    // stay real so a syntactic plugin id cannot acknowledge dormant reach.
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
        ctx: { nowMs: 2, newId: () => 'new-rule' },
        writeCatalog: async candidate => {
          if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
          catalog = candidate.catalog;
          return { status: 'updated', revision: ++revision, cursor: revision };
        } }),
      machine: async () => { throw new Error('Rules are Account-owned'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.rules.set', input: {
      items: [{ serverId: 'server' }, { serverId: missingPluginItemId }],
      change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } },
    }, context })).toEqual({ ok: true, result: { ok: false, code: 'not_found' } });
    expect(catalog).toBe(original);
    expect(revision).toBe(9);
  });

  it('keeps list configuration private and removes referenced bindings only on explicit cleanup', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'http',
      remote: { url: 'https://example.test/private-path', headers: { Authorization: { t: 'literal', v: 'private-header' } } },
      env: { TOKEN: { t: 'literal', v: 'private-token' } }, createdAt: 1, updatedAt: 2 }],
      bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' },
        createdAt: 1, updatedAt: 2 }] };
    const original = catalog;
    let revision = 9;
    // The row persistence boundary is in-memory. The real catalog loader,
    // semantic reducer and public MCP Action executor remain beneath it.
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: async (change, expectedRevision) => {
        expect(expectedRevision).toBe(revision);
        catalog = applyMcpServerCatalogMutationV1(catalog, change);
        return { status: 'updated', revision: ++revision, cursor: revision };
      },
      machine: async () => { throw new Error('Catalog operations cannot execute on a Machine'); },
    });
    const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.servers.list', input: {}, context })).toEqual({ ok: true, result: {
      status: 'ready', revision: 9, authority: 'active', diagnostics: [], catalog: { v: 1,
        servers: [{ id: 'server', name: 'server', transport: 'http', createdAt: 1, updatedAt: 2 }],
        bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2 }] },
    } });
    expect(await execute({ actionId: 'mcp.servers.read', input: { serverId: 'server' }, context })).toMatchObject({
      ok: true, result: { status: 'present', server: original.servers[0], bindings: original.bindings, revision: 9 },
    });
    await expect(execute({ actionId: 'mcp.servers.delete', input: {
      expectedRevision: 9, serverId: 'server', removeBindings: false }, context })).rejects.toThrow();
    expect(catalog).toEqual(original);
    expect(revision).toBe(9);
    expect(await execute({ actionId: 'mcp.servers.delete', input: {
      expectedRevision: 9, serverId: 'server', removeBindings: true }, context })).toEqual({
      ok: true, result: { status: 'updated', revision: 10, cursor: 10 },
    });
    expect(catalog).toEqual({ v: 1, servers: [], bindings: [] });
  });

  it('creates imported definitions and default rules in one row CAS and refuses a batch atomically', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
    let revision = 9;
    const entries = [
      { entry: { id: 'alpha', name: 'alpha', transport: 'stdio', stdio: { command: 'echo', args: [] },
        env: { TOKEN: { t: 'literal', v: 'private-batch-token' } }, createdAt: 1, updatedAt: 1 } },
      { entry: { id: 'beta', name: 'beta', transport: 'http', remote: { url: 'https://example.test/mcp', headers: {} },
        env: {}, createdAt: 1, updatedAt: 1 } },
    ] satisfies { entry: McpServerCatalogV1['servers'][number] }[];
    const ruleIds = ['alpha-binding', 'beta-binding'];
    // Only the durable row boundary is replaced. Batch admission, reduction,
    // validation, commit sequencing and Action projection remain canonical.
    const execute = createMcpServerActionExecuteV1({
      ruleWriteContext: () => ({ nowMs: 1, newId: () => ruleIds.shift() ?? 'other-binding' }),
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: async (change, expectedRevision) => {
        if (expectedRevision !== revision) return { status: 'conflict', revision };
        return commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
          writeCatalog: async candidate => {
            if (candidate.expectedRevision !== revision) return { status: 'conflict', revision };
            catalog = candidate.catalog;
            return { status: 'updated', revision: ++revision, cursor: revision };
          } });
      },
      machine: async () => { throw new Error('Import cannot execute on a Machine'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.servers.create', input: { expectedRevision: 9, entries }, context }))
      .toEqual({ ok: true, result: { status: 'updated', revision: 10, cursor: 10, serverIds: ['alpha', 'beta'] } });
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.create')?.projectObservationInput?.({
      expectedRevision: 9, entries,
    })).toEqual({ expectedRevision: 9, serverIds: ['alpha', 'beta'] });
    const committed = { v: 1, servers: entries.map(item => item.entry), bindings: entries.map(item => ({
      id: `${item.entry.id}-binding`, serverId: item.entry.id, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
    })) };
    expect(catalog).toEqual(committed);
    expect(await execute({ actionId: 'mcp.servers.list', input: {}, context })).toMatchObject({
      ok: true, result: { status: 'ready', authority: 'active', revision: 10,
        catalog: { servers: [{ id: 'alpha' }, { id: 'beta' }], bindings: [{ id: 'alpha-binding' }, { id: 'beta-binding' }] } },
    });
    const first = entries[0]!;
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.create'].safeParse({ expectedRevision: 10,
      entries, entry: first.entry }).success).toBe(false);
    await expect(execute({ actionId: 'mcp.servers.create', input: { expectedRevision: 10, entries: [
      { entry: { ...first.entry, id: 'next', name: 'next' } },
      first,
    ] }, context })).rejects.toMatchObject({ code: 'invalid-mutation' });
    expect(catalog).toEqual(committed);
    expect(revision).toBe(10);
  });
});
