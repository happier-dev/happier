import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { normalizeStrictJsonValue } from '../../json/strictJsonValue.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { RegistryBrowserExtensionV1 } from '../registryBrowserExtensionV1.js';
import type { RegistryContentRefV1, RegistryItemSummaryV1, RegistryItemV1, RegistryRemoteProvenanceV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1, type RegistryListPageV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1 } from './registryFormatAdapterV1.js';
import type { MarketplaceCatalogDiscoveryV1 } from '../../marketplace/marketplaceIndexV1.js';

export const CHROME_WEB_STORE_RPC_URL_V1 = 'https://chromewebstore.google.com/_/ChromeWebStoreConsumerFeUi/data/batchexecute';
const SEARCH_RPC = 'zTyKYc';
const TYPEAHEAD_RPC = 'QcU9bc';
const DETAIL_RPC = 'xY2Ddd';
const STORE_ID = /^[a-p]{32}$/u;

type StoreResult = Readonly<{ extensionId: string; title: string; description?: string; iconUrl?: string; website?: string; category?: string; version?: string; installs?: number; updatedAt?: number; permissions?: readonly string[]; manifest?: Readonly<Record<string, unknown>> }>;

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) for (const item of value) walk(item, visit);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item, visit);
}

/** Defensive projection of the positional store tuple; unknown additions are ignored. */
export function parseChromeWebStoreResultV1(value: unknown): StoreResult {
  let tuple: unknown[] | undefined;
  walk(value, candidate => {
    if (!tuple && Array.isArray(candidate) && typeof candidate[0] === 'string' && STORE_ID.test(candidate[0])) tuple = candidate;
  });
  if (!tuple) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const id = tuple[0] as string;
  const text = (index: number) => typeof tuple![index] === 'string' && tuple![index]!.trim() ? tuple![index] as string : undefined;
  const manifest = (() => {
    let parsed: Readonly<Record<string, unknown>> | undefined;
    for (const entry of tuple!.filter(item => typeof item === 'string')) {
      try { const candidate = JSON.parse(entry as string); if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && typeof candidate.version === 'string') parsed = candidate; } catch { /* positional text */ }
    }
    return parsed;
  })();
  const categories = tuple[11];
  return { extensionId: id, title: text(2) ?? id,
    ...(text(6) ? { description: text(6) } : {}), ...(text(1) ? { iconUrl: text(1) } : {}),
    ...(text(7) ? { website: text(7) } : {}), ...(Array.isArray(categories) && typeof categories[0] === 'string' ? { category: categories[0] } : {}),
    ...(typeof tuple[14] === 'number' ? { installs: tuple[14] } : {}), ...(manifest?.version ? { version: manifest.version as string } : {}),
    ...(manifest ? { manifest, ...(Array.isArray(manifest.permissions) ? { permissions: manifest.permissions.filter((value): value is string => typeof value === 'string') } : {}) } : {}) };
}

function readJsonArrayAfter(value: string, start: number): unknown[] | undefined {
  let depth = 0; let quoted = false; let escaped = false; let end = -1;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '[') depth += 1;
    else if (char === ']' && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0) return undefined;
  try { const parsed: unknown = JSON.parse(value.slice(start, end)); return Array.isArray(parsed) ? parsed : undefined; }
  catch { return undefined; }
}

/** Visit each positional item once; containers never stand in for their first item. */
function parseResults(value: unknown): readonly StoreResult[] {
  const items = new Map<string, StoreResult>();
  const visit = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    if (typeof candidate[0] === 'string' && STORE_ID.test(candidate[0])) {
      const item = parseChromeWebStoreResultV1(candidate);
      items.set(item.extensionId, item);
      return;
    }
    candidate.forEach(visit);
  };
  visit(value);
  return [...items.values()];
}

/** Parses the store's SSR AF_initDataCallback arrays used by home/collection/category pages. */
export function parseChromeWebStoreSsrListingsV1(value: string): readonly StoreResult[] {
  const data: unknown[] = [];
  const marker = /AF_initDataCallback\(\{key:\s*'ds:\d+'\s*,\s*hash:\s*'[^']*'\s*,\s*data:/gu;
  for (const match of value.matchAll(marker)) {
    const parsed = readJsonArrayAfter(value, (match.index ?? 0) + match[0].length);
    if (parsed) data.push(parsed);
  }
  return parseResults(data);
}

function parseBatchResponse(text: string): unknown {
  const chunks: unknown[] = [];
  // The upstream frames are JSON lines following the XSSI prefix and byte counts.
  for (const line of text.split('\n')) {
    if (!line.startsWith('[')) continue;
    try {
      const frames: unknown = JSON.parse(line);
      walk(frames, candidate => {
        if (Array.isArray(candidate) && candidate[0] === 'wrb.fr' && typeof candidate[2] === 'string') chunks.push(JSON.parse(candidate[2]));
      });
    } catch { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
  }
  if (!chunks.length) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return chunks.length === 1 ? chunks[0] : chunks;
}

async function rpc(ctx: RegistryFetchContextV1, rpcid: string, args: unknown, source: RegistrySourceV1): Promise<unknown> {
  const encoded = JSON.stringify([[rpcid, JSON.stringify(args), null, 'generic']]);
  const url = `${CHROME_WEB_STORE_RPC_URL_V1}?rpcids=${rpcid}&hl=en&rt=c`;
  const postForm = ctx.http.postForm;
  if (!postForm) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
  const response = await postForm(url, `f.req=${encodeURIComponent(`[${encoded}]`)}`, { source });
  if (!response.ok) throw new RegistryFetchErrorV1(response.status);
  return parseBatchResponse(response.value);
}

type DiscoveryGroup = Readonly<{ id: string; title: string; items: readonly string[] }>;
function discovery(source: RegistrySourceV1, items: readonly RegistryItemSummaryV1[], groups: readonly DiscoveryGroup[], featuredItem?: string): MarketplaceCatalogDiscoveryV1 {
  const ids = items.map(item => JSON.stringify(['browserExtension', source.id, item.itemId]));
  const idByItem = new Map(items.map((item, index) => [item.itemId, ids[index]!]));
  const discovered = items.map((item, index) => ({ id: ids[index]!, title: item.title, ...(item.description === undefined ? {} : { description: item.description }),
    reference: { type: 'registryItem' as const, kind: 'browserExtension' as const, sourceId: source.id, itemId: item.itemId } }));
  const categories = groups.map(group => ({ id: group.id, title: group.title, items: group.items.flatMap(itemId => { const id = idByItem.get(itemId); return id ? [id] : []; }) }));
  const featured = idByItem.get(featuredItem ?? items[0]?.itemId);
  return { items: discovered, ...(featured ? { featured: { item: featured, reason: 'Featured on the Chrome Web Store home page' } } : {}), categories, jobs: [] };
}

async function readDiscoveryListings(ctx: RegistryFetchContextV1, source: RegistrySourceV1): Promise<Readonly<{ items: readonly StoreResult[]; groups: readonly DiscoveryGroup[]; featuredItem?: string }>> {
  const routes = [
    { path: '/', id: 'featured', title: 'Featured' },
    { path: '/collection/by_google', id: 'collection-by-google', title: 'Google collection' },
    { path: '/category/extensions', id: 'extensions', title: 'Extensions' },
  ] as const;
  const items = new Map<string, StoreResult>();
  const groups: DiscoveryGroup[] = [];
  let featuredItem: string | undefined;
  for (const route of routes) {
    const response = await ctx.http.getText(`https://chromewebstore.google.com${route.path}`, { source });
    if (!response.ok) throw new RegistryFetchErrorV1(response.status);
    const parsed = parseChromeWebStoreSsrListingsV1(response.value);
    if (!parsed.length) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    parsed.forEach(item => items.set(item.extensionId, item));
    const ids = parsed.map(item => item.extensionId);
    if (route.id === 'featured') featuredItem = ids[0];
    groups.push({ id: route.id, title: route.title, items: ids });
  }
  return { items: [...items.values()], groups, featuredItem };
}

function summary(source: RegistrySourceV1, item: StoreResult): RegistryItemSummaryV1 {
  return { sourceId: source.id, kind: 'browserExtension', itemId: item.extensionId, title: item.title,
    ...(item.description ? { description: item.description } : {}), ...(item.version ? { version: item.version } : {}),
    ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}), ...(item.installs === undefined ? {} : { installs: item.installs }),
    ...(item.website ? { links: { website: item.website } } : {}) };
}

function digest(item: StoreResult): string { return `sha256:${bytesToHex(sha256(new TextEncoder().encode(createCanonicalJsonSigningInput(normalizeStrictJsonValue(item)))))}`; }

export const chromeWebStoreRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'chrome-web-store', kinds: ['browserExtension'], browserFetchable: () => true, supportsQuery: true,
  async list(ctx, req): Promise<RegistryListPageV1> {
    try {
      const query = req.query?.trim();
      const listing = query ? undefined : await readDiscoveryListings(ctx, req.source);
      const items = listing?.items ?? parseResults(await rpc(ctx, SEARCH_RPC,
        [[null, [null, null, null, [query, [20], null, null, null, null, 1]]]], req.source));
      const summaries = items.map(item => summary(req.source, item));
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: Date.now() }, items: summaries, nextCursor: null,
        ...(listing ? { discovery: discovery(req.source, summaries, listing.groups, listing.featuredItem) } : {}) };

    } catch (error) { if (!(error instanceof RegistryFetchErrorV1)) throw error; return { sourceId: req.source.id, status: error.status, items: [], nextCursor: null }; }
  },
  async read(ctx, req): Promise<RegistryItemV1> {
    const item = parseChromeWebStoreResultV1(await rpc(ctx, DETAIL_RPC, [req.itemId], req.source));
    if (item.extensionId !== req.itemId) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const extension: RegistryBrowserExtensionV1 = { kind: 'webStore', extensionId: item.extensionId };
    const ref = { kind: 'content' as const, digest: digest(item) };
    const value = { summary: { ...summary(req.source, item), version: ref.digest }, payload: { kind: 'browserExtension' as const, extension, ref }, fetchedAt: Date.now() };
    return value;
  },
  async latest(ctx, items: readonly RegistryRemoteProvenanceV1[], options): Promise<ReadonlyMap<string, RegistryContentRefV1 | 'removed'>> {
    const result = new Map<string, RegistryContentRefV1 | 'removed'>();
    for (const item of items) {
      const url = new URL('https://clients2.google.com/service/update2/crx');
      url.searchParams.set('prodversion', '130.0'); url.searchParams.set('acceptformat', 'crx3');
      url.searchParams.set('x', `id=${item.itemId}&uc`);
      const response = await ctx.http.getText(url.toString(), { source: options?.source });
      if (!response.ok) throw new RegistryFetchErrorV1(response.status);
      const match = /<updatecheck\b[^>]*\bstatus=["']ok["'][^>]*\bhash_sha256=["']([a-f0-9]{64})["']/iu.exec(response.value)
        ?? /<updatecheck\b[^>]*\bhash_sha256=["']([a-f0-9]{64})["'][^>]*\bstatus=["']ok["']/iu.exec(response.value);
      if (!match) { if (/status=["']noupdate["']/iu.test(response.value)) result.set(item.itemId, item.ref.kind === 'content' ? item.ref : 'removed'); else throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
      else result.set(item.itemId, { kind: 'content', digest: `sha256:${match[1]!.toLowerCase()}` });
    }
    return result;
  },
};

export { SEARCH_RPC as CHROME_WEB_STORE_SEARCH_RPC_V1, TYPEAHEAD_RPC as CHROME_WEB_STORE_TYPEAHEAD_RPC_V1, DETAIL_RPC as CHROME_WEB_STORE_DETAIL_RPC_V1 };
