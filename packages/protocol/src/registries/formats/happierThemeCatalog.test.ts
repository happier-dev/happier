import { expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, deriveMarketplaceSourceId } from '../../marketplace/marketplaceSourceRegistryV1.js';
import type { RegistrySourceDescriptorV1 } from '../registrySourcesV1.js';

it('discovers catalog summaries without opening bodies and preserves selected future presentation', async () => {
  const url = 'https://catalog.example.test/index.json';
  const source: RegistrySourceDescriptorV1 = { id: deriveMarketplaceSourceId('https://catalog.example.test/index.json'), title: 'Themes', url,
    format: 'happier-catalog', kinds: ['theme'], enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
  const calls: string[] = [];
  const profile = { schemaVersion: 1, id: 'sample_theme', name: 'Sample', createdAt: '2026-11-16', updatedAt: '2026-11-16',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, futurePresentation: { value: 'retained' } };
  const catalog = { source: { id: source.id, title: source.title, sourceUrl: url, kind: 'user' },
    freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], picks: [], diagnostics: [],
    themes: [{ itemId: 'sample', title: 'Sample', version: '1.0.0', listing: { includes: [{ key: 'night', label: 'Night', mode: 'dark' }], license: 'Custom' },
      contentUrl: 'https://catalog.example.test/sample.json' }] };
  const host = createRegistryHostV1({ host: 'web', readSources: async () => [source], http: {
    async getJson(request) { calls.push(request); return { ok: true, fetchedAt: 1, value: request === url ? catalog : { themes: [{ key: 'night', label: 'Night', mode: 'dark', document: profile }] } }; },
    async getText() { throw new Error('unexpected text'); }, async getBytes() { throw new Error('unexpected package'); },
  } });
  const page = await host.fetchRequest({ op: 'list', sourceId: source.id, kind: 'theme' });
  expect(page.op === 'list' && page.page.items).toMatchObject([{ itemId: 'sample', kind: 'theme', themeMetadata: { includes: [{ key: 'night', mode: 'dark' }] } }]);
  expect(calls).toEqual([url]);
  const metadata = await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample', version: '1.0.0' });
  expect(metadata.op === 'read' && metadata.item.payload).toMatchObject({ kind: 'theme', state: 'listing' });
  expect(calls).toEqual([url, url]);
  const item = await host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample', version: '1.0.0', themeContent: true });
  expect(item.op === 'read' && item.item.payload).toMatchObject({ kind: 'theme', state: 'ready', themes: [{ document: {
    profile: { assetAppearance: 'dark' }, raw: { assetAppearance: 'dark', futurePresentation: { value: 'retained' } },
  } }] });
  expect(calls).toEqual([url, url, url, 'https://catalog.example.test/sample.json']);
});

it('settles malformed selected catalog faces as invalid source without retrying another transport', async () => {
  const url = 'https://catalog.example.test/index.json';
  const source: RegistrySourceDescriptorV1 = { id: deriveMarketplaceSourceId(url), title: 'Themes', url,
    format: 'happier-catalog', kinds: ['theme'], enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
  const profile = { schemaVersion: 1, id: 'sample_theme', name: 'Sample', createdAt: '2026-11-16', updatedAt: '2026-11-16',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } };
  const catalog = { source: { id: source.id, title: source.title, sourceUrl: url, kind: 'user' },
    freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], picks: [], diagnostics: [],
    themes: [{ itemId: 'sample', title: 'Sample', version: '1.0.0',
      listing: { includes: [{ key: 'night', label: 'Night', mode: 'dark' }] },
      themes: [{ key: 'other', label: 'Night', mode: 'dark', document: profile }] }] };
  let sourceReads = 0;
  let daemonReads = 0;
  const host = createRegistryHostV1({ host: 'web', readSources: async () => [source], http: {
    async getJson() { sourceReads++; return { ok: true, fetchedAt: 1, value: catalog }; },
    async getText() { throw new Error('unexpected text'); }, async getBytes() { throw new Error('unexpected package'); },
  }, daemonFetch: async () => { daemonReads++; throw new Error('unexpected retry'); } });
  await expect(host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample', themeContent: true }))
    .resolves.toEqual({ op: 'error', status: { state: 'invalid_source' } });
  expect(sourceReads).toBe(1);
  expect(daemonReads).toBe(0);
});

it('keeps curated theme picks metadata-only until selected content follows daemon placement', async () => {
  const url = DEFAULT_CURATED_MARKETPLACE_SOURCE_URL;
  const source: RegistrySourceDescriptorV1 = { id: deriveMarketplaceSourceId(url), title: 'Themes', url,
    format: 'happier-catalog', kinds: ['theme'], enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
  const manifest = { publisher: 'sample', name: 'palette', version: '1.0.0', contributes: {
    themes: [{ label: 'Night', uiTheme: 'vs-dark', path: './themes/night.json' }],
  } };
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [path, content] of Object.entries({ 'extension/package.json': manifest,
    'extension/themes/night.json': { colors: { 'editor.background': '#123456' } } })) {
    await writer.add(path, new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(content))), { useWebWorkers: false });
  }
  const bytes = await writer.close();
  const calls: string[] = [];
  const catalog = { source: { id: source.id, title: source.title, sourceUrl: url, kind: 'curated' },
    freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [],
    picks: [{ kind: 'theme', format: 'open-vsx', sourceUrl: 'https://open-vsx.org/api', itemId: 'sample/palette', display: { title: 'Sample' } }] };
  const http = {
    async getJson(request: string) {
      calls.push(request);
      return { ok: true as const, fetchedAt: 1, value: request === url ? catalog : request.endsWith('/manifest.json') ? manifest : {
        namespace: 'sample', name: 'palette', version: '1.0.0', files: { manifest: 'https://open-vsx.org/manifest.json',
          download: 'https://open-vsx.org/package.vsix', sha256: 'https://open-vsx.org/package.sha256' },
      } };
    },
    async getText(request: string) { calls.push(request); return { ok: true as const, fetchedAt: 1, value: bytesToHex(sha256(bytes)) }; },
    async getBytes(request: string) { calls.push(request); return { ok: true as const, fetchedAt: 1, value: bytes }; },
  };
  const requests: unknown[] = [];
  const daemon = createRegistryHostV1({ host: 'node', readSources: async () => [source], http });
  const native = createRegistryHostV1({ host: 'native', readSources: async () => [source], http,
    daemonFetch: async request => { requests.push(request); return daemon.fetchRequest(request); } });
  const page = await native.fetchRequest({ op: 'list', sourceId: source.id, kind: 'theme' });
  expect(page.op === 'list' && page.page.items).toMatchObject([{ itemId: 'sample/palette', kind: 'theme' }]);
  expect(calls).toEqual([url]);
  const metadata = await native.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette' });
  expect(metadata.op === 'read' && metadata.item.payload).toMatchObject({ kind: 'theme', state: 'listing' });
  expect(requests).toEqual([]);
  const acquired = await native.readRegistryTheme({ sourceId: source.id, itemId: 'sample/palette' });
  expect(acquired.item.payload.themes[0]?.document.profile.overrides.dark).toMatchObject({ 'background.canvas': '#123456' });
  expect(acquired.provenance).toMatchObject({ sourceId: source.id, format: 'happier-catalog', itemId: 'sample/palette' });
  expect(requests).toEqual([{ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette', themeContent: true }]);
  expect(calls.filter(request => request.endsWith('/package.vsix'))).toHaveLength(1);
});
