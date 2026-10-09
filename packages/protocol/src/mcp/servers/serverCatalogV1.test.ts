import { describe, expect, it } from 'vitest';
import { loadMcpServerCatalogV1, applyMcpServerCatalogMutationV1, listMcpServerCatalogSavedSecretRefsV1,
  remapMcpServerCatalogSavedSecretReferencesV1, readMcpServersFromCatalogSnapshotV1 } from './serverCatalogV1.js';
import { sealMcpServerCatalogContentV1, openMcpServerCatalogContentV1, sealMcpServerCatalogMigrationContentV1,
  parseMcpServerCatalogMigrationContentV1, McpServerCatalogContentV1Schema,
  type McpServerCatalogV1 } from './serverRowsV1.js';
import { formatSharedSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';

const oldReference = formatSharedSavedSecretRefV1('old');
const newReference = formatSharedSavedSecretRefV1('new');

const catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'http',
  remote: { url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: { t: 'savedSecret', secretId: oldReference } } },
  env: { REGION: { t: 'literal', v: 'local' } }, createdAt: 1, updatedAt: 2 }], bindings: [{
  id: 'binding', serverId: 'server', enabled: true,
  target: { t: 'workspace', machineId: 'machine', workspaceRoot: 'C:\\Users\\alice\\project' },
  overrides: { envPatch: { TOKEN: { t: 'savedSecret', secretId: oldReference }, REMOVED: null },
    remote: { headersPatch: { Authorization: null } } }, createdAt: 1, updatedAt: 2,
}] };

describe('MCP catalog row authority', () => {
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

  it('keeps active personal or invalid references diagnostic while retained source still reaches its importer', async () => {
    for (const secretId of ['personal-source', 'happier:shared-secret:v1:']) {
      const source = { ...catalog, servers: catalog.servers.map(entry => ({ ...entry,
        remote: { ...entry.remote!, headers: { Authorization: { t: 'savedSecret' as const, secretId } } } })) };
      const opened = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: source } });
      expect(opened).toMatchObject({ status: 'partial' });
      if (opened.status !== 'partial') throw new Error('Unadmitted reference must remain diagnostic');
      expect(opened.diagnostics).toContainEqual({ path: 'servers[0].remote.headers.Authorization', reason: 'unclassified-reference' });
    }
    const source = { ...catalog, servers: catalog.servers.map(entry => ({ ...entry,
      remote: { ...entry.remote!, headers: { Authorization: { t: 'savedSecret' as const, secretId: 'personal-source' } } } })) };
    const retained = await loadMcpServerCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'absent' }), transfer: {
        readSourceSnapshot: async () => ({ version: 2, raw: { mcpServersSettingsV1: { ...source, strictMode: false } } }),
        initializeCatalog: async () => { throw new Error('Without source CAS this read must remain inactive'); },
      } });
    expect(retained).toMatchObject({ status: 'ready', authority: 'inactive', revision: 'absent', catalog: source });
    expect(readMcpServersFromCatalogSnapshotV1({ snapshot: retained, strictMode: false }))
      .toEqual({ status: 'unavailable', reason: 'authority-not-confirmed' });
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
        ...catalog, strictMode: false, servers: [...catalog.servers, { id: 'bad', name: 'bad', transport: 'stdio' }],
      } } }),
      initializeCatalog: async () => { throw new Error('Incomplete source must remain authoritative'); },
    } });
    expect(loaded).toMatchObject({ status: 'partial', authority: 'inactive', revision: 'absent', catalog });
    if (loaded.status !== 'partial') throw new Error('Expected incomplete retained source');
    expect(loaded.diagnostics).toContainEqual({ path: 'servers[1]', reason: 'invalid-stored-content' });
  });
  it('extracts strict policy before row activation, then removes source and sanitizes cleanup-created history', async () => {
    let raw: Record<string, unknown> = { mcpServersSettingsV1: { ...catalog, strictMode: true }, unrelated: 7 };
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

  it('never reseeds a deleted destination from a retained source', async () => {
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'deleted', revision: 4 }),
      transfer: {
        readSourceSnapshot: async () => ({ raw: { mcpServersSettingsV1: { ...catalog, strictMode: true }, mcpServersStrictMode: false }, version: 3 }),
        initializeCatalog: async () => { throw new Error('Deleted authority must never initialize'); },
      } });
    expect(loaded).toMatchObject({ status: 'ready', authority: 'active', revision: 4, catalog: { v: 1, servers: [], bindings: [] } });
  });

  it('preserves genuine retained policy when an already-active destination contracts its source', async () => {
    let raw: Readonly<Record<string, unknown>> = { mcpServersSettingsV1: { ...catalog, strictMode: true }, unrelated: 7 };
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
    expect(remapped.bindings[0]?.overrides?.envPatch?.REMOVED).toBeNull();
    expect(remapped.bindings[0]?.overrides?.remote?.headersPatch?.Authorization).toBeNull();
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
    const next = applyMcpServerCatalogMutationV1(catalog, { kind: 'server-create', entry, bindings: [binding] });
    expect(next.servers).toEqual([...catalog.servers, entry]);
    expect(next.bindings).toEqual([...catalog.bindings, binding]);
    expect(() => applyMcpServerCatalogMutationV1(catalog, {
      kind: 'server-create', entry: { ...entry, name: 'server' }, bindings: [binding],
    })).toThrow();
    expect(() => applyMcpServerCatalogMutationV1(catalog, {
      kind: 'server-create', entry, bindings: [{ ...binding, serverId: 'missing' }],
    })).toThrow();
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.bindings).toHaveLength(1);
  });

  it('updates nullable binding patches and enablement without changing its platform-qualified target or definition', () => {
    const binding = { ...catalog.bindings[0]!, overrides: { envPatch: { TOKEN: null } } };
    const edited = applyMcpServerCatalogMutationV1(catalog, { kind: 'binding-update', binding });
    const disabled = applyMcpServerCatalogMutationV1(edited, { kind: 'binding-enabled', bindingId: binding.id, enabled: false });
    expect(disabled.servers).toEqual(catalog.servers);
    expect(disabled.bindings).toEqual([{ ...binding, enabled: false }]);
    expect(applyMcpServerCatalogMutationV1(disabled, { kind: 'binding-remove', bindingId: binding.id }))
      .toEqual({ ...catalog, bindings: [] });
  });
});
