import { describe, expect, it } from 'vitest';
import { chromeWebStoreRegistryAdapterV1, parseChromeWebStoreResultV1 } from './chromeWebStore.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';

const source = { id: 'builtin:chrome-web-store', title: 'Chrome Web Store', format: 'chrome-web-store' as const,
  kinds: ['browserExtension' as const], url: 'https://chromewebstore.google.com', enabled: true, addedAt: 0 };
const id = 'a'.repeat(32);
const tuple = [id, 'https://icon.test/icon.png', 'Fixture extension', 4.5, 12, null, 'A useful extension', 'https://example.test', true, null, null,
  [['productivity', null]], null, null, JSON.stringify({ manifest_version: 3, version: '1.2.3', permissions: ['storage'], host_permissions: ['https://example.test/*'] })];

describe('Chrome Web Store registry adapter', () => {
  it('parses the store tuple into a browser extension source and manifest metadata', () => {
    expect(parseChromeWebStoreResultV1([tuple])).toMatchObject({ extensionId: id, title: 'Fixture extension', version: '1.2.3', permissions: ['storage'] });
  });
  it('searches through the private batchexecute owner and reads detail', async () => {
    const requests: string[] = [];
    const http: RegistryHttpV1 = {
      async getText(url) { requests.push(url); if (url.includes('clients2.google.com')) return { ok: true, fetchedAt: 2, value: `<response><updatecheck version="1.2.3" hash_sha256="${'b'.repeat(64)}" status="ok" codebase="https://example.test/x.crx" /></response>` }; if (url.includes('batchexecute')) return { ok: true, fetchedAt: 1, value: `)]}'\n${JSON.stringify(['wrb.fr', 'zTyKYc', JSON.stringify([tuple])])}` }; return { ok: false, status: { state: 'unreachable' } }; },
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
  });
});
