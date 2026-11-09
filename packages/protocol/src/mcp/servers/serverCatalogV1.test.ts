import { describe, expect, it } from 'vitest';
import { loadMcpServerCatalogV1, applyMcpServerCatalogMutationV1, listMcpServerCatalogSavedSecretRefsV1,
  remapMcpServerCatalogSavedSecretReferencesV1, readMcpServersFromCatalogSnapshotV1 } from './serverCatalogV1.js';
import { sealMcpServerCatalogContentV1, openMcpServerCatalogContentV1, sealMcpServerCatalogMigrationContentV1,
  parseMcpServerCatalogMigrationContentV1, McpServerCatalogContentV1Schema,
  type McpServerCatalogV1 } from './serverRowsV1.js';
import { formatSharedSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { mcpPluginItemIdV1 } from './settingsV1.js';

const oldReference = formatSharedSavedSecretRefV1('old');
const newReference = formatSharedSavedSecretRefV1('new');
const pluginServerId = mcpPluginItemIdV1({ pluginId: 'example.fixture', localId: 'server' });

const catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'http',
  remote: { url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: { t: 'savedSecret', secretId: oldReference } } },
  env: { REGION: { t: 'literal', v: 'local' } }, createdAt: 1, updatedAt: 2,
  configOverrides: [{ target: { t: 'workspace', machineId: 'machine', workspaceRoot: 'C:\\Users\\alice\\project' },
    envPatch: { TOKEN: { t: 'savedSecret', secretId: oldReference }, REMOVED: null }, remote: { headersPatch: { Authorization: null } } }],
  }], bindings: [{
  id: 'binding', serverId: 'server', enabled: true,
  target: { t: 'workspace', machineId: 'machine', workspaceRoot: 'C:\\Users\\alice\\project' },
  createdAt: 1, updatedAt: 2,
}] };
const retainedCatalog = { ...catalog,
  servers: catalog.servers.map(({ configOverrides: _overrides, ...server }) => server),
  bindings: catalog.bindings.map(rule => {
    const { target: _target, ...overrides } = catalog.servers[0]!.configOverrides![0]!;
    return { ...rule, overrides };
  }),
};

describe('MCP catalog row authority', () => {
  it.each([true, false])('keeps finite catalog reads free of retained maintenance after admission (present=%s)', async present => {
    let destination: McpServerCatalogV1 | null = present ? catalog : null;
    const reads: string[] = [];
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null, maintainSource: false,
      readRow: async () => destination ? { status: 'present', revision: 1, content: { t: 'plain', v: destination } }
        : { status: 'absent' },
      transfer: {
        readSourceSnapshot: async () => { reads.push('source'); return { raw: { mcpServersSettingsV1: retainedCatalog, mcpServersStrictMode: true }, version: 3 }; },
        initializeCatalog: async input => { destination = input.catalog; return { status: 'updated', revision: 1, cursor: 1 }; },
        replaceSource: async () => { reads.push('cleanup'); return { status: 'applied', settingsVersion: 4 }; },
        normalizeHistory: async () => { reads.push('history'); return { status: 'complete' }; },
      },
    });
    expect(loaded).toMatchObject({ status: 'ready', authority: 'active', revision: 1, catalog });
    expect(reads).toEqual(present ? [] : ['source']);
  });

  it('does not interpret admitted tool names as credential carrier fields', () => {
    const tools = { default: 'ask' as const, overrides: { savedSecretId: 'allow' as const, apiSecretRef: 'off' as const } };
    const source = { ...catalog, servers: catalog.servers.map(server => ({ ...server, tools })),
      pluginServers: { [pluginServerId]: { tools } } };
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } }))
      .toEqual({ status: 'opened', catalog: source });
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: {
      ...source, servers: source.servers.map(server => ({ ...server, tools: { ...tools, futureSecretRef: 'hidden' } })),
    } } })).toMatchObject({ status: 'partial', diagnostics: [
      { path: 'servers[0].tools.futureSecretRef', reason: 'unclassified-reference' },
    ] });
  });
  it('preserves attested references through catalog admission and secret rewrites', () => {
    const source: McpServerCatalogV1 = { ...catalog,
      servers: catalog.servers.map(server => ({ ...server, remote: { ...server.remote!, headers: {
        ...server.remote!.headers, Sender: { t: 'sessionAttested', field: 'externalPrincipalId' },
      } }, configOverrides: server.configOverrides?.map(override => ({ ...override,
        remote: { headersPatch: { Message: { t: 'sessionAttested', field: 'sourceMessageId' }, Removed: null } },
      })) })),
    };
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } }))
      .toEqual({ status: 'opened', catalog: source });
    expect(listMcpServerCatalogSavedSecretRefsV1(source).map(ref => ref.secretId)).toEqual([oldReference, oldReference]);
    const rewritten = remapMcpServerCatalogSavedSecretReferencesV1(source, { [oldReference]: newReference });
    expect(rewritten.servers[0]?.remote?.headers.Sender).toEqual({ t: 'sessionAttested', field: 'externalPrincipalId' });
    expect(rewritten.servers[0]?.configOverrides?.[0]?.remote?.headersPatch).toEqual({
      Message: { t: 'sessionAttested', field: 'sourceMessageId' }, Removed: null,
    });
    expect(listMcpServerCatalogSavedSecretRefsV1(rewritten).map(ref => ref.secretId)).toEqual([newReference, newReference]);
  });

  it('converts complete retained metadata losslessly while ordinary new writes remain strict', () => {
    const payload = { ...catalog, catalogMetadata: { label: 'retained' }, servers: catalog.servers.map(server => ({ ...server,
      serverMetadata: { label: 'original' }, env: { REGION: { t: 'literal', v: 'local', literalMetadata: { source: 'prior' } } } })) };
    const content = { t: 'plain', v: payload, envelopeMetadata: { origin: 'retained' } };
    expect(McpServerCatalogContentV1Schema.safeParse(content).success).toBe(false);
    const opened = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content, admission: 'migration' });
    expect(opened.status).toBe('opened');
    if (opened.status !== 'opened') throw new Error('Complete retained metadata must be available for conversion');
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) };
    const encrypted = sealMcpServerCatalogMigrationContentV1({ source: opened.migrationSource, mode: 'e2ee', material });
    const decrypted = openMcpServerCatalogContentV1({ mode: 'e2ee', material, content: encrypted, admission: 'migration' });
    if (decrypted.status !== 'opened') throw new Error('Resealed metadata must open completely');
    expect(decrypted.migrationSource.payload).toEqual(payload);
    expect(sealMcpServerCatalogMigrationContentV1({ source: decrypted.migrationSource, mode: 'plain', material: null })).toEqual(content);
  });

  it('refuses migration authority for visible envelope references and reserved target-field collisions', () => {
    const visible = { t: 'plain', v: catalog, futureCredential: { t: 'savedSecret', secretId: oldReference } };
    const opened = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: visible, admission: 'migration' });
    expect(opened).toMatchObject({ status: 'partial' });
    expect(parseMcpServerCatalogMigrationContentV1(visible)).toBeNull();
    const reserved = openMcpServerCatalogContentV1({ mode: 'plain', material: null,
      content: { t: 'plain', v: catalog, c: 'retained metadata must not be overwritten' }, admission: 'migration' });
    if (reserved.status !== 'opened') throw new Error('Harmless stored fields remain readable');
    expect(() => sealMcpServerCatalogMigrationContentV1({ source: reserved.migrationSource, mode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(8) } })).toThrow('invalid-stored-content');
  });

  it.each([
    {}, { v: null }, { v: 1, servers: null, bindings: [] }, { v: 1, servers: [], bindings: null },
  ])('refuses malformed retained source rather than inventing an empty catalog', async source => {
    let rowWrites = 0;
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'absent' }), transfer: {
        readSourceSnapshot: async () => ({ raw: { mcpServersSettingsV1: source }, version: 3 }),
        initializeCatalog: async () => { rowWrites += 1; return { status: 'updated', revision: 0, cursor: 1 }; },
      } });
    expect(loaded).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(rowWrites).toBe(0);
  });

  it('admits active personal references while malformed shared references remain diagnostic', async () => {
    for (const secretId of ['happier:shared-secret:v1:']) {
      const source = { ...catalog, servers: catalog.servers.map(entry => ({ ...entry,
        remote: { ...entry.remote!, headers: { Authorization: { t: 'savedSecret' as const, secretId } } } })) };
      const opened = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } });
      expect(opened).toMatchObject({ status: 'partial' });
      if (opened.status !== 'partial') throw new Error('Unadmitted reference must remain diagnostic');
      expect(opened.diagnostics).toContainEqual({ path: 'servers[0].remote.headers.Authorization', reason: 'unclassified-reference' });
    }
    const source = { ...catalog, servers: catalog.servers.map(entry => ({ ...entry,
      remote: { ...entry.remote!, headers: { Authorization: { t: 'savedSecret' as const, secretId: 'personal-source' } } } })) };
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } }))
      .toEqual({ status: 'opened', catalog: source });
    expect(listMcpServerCatalogSavedSecretRefsV1(source)).toContainEqual({
      path: 'servers[0].remote.headers.Authorization', secretId: 'personal-source',
    });
    const retainedSource = { ...source, servers: source.servers.map(({ configOverrides: _overrides, ...server }) => server), bindings: retainedCatalog.bindings };
    const retained = await loadMcpServerCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'absent' }), transfer: {
        readSourceSnapshot: async () => ({ version: 2, raw: { mcpServersSettingsV1: { ...retainedSource, strictMode: false } } }),
        initializeCatalog: async () => { throw new Error('Without source CAS this read must remain inactive'); },
      } });
    expect(retained).toMatchObject({ status: 'ready', authority: 'inactive', revision: 'absent', catalog: source });
    expect(readMcpServersFromCatalogSnapshotV1({ snapshot: retained, strictMode: false }))
      .toEqual({ status: 'unavailable', reason: 'authority-not-confirmed' });
  });

  it('counts and rewrites template secrets in configuration and machine overrides', () => {
    const template = { t: 'template' as const, template: 'Bearer {api_key}', vars: {
      api_key: { t: 'savedSecret' as const, secretId: 'personal-source' },
    } };
    const source = { ...catalog, servers: catalog.servers.map(entry => ({ ...entry,
      remote: { ...entry.remote!, headers: { Authorization: template } },
      configOverrides: [{ target: { t: 'machine' as const, machineId: 'machine' }, envPatch: { API_KEY: template },
        remote: { headersPatch: { Authorization: template } } }],
    })) };
    const opened = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } });
    expect(opened).toEqual({ status: 'opened', catalog: source });
    if (opened.status !== 'opened') throw new Error('Template references must be admitted');
    const refs = listMcpServerCatalogSavedSecretRefsV1(opened.catalog);
    expect(refs).toEqual([
      { path: 'servers[0].remote.headers.Authorization.vars.api_key', secretId: 'personal-source' },
      { path: 'servers[0].configOverrides[0].envPatch.API_KEY.vars.api_key', secretId: 'personal-source' },
      { path: 'servers[0].configOverrides[0].remote.headersPatch.Authorization.vars.api_key', secretId: 'personal-source' },
    ]);
    const rewritten = remapMcpServerCatalogSavedSecretReferencesV1(opened.catalog, { 'personal-source': newReference });
    expect(listMcpServerCatalogSavedSecretRefsV1(rewritten)).toEqual(refs.map(ref => ({ ...ref, secretId: newReference })));
    expect(rewritten.servers[0]?.remote?.headers.Authorization).toMatchObject({ template: 'Bearer {api_key}' });
  });

  it('preserves tool policies and snapshots for catalog and plugin servers through stored projection', () => {
    const tools = { default: 'allow_read_only', overrides: { read: 'allow', remove: 'off' } };
    const toolsSnapshot = { checkedAt: 20, machineId: 'machine', protocolVersion: '2025-11-25',
      serverInfo: { name: 'example', version: '1' }, instructions: 'Use read first',
      tools: [{ name: 'read', title: 'Read', description: 'Read entries', tokens: 17, annotations: { readOnlyHint: true } }],
    };
    const source = { ...catalog, servers: catalog.servers.map(server => ({ ...server, tools, toolsSnapshot })),
      pluginServers: { [pluginServerId]: { tools, toolsSnapshot } },
    };
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } }))
      .toEqual({ status: 'opened', catalog: source });
    const extra = { ...source, pluginServers: { [pluginServerId]: { ...source.pluginServers[pluginServerId],
      future: 'metadata', toolsSnapshot: { ...toolsSnapshot, tools: toolsSnapshot.tools.map(tool => ({ ...tool, future: 'metadata' })) },
    } } };
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: extra } }))
      .toEqual({ status: 'opened', catalog: source });
    const invalid = { ...source, pluginServers: { [pluginServerId]: { tools: { default: 'allow_all', overrides: { remove: 'invalid' } } } } };
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: invalid } }))
      .toMatchObject({ status: 'partial', diagnostics: [{ path: 'pluginServers', reason: 'invalid-stored-content' }] });
  });

  it('writes plugin Test snapshots without requiring prior tool settings or replacing them', () => {
    const snapshot = { checkedAt: 20, machineId: 'machine', tools: [{ name: 'read', tokens: 7 }] };
    const ctx = { nowMs: 20, newId: () => 'unused', pluginItemIds: [pluginServerId] };
    const first = applyMcpServerCatalogMutationV1(catalog, { kind: 'tools-snapshot', serverId: pluginServerId, snapshot }, ctx);
    expect(first.pluginServers?.[pluginServerId]).toEqual({ toolsSnapshot: snapshot });
    const edited = applyMcpServerCatalogMutationV1(first, { kind: 'tools-change', serverId: pluginServerId,
      settings: { default: 'allow_read_only', tools: { write: 'off' } } }, ctx);
    const checked = applyMcpServerCatalogMutationV1(edited, { kind: 'tools-snapshot', serverId: pluginServerId,
      snapshot: { ...snapshot, checkedAt: 21 } }, ctx);
    expect(checked.pluginServers?.[pluginServerId]).toEqual({
      tools: { default: 'allow_read_only', overrides: { write: 'off' } }, toolsSnapshot: { ...snapshot, checkedAt: 21 },
    });
    expect(checked.servers).toEqual(catalog.servers);
    expect(checked.bindings).toEqual(catalog.bindings);
    expect(() => applyMcpServerCatalogMutationV1(catalog, { kind: 'tools-snapshot', serverId: pluginServerId, snapshot },
      { ...ctx, pluginItemIds: [] })).toThrow('Server not found');
  });

  it('retains registry and machine origins through the canonical catalog reader', () => {
    const registry = { kind: 'registry', provenance: { sourceId: 'builtin:mcp-registry', format: 'mcp-registry',
      sourceUrl: 'https://registry.modelcontextprotocol.io', itemId: 'example/server',
      ref: { kind: 'version', version: '1' }, importedAt: 10 },
      upstream: { state: 'update_available', latest: { kind: 'version', version: '2' } },
    };
    for (const origin of [registry, { kind: 'machine', machineId: 'machine', agentId: 'claude' }]) {
      const source = { ...catalog, servers: catalog.servers.map(server => ({ ...server, origin })) };
      expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } }))
        .toEqual({ status: 'opened', catalog: source });
    }
  });

  it.each(['server-create', 'server-create-batch', 'server-duplicate'] as const)('refuses reserved plugin ids on %s', kind => {
    const entry = { ...catalog.servers[0]!, id: pluginServerId, name: 'copy' };
    const change = kind === 'server-create-batch' ? { kind, entries: [{ entry, rules: [] }] }
      : kind === 'server-duplicate' ? { kind, serverId: 'server', entry, rules: [] } : { kind, entry, rules: [] };
    expect(() => applyMcpServerCatalogMutationV1(catalog, change)).toThrow();
  });

  it('preserves typed transport refusals rather than reporting an unsupported server as unreachable', async () => {
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null,
      readRow: async () => { throw Object.assign(new Error('Server does not support MCP rows'), { code: 'unsupported' }); },
    });
    expect(loaded).toEqual({ status: 'unavailable', reason: 'unsupported' });
  });

  it('shows valid retained neighbors with diagnostics but never activates an incomplete inventory', async () => {
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'absent' }), transfer: {
      readSourceSnapshot: async () => ({ version: 2, raw: { mcpServersSettingsV1: {
        ...retainedCatalog, strictMode: false, servers: [...retainedCatalog.servers, { id: 'bad', name: 'bad', transport: 'stdio' }],
      } } }),
      initializeCatalog: async () => { throw new Error('Incomplete source must remain authoritative'); },
    } });
    expect(loaded).toMatchObject({ status: 'partial', authority: 'inactive', revision: 'absent', catalog });
    if (loaded.status !== 'partial') throw new Error('Expected incomplete retained source');
    expect(loaded.diagnostics).toContainEqual({ path: 'servers[1]', reason: 'invalid-stored-content' });
  });
  it('extracts strict policy before row activation, then removes source and sanitizes cleanup-created history', async () => {
    let raw: Record<string, unknown> = { mcpServersSettingsV1: { ...retainedCatalog, strictMode: true }, unrelated: 7 };
    let version = 8;
    let row: { status: 'absent' } | { status: 'present'; revision: number; content: ReturnType<typeof sealMcpServerCatalogContentV1> } = { status: 'absent' };
    const effects: string[] = [];
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => row, transfer: {
      readSourceSnapshot: async () => ({ raw, version }),
      replaceSource: async input => {
        expect(input.expectedVersion).toBe(version);
        effects.push(Object.hasOwn(input.raw, 'mcpServersSettingsV1') ? 'policy' : 'source');
        raw = { ...input.raw }; version += 1;
        return { status: 'applied', settingsVersion: version };
      },
      initializeCatalog: async input => {
        expect(raw.mcpServersStrictMode).toBe(true);
        expect(input.sourceSettingsVersion).toBe(version);
        expect(Object.hasOwn(raw, 'mcpServersSettingsV1')).toBe(true);
        effects.push('row');
        row = { status: 'present', revision: 0, content: sealMcpServerCatalogContentV1({ mode: 'plain', material: null, catalog: input.catalog }) };
        return { status: 'updated', revision: 0, cursor: 1 };
      },
      normalizeHistory: async input => {
        expect(Object.hasOwn(raw, 'mcpServersSettingsV1')).toBe(false);
        expect(input.activeTransferredRoots).toEqual(['mcpServersSettingsV1']);
        effects.push('history');
        return { status: 'complete' };
      },
    } });
    expect(effects).toEqual(['policy', 'row', 'source', 'history']);
    expect(loaded).toMatchObject({ status: 'ready', authority: 'active', revision: 0, catalog, cleanup: { status: 'complete' } });
    expect(raw).toEqual({ unrelated: 7, mcpServersStrictMode: true });
  });

  it('transfers a released 0.2 MCP settings blob without losing any field it wrote', async () => {
    // Provenance: ../0.2 9351d350fe packages/protocol/src/mcpServers/settingsV1.ts (released in
    // cli-v0.2.17-dev.5+): this exact value is McpServersSettingsV1Schema.parse output, i.e. what
    // 0.2 writes. 0.2 strips unknown keys on write, so no other legacy-root fields exist.
    const released = { v: 1, strictMode: true, servers: [
      { id: 'srv-gh', name: 'github', title: 'GitHub', description: 'Issues and PRs', transport: 'stdio',
        stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        env: { GITHUB_TOKEN: { t: 'savedSecret', secretId: 'secret-gh' }, LOG_LEVEL: { t: 'literal', v: 'info' } },
        createdAt: 1761400000000, updatedAt: 1761400100000 },
      { id: 'srv-docs', name: 'docs', transport: 'http',
        remote: { url: 'https://mcp.example.test/mcp', headers: { Authorization: { t: 'savedSecret', secretId: 'secret-docs' } } },
        env: {}, createdAt: 1761400000000, updatedAt: 1761400000000 },
    ], bindings: [
      { id: 'b-all', serverId: 'srv-gh', enabled: true, target: { t: 'allMachines' }, createdAt: 1761400000000, updatedAt: 1761400000000 },
      { id: 'b-ws', serverId: 'srv-docs', enabled: false, target: { t: 'workspace', machineId: 'm1', workspaceRoot: 'C:\\Users\\alice\\repo' },
        overrides: { remote: { headersPatch: { Authorization: null } }, envPatch: { REGION: { t: 'literal', v: 'eu' } } },
        createdAt: 1761400000000, updatedAt: 1761400200000 },
    ] };
    let raw: Record<string, unknown> = { mcpServersSettingsV1: released, unrelated: 7 };
    let version = 1;
    let row: { status: 'absent' } | { status: 'present'; revision: number; content: ReturnType<typeof sealMcpServerCatalogContentV1> } = { status: 'absent' };
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => row, transfer: {
      readSourceSnapshot: async () => ({ raw, version }),
      replaceSource: async input => {
        // The source root is retired only once the destination row exists.
        if (!Object.hasOwn(input.raw, 'mcpServersSettingsV1')) expect(row.status).toBe('present');
        raw = { ...input.raw }; version += 1;
        return { status: 'applied', settingsVersion: version };
      },
      initializeCatalog: async input => {
        row = { status: 'present', revision: 0, content: sealMcpServerCatalogContentV1({ mode: 'plain', material: null, catalog: input.catalog }) };
        return { status: 'updated', revision: 0, cursor: 1 };
      },
      normalizeHistory: async () => ({ status: 'complete' }),
    } });
    expect(loaded).toMatchObject({ status: 'ready', authority: 'active', cleanup: { status: 'complete' } });
    if (loaded.status !== 'ready') throw new Error('Expected the released blob to transfer');
    expect(raw).toEqual({ unrelated: 7, mcpServersStrictMode: true });
    const [github, docs] = loaded.catalog.servers;
    expect(github).toMatchObject(released.servers[0]!);
    expect(docs).toMatchObject({ ...released.servers[1], configOverrides: [{ target: released.bindings[1]!.target,
      remote: { headersPatch: { Authorization: null } }, envPatch: { REGION: { t: 'literal', v: 'eu' } } }] });
    expect(loaded.catalog.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'b-all', serverId: 'srv-gh', enabled: true, target: { t: 'allMachines' } }),
      expect.objectContaining({ id: 'b-ws', serverId: 'srv-docs', enabled: false, target: released.bindings[1]!.target }),
    ]));
  });

  it('never reseeds a deleted destination from a retained source', async () => {
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'deleted', revision: 4 }),
      transfer: {
        readSourceSnapshot: async () => ({ raw: { mcpServersSettingsV1: { ...retainedCatalog, strictMode: true }, mcpServersStrictMode: false }, version: 3 }),
        initializeCatalog: async () => { throw new Error('Deleted authority must never initialize'); },
      } });
    expect(loaded).toMatchObject({ status: 'ready', authority: 'active', revision: 4, catalog: { v: 1, servers: [], bindings: [] } });
  });

  it('preserves genuine retained policy when an already-active destination contracts its source', async () => {
    let raw: Readonly<Record<string, unknown>> = { mcpServersSettingsV1: { ...retainedCatalog, strictMode: true }, unrelated: 7 };
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'deleted', revision: 4 }), transfer: {
        readSourceSnapshot: async () => ({ raw, version: 3 }),
        initializeCatalog: async () => { throw new Error('Active destination must not initialize'); },
        replaceSource: async input => { raw = input.raw; return { status: 'applied', settingsVersion: 4 }; },
        normalizeHistory: async () => ({ status: 'complete' }),
      } });
    expect(loaded).toMatchObject({ status: 'ready', authority: 'active', revision: 4 });
    expect(raw).toEqual({ unrelated: 7, mcpServersStrictMode: true });
  });

  it('opens nested stored extras but emits only canonical payloads and keeps both mode directions', () => {
    const extra = { ...catalog, future: true, servers: catalog.servers.map(server => ({ ...server,
      remote: { ...server.remote!, future: true } })) };
    const read = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: extra } });
    expect(read).toEqual({ status: 'opened', catalog });
    if (read.status !== 'opened') throw new Error('Expected opened catalog');
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) };
    const encrypted = sealMcpServerCatalogContentV1({ mode: 'e2ee', material, catalog: read.catalog });
    expect(openMcpServerCatalogContentV1({ mode: 'e2ee', material, content: encrypted })).toEqual(read);
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: encrypted }))
      .toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
    expect(sealMcpServerCatalogContentV1({ mode: 'plain', material: null, catalog: read.catalog })).toEqual({ t: 'plain', v: catalog });
  });

  it('rewrites references without turning nullable removals or ordinary literals into credentials', () => {
    expect(listMcpServerCatalogSavedSecretRefsV1(catalog).map(ref => ref.secretId)).toEqual([oldReference, oldReference]);
    const remapped = remapMcpServerCatalogSavedSecretReferencesV1(catalog, { [oldReference]: newReference });
    expect(listMcpServerCatalogSavedSecretRefsV1(remapped).map(ref => ref.secretId)).toEqual([newReference, newReference]);
    expect(remapped.servers[0]?.configOverrides?.[0]?.envPatch?.REMOVED).toBeNull();
    expect(remapped.servers[0]?.configOverrides?.[0]?.remote?.headersPatch?.Authorization).toBeNull();
    expect(remapped.servers[0]?.env.REGION).toEqual({ t: 'literal', v: 'local' });
    expect(() => applyMcpServerCatalogMutationV1(catalog, { kind: 'server-remove', serverId: 'server', removeBindings: false })).toThrow(/binding/i);
    expect(applyMcpServerCatalogMutationV1(catalog, { kind: 'server-remove', serverId: 'server', removeBindings: true }))
      .toEqual({ v: 1, servers: [], bindings: [] });
  });

  it('does not claim a complete census after projecting a recognizable future reference carrier', () => {
    const extra = { ...catalog, futureCredential: { t: 'savedSecret', secretId: 'future' } };
    const read = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: extra } });
    expect(read).toMatchObject({ status: 'partial', catalog });
    if (read.status !== 'partial') throw new Error('Dropped reference must remain incomplete');
    expect(read.diagnostics).toContainEqual({ path: 'futureCredential', reason: 'unclassified-reference' });
  });

  it('keeps malformed binding neighbors diagnostic rather than inventing an empty complete catalog', () => {
    const raw = { ...catalog, bindings: [...catalog.bindings, {
      ...catalog.bindings[0]!, id: 'dangling', serverId: 'missing',
    }] };
    const read = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: raw } });
    expect(read).toMatchObject({ status: 'partial', catalog });
    if (read.status !== 'partial') throw new Error('Malformed retained binding must remain incomplete');
    expect(read.diagnostics).toContainEqual({ path: 'bindings[1]', reason: 'invalid-stored-content' });
  });

  it('applies a typed definition-and-binding change atomically with name and target integrity', () => {
    const entry = { ...catalog.servers[0]!, id: 'another', name: 'another' };
    const binding = { ...catalog.bindings[0]!, id: 'another-binding', serverId: entry.id };
    const next = applyMcpServerCatalogMutationV1(catalog, { kind: 'server-create', entry, rules: [binding] });
    expect(next.servers).toEqual([...catalog.servers, entry]);
    expect(next.bindings).toEqual([...catalog.bindings, binding]);
    expect(() => applyMcpServerCatalogMutationV1(catalog, {
      kind: 'server-create', entry: { ...entry, name: 'server' }, rules: [binding],
    })).toThrow();
    expect(() => applyMcpServerCatalogMutationV1(catalog, {
      kind: 'server-create', entry, rules: [{ ...binding, serverId: 'missing' }],
    })).toThrow();
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.bindings).toHaveLength(1);
  });

  it('advances witnessed entry revisions for definition, tool-policy and same-clock rule edits', () => {
    const server = catalog.servers[0]!;
    const definition = applyMcpServerCatalogMutationV1(catalog, { kind: 'server-update', entry: { ...server, title: 'Changed' } });
    expect(definition.servers[0]!.updatedAt).toBeGreaterThan(server.updatedAt);
    const tools = applyMcpServerCatalogMutationV1(catalog, { kind: 'tools-change', serverId: server.id,
      settings: { default: 'allow_all' } }, { nowMs: server.updatedAt, newId: () => 'unused' });
    expect(tools.servers[0]!.updatedAt).toBeGreaterThan(server.updatedAt);
    const rule = catalog.bindings[0]!;
    const ctx = { nowMs: rule.updatedAt, newId: () => 'unused' };
    const disabled = applyMcpServerCatalogMutationV1(catalog, { kind: 'rules-change', serverIds: [server.id],
      change: { kind: 'write', write: { place: rule.target, state: 'off' } } }, ctx);
    const restored = applyMcpServerCatalogMutationV1(disabled, { kind: 'rules-change', serverIds: [server.id],
      change: { kind: 'write', write: { place: rule.target, state: 'on' } } }, ctx);
    expect(disabled.bindings[0]!.updatedAt).toBeGreaterThan(rule.updatedAt);
    expect(restored.bindings[0]!.updatedAt).toBeGreaterThan(disabled.bindings[0]!.updatedAt);
  });

  it('changes and inherits rules without changing their platform-qualified target or definition', () => {
    const binding = catalog.bindings[0]!;
    const ctx = { nowMs: 3, newId: () => 'new' };
    const disabled = applyMcpServerCatalogMutationV1(catalog, { kind: 'rules-change', serverIds: ['server'],
      change: { kind: 'write', write: { place: binding.target, state: 'off' } } }, ctx);
    expect(disabled.servers).toEqual(catalog.servers);
    expect(disabled.bindings).toEqual([{ ...binding, enabled: false, updatedAt: 3 }]);
    expect(applyMcpServerCatalogMutationV1(disabled, { kind: 'rules-change', serverIds: ['server'],
      change: { kind: 'write', write: { place: binding.target, state: 'inherit' } } }, ctx))
      .toEqual({ ...catalog, bindings: [] });
  });

  it('refuses unsupported plugin rule writes before producing a catalog mutation', () => {
    const unsupportedPluginServerId = mcpPluginItemIdV1({ pluginId: 'example.unknown', localId: 'item' });
    const source: McpServerCatalogV1 = { ...catalog, bindings: [...catalog.bindings, {
      id: 'reserved-plugin-rule', serverId: unsupportedPluginServerId, enabled: true,
      target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2,
    }] };
    // Reserved stored shapes do not establish a live plugin item producer.
    expect(openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } }))
      .toEqual({ status: 'opened', catalog: source });
    expect(() => applyMcpServerCatalogMutationV1(source, {
      kind: 'rules-change', serverIds: ['server', unsupportedPluginServerId],
      change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } },
    }, { nowMs: 3, newId: () => 'new-rule' })).toThrow('Server not found');
    expect(source.bindings).toEqual([...catalog.bindings, {
      id: 'reserved-plugin-rule', serverId: unsupportedPluginServerId, enabled: true,
      target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2,
    }]);
  });
});
