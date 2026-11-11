import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { normalizeStrictJsonValue } from '../../json/strictJsonValue.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { RegistryBrowserExtensionV1 } from '../registryBrowserExtensionV1.js';
import type { RegistryContentRefV1, RegistryItemSummaryV1, RegistryItemV1, RegistryRemoteProvenanceV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1, type RegistryListPageV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1 } from './registryFormatAdapterV1.js';

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
    ...(typeof tuple[4] === 'number' ? { installs: tuple[4] } : {}), ...(manifest?.version ? { version: manifest.version as string } : {}),
    ...(manifest ? { manifest, ...(Array.isArray(manifest.permissions) ? { permissions: manifest.permissions.filter((value): value is string => typeof value === 'string') } : {}) } : {}) };
}

function parseBatchResponse(text: string): unknown {
  const body = text.replace(/^\)\]\}'\s*/, '');
  const chunks: unknown[] = [];
  for (const match of body.matchAll(/\["wrb\.fr","[^"]+","((?:\\.|[^"\\])*)"\]/gu)) {
    try { chunks.push(JSON.parse(JSON.parse(`"${match[1]}"`))); } catch { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
  }
  if (!chunks.length) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return chunks.length === 1 ? chunks[0] : chunks;
}

async function rpc(ctx: RegistryFetchContextV1, rpcid: string, args: unknown, source: RegistrySourceV1): Promise<unknown> {
  const encoded = JSON.stringify([[rpcid, JSON.stringify(args), null, 'generic']]);
  const url = `${CHROME_WEB_STORE_RPC_URL_V1}?rpcids=${rpcid}&hl=en&rt=c&f.req=${encodeURIComponent(JSON.stringify([encoded]))}`;
  const response = await ctx.http.getText(url, { source });
  if (!response.ok) throw new RegistryFetchErrorV1(response.status);
  return parseBatchResponse(response.value);
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
      const raw = await rpc(ctx, SEARCH_RPC, [[null, [null, null, null, [req.query?.trim() ?? '', [20], null, null, null, null, 1]]]], req.source);
      const items = Array.isArray(raw) ? raw.flatMap(value => { try { return [parseChromeWebStoreResultV1(value)]; } catch { return []; } }) : [];
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: Date.now() }, items: items.map(item => summary(req.source, item)), total: items.length, nextCursor: null };
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
