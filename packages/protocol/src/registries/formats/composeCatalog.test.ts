import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1, HAPPIER_PICKS_SOURCE_ID, listRegistrySourcesV1, RegistrySourceDescriptorV1Schema, type RegistrySourceDescriptorV1 } from '../registrySourcesV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';
import { composeCatalogRegistryAdapterV1 } from './composeCatalog.js';
import { computeGitBlobShaV1, computeGitTreeShaFromEntriesV1, computeGitTreeShaV1 } from '../registryGitTreeV1.js';
import { MarketplaceIndexSourceSnapshotV1Schema } from '../../marketplace/marketplaceIndexV1.js';

// Original Apache-2.0 catalog input: coolify/templates/compose/uptime-kuma.yaml,
// inspected 2026-10-25. The variable alias intentionally differs from its service.
const original = `# documentation: https://github.com/louislam/uptime-kuma?tab=readme-ov-file
# slogan: Uptime Kuma is a monitoring tool for tracking the status and performance of your applications in real-time.
# category: monitoring
# tags: monitoring, status, performance, web, services, applications, real-time
# logo: svgs/uptime-kuma.svg
# port: 3001

services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    environment:
      - SERVICE_URL_UPTIMEKUMA_3001
    volumes:
      - uptime-kuma-data:/app/data
    healthcheck:
      test: ["CMD-SHELL", "extra/healthcheck"]
      interval: 5s
      timeout: 5s
      retries: 10
`;
const commit = 'a'.repeat(40);
const source = (sourceId = 'catalog') => RegistrySourceDescriptorV1Schema.parse({ id: sourceId, title: 'Apps', format: 'coolify-templates',
  kinds: ['app'], url: 'https://github.com/example/catalog', enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true });
function harness(body = original, entries: unknown = [{ name: 'uptime-kuma', slogan: 'Monitoring', category: 'monitoring', compose: 'not-base64', envs: 'not-base64' }], descriptor = source()) {
  const calls: string[] = [];
  const http: RegistryHttpV1 = {
    getJson: async url => { calls.push(url); return { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: commit } : entries }; },
    getText: async url => { calls.push(url); return { ok: true, fetchedAt: 2, value: body }; },
    getBytes: async () => { throw new Error('Unexpected bytes acquisition'); },
  };
  const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [descriptor] });
  return { host, calls };
}
describe('Compose catalog through the registered registry owner', () => {
  it.each([
    { itemId: 'status_page-agent', metadata: {}, title: 'Status Page Agent' },
    { itemId: 'uptime-kuma', metadata: { name: 'uPTIME Kuma v2', title: 'Other title' }, title: 'uPTIME Kuma v2' },
    { itemId: 'uptime-kuma', metadata: { title: 'myStatus v2' }, title: 'myStatus v2' },
  ])('uses $title for list and selected app display while preserving $itemId identity', async ({ itemId, metadata, title }) => {
    const { host, calls } = harness(original, { [itemId]: { slogan: 'Monitoring', ...metadata } });
    expect(await host.fetchRequest({ op: 'list', sourceId: 'catalog', kind: 'app' }))
      .toMatchObject({ op: 'list', page: { items: [{ itemId, title }] } });
    expect(await host.fetchRequest({ op: 'read', sourceId: 'catalog', kind: 'app', itemId, version: commit }))
      .toMatchObject({ op: 'read', item: { summary: { itemId, title }, payload: { kind: 'app', state: 'ready', app: { title } } } });
    expect(calls.filter(url => /\.ya?ml$/.test(url)))
      .toEqual([`https://raw.githubusercontent.com/example/catalog/${commit}/templates/compose/${itemId}.yaml`]);
  });
  it('preserves rate limiting from a direct template catalog without losing retry metadata', async () => {
    const requests: string[] = [];
    const unused = async (): Promise<never> => { throw new Error('Detection acquired template content'); };
    const http: RegistryHttpV1 = {
      getJson: async url => { requests.push(url); return { ok: false, status: { state: 'rate_limited', retryAt: 1234 } }; },
      getText: unused, getBytes: unused,
    };
    const detect = composeCatalogRegistryAdapterV1.detect;
    if (!detect) throw new Error('Missing compose catalog detection');
    const url = 'https://templates.example/service-templates.json';
    await expect(detect({ http }, url)).rejects.toMatchObject({ status: { state: 'rate_limited', retryAt: 1234 } });
    expect(requests).toEqual([url]);
  });
  const readReview = async (body: string) => {
    const response = await harness(body).host.fetchRequest({ op: 'read', sourceId: 'catalog', kind: 'app', itemId: 'uptime-kuma', version: commit });
    if (response.op !== 'read' || response.item.payload.kind !== 'app') throw new Error(JSON.stringify(response));
    return { payload: response.item.payload, problem: response.item.summary.problem };
  };
  const read = async (body: string) => {
    const result = await readReview(body);
    if (result.payload.state !== 'ready') throw new Error(JSON.stringify(result.problem));
    return { app: result.payload.app, problem: result.problem };
  };
  it('preserves native relative icon and upstream minimum-version metadata without inventing a Happier version floor', async () => {
    // Exact metadata fields from the pinned research clone's native index.
    const metadata = { 'uptime-kuma': {
      documentation: 'https://github.com/louislam/uptime-kuma?tab=readme-ov-file?utm_source=coolify.io',
      slogan: 'Uptime Kuma is a monitoring tool for tracking the status and performance of your applications in real-time.',
      tags: ['monitoring', 'status', 'performance', 'web', 'services', 'applications', 'real-time'],
      category: 'monitoring', logo: 'svgs/uptime-kuma.svg', minversion: '0.0.0',
      template_last_updated_at: '2026-01-08T21:10:17+01:00', port: '3001',
    } };
    const { host, calls } = harness(original, metadata);
    const listed = await host.fetchRequest({ op: 'list', sourceId: 'catalog', kind: 'app' });
    const pinnedIcon = `https://raw.githubusercontent.com/example/catalog/${commit}/public/svgs/uptime-kuma.svg`;
    expect(listed).toMatchObject({ op: 'list', page: { items: [{ itemId: 'uptime-kuma', title: 'Uptime Kuma', iconUrl: pinnedIcon,
      appMetadata: { upstreamIcon: 'svgs/uptime-kuma.svg', upstreamMinimumVersion: '0.0.0', containerPort: 3001, category: 'monitoring' } }] } });
    expect(calls.some(url => /\.ya?ml$/.test(url))).toBe(false);
    const selected = await host.fetchRequest({ op: 'read', sourceId: 'catalog', kind: 'app', itemId: 'uptime-kuma', version: commit });
    expect(selected).toMatchObject({ op: 'read', item: { summary: { itemId: 'uptime-kuma', title: 'Uptime Kuma', iconUrl: pinnedIcon,
      appMetadata: { upstreamIcon: 'svgs/uptime-kuma.svg', upstreamMinimumVersion: '0.0.0' } }, payload: { kind: 'app', state: 'ready', app: { title: 'Uptime Kuma' } } } });
    if (selected.op !== 'read' || selected.item.payload.kind !== 'app' || selected.item.payload.state !== 'ready') throw new Error('Expected metadata-only upstream requirement');
    expect(selected.item.payload.app.minimumResources).toBeUndefined();
    const direct = RegistrySourceDescriptorV1Schema.parse({ ...source(), url: 'https://templates.example/service-templates.json' });
    const directHarness = harness(original, metadata, direct);
    const directList = await directHarness.host.fetchRequest({ op: 'list', sourceId: 'catalog', kind: 'app' });
    expect(directList).toMatchObject({ op: 'list', page: { items: [{ appMetadata: { upstreamIcon: 'svgs/uptime-kuma.svg', upstreamMinimumVersion: '0.0.0' } }] } });
    if (directList.op !== 'list') throw new Error('Expected direct HTTP catalog');
    expect(directList.page.items[0]).not.toHaveProperty('iconUrl');
    expect(directHarness.calls).toEqual(['https://templates.example/service-templates.json']);
  });
  it('detects and creates a GitHub catalog source through the same source writer before metadata-only browsing', async () => {
    let sources: RegistrySourceDescriptorV1[] = [];
    const calls: string[] = [];
    const unused = async (): Promise<never> => { throw new Error('Detection/list acquired a body'); };
    const http: RegistryHttpV1 = { getJson: async url => {
      calls.push(url);
      return { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: commit }
        : { 'uptime-kuma': { slogan: 'Monitoring', compose: 'not-base64', tags: ['monitoring'], category: 'operations', port: '3001' } } };
    }, getText: unused, getBytes: unused };
    const host = createRegistryHostV1({ host: 'node', http, readSources: async () => sources, mutateSources: async mutation => {
      if (mutation.kind !== 'create') throw new Error('Unexpected mutation');
      sources = [RegistrySourceDescriptorV1Schema.parse({ ...mutation.source, origin: { kind: 'user' }, removable: true })];
      return { status: 'updated', revision: 1 };
    } });
    expect(await host.execute('registries.sources.create', { url: 'https://github.com/example/catalog' })).toMatchObject({ source: { format: 'coolify-templates', kinds: ['app'] }, existing: false });
    const listed = await host.fetchRequest({ op: 'list', sourceId: sources[0]!.id, kind: 'app' });
    expect(listed).toMatchObject({ op: 'list', page: { items: [{ itemId: 'uptime-kuma', appMetadata: { category: 'operations', tags: ['monitoring'], containerPort: 3001 } }] } });
    expect(calls.filter(url => url.endsWith('/templates/service-templates.json'))).toHaveLength(2);
    expect(calls.some(url => /\.ya?ml$/.test(url))).toBe(false);
  });
  it('browses one metadata index without reading or decoding unrelated bodies, then selects only the pinned original', async () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({ name: `other-${i}`, slogan: 'Other', compose: 'deliberately-invalid-base64' }));
    const { host, calls } = harness(original, [{ name: 'uptime-kuma', slogan: 'Monitoring', compose: 'deliberately-invalid-base64' }, ...entries]);
    const listed = await host.fetchRequest({ op: 'list', sourceId: 'catalog', kind: 'app' });
    expect(listed).toMatchObject({ op: 'list', page: { status: { state: 'ok' }, total: 251 } });
    if (listed.op !== 'list') throw new Error('Expected app list');
    expect(listed.page.items[0]).toMatchObject({ itemId: 'uptime-kuma', version: commit });
    expect(calls.filter(url => url.endsWith('/templates/service-templates.json'))).toHaveLength(1);
    expect(calls.some(url => /\.ya?ml$/.test(url))).toBe(false);
    const selected = await host.fetchRequest({ op: 'read', sourceId: 'catalog', kind: 'app', itemId: 'uptime-kuma', version: commit });
    expect(selected.op).toBe('read');
    if (selected.op !== 'read' || selected.item.payload.kind !== 'app' || selected.item.payload.state !== 'ready') throw new Error('Expected app');
    expect(selected.item.summary.problem).toBeUndefined();
    expect(selected.item.payload.app.domains).toEqual([{ key: 'SERVICE_URL_UPTIMEKUMA_3001', service: 'uptime-kuma', containerPort: 3001, protocol: 'http', required: true }]);
    const effective = parse(selected.item.payload.app.compose.document);
    expect(effective.services['uptime-kuma']).toMatchObject({ image: 'louislam/uptime-kuma:2', volumes: ['uptime-kuma-data:/app/data'], healthcheck: { test: ['CMD-SHELL', 'extra/healthcheck'], retries: 10 } });
    expect(effective.services['uptime-kuma'].environment ?? []).not.toContain('SERVICE_URL_UPTIMEKUMA_3001');
    expect(calls.filter(url => /\.ya?ml$/.test(url))).toEqual([`https://raw.githubusercontent.com/example/catalog/${commit}/templates/compose/uptime-kuma.yaml`]);
  });
  it('keeps a missing Git template body reviewable with the actual pinned index input, without inventing an app', async () => {
    const metadata = { 'uptime-kuma': { slogan: 'Monitoring', category: 'monitoring' } };
    const indexPath = 'templates/service-templates.json';
    const indexBytes = new TextEncoder().encode(JSON.stringify(metadata));
    const calls: string[] = [];
    let bodyStatus: 'invalid_source' | 'auth_failed' = 'invalid_source';
    const http: RegistryHttpV1 = {
      getJson: async url => {
        calls.push(url);
        return { ok: true, fetchedAt: 10, value: url.includes('/commits/') ? { sha: commit }
          : url.includes('/git/trees/') ? { sha: 'b'.repeat(40), tree: [
            { path: indexPath, mode: '100644', type: 'blob', sha: computeGitBlobShaV1(indexBytes) },
            { path: 'templates/compose/unrelated.yaml', mode: '100644', type: 'blob', sha: 'c'.repeat(40) },
          ] } : metadata };
      },
      getText: async url => { calls.push(url); return { ok: false, status: { state: bodyStatus } }; },
      getBytes: async () => { throw new Error('Unexpected bytes acquisition'); },
    };
    const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [source()] });
    const response = await host.fetchRequest({ op: 'read', sourceId: 'catalog', kind: 'app', itemId: 'uptime-kuma', version: commit });
    const diagnostics = [{ field: 'compose.document', reason: 'body_unavailable' }];
    expect(response).toMatchObject({ op: 'read', item: {
      summary: { title: 'Uptime Kuma', description: 'Monitoring', problem: { code: 'needs_review', diagnostics } },
      payload: { kind: 'app', state: 'needs_review', diagnostics, ref: { kind: 'gitTree', repo: 'https://github.com/example/catalog', commit, path: '',
        treeSha: computeGitTreeShaV1([{ path: indexPath, unixMode: 0o644, bytes: indexBytes }]) } },
    } });
    if (response.op !== 'read') throw new Error('Expected review-only source input');
    expect(response.item.payload).not.toHaveProperty('app');
    expect(calls.filter(url => /\.ya?ml$/.test(url))).toEqual([
      `https://raw.githubusercontent.com/example/catalog/${commit}/templates/compose/uptime-kuma.yaml`,
      `https://raw.githubusercontent.com/example/catalog/${commit}/templates/compose/uptime-kuma.yml`,
    ]);
    calls.length = 0;
    bodyStatus = 'auth_failed';
    expect(await host.fetchRequest({ op: 'read', sourceId: 'catalog', kind: 'app', itemId: 'uptime-kuma', version: commit }))
      .toMatchObject({ op: 'error', status: { state: 'auth_failed' } });
    expect(calls.some(url => url.includes('/git/trees/'))).toBe(false);
  });
  it('keeps a missing HTTP body reviewable against exact index bytes while preserving auth and reviewed-pin refusal', async () => {
    const descriptor = RegistrySourceDescriptorV1Schema.parse({ ...source(), url: 'https://templates.example/service-templates.json' });
    const indexText = '{\n  "uptime-kuma": {"slogan": "Monitoring"}\n}\n';
    const calls: string[] = [];
    let bodyStatus: 'invalid_source' | 'auth_failed' = 'invalid_source';
    const http: RegistryHttpV1 = {
      getJson: async url => { calls.push(url); return { ok: true, fetchedAt: 10, value: JSON.parse(indexText) }; },
      getText: async url => {
        calls.push(url);
        return url === descriptor.url ? { ok: true, fetchedAt: 11, value: indexText }
          : { ok: false, status: { state: bodyStatus } };
      },
      getBytes: async () => { throw new Error('Unexpected byte acquisition'); },
    };
    const host = createRegistryHostV1({ host: 'node', http, readSources: async () => [descriptor] });
    const response = await host.fetchRequest({ op: 'read', sourceId: descriptor.id, kind: 'app', itemId: 'uptime-kuma' });
    expect(response).toMatchObject({ op: 'read', item: {
      summary: { description: 'Monitoring', problem: { code: 'needs_review', diagnostics: [{ field: 'compose.document', reason: 'body_unavailable' }] } },
      payload: { kind: 'app', state: 'needs_review', ref: { kind: 'content' } },
    } });
    if (response.op !== 'read' || response.item.payload.kind !== 'app') throw new Error('Expected review-only index input');
    expect(response.item.payload).not.toHaveProperty('app');
    expect(calls).toEqual([descriptor.url, 'https://templates.example/compose/uptime-kuma.yaml',
      'https://templates.example/compose/uptime-kuma.yml', descriptor.url]);
    const priorRef = response.item.payload.ref;
    if (priorRef.kind !== 'content') throw new Error('HTTP review must identify its content');
    expect(priorRef.digest).toBe(`sha256:${createHash('sha256').update(JSON.stringify([
      { path: 'service-templates.json', content: indexText },
    ])).digest('hex')}`);
    // A reviewed installable body's pin cannot be replaced by an index-only pin.
    expect(await host.fetchRequest({ op: 'read', sourceId: descriptor.id, kind: 'app', itemId: 'uptime-kuma',
      version: `sha256:${'0'.repeat(64)}` })).toMatchObject({ op: 'error', status: { state: 'invalid_source' } });
    calls.length = 0;
    bodyStatus = 'auth_failed';
    expect(await host.fetchRequest({ op: 'read', sourceId: descriptor.id, kind: 'app', itemId: 'uptime-kuma' }))
      .toMatchObject({ op: 'error', status: { state: 'auth_failed' } });
    expect(calls).toEqual([descriptor.url, 'https://templates.example/compose/uptime-kuma.yaml']);
  });
  it('honours ignored index entries and ignored selected headers without a direct-read bypass', async () => {
    const ignored = harness(original, [{ name: 'hidden', ignore: true }, { name: 'uptime-kuma' }]);
    expect(await ignored.host.fetchRequest({ op: 'list', sourceId: 'catalog', kind: 'app' })).toMatchObject({ op: 'list', page: { items: [{ itemId: 'uptime-kuma' }], total: 1 } });
    expect(await ignored.host.fetchRequest({ op: 'read', sourceId: 'catalog', kind: 'app', itemId: 'hidden' })).toMatchObject({ op: 'error', status: { state: 'invalid_source' } });
    expect(ignored.calls.some(url => url.includes('/hidden.yaml'))).toBe(false);
    expect(await harness(`# ignore: true\n${original}`).host.fetchRequest({ op: 'read', sourceId: 'catalog', kind: 'app', itemId: 'uptime-kuma' })).toMatchObject({ op: 'error', status: { state: 'invalid_source' } });
  });
  it('applies curated first-run metadata only to the exact built-in source/item without inventing a login', async () => {
    const defaults = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] });
    expect(defaults.find(candidate => candidate.id === HAPPIER_PICKS_SOURCE_ID)?.kinds).toContain('app');
    const builtin = BUILT_IN_REGISTRY_SOURCES_V1.find(candidate => candidate.id === 'builtin:compose-catalog');
    expect(builtin).toMatchObject({ url: 'https://github.com/coollabsio/coolify', format: 'coolify-templates', kinds: ['app'], origin: { kind: 'built_in' } });
    if (!builtin) throw new Error('Missing declared built-in catalog');
    const { host, calls } = harness(original, [{ name: 'uptime-kuma', slogan: 'Monitoring' }], builtin);
    const response = await host.fetchRequest({
      op: 'read', sourceId: 'builtin:compose-catalog', kind: 'app', itemId: 'uptime-kuma', version: commit,
    });
    expect(response).toMatchObject({ op: 'read', item: { payload: { kind: 'app', app: { firstRunSetup: true } } } });
    if (response.op !== 'read' || response.item.payload.kind !== 'app' || response.item.payload.state !== 'ready') throw new Error('Expected built-in app');
    expect(response.item.summary.problem).toBeUndefined();
    expect(response.item.payload.app.loginFields).toBeUndefined();
    expect(response.item.payload.app.generatedSecrets).toEqual([]);
    expect(calls.filter(url => /\.ya?ml$/.test(url))).toEqual([`https://raw.githubusercontent.com/coollabsio/coolify/${commit}/templates/compose/uptime-kuma.yaml`]);
    expect((await read(original)).app.firstRunSetup).toBeUndefined();
    const review = await harness('services: [', [{ name: 'uptime-kuma' }], builtin).host.fetchRequest({
      op: 'read', sourceId: builtin.id, kind: 'app', itemId: 'uptime-kuma', version: commit,
    });
    expect(review).toMatchObject({ op: 'read', item: { payload: { kind: 'app', state: 'needs_review' } } });
    if (review.op !== 'read') throw new Error('Expected review-only app');
    expect(review.item.payload).not.toHaveProperty('app');
  });
  it('does not borrow curated metadata from a spoofed built-in id with another repository', async () => {
    for (const origin of [{ kind: 'user' }, { kind: 'built_in' }] as const) {
      const descriptor = RegistrySourceDescriptorV1Schema.parse({ ...source('builtin:compose-catalog'), origin });
      const response = await harness(original, [{ name: 'uptime-kuma', slogan: 'Monitoring' }], descriptor).host.fetchRequest({
        op: 'read', sourceId: descriptor.id, kind: 'app', itemId: 'uptime-kuma', version: commit,
      });
      if (response.op !== 'read' || response.item.payload.kind !== 'app' || response.item.payload.state !== 'ready') throw new Error('Expected unhinted app');
      expect(response.item.payload.app.firstRunSetup).toBeUndefined();
      expect(response.item.payload.app.loginFields).toBeUndefined();
    }
  });
  it('does not borrow built-in hints through another source identity, path or ref', async () => {
    const builtin = BUILT_IN_REGISTRY_SOURCES_V1.find(candidate => candidate.id === 'builtin:compose-catalog');
    if (!builtin || 'packageContent' in builtin) throw new Error('Missing built-in catalog');
    const variants = [
      { ...builtin, id: 'user-copy', origin: { kind: 'user' }, removable: true },
      { ...builtin, id: 'external/apps', origin: { kind: 'plugin', pluginId: 'external', localId: 'apps', suppliers: ['machine'] } },
      { ...builtin, path: 'foreign/templates' },
      { ...builtin, ref: 'another-release' },
      { ...builtin, origin: { kind: 'user' }, removable: true },
    ];
    for (const variant of variants) {
      const descriptor = RegistrySourceDescriptorV1Schema.parse(variant);
      const response = await harness(original, [{ name: 'uptime-kuma' }], descriptor).host.fetchRequest({
        op: 'read', sourceId: descriptor.id, kind: 'app', itemId: 'uptime-kuma', version: commit,
      });
      if (response.op !== 'read' || response.item.payload.kind !== 'app' || response.item.payload.state !== 'ready') throw new Error('Expected unhinted app');
      expect.soft(response.item.payload.app.firstRunSetup, JSON.stringify(variant)).toBeUndefined();
      expect(response.item.payload.app.loginFields).toBeUndefined();
    }
  });
  it('preserves the exact built-in catalog hint through a curated pointer without extra body reads', async () => {
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] });
    const picks = sources.find(candidate => candidate.id === HAPPIER_PICKS_SOURCE_ID);
    const builtin = sources.find(candidate => candidate.id === 'builtin:compose-catalog');
    if (!picks || 'packageContent' in picks || !builtin || 'packageContent' in builtin) throw new Error('Missing declared catalogs');
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({
      source: { id: picks.id, sourceUrl: picks.url, title: picks.title, kind: 'curated' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [],
      picks: [{ kind: 'app', format: 'coolify-templates', sourceUrl: builtin.url, itemId: 'uptime-kuma' }],
    });
    const calls: string[] = [];
    const host = createRegistryHostV1({ host: 'node', readSources: async () => sources, http: {
      getJson: async url => { calls.push(url); return { ok: true, fetchedAt: 1,
        value: url === picks.url ? catalog : url.includes('/commits/') ? { sha: commit } : [{ name: 'uptime-kuma' }] }; },
      getText: async url => { calls.push(url); return { ok: true, fetchedAt: 2, value: original }; },
      getBytes: async () => { throw new Error('Unexpected byte acquisition'); },
    } });
    const response = await host.fetchRequest({ op: 'read', sourceId: picks.id, kind: 'app', itemId: 'uptime-kuma', version: commit });
    expect(response).toMatchObject({ op: 'read', item: { summary: { sourceId: picks.id, itemId: 'uptime-kuma' },
      payload: { kind: 'app', state: 'ready', app: { firstRunSetup: true, generatedSecrets: [] } } } });
    expect(calls.filter(url => /\.ya?ml$/.test(url))).toEqual([`https://raw.githubusercontent.com/coollabsio/coolify/${commit}/templates/compose/uptime-kuma.yaml`]);
  });
  it('routes aliases from declarations, distinguishes references and shares URL/host domain bindings', async () => {
    const { app, problem } = await read(`services:
  web-api:
    image: example/api:1
    environment: [SERVICE_URL_CUSTOM_ALIAS_8080]
  worker:
    image: example/worker:1
    environment:
      API_URL: $SERVICE_URL_CUSTOM_ALIAS_8080
      API_HOST: \${SERVICE_FQDN_CUSTOM_ALIAS_8080}
`);
    expect(problem).toBeUndefined();
    expect(app.domains).toEqual([{ key: 'SERVICE_URL_CUSTOM_ALIAS_8080', service: 'web-api', containerPort: 8080, protocol: 'http', required: true }]);
    expect(app.variables).toMatchObject([
      { key: 'SERVICE_URL_CUSTOM_ALIAS_8080', valueFrom: { kind: 'domainUrl', domainKey: 'SERVICE_URL_CUSTOM_ALIAS_8080' }, sites: [{ service: 'worker', path: ['environment', 'API_URL'] }] },
      { key: 'SERVICE_FQDN_CUSTOM_ALIAS_8080', valueFrom: { kind: 'domainHost', domainKey: 'SERVICE_URL_CUSTOM_ALIAS_8080' } },
    ]);
    const copied = await read(`services:
  app:
    image: example/app:1
    environment: [SERVICE_URL_APP_8080]
  worker:
    image: example/worker:1
    environment: {COPY: "$SERVICE_URL_APP_8080"}
`);
    expect(copied.problem).toBeUndefined();
    expect(copied.app.domains).toHaveLength(1);
    expect(copied.app.domains[0]?.service).toBe('app');
    expect((await readReview(`services:
  alias:
    image: example/app:1
    environment: [SERVICE_URL_ALIAS_8080]
  worker:
    image: example/worker:1
    environment: [SERVICE_URL_ALIAS_8080]
`)).problem).toMatchObject({ code: 'needs_review', diagnostics: expect.arrayContaining([expect.objectContaining({ reason: 'conflicting_domain_owner' })]) });
  });
  it('preserves per-expression fallback omission instead of inventing a global binding default', async () => {
    const optional = await read(`services:
  app:
    image: example/app:1
    environment:
      FIRST: \${X:-alpha}
      SECOND: \${X:-beta}
      ALTERNATIVE: \${X:+present}
`);
    expect(optional.app.variables).toEqual([expect.objectContaining({ key: 'X', required: false })]);
    expect(optional.app.variables[0]).not.toHaveProperty('default');
    expect(parse(optional.app.compose.document).services.app.environment).toEqual({ FIRST: '${X:-alpha}', SECOND: '${X:-beta}', ALTERNATIVE: '${X:+present}' });
    const required = await read(`services:
  app:
    image: example/app:1
    environment:
      FIRST: \${X:-alpha}
      REQUIRED: \${X:?required}
`);
    expect(required.app.variables).toEqual([expect.objectContaining({ key: 'X', required: true })]);
    expect(required.app.variables[0]).not.toHaveProperty('default');
  });
  it('resolves supported mapping merges before finding inherited Domain and variable declarations', async () => {
    const { app, problem } = await read(`x-base: &base
  image: example/app:1
  environment:
    SERVICE_URL_WEB_8080:
    TOKEN: \${TOKEN:?required}
services:
  web:
    <<: *base
`);
    expect(problem).toBeUndefined();
    expect(app.domains).toEqual([{ key: 'SERVICE_URL_WEB_8080', service: 'web', containerPort: 8080, protocol: 'http', required: true }]);
    expect(app.variables).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'TOKEN', required: true,
      sites: [{ service: 'web', path: ['environment', 'TOKEN'] }] })]));
    expect(parse(app.compose.document).services.web).toMatchObject({ image: 'example/app:1', environment: { TOKEN: '${TOKEN:?required}' } });
  });
  it('preserves exact generator profiles and one secret identity across substitution sites', async () => {
    const { app, problem } = await read(`services:
  app:
    image: example/app:1
    environment:
      FIRST: \${SERVICE_PASSWORD_FOO}
      SECOND: \${SERVICE_PASSWORD_FOO}
      LONG: \${SERVICE_PASSWORD_64_FOO}
      USER: \${SERVICE_USER_FOO}
      ALPHA: \${SERVICE_BASE64_128_FOO}
      HEX32: \${SERVICE_HEX_32_FOO}
      HEX64: \${SERVICE_HEX_64_FOO}
      HEX128: \${SERVICE_HEX_128_FOO}
      BASE32: \${SERVICE_REALBASE64_FOO}
      BASE64: \${SERVICE_REALBASE64_64_FOO}
      BASE128: \${SERVICE_REALBASE64_128_FOO}
`);
    expect(problem).toBeUndefined();
    expect(Object.fromEntries(app.generatedSecrets.map(secret => [secret.key, secret.profile]))).toEqual({
      SERVICE_PASSWORD_FOO: { kind: 'alphanumeric-characters', characters: 32 }, SERVICE_PASSWORD_64_FOO: { kind: 'alphanumeric-characters', characters: 64 },
      SERVICE_USER_FOO: { kind: 'alphanumeric-characters', characters: 16 }, SERVICE_BASE64_128_FOO: { kind: 'alphanumeric-characters', characters: 128 },
      SERVICE_HEX_32_FOO: { kind: 'hex-bytes', bytes: 16 }, SERVICE_HEX_64_FOO: { kind: 'hex-bytes', bytes: 32 }, SERVICE_HEX_128_FOO: { kind: 'hex-bytes', bytes: 64 },
      SERVICE_REALBASE64_FOO: { kind: 'base64-bytes', bytes: 32 }, SERVICE_REALBASE64_64_FOO: { kind: 'base64-bytes', bytes: 64 }, SERVICE_REALBASE64_128_FOO: { kind: 'base64-bytes', bytes: 128 },
    });
    expect(app.variables.find(variable => variable.key === 'SERVICE_PASSWORD_FOO')?.sites).toHaveLength(2);
  });
  it('converts public inline content without overwriting configs and removes dialect health fields', async () => {
    const { app, problem } = await read(`services:
  app:
    image: example/app:1
    exclude_from_hc: true
    healthcheck: {test: [CMD, echo, healthy]}
    volumes:
      - type: bind
        source: ./missing-sidecar.txt
        target: /etc/app.conf
        content: |-
          public=\${PUBLIC_VALUE:-hello}
          untouched bytes
configs:
  happier_app_0:
    content: original config
`);
    expect(problem).toBeUndefined();
    const document = parse(app.compose.document);
    expect(document.configs).toEqual({ happier_app_0: { content: 'original config' }, happier_app_0_2: { content: 'public=\${PUBLIC_VALUE:-hello}\nuntouched bytes' } });
    expect(document.services.app.volumes).toEqual([]);
    expect(document.services.app.configs).toEqual([{ source: 'happier_app_0_2', target: '/etc/app.conf' }]);
    expect(document.services.app.exclude_from_hc).toBeUndefined();
    expect(document.services.app.healthcheck.test).toEqual(['CMD', 'echo', 'healthy']);
    expect(app.health).toEqual([{ service: 'app', participates: false }]);
  });
  it('keeps unresolved helpers and secret or writable inline files reviewable', async () => {
    for (const [value, reason] of [['content: "\${SERVICE_PASSWORD_SECRET}"', 'secret_content_requires_binding'], ['content: public\n        read_only: false', 'writable_content_requires_review']] as const) {
      const result = await readReview(`services:
  app:
    image: example/app:1
    volumes:
      - type: bind
        source: ./file
        target: /etc/file
        ${value}
`);
      expect(result.problem).toMatchObject({ code: 'needs_review', diagnostics: [{ reason }] });
    }
    expect((await readReview(`services:
  app:
    image: example/app:1
    environment: {TOKEN: "\${SERVICE_JWT_TOKEN}"}
`)).problem).toMatchObject({ code: 'needs_review', diagnostics: [{ reason: 'unsupported_generator' }] });
  });
  it('uses the same native selected file identity for bytes and Git metadata', () => {
    const files = [{ path: 'templates/compose/uptime-kuma.yaml', unixMode: 0o644 as const, bytes: new TextEncoder().encode(original) },
      { path: 'template.toml', unixMode: 0o644 as const, bytes: new TextEncoder().encode('public = "value"') }];
    expect(computeGitTreeShaFromEntriesV1(files.map(file => ({ path: file.path, unixMode: file.unixMode, blobSha: computeGitBlobShaV1(file.bytes) })))).toBe(computeGitTreeShaV1(files));
    expect(computeGitTreeShaV1(files.slice(0, 1))).not.toBe(computeGitTreeShaV1(files));
  });
});
