import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromeWebStoreRegistryAdapterV1, parseChromeWebStoreResultV1, parseChromeWebStoreSsrListingsV1 } from './chromeWebStore.js';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from '../registrySourcesV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';

const source = { id: 'builtin:chrome-web-store', title: 'Chrome Web Store', format: 'chrome-web-store' as const,
  kinds: ['browserExtension' as const], url: 'https://chromewebstore.google.com', enabled: true, addedAt: 0 };
const id = 'a'.repeat(32);
const tuple = [id, 'https://icon.test/icon.png', 'Fixture extension', 4.5, 12, null, 'A useful extension', 'https://example.test', true, null, null,
  [['productivity', null]], null, null, JSON.stringify({ manifest_version: 3, version: '1.2.3', permissions: ['storage'], host_permissions: ['https://example.test/*'] })];

describe('Chrome Web Store registry adapter', () => {
  const recordedSearch = readFileSync(new URL('./fixtures/chromeWebStoreSearch.txt', import.meta.url), 'utf8');
  const listingHttp = (pages: Readonly<Record<string, string>>): RegistryHttpV1 => ({
    async postForm() { return { ok: true, fetchedAt: 1, value: recordedSearch }; },
    async getText(url) { const value = pages[new URL(url).pathname]; return value === undefined ? { ok: false, status: { state: 'unreachable' } } : { ok: true, fetchedAt: 1, value }; },
    async getJson() { throw new Error('unexpected GET RPC'); },
    async getBytes() { throw new Error('unexpected download'); },
  });
  it('preserves every result in a recorded nested search response', async () => {
    const page = await chromeWebStoreRegistryAdapterV1.list({ http: listingHttp({}) }, { source, kind: 'browserExtension', query: 'ublock' });
    expect(page.status.state).toBe('ok');
    expect(page.items).toHaveLength(20);
    expect(new Set(page.items.map(item => item.itemId)).size).toBe(20);
    expect(page.items[0]).toMatchObject({ title: 'uBlock', installs: 1000000 });
    expect(page.discovery).toBeUndefined();
  });
  it('reads the built-in store through its daemon carrier on web where store CORS is unavailable', async () => {
    const builtIn = BUILT_IN_REGISTRY_SOURCES_V1.find(item => item.format === 'chrome-web-store')!;
    const unavailable = async (): Promise<never> => { throw new TypeError('Store has no browser CORS'); };
    const host = createRegistryHostV1({ host: 'web', readSources: async () => [builtIn],
      http: { getJson: unavailable, getText: unavailable, getBytes: unavailable, postForm: unavailable },
      daemonFetch: async request => {
        if (request.op !== 'list') throw new Error('unexpected request');
        return { op: 'list', page: await chromeWebStoreRegistryAdapterV1.list({ http: listingHttp({}) },
          { source: builtIn, kind: 'browserExtension', query: request.query }) };
      },
    });
    const result = await host.fetchRequest({ op: 'list', sourceId: builtIn.id, kind: 'browserExtension', query: 'ublock' });
    expect(result.op).toBe('list');
    if (result.op === 'list') {
      expect(result.page.status.state).toBe('ok');
      expect(result.page.items).toHaveLength(20);
    }
  });
  it('continues a recorded search with the upstream cursor and returns the next distinct page', async () => {
    const responses = ['chromeWebStoreSearchFirst.txt', 'chromeWebStoreSearchNext.txt'].map(name =>
      readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
    const requests: unknown[] = [];
    const http: RegistryHttpV1 = {
      ...listingHttp({}),
      async postForm(_url, body) {
        const frames = JSON.parse(new URLSearchParams(body).get('f.req')!);
        requests.push(JSON.parse(frames[0][0][1]));
        return { ok: true, fetchedAt: 1, value: responses[requests.length - 1]! };
      },
    };
    const first = await chromeWebStoreRegistryAdapterV1.list({ http }, { source, kind: 'browserExtension', query: 'ublock' });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await chromeWebStoreRegistryAdapterV1.list({ http }, { source, kind: 'browserExtension', query: 'ublock', cursor: first.nextCursor });
    expect(second.status.state).toBe('ok');
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(20);
    expect(new Set([...first.items, ...second.items].map(item => item.itemId)).size).toBe(40);
    expect(requests[1]).toEqual([[null, [null, null, null, ['ublock', [20, first.nextCursor], null, null, null, null, 1]]]]);
  });
  it('projects home, collection and category membership from recorded listing pages', async () => {
    const paths = { '/': 'home', '/collection/by_google': 'by_google', '/category/extensions': 'extensions' };
    const pages = Object.fromEntries(Object.entries(paths).map(([path, name]) => [path, readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8')]));
    const page = await chromeWebStoreRegistryAdapterV1.list({ http: listingHttp(pages) }, { source, kind: 'browserExtension' });
    expect(page.status.state).toBe('ok');
    expect(page.discovery?.categories).toHaveLength(3);
    for (const category of page.discovery!.categories) expect(category.items.length).toBeGreaterThan(1);
    expect(page.discovery!.categories[0]!.items).not.toEqual(page.discovery!.categories[1]!.items);
  });
  it('surfaces a failed browse page instead of presenting an empty successful catalog', async () => {
    const page = await chromeWebStoreRegistryAdapterV1.list({ http: listingHttp({}) }, { source, kind: 'browserExtension' });
    expect(page.status.state).toBe('unreachable');
  });

  it('parses the store tuple into a browser extension source and manifest metadata', () => {
    expect(parseChromeWebStoreResultV1([tuple])).toMatchObject({ extensionId: id, title: 'Fixture extension', version: '1.2.3', permissions: ['storage'] });
  });
  it.each(['home', 'by_google', 'extensions'] as const)('parses recorded %s SSR listing callbacks', (name) => {
    const listings = parseChromeWebStoreSsrListingsV1(readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8'));
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every(item => /^[a-p]{32}$/u.test(item.extensionId))).toBe(true);
  });
  it('searches through the private batchexecute owner and reads detail', async () => {
    const requests: string[] = [];
    const bodies: string[] = [];
    const http: RegistryHttpV1 = {
      async getText(url) { requests.push(url); if (url.includes('clients2.google.com')) return { ok: true, fetchedAt: 2, value: `<response><updatecheck version="1.2.3" hash_sha256="${'b'.repeat(64)}" status="ok" codebase="https://example.test/x.crx" /></response>` }; return { ok: false, status: { state: 'unreachable' } }; },
      async postForm(url, body) { requests.push(url); bodies.push(body); if (url.includes('batchexecute')) return { ok: true, fetchedAt: 1, value: `)]}'\n${JSON.stringify(['wrb.fr', 'zTyKYc', JSON.stringify([tuple])])}` }; return { ok: false, status: { state: 'unreachable' } }; },
      async getJson(url) { requests.push(url); return { ok: true, fetchedAt: 1, value: url.includes('xY2Ddd') ? [tuple] : [[tuple]] }; },
      async getBytes() { return { ok: false, status: { state: 'unreachable' } }; },
    };
    const page = await chromeWebStoreRegistryAdapterV1.list({ http }, { source, kind: 'browserExtension', query: 'fixture', cursor: null });
    expect(page.items[0]).toMatchObject({ itemId: id, title: 'Fixture extension', version: '1.2.3' });
    const item = await chromeWebStoreRegistryAdapterV1.read({ http }, { source, kind: 'browserExtension', itemId: id });
    expect(item.payload).toMatchObject({ kind: 'browserExtension', extension: { extensionId: id } });
    const latest = await chromeWebStoreRegistryAdapterV1.latest({ http }, [{ sourceId: source.id, sourceUrl: source.url, format: source.format, itemId: id, ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` }, importedAt: 0 }], { source });
    expect(latest.get(id)).toEqual({ kind: 'content', digest: `sha256:${'b'.repeat(64)}` });
    expect(requests.some(value => value.includes('batchexecute'))).toBe(true);
    expect(requests.some(value => value.includes('f.req='))).toBe(false);
    expect(bodies.some(value => value.startsWith('f.req='))).toBe(true);
    expect(page.discovery).toBeUndefined();
  });
});
