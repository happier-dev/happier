import { describe, expect, it } from 'vitest';
import { deriveMarketplaceSourceId } from '../marketplace/marketplaceSourceRegistryV1.js';
import { MarketplaceIndexSourceSnapshotV1Schema } from '../marketplace/marketplaceIndexV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from './registryActionsV1.js';
import { RegistryItemV1Schema } from './registryItemsV1.js';
import { createRegistryHostV1 } from './registryHostV1.js';
import { RegistrySourceDescriptorV1Schema, RegistrySourceV1Schema } from './registrySourcesV1.js';
import type { RegistryHttpV1 } from './formats/registryFormatAdapterV1.js';

const url = 'https://extensions.example/catalog.json';
const extensionId = 'a'.repeat(32);
const entry = { itemId: 'password-manager', title: 'Password manager', description: 'Fill passwords in your browser',
  extension: { kind: 'webStore', extensionId } };
const sourceInput = { id: deriveMarketplaceSourceId(url), title: 'Extensions', format: 'happier-catalog',
  kinds: ['browserExtension'], url, enabled: true, addedAt: 0 };
function catalog(browserExtensions: unknown[] = [entry]) {
  return { source: { id: sourceInput.id, title: sourceInput.title, sourceUrl: url, kind: 'user' },
    freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], browserExtensions };
}
function fixture() {
  const source = RegistrySourceDescriptorV1Schema.parse({ ...sourceInput, origin: { kind: 'user' }, removable: true });
  let value: unknown = catalog();
  let unavailable = false;
  const requests: string[] = [];
  const forbidden = async (): Promise<never> => { throw new Error('Catalog discovery must not acquire extension bytes'); };
  // The catalog HTTP response is the external boundary; host, format, and strict readers remain real.
  const http: RegistryHttpV1 = { getJson: async target => {
    requests.push(target);
    return unavailable ? { ok: false, status: { state: 'unreachable' } }
      : { ok: true, value, fetchedAt: 1 };
  }, getText: forbidden, getBytes: forbidden };
  return { source, requests, host: createRegistryHostV1({ host: 'web', readSources: async () => [source], http }),
    setCatalog: (next: unknown) => { value = next; }, fail: () => { unavailable = true; } };
}

describe('host-defined browser extension catalog', () => {
  it('admits Web Store references only through the existing happier catalog kind', () => {
    expect(RegistrySourceV1Schema.safeParse(sourceInput).success).toBe(true);
    expect(RegistrySourceV1Schema.safeParse({ ...sourceInput, format: 'happier-npm' }).success).toBe(false);
    expect(MarketplaceIndexSourceSnapshotV1Schema.parse(catalog()).browserExtensions).toEqual([entry]);
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse(catalog([
      { ...entry, extension: { kind: 'webStore', extensionId: 'invalid' } },
    ])).success).toBe(false);
  });

  it('detects, searches and reads an extension through real host Actions without acquiring its package', async () => {
    const { host, source, requests } = fixture();
    expect(await host.execute('registries.sources.detect', { url })).toMatchObject({ detected: {
      format: 'happier-catalog', kinds: ['plugin', 'browserExtension'], itemCount: 1,
    } });
    const listed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'browserExtension', sourceIds: [source.id], query: 'passwords',
    }));
    expect(listed.pages[0]).toMatchObject({ status: { state: 'ok' }, items: [{ kind: 'browserExtension',
      itemId: entry.itemId, title: entry.title }], nextCursor: null });
    const discovery = listed.pages[0]?.discovery?.items[0];
    expect(discovery?.reference).toEqual({ type: 'registryItem', kind: 'browserExtension', sourceId: source.id, itemId: entry.itemId });
    const read = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'browserExtension', sourceId: source.id, itemId: entry.itemId,
    }));
    const consumed = RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(read.item)));
    expect(consumed).toMatchObject({ summary: { kind: 'browserExtension', sourceId: source.id, itemId: entry.itemId,
      version: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }, payload: { kind: 'browserExtension', extension: entry.extension,
      ref: { kind: 'content', digest: consumed.summary.version } } });
    expect(requests.every(target => target === url)).toBe(true);
    await expect(host.execute('registries.items.read', { kind: 'browserExtension', sourceId: source.id,
      itemId: entry.itemId, version: 'sha256:wrong' })).rejects.toMatchObject({ status: { state: 'invalid_source' } });
    expect(RegistryItemV1Schema.safeParse({ ...consumed, summary: { ...consumed.summary, version: 'other' } }).success).toBe(false);
  });

  it('keeps empty, unavailable and duplicate selections distinct', async () => {
    const { host, source, setCatalog, fail } = fixture();
    setCatalog(catalog([]));
    expect(await host.execute('registries.items.list', { kind: 'browserExtension', sourceIds: [source.id] }))
      .toMatchObject({ pages: [{ status: { state: 'ok' }, items: [] }] });
    setCatalog(catalog([entry, entry]));
    await expect(host.execute('registries.items.read', { kind: 'browserExtension', sourceId: source.id,
      itemId: entry.itemId })).rejects.toMatchObject({ status: { state: 'invalid_source' } });
    fail();
    expect(await host.execute('registries.items.list', { kind: 'browserExtension', sourceIds: [source.id] }))
      .toMatchObject({ pages: [{ status: { state: 'unreachable' }, items: [] }] });
  });
});
