import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  deriveMarketplaceSourceId,
  MarketplaceIndexSourceSnapshotV1Schema,
  createRegistryHostV1,
  listRegistrySourcesV1,
  REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
} from '@happier-dev/protocol';

import { generateMarketplaceCatalog } from './generate-marketplace-catalog.mjs';

const websiteRoot = fileURLToPath(new URL('..', import.meta.url));
const CANONICAL_SOURCE_URL = 'https://marketplace.happier.dev/catalog.json';
const VALID_ENTRY = {
  pluginId: 'com.example.sample',
  publisher: { id: 'example', displayName: 'Example' },
  display: { title: 'Sample', description: 'A sample plugin' },
  distribution: {
    kind: 'npm',
    registryOrigin: 'https://registry.npmjs.org',
    packageName: '@example/happier-sample',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  },
  manifestDigest: `sha256:${'a'.repeat(64)}`,
  compatibility: { platforms: ['linux'] },
  summary: {
    contributions: [],
    requiredHostAccess: [],
    optionalHostAccess: [],
    executableRealms: ['daemon'],
  },
  review: { status: 'approved', reviewedAt: '2026-09-20T00:00:00.000Z' },
  categories: [],
  media: [],
  updatePolicy: 'allowed',
  links: {},
};

async function writeSource(root, entries, picks = [], discovery) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'marketplace'), { recursive: true });
  await writeFile(join(root, 'marketplace', 'catalog.source.json'), JSON.stringify({ entries, picks, discovery }), 'utf8');
}

test('projects admitted editorial references while retaining unresolved choices only in the source', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-discovery-'));
  const item = { id: 'browser', title: 'Browser tools', reference: {
    type: 'registryItem', kind: 'mcpServer', sourceId: 'builtin:mcp-registry', itemId: 'io.github.microsoft/playwright-mcp',
  } };
  const pending = { id: 'app', title: 'App', pending: { reason: 'app-source-binding',
    reference: { type: 'appCatalogItem', itemId: 'uptime-kuma' } } };
  const discovery = { items: [item, pending], featured: { item: 'app', reason: 'Monitor services' },
    categories: [{ id: 'browser', title: 'Browser', items: ['browser', 'app'] }],
    suggestions: [{ item: 'browser', because: { kind: 'repository', hostingKind: 'github' } }],
    jobs: [{ id: 'browser', title: 'Browser', description: 'Use a browser', glyph: 'fcGlobe',
      groups: [{ title: 'Tools', items: ['browser', 'app'] }] }] };
  try {
    await writeSource(sourceDir, [], [], discovery);
    const output = JSON.parse(await readFile(await generateMarketplaceCatalog({ websiteRoot: sourceDir,
      publicDir: join(sourceDir, 'public') }), 'utf8'));
    assert.deepEqual(output.discovery, { items: [item], suggestions: [discovery.suggestions[0]],
      categories: [{ ...discovery.categories[0], items: ['browser'] }],
      jobs: [{ ...discovery.jobs[0], groups: [{ title: 'Tools', items: ['browser'] }] }] });
    assert.deepEqual(output.entries, []);
    await writeSource(sourceDir, [], [], { ...discovery,
      suggestions: [{ item: 'app', because: { kind: 'repository', hostingKind: 'github' } }] });
    await assert.rejects(() => generateMarketplaceCatalog({ websiteRoot: sourceDir, publicDir: join(sourceDir, 'public') }));
    await writeSource(sourceDir, [], [], { ...discovery, items: [{ ...item, reference: { ...item.reference, install: true } }, pending] });
    await assert.rejects(() => generateMarketplaceCatalog({ websiteRoot: sourceDir, publicDir: join(sourceDir, 'public') }));
    await writeSource(sourceDir, [], [], { ...discovery, jobs: [{ ...discovery.jobs[0], groups: [{ title: 'Tools', items: ['missing'] }] }] });
    await assert.rejects(() => generateMarketplaceCatalog({ websiteRoot: sourceDir, publicDir: join(sourceDir, 'public') }));
  } finally { await rm(sourceDir, { recursive: true, force: true }); }
});

test('the approved six-job source projects the featured app, native software and picks with exact generated correspondence', async () => {
  const source = JSON.parse(await readFile(join(websiteRoot, 'marketplace', 'catalog.source.json'), 'utf8'));
  assert.deepEqual(source.discovery.jobs.map(job => job.id), ['down', 'browser', 'agent', 'db', 'errors', 'media']);
  const publicDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-approved-'));
  try {
    const generated = await readFile(await generateMarketplaceCatalog({ publicDir }), 'utf8');
    assert.equal(await readFile(join(websiteRoot, 'public', 'catalog.json'), 'utf8'), generated);
    const snapshot = MarketplaceIndexSourceSnapshotV1Schema.parse(JSON.parse(generated));
    assert.deepEqual(snapshot.discovery.items.map(item => item.id), source.discovery.items.filter(item => !item.pending).map(item => item.id));
    assert.equal(snapshot.discovery.jobs.length, 6);
    assert.equal(snapshot.discovery.categories.length, 6);
    assert.deepEqual(snapshot.discovery.featured, source.discovery.featured);
    const featured = snapshot.discovery.items.find(item => item.id === snapshot.discovery.featured.item);
    assert.deepEqual(featured.reference, { type: 'registryItem', kind: 'app',
      sourceId: 'builtin:compose-catalog', itemId: 'uptime-kuma' });
    assert.deepEqual(['chrome', 'ffmpeg', 'python', 'coolify', 'dokploy'].map(id =>
      snapshot.discovery.items.find(item => item.id === id)?.reference), [
      { type: 'software', value: { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' } },
      { type: 'software', value: { pluginId: 'happier.machine.recipes', recipeId: 'ffmpeg', revision: '1' } },
      { type: 'software', value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' } },
      { type: 'software', value: { pluginId: 'happier.machine.recipes', recipeId: 'coolify', revision: '1' } },
      { type: 'software', value: { pluginId: 'happier.machine.recipes', recipeId: 'dokploy', revision: '1' } },
    ], 'curated software uses the offered native recipe and toolchain identities');
    const categorized = new Set(snapshot.discovery.categories.flatMap(category => category.items));
    assert.ok(snapshot.discovery.items.some(item => !categorized.has(item.id)
      && item.reference.type === 'registryItem' && item.reference.kind === 'skill'
      && item.reference.sourceId === 'builtin:skills-sh'
      && item.reference.itemId === 'anthropics/skills/frontend-design'),
    'native discovery picks remain available without curated-only legacy pointers');
    assert.deepEqual(snapshot.picks, []);
    assert.deepEqual(snapshot.entries, []);
    const devUrl = 'https://catalog-dev.example.test/catalog.json';
    const devSnapshot = JSON.parse(await readFile(await generateMarketplaceCatalog({ publicDir: join(publicDir, 'dev'), sourceUrl: devUrl }), 'utf8'));
    assert.equal(devSnapshot.source.sourceUrl, devUrl);
    assert.equal(devSnapshot.source.kind, 'user');
    assert.equal(devSnapshot.source.id, deriveMarketplaceSourceId(devUrl));
    assert.deepEqual(devSnapshot.discovery, snapshot.discovery);
    const devId = deriveMarketplaceSourceId(devUrl);
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [{ id: devId,
      title: 'Approved dev catalog', format: 'happier-catalog', kinds: ['plugin'], url: devUrl, enabled: true, addedAt: 1 }],
      disabledSourceIds: [] }, pluginSources: [] });
    const requests = [];
    const host = createRegistryHostV1({ host: 'web', readSources: async () => sources, http: {
      async getJson(url) {
        requests.push(url);
        if (url === devUrl) return { ok: true, value: devSnapshot, fetchedAt: 1 };
        assert.match(url, /io.github.microsoft%2Fplaywright-mcp\/versions\/1\.0\.0$/u);
        return { ok: true, fetchedAt: 1, value: { server: { name: 'io.github.microsoft/playwright-mcp',
          title: 'Playwright', description: 'Fixture browser tools', version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@playwright/mcp',
            version: '1.0.0', transport: { type: 'stdio' } }] } } };
      },
      async getText() { throw new Error('Browse must not read target text'); },
      async getBytes() { throw new Error('Browse must not read target bytes'); },
    } });
    const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'plugin', sourceIds: [devId],
    })).pages[0];
    assert.equal(page.status.state, 'ok');
    assert.deepEqual(page.discovery, snapshot.discovery);
    assert.deepEqual(requests, [devUrl], 'all jobs/categories share one inert catalog read, with zero target bodies');
    const browser = page.discovery.jobs.find(job => job.id === 'browser');
    const selected = page.discovery.items.find(item => item.id === browser.groups[1].items[0]).reference;
    assert.equal(selected.itemId, 'io.github.microsoft/playwright-mcp');
    const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: selected.kind, sourceId: selected.sourceId, itemId: selected.itemId, version: '1.0.0',
    })).item;
    assert.equal(item.payload.kind, 'mcpServer');
    assert.equal(item.summary.sourceId, selected.sourceId);
    assert.equal(item.summary.version, '1.0.0');
    assert.equal(requests.length, 2, 'only the selected native pin is read');
  } finally { await rm(publicDir, { recursive: true, force: true }); }
});

test('emits validated curated registry pointers without copying their content', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-picks-'));
  const publicDir = join(sourceDir, 'public');
  const picks = [{ kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: '', path: 'review' }];
  try {
    await writeSource(sourceDir, [], picks);
    const output = JSON.parse(await readFile(await generateMarketplaceCatalog({ publicDir, websiteRoot: sourceDir }), 'utf8'));
    assert.deepEqual(MarketplaceIndexSourceSnapshotV1Schema.parse(output).picks, picks);
    await writeSource(sourceDir, [], [{ ...picks[0], kind: 'plugin' }]);
    await assert.rejects(() => generateMarketplaceCatalog({ publicDir, websiteRoot: sourceDir }));
  } finally { await rm(sourceDir, { recursive: true, force: true }); }
});

test('emits a deterministic strict curated snapshot bound to the canonical source identity', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-catalog-'));
  try {
    const outputPath = await generateMarketplaceCatalog({ publicDir });
    assert.equal(outputPath, join(publicDir, 'catalog.json'));
    const raw = await readFile(outputPath, 'utf8');
    const snapshot = MarketplaceIndexSourceSnapshotV1Schema.parse(JSON.parse(raw));
    assert.equal(snapshot.source.sourceUrl, CANONICAL_SOURCE_URL);
    assert.equal(snapshot.source.kind, 'curated');
    assert.equal(snapshot.source.id, deriveMarketplaceSourceId(CANONICAL_SOURCE_URL));
    assert.deepEqual(snapshot.entries, [], 'the source stays empty until an approved public npm release exists');
    // Deterministic bytes: a second generation from the same source input is identical,
    // and an unchanged rerun leaves the published file untouched (no mtime churn for build caches).
    const { stat, utimes } = await import('node:fs/promises');
    await utimes(outputPath, 1_000_000, 1_000_000);
    const secondPath = await generateMarketplaceCatalog({ publicDir });
    assert.equal(await readFile(secondPath, 'utf8'), raw);
    assert.equal((await stat(secondPath)).mtimeMs, 1_000_000_000, 'an unchanged rerun rewrote catalog.json');
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
});

test('rejects unreviewed curated entries', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-catalog-invalid-'));
  const sourceDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-source-'));
  try {
    await writeSource(sourceDir, [{ ...VALID_ENTRY, review: { status: 'unreviewed', reviewedAt: null } }]);
    await assert.rejects(() => generateMarketplaceCatalog({ publicDir, websiteRoot: sourceDir }));
  } finally {
    await rm(publicDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test('rejects inexact versions, malformed SRI, and private registry bindings', async () => {
  for (const distribution of [
    { ...VALID_ENTRY.distribution, version: '^1.0.0' },
    { ...VALID_ENTRY.distribution, integrity: 'sha512-not-complete' },
    { ...VALID_ENTRY.distribution, registryProfileId: 'private-registry' },
  ]) {
    const publicDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-catalog-invalid-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-source-'));
    try {
      await writeSource(sourceDir, [{ ...VALID_ENTRY, distribution }]);
      await assert.rejects(() => generateMarketplaceCatalog({ publicDir, websiteRoot: sourceDir }));
    } finally {
      await rm(publicDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  }
});

test('publication configuration exposes only the curated catalog path on the marketplace host', async () => {
  const wrangler = await readFile(join(websiteRoot, 'wrangler.toml'), 'utf8');
  assert.match(wrangler, /pattern\s*=\s*"marketplace\.happier\.dev\/catalog\.json"[\s\S]*?zone_name\s*=\s*"happier\.dev"/u);
  assert.doesNotMatch(wrangler, /pattern\s*=\s*"marketplace\.happier\.dev"\s*[\r\n]+\s*custom_domain\s*=\s*true/u);
});

test('committed editorial source parses offline without npm availability', async () => {
  const raw = await readFile(join(websiteRoot, 'marketplace', 'catalog.source.json'), 'utf8');
  const source = JSON.parse(raw);
  assert.ok(Array.isArray(source.entries));
});
