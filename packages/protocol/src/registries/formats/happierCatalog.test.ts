import { describe, expect, it } from 'vitest';
import { MarketplaceIndexEntryV1Schema, MarketplaceIndexSourceSnapshotV1Schema } from '../../marketplace/marketplaceIndexV1.js';
import { deriveMarketplaceSourceId } from '../../marketplace/marketplaceSourceRegistryV1.js';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { RegistryItemV1Schema } from '../registryItemsV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../registryActionsV1.js';
import type { RegistrySourceDescriptorV1 } from '../registrySourcesV1.js';
import { HAPPIER_PICKS_SOURCE_ID, listRegistrySourcesV1 } from '../registrySourcesV1.js';
import { createPluginRegistrySourceDescriptorV1 } from '../registryPluginSourcesV1.js';
import { readPromptLibraryCatalogRecordV1, updatePromptLibraryRegistrySourcesV1, type PromptLibraryStackActionPortV1 } from '../../prompts/library/promptLibraryCatalogV1.js';
import { StoredPromptLibraryRecordV1Schema } from '../../prompts/library/promptLibraryRowsV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';
import type { RegistrySourceStatusV1 } from '../registryListV1.js';
import { computeGitBlobShaV1, computeGitTreeShaV1 } from '../registryGitTreeV1.js';
import { checkRegistryUpstreamV1 } from '../registryUpdatesV1.js';
import { ACP_REGISTRY_V1_FIXTURE } from './fixtures/acpRegistryV1Fixture.js';

describe('curated picks through the registered catalog and target reader', () => {
  const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] });
  const source = sources.find(source => source.id === HAPPIER_PICKS_SOURCE_ID)!;
  const commit = '1'.repeat(40);
  const files = [{ path: 'SKILL.md', unixMode: 0o644 as const, bytes: new TextEncoder().encode('---\nname: review-changes\ndescription: Review a change\n---\nInstructions\n') }];
  function fixture() {
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({
      source: { id: source.id, sourceUrl: source.url, title: source.title, kind: 'curated' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [
        { kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: '' },
        { kind: 'skill', format: 'git', sourceUrl: 'https://github.com/other/skills', itemId: '' },
        { kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: 'removed' },
      ],
    });
    let failure: Exclude<RegistrySourceStatusV1, { state: 'ok' }> | null = null;
    const reads: string[] = [];
    const http: RegistryHttpV1 = {
      async getJson(url) { reads.push(url); return url === source.url
        ? failure ? { ok: false, status: failure } : { ok: true, value: catalog, fetchedAt: 1 }
        : { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: commit }
          : { sha: computeGitTreeShaV1(files), tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', sha: computeGitBlobShaV1(file.bytes), size: file.bytes.length })) } }; },
      async getText() { return { ok: true, value: new TextDecoder().decode(files[0]!.bytes), fetchedAt: 1 }; },
      async getBytes() { return { ok: true, value: files[0]!.bytes, fetchedAt: 1 }; },
    };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => sources,
      daemonFetch: async () => { throw new Error('Picks must not fetch a daemon'); } });
    return { host, http, catalog, reads, unavailable: (status: Exclude<RegistrySourceStatusV1, { state: 'ok' }> = { state: 'unreachable' }) => { failure = status; } };
  }
  it('lists a hundred old pointers without any target work, then reads only the selected pinned target', async () => {
    const { host, catalog, reads } = fixture();
    catalog.picks = Array.from({ length: 100 }, (_, index) => ({ kind: 'skill', format: 'git',
      sourceUrl: `https://github.com/owner${index}/skills`, itemId: '' }));
    const { pages } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'skill', sourceIds: [source.id],
    }));
    expect(pages[0]?.items).toHaveLength(100);
    expect(reads.filter(url => url !== source.url)).toHaveLength(0);
    const selected = pages[0]!.items[42]!;
    const shared = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'plugin', sourceIds: [source.id],
    })).pages[0]!;
    expect(shared.discovery?.items).toHaveLength(100);
    expect(shared.discovery?.items[42]?.reference).toEqual({ type: 'registryItem', kind: 'skill', sourceId: source.id, itemId: selected.itemId });
    const choice = shared.discovery!.items[42]!;
    catalog.picks.unshift({ kind: 'skill', format: 'git', sourceUrl: 'https://github.com/inserted/skills', itemId: '' });
    const inserted = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'plugin', sourceIds: [source.id],
    })).pages[0]!;
    expect(inserted.discovery?.items.find(item => item.reference.type === 'registryItem'
      && item.reference.itemId === selected.itemId)?.id).toBe(choice.id);
    catalog.picks.shift();
    catalog.picks[42] = { ...catalog.picks[42]!, display: { title: 'Review changes', description: 'A lightweight authored summary' } };
    catalog.discovery = { items: [{ id: 'review', title: 'Review changes', reference: { type: 'registryItem',
      kind: 'skill', sourceId: source.id, itemId: selected.itemId, version: commit } }],
      featured: { item: 'review', reason: 'Review your changes' },
      suggestions: [{ item: 'review', because: { kind: 'repository', hostingKind: 'github' } }],
      categories: [{ id: 'code', title: 'Code', items: ['review'] }],
      jobs: [{ id: 'review', title: 'Review code', description: 'Choose a reviewer', glyph: 'code',
        groups: [{ title: 'Review', items: ['review'] }] }] };
    const narrowed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'skill', sourceIds: [source.id], query: 'authored summary',
    }));
    expect(narrowed.pages[0]?.items).toEqual([expect.objectContaining({ itemId: selected.itemId, title: 'Review changes' })]);
    expect(narrowed.pages[0]?.discovery).toEqual(catalog.discovery);
    expect(reads.filter(url => url !== source.url)).toHaveLength(0);
    const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'skill', sourceId: source.id, itemId: selected.itemId, version: commit,
    }));
    expect(item.payload).toMatchObject({ kind: 'skill', skill: { ref: { repo: 'https://github.com/owner42/skills', commit } } });
    expect(reads.filter(url => url !== source.url).every(url => url.includes('/owner42/'))).toBe(true);
    expect(reads.some(url => url.includes('/owner42/'))).toBe(true);
  });
  it('keeps colliding root skill pointers distinct and defers unknown target facts until selected', async () => {
    const { host, reads } = fixture();
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'skill', sourceIds: [source.id],
    }));
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.status.state).toBe('ok');
    expect(page.items).toHaveLength(3);
    const [first, second, removed] = page.items;
    expect(first).toMatchObject({ sourceId: source.id, title: 'skills', flags: { pick: true } });
    expect(first?.version).toBeUndefined();
    expect(second!.itemId).not.toBe(first!.itemId);
    expect(removed).toMatchObject({ title: 'removed', flags: { pick: true } });
    expect(removed?.problem).toBeUndefined();
    expect(reads.filter(url => url !== source.url)).toHaveLength(0);
    const read = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'skill', sourceId: source.id, itemId: second!.itemId, version: commit,
    }));
    const consumed = RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(read.item)));
    expect(consumed.payload).toMatchObject({ kind: 'skill', skill: { ref: { repo: 'https://github.com/other/skills', commit }, skillMarkdown: new TextDecoder().decode(files[0]!.bytes) } });
    expect(consumed.summary.itemId).toBe(second!.itemId);
    expect(await host.filesForPointer({ sourceId: source.id, itemId: first!.itemId, version: commit })).toEqual(files);
    expect(reads.some(url => url.includes('/repos/example/skills/commits/'))).toBe(true);
    expect(reads.some(url => url.includes('/repos/other/skills/commits/'))).toBe(true);
  });
  it.each(['skill', 'mcpServer', 'plugin'] as const)('omits only confirmed-empty picks and preserves %s source failures for recovery', async kind => {
    const { host, catalog, unavailable } = fixture();
    catalog.picks = [];
    const empty = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind, sourceIds: [source.id] }));
    expect(empty.pages.every(page => page.status.state === 'ok' && page.items.length === 0)).toBe(true);
    if (kind !== 'plugin') {
      expect(empty.pages).toEqual([]);
      expect(await host.execute('registries.sources.list', { kind })).not.toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: source.id })]) });
    }
    for (const status of [{ state: 'rate_limited' }, { state: 'unreachable' }] as const) {
      unavailable(status);
      expect(await host.execute('registries.items.list', { kind, sourceIds: [source.id] })).toMatchObject({ pages: [{ sourceId: source.id, status, items: [], nextCursor: null }] });
      expect(await host.execute('registries.sources.list', { kind })).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: source.id })]) });
    }
  });
  it('keeps pointer rows without probing an unavailable target and reports failure on its selected read', async () => {
    const { http } = fixture();
    const host = createRegistryHostV1({ host: 'web', readSources: async () => sources, http: { ...http,
      getJson: async (url, options) => { if (url.includes('/repos/other/')) throw new TypeError('Failed to fetch'); return http.getJson(url, options); } } });
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind: 'skill', sourceIds: [source.id] }));
    expect(result.pages[0]?.items).toHaveLength(3);
    expect(result.pages[0]?.status.state).toBe('ok');
    expect(result.pages[0]?.items[0]?.title).toBe('skills');
    await expect(host.execute('registries.items.read', { kind: 'skill', sourceId: source.id,
      itemId: result.pages[0]!.items[1]!.itemId, version: commit })).rejects.toMatchObject({ status: { state: 'unreachable' } });
  });
  it('checks the actual target of an installed pick through the canonical update owner', async () => {
    const { host, http, catalog } = fixture();
    const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind: 'skill', sourceIds: [source.id] }));
    const summary = page.pages[0]!.items[0]!;
    const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'skill', sourceId: source.id, itemId: summary.itemId, version: summary.version,
    }));
    if (item.payload.kind !== 'skill') throw new Error('Expected skill');
    const provenance = { sourceId: source.id, sourceUrl: source.url, format: source.format, itemId: summary.itemId, importedAt: 1, ref: item.payload.skill.ref };
    expect((await checkRegistryUpstreamV1({ http }, { sources, items: [{ key: 'installed', provenance }] })).get('installed')).toMatchObject({ state: 'current', latest: { treeSha: item.payload.skill.ref.treeSha } });
    catalog.picks = [];
    expect((await checkRegistryUpstreamV1({ http }, { sources, items: [{ key: 'installed', provenance }] })).get('installed')).toEqual({ state: 'removed_from_source' });
  });
  it('preserves native Agent ids and strict pinned payloads, and refuses an ambiguous curated Agent pointer', async () => {
    const { catalog, http } = fixture();
    let index: unknown = ACP_REGISTRY_V1_FIXTURE;
    const url = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
    catalog.picks = [{ kind: 'agent', format: 'acp-registry', sourceUrl: url, itemId: 'goose' }];
    const host = createRegistryHostV1({ host: 'web', readSources: async () => sources, http: { ...http,
      getJson: async (request, options) => request === source.url ? http.getJson(request, options) : { ok: true, value: index, fetchedAt: 1 } } });
    const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind: 'agent', sourceIds: [source.id] }));
    expect(page.pages[0]!.items[0]).toMatchObject({ sourceId: source.id, itemId: 'goose', flags: { pick: true } });
    expect(page.pages[0]!.items[0]?.version).toBeUndefined();
    const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'agent', sourceId: source.id, itemId: 'goose', version: '1.54.0',
    }));
    expect(RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(item))).payload).toMatchObject({ kind: 'agent', agent: { id: 'goose', version: '1.54.0' } });
    index = { version: '1.0.0', agents: [{ ...ACP_REGISTRY_V1_FIXTURE.agents[2], distribution: { npx: { package: 'goose@latest' } } }] };
    await expect(host.execute('registries.items.read', { kind: 'agent', sourceId: source.id, itemId: 'goose', version: '1.54.0' }))
      .rejects.toMatchObject({ status: { state: 'invalid_source' } });
    catalog.picks.push({ ...catalog.picks[0]!, sourceUrl: 'https://other.example/registry.json' });
    expect(await host.execute('registries.items.list', { kind: 'agent', sourceIds: [source.id] })).toMatchObject({ pages: [{ items: [
      { problem: { code: 'unsupported_entry' } }, { problem: { code: 'unsupported_entry' } },
    ] }] });
    await expect(host.execute('registries.items.read', { kind: 'agent', sourceId: source.id, itemId: 'goose', version: '1.54.0' })).rejects.toMatchObject({ status: { state: 'invalid_source' } });
  });
});

describe('catalog registry production composition', () => {
  it('does not give arbitrary or noncanonical slash strings source identity', () => {
    for (const id of ['arbitrary/slash', 'com.acme.sources//team', 'com.acme.sources/team\n']) {
      expect(MarketplaceIndexSourceSnapshotV1Schema.shape.source.safeParse({ id, title: 'Invalid declaration', kind: 'user',
        sourceUrl: 'https://catalog.example/plugins.json' }).success).toBe(false);
    }
  });
  it.each(['https://catalog.example/plugins.json', 'https://catalog.example/'])('creates and reads %s with its published identity and strict plugin payload', async (url) => {
    const source: RegistrySourceDescriptorV1 = { id: deriveMarketplaceSourceId(url), url, title: 'Team', format: 'happier-catalog',
      kinds: ['plugin'], enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
    const entry = MarketplaceIndexEntryV1Schema.parse({ pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Plugin', description: 'Team plugin' }, distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@acme/plugin',
        version: '1.0.0', integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
      manifestDigest: `sha256:${'a'.repeat(64)}`, compatibility: { platforms: ['linux'] }, summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy: 'allowed', links: {} });
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: { id: source.id, title: source.title, sourceUrl: url, kind: 'user' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [entry], diagnostics: [] });
    const http: RegistryHttpV1 = { getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
      getText: async () => { throw new Error('Unexpected text'); }, getBytes: async () => { throw new Error('Unexpected bytes'); } };
    let revision = 0;
    let pluginSources: readonly RegistrySourceDescriptorV1[] = [];
    let stored = StoredPromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] } });
    // Only storage is substituted; create, Account-row CAS, identity selection,
    // source projection, adapter registration and wire consumption remain real.
    const port: PromptLibraryStackActionPortV1 = { serverId: 'account-test', assertCurrent() {},
      readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: stored, revision }], tombstones: [], diagnostics: [] } }),
      writeRecord: async input => { if (input.expectedRevision !== revision) return { status: 'conflict', revision };
        stored = StoredPromptLibraryRecordV1Schema.parse(input.record); return { status: 'updated', revision: ++revision }; },
    };
    const host = createRegistryHostV1({ host: 'web', http,
      readSources: async () => { const snapshot = await port.readCatalog();
        const read = readPromptLibraryCatalogRecordV1({ ...snapshot, key: 'registry-sources' });
        if (read.status !== 'ready' || read.record.key !== 'registry-sources') throw new Error('Expected Account sources');
        return listRegistrySourcesV1({ record: read.record.value, pluginSources }); },
      mutateSources: mutation => updatePromptLibraryRegistrySourcesV1(port, mutation),
    });
    expect(await host.execute('registries.sources.detect', { url })).toMatchObject({ detected: { format: 'happier-catalog', kinds: ['plugin'] } });
    expect(await host.execute('registries.sources.create', { url })).toMatchObject({ source: { id: deriveMarketplaceSourceId(url), format: 'happier-catalog' }, existing: false });
    expect(await host.execute('registries.sources.create', { url })).toMatchObject({ source: { id: deriveMarketplaceSourceId(url) }, existing: true });
    const listed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(
      await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [source.id] }));
    expect(listed).toMatchObject({ pages: [{ items: [{ itemId: 'acme.plugin', version: '1.0.0', pluginListing: {
      pluginId: entry.pluginId, packageName: entry.distribution.packageName, publisher: entry.publisher,
      categories: entry.categories, contributions: entry.summary.contributions, executableRealms: entry.summary.executableRealms,
      platforms: entry.compatibility.platforms, review: entry.review, updatePolicy: entry.updatePolicy, links: entry.links,
    } }] }] });
    const read = await host.fetchRequest({ op: 'read', kind: 'plugin', sourceId: source.id, itemId: 'acme.plugin', version: '1.0.0' });
    if (read.op !== 'read') throw new Error('Expected catalog read');
    expect(RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(read.item))).payload).toEqual({ kind: 'plugin', listing: entry, source: catalog.source });
    expect(RegistryItemV1Schema.safeParse({ ...read.item, summary: { ...read.item.summary,
      pluginListing: { ...read.item.summary.pluginListing, pluginId: 'other.plugin' } } }).success).toBe(false);
    const newer = MarketplaceIndexEntryV1Schema.parse({ ...entry, distribution: { ...entry.distribution, version: '2.0.0' } });
    catalog.entries = [newer, entry];
    expect(await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [source.id] }))
      .toMatchObject({ pages: [{ items: [{ itemId: 'acme.plugin', version: '2.0.0' }] }] });
    const pinned = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read',
      { kind: 'plugin', sourceId: source.id, itemId: 'acme.plugin', version: '1.0.0' }));
    expect(RegistryItemV1Schema.parse(pinned.item).payload).toEqual({ kind: 'plugin', listing: entry, source: catalog.source });
    const declared = createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.sources', suppliers: ['installed-source-plugin'],
      definition: { id: 'team', title: 'Team declaration', format: 'happier-catalog', kinds: ['plugin'], url } });
    pluginSources = [declared];
    catalog.discovery = { items: [{ id: 'plugin', title: entry.display.title,
      reference: { type: 'registryItem', kind: 'plugin', sourceId: source.id, itemId: entry.pluginId, version: '1.0.0' } }],
      featured: { item: 'plugin', reason: 'Team choice' }, categories: [], jobs: [] };
    const declaredPage = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list',
      { kind: 'plugin', sourceIds: [declared.id] })).pages[0]!;
    expect(declaredPage.discovery?.items[0]?.reference).toMatchObject({ sourceId: declared.id, itemId: entry.pluginId, version: '1.0.0' });
    const declaredRead = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read',
      { kind: 'plugin', sourceId: declared.id, itemId: 'acme.plugin', version: '1.0.0' }));
    const consumed = RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(declaredRead.item)));
    expect(consumed.summary.sourceId).toBe(declared.id);
    expect(consumed.payload).toEqual({ kind: 'plugin', listing: entry,
      source: { id: declared.id, title: declared.title, sourceUrl: url, kind: 'user' } });
    catalog.source.id = 'marketplace:other';
    expect(await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [source.id] })).toMatchObject({ pages: [{ status: { state: 'invalid_source' }, items: [] }] });
  });
});
