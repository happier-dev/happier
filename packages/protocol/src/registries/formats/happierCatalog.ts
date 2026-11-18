import { registryThemeCatalogSummaryV1, readHappierThemeCatalogItemV1 } from './happierThemeCatalog.js';
import { parseMarketplaceIndexSourceSnapshotV1, type HappierPickV1, type MarketplaceIndexEntryV1, type MarketplaceCatalogDiscoveryV1 } from '../../marketplace/marketplaceIndexV1.js';
import { readMarketplaceSourceListingsV1 } from '../../marketplace/marketplaceSourceListingsV1.js';
import { deriveMarketplaceSourceId, normalizeMarketplaceSourceUrlV1 } from '../../marketplace/marketplaceSourceRegistryV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1 } from './registryFormatAdapterV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1, REGISTRY_FORMAT_KINDS_V1, deriveRegistrySourceIdV1, type RegistrySourceV1 } from '../registrySourcesV1.js';
import { isReadyRegistryThemeItemV1, RegistryItemV1Schema, type RegistryContentRefV1, type RegistryItemSummaryV1, type RegistryRemoteProvenanceV1 } from '../registryItemsV1.js';
import { REGISTRY_FORMAT_ADAPTERS_V1 } from './index.js';
import { registryPluginItemV1, registryPluginSummaryV1, registryPluginSupportsKindV1 } from './registryPluginListingV1.js';
import { bindRegistryMarketplaceCatalogV1 } from './registryMarketplaceCatalogBindingV1.js';
import { HappierAppCatalogV1Schema, latestHappierAppCatalogRefsV1, listHappierAppCatalogV1, readHappierAppCatalogItemV1 } from './happierAppCatalog.js';
import { readHappierBrowserExtensionCatalogItemV1, registryBrowserExtensionSummaryV1 } from './happierBrowserExtensionCatalog.js';
import { chromeWebStoreRegistryAdapterV1 } from './chromeWebStore.js';
import { RegistryStarterCatalogV1Schema } from '../registryStarterV1.js';
import { listHappierStarterCatalogV1, readHappierStarterCatalogItemV1, parseStarterCatalogV1 } from './happierStarterCatalog.js';
import type { RegistryBrowserExtensionCatalogEntryV1 } from '../registryBrowserExtensionV1.js';

async function readCatalog(ctx: RegistryFetchContextV1, source: RegistrySourceV1,
  pinned?: Readonly<{ pluginId: string; version: string }>, acquired?: Readonly<{ value: unknown; fetchedAt: number }>) {
  const response = acquired ? { ok: true as const, ...acquired } : await ctx.http.getJson(source.url, { source });
  if (!response.ok) throw new RegistryFetchErrorV1(response.status);
  let catalog;
  try { catalog = parseMarketplaceIndexSourceSnapshotV1(response.value); }
  catch { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
  catalog = bindRegistryMarketplaceCatalogV1(catalog, source);
  return { catalog: { ...catalog, ...readMarketplaceSourceListingsV1(catalog, pinned) }, fetchedAt: response.fetchedAt };
}

export const happierCatalogRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'happier-catalog', kinds: REGISTRY_FORMAT_KINDS_V1['happier-catalog'], browserFetchable: () => true, supportsQuery: true,
  supportsContributionFamily: true,
  async detect(ctx, url) {
    const response = await ctx.http.getJson(url);
    if (!response.ok) return null;
    const apps = HappierAppCatalogV1Schema.safeParse(response.value);
    if (apps.success) return { format: 'happier-catalog', kinds: ['app'], title: new URL(url).hostname, itemCount: apps.data.apps.length };
    const starters = RegistryStarterCatalogV1Schema.safeParse(response.value);
    if (starters.success) return { format: 'happier-catalog', kinds: ['starter'], title: new URL(url).hostname, itemCount: starters.data.starters.length };
    let catalog;
    try { catalog = parseMarketplaceIndexSourceSnapshotV1(response.value); }
    catch { return null; }
    const sourceUrl = normalizeMarketplaceSourceUrlV1(url);
    bindRegistryMarketplaceCatalogV1(catalog, {
      id: deriveMarketplaceSourceId(sourceUrl), url: sourceUrl, title: catalog.source.title, format: 'happier-catalog',
      kinds: [...REGISTRY_FORMAT_KINDS_V1['happier-catalog']], enabled: true, addedAt: 0,
    });
    const kinds = [...new Set(['plugin' as const, ...catalog.picks.map(pick => pick.kind),
        ...(catalog.entries.some(entry => registryPluginSupportsKindV1(entry, 'agent')) ? ['agent' as const] : []),
        ...(catalog.browserExtensions?.length ? ['browserExtension' as const] : []),
        ...(catalog.themes?.length ? ['theme' as const] : [])])];
    // Detection has no requested kind, so a mixed catalog has no single-kind count.
    return { format: 'happier-catalog', kinds, title: catalog.source.title,
      ...(kinds.length === 1 ? { itemCount: catalog.entries.length } : {}) };
  },
  async list(ctx, req) {
    try {
      if (req.kind === 'starter') {
        const response = await ctx.http.getJson(req.source.url, { source: req.source });
        if (!response.ok) throw new RegistryFetchErrorV1(response.status);
        return listHappierStarterCatalogV1({ sourceId: req.source.id, catalog: parseStarterCatalogV1(response.value),
          fetchedAt: response.fetchedAt, query: req.query });
      }
      let acquired: Readonly<{ value: unknown; fetchedAt: number }> | undefined;
      if (req.kind === 'app') {
        const response = await ctx.http.getJson(req.source.url, { source: req.source });
        if (!response.ok) throw new RegistryFetchErrorV1(response.status);
        const parsed = HappierAppCatalogV1Schema.safeParse(response.value);
        if (parsed.success) return listHappierAppCatalogV1({ sourceId: req.source.id, catalog: parsed.data, fetchedAt: response.fetchedAt, query: req.query });
        acquired = response;
      }
      const { catalog, fetchedAt } = await readCatalog(ctx, req.source, undefined, acquired);
      const query = (req.query ?? '').trim().toLocaleLowerCase();
      const discovery = catalog.discovery ?? legacyDiscovery(req.source, catalog);
      if (req.kind === 'browserExtension') {
        const items = (catalog.browserExtensions ?? []).map(entry => registryBrowserExtensionSummaryV1(req.source.id, entry))
          .filter(item => !query || `${item.title} ${item.description ?? ''} ${item.itemId}`.toLocaleLowerCase().includes(query));
        return { sourceId: req.source.id, status: { state: 'ok', fetchedAt }, items, total: items.length, nextCursor: null, discovery };
      }
      if (req.kind !== 'plugin') {
        const picks = catalog.picks.filter(pick => pick.kind === req.kind);
        const counts = new Map<string, number>();
        for (const pick of picks) { const id = pickItemId(pick); counts.set(id, (counts.get(id) ?? 0) + 1); }
        const items = picks.map(pick => {
          const itemId = pickItemId(pick);
          if (counts.get(itemId)! > 1 || !targetAdapter(pick)) {
            return pickSummary(req.source, pick, { code: 'unsupported_entry', reason: 'distribution' });
          }
          return pickSummary(req.source, pick);
        })
          .filter(item => !query || `${item.title} ${item.description ?? ''} ${item.itemId}`.toLocaleLowerCase().includes(query));
        const plugins = catalog.entries.filter(entry => registryPluginSupportsKindV1(entry, req.kind)
          && (!query || `${entry.display.title} ${entry.display.description ?? ''} ${entry.pluginId}`.toLocaleLowerCase().includes(query)))
          .map(entry => registryPluginSummaryV1(req.source, entry));
        const themes = req.kind === 'theme' ? (catalog.themes ?? []).map(entry => registryThemeCatalogSummaryV1(req.source.id, entry))
          .filter(item => !query || `${item.title} ${item.description ?? ''} ${item.itemId}`.toLocaleLowerCase().includes(query)) : [];
        return { sourceId: req.source.id, status: { state: 'ok', fetchedAt }, total: items.length + plugins.length + themes.length,
          items: [...items, ...plugins, ...themes], nextCursor: null, discovery };
      }
      const entries = catalog.entries.filter(entry => (!req.contributionFamily || entry.summary.contributions.includes(req.contributionFamily))
        && (!query || `${entry.display.title} ${entry.display.description ?? ''} ${entry.pluginId}`.toLocaleLowerCase().includes(query)));
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt }, total: entries.length,
        items: entries.map(entry => registryPluginSummaryV1(req.source, entry)), nextCursor: null,
        discovery };
    } catch (error) { if (error instanceof RegistryFetchErrorV1) return { sourceId: req.source.id, status: error.status, items: [], nextCursor: null }; throw error; }
  },
  async read(ctx, req) {
    if (req.kind === 'starter') {
      const response = await ctx.http.getJson(req.source.url, { source: req.source });
      if (!response.ok) throw new RegistryFetchErrorV1(response.status);
      return readHappierStarterCatalogItemV1({ sourceId: req.source.id, catalog: parseStarterCatalogV1(response.value),
        fetchedAt: response.fetchedAt, itemId: req.itemId });
    }
    let acquired: Readonly<{ value: unknown; fetchedAt: number }> | undefined;
    if (req.kind === 'app') {
      const response = await ctx.http.getJson(req.source.url, { source: req.source });
      if (!response.ok) throw new RegistryFetchErrorV1(response.status);
      const parsed = HappierAppCatalogV1Schema.safeParse(response.value);
      if (parsed.success) return readHappierAppCatalogItemV1({ sourceId: req.source.id, catalog: parsed.data,
        fetchedAt: response.fetchedAt, itemId: req.itemId, version: req.version, appMappingCorrection: req.appMappingCorrection });
      acquired = response;
    }
    const { catalog, fetchedAt } = await readCatalog(ctx, req.source,
      (req.kind === 'plugin' || req.kind === 'agent') && req.version ? { pluginId: req.itemId, version: req.version } : undefined, acquired);
    if (req.kind === 'theme' && catalog.themes?.some(entry => entry.itemId === req.itemId)) return readHappierThemeCatalogItemV1(ctx, { source: req.source, entries: catalog.themes,
      itemId: req.itemId, version: req.version, fetchedAt, themeContent: req.themeContent });
    if (req.kind === 'browserExtension') return readHappierBrowserExtensionCatalogItemV1({ sourceId: req.source.id,
      entries: catalog.browserExtensions ?? [], itemId: req.itemId, version: req.version, fetchedAt });
    if (req.kind !== 'plugin') {
      const picks = catalog.picks.filter(pick => pick.kind === req.kind && pickItemId(pick) === req.itemId);
      const pick = picks.length === 1 ? picks[0] : undefined;
      const adapter = pick && targetAdapter(pick);
      if (picks.length === 0) {
        const listing = catalog.entries.find(entry => entry.pluginId === req.itemId
          && (!req.version || entry.distribution.version === req.version) && registryPluginSupportsKindV1(entry, req.kind));
        if (listing) return registryPluginItemV1(req.source, listing, fetchedAt);
      }
      if (!pick || !adapter) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const target = { source: pickSource(pick), kind: pick.kind, itemId: pick.itemId, ...(req.version === undefined ? {} : { version: req.version }),
        ...(req.themeContent ? { themeContent: req.themeContent } : {}),
        ...(req.appMappingCorrection ? { appMappingCorrection: req.appMappingCorrection } : {}) };
      const read = ctx.readTargetItem ? await ctx.readTargetItem(target) : await adapter.read(ctx, target);
      const item = isReadyRegistryThemeItemV1(read) ? read : RegistryItemV1Schema.parse(read);
      return { ...item, summary: { ...item.summary, sourceId: req.source.id, itemId: req.itemId,
        flags: { ...item.summary.flags, pick: true as const } } };
    }
    const listing = catalog.entries.find(entry => entry.pluginId === req.itemId && (!req.version || entry.distribution.version === req.version));
    if (!listing) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return registryPluginItemV1(req.source, listing, fetchedAt);
  },
  async latest(ctx, items, options) {
    const result = new Map<string, RegistryContentRefV1 | 'removed'>();
    if (items.length === 0) return result; // Plugins keep the plugin update-policy owner.
    const source = options?.source;
    if (!source) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const response = await ctx.http.getJson(source.url, { source });
    if (!response.ok) throw new RegistryFetchErrorV1(response.status);
    const apps = HappierAppCatalogV1Schema.safeParse(response.value);
    if (apps.success) return latestHappierAppCatalogRefsV1({ sourceId: source.id, catalog: apps.data,
      fetchedAt: response.fetchedAt, itemIds: items.map(item => item.itemId) });
    const { catalog } = await readCatalog(ctx, source, undefined, response);
    const groups = new Map<string, { source: RegistrySourceV1; adapter: RegistryFormatAdapterV1;
      items: { catalogId: string; provenance: RegistryRemoteProvenanceV1 }[] }>();
    for (const item of items) {
      const theme = catalog.themes?.find(entry => entry.itemId === item.itemId);
      if (theme) { result.set(item.itemId, { kind: 'version', version: theme.version }); continue; }
      const matches = catalog.picks.filter(pick => pickItemId(pick) === item.itemId);
      if (matches.length === 0) { result.set(item.itemId, 'removed'); continue; }
      const pick = matches.length === 1 ? matches[0] : undefined;
      const adapter = pick && targetAdapter(pick);
      if (!pick || !adapter) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const target = pickSource(pick);
      const key = JSON.stringify([target.format, target.url, target.path]);
      let group = groups.get(key);
      if (!group) { group = { source: target, adapter, items: [] }; groups.set(key, group); }
      group.items.push({ catalogId: item.itemId, provenance: { ...item, sourceId: target.id, sourceUrl: target.url,
        format: target.format, itemId: pick.itemId } });
    }
    await Promise.all([...groups.values()].map(async group => {
      const latest = await group.adapter.latest(ctx, group.items.map(item => item.provenance), { source: group.source });
      for (const item of group.items) {
        const ref = latest.get(item.provenance.itemId);
        if (ref !== undefined) result.set(item.catalogId, ref);
      }
    }));
    for (const item of items) {
      if (item.format !== 'happier-catalog') continue;
      const browser = catalog.browserExtensions?.find(entry => entry.itemId === item.itemId);
      if (!browser) continue;
      const target: RegistryRemoteProvenanceV1 = { sourceId: 'builtin:chrome-web-store', sourceUrl: 'https://chromewebstore.google.com', format: 'chrome-web-store', itemId: browser.extension.extensionId, ref: item.ref, importedAt: item.importedAt };
      const latest = await chromeWebStoreRegistryAdapterV1.latest(ctx, [target], { source: { id: 'builtin:chrome-web-store', title: 'Chrome Web Store', format: 'chrome-web-store', kinds: ['browserExtension'], url: 'https://chromewebstore.google.com', enabled: true, addedAt: 0 } });
      result.set(item.itemId, latest.get(browser.extension.extensionId) ?? 'removed');
    }
    return result;
  },
};

/** Old pointer-only catalogs are also one inert, cross-kind acquisition. No
 * target fact is manufactured: unresolved versions stay absent until selection. */
function legacyDiscovery(source: RegistrySourceV1, catalog: Readonly<{ picks: readonly HappierPickV1[]; entries: readonly MarketplaceIndexEntryV1[];
  browserExtensions?: readonly RegistryBrowserExtensionCatalogEntryV1[] }>): MarketplaceCatalogDiscoveryV1 {
  const summaries = [...catalog.picks.map(pick => pickSummary(source, pick)),
    ...catalog.entries.map(entry => registryPluginSummaryV1(source, entry)),
    ...(catalog.browserExtensions ?? []).map(entry => registryBrowserExtensionSummaryV1(source.id, entry))];
  const counts = new Map<string, number>();
  for (const summary of summaries) {
    const key = JSON.stringify([summary.kind, summary.itemId]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { items: summaries.flatMap(summary => counts.get(JSON.stringify([summary.kind, summary.itemId])) !== 1 ? [] : [{
    id: JSON.stringify([summary.kind, summary.itemId]), title: summary.title,
    ...(summary.description === undefined ? {} : { description: summary.description }),
    reference: { type: 'registryItem' as const, kind: summary.kind, sourceId: source.id, itemId: summary.itemId,
      ...(summary.version === undefined ? {} : { version: summary.version }) },
  }]), categories: [], jobs: [] };
}

/** Root skills from different repositories share their native item id. The
 * catalog pointer retains the complete location while target payload refs stay native. */
function pickItemId(pick: HappierPickV1): string {
  return pick.kind === 'skill' ? `pick:${JSON.stringify([pick.format, pick.sourceUrl, pick.path ?? '', pick.itemId])}` : pick.itemId;
}
function pickSource(pick: HappierPickV1): RegistrySourceV1 {
  // A pointer to the exact declared app catalog retains that source's identity.
  // The pointer has no source ref, so it cannot borrow a differently pinned source.
  const builtin = pick.kind === 'app' ? BUILT_IN_REGISTRY_SOURCES_V1.find(candidate => !('packageContent' in candidate)
    && candidate.kinds.includes('app') && candidate.format === pick.format && candidate.url === pick.sourceUrl
    && candidate.path === pick.path && candidate.ref === undefined) : undefined;
  return { id: builtin?.id ?? deriveRegistrySourceIdV1(pick.sourceUrl), title: new URL(pick.sourceUrl).hostname,
    format: pick.format, kinds: [pick.kind], url: pick.sourceUrl, ...(pick.path === undefined ? {} : { path: pick.path }), enabled: true, addedAt: 0 };
}
function targetAdapter(pick: HappierPickV1): RegistryFormatAdapterV1 | undefined {
  return (REGISTRY_FORMAT_ADAPTERS_V1 as Partial<Record<HappierPickV1['format'], RegistryFormatAdapterV1>>)[pick.format];
}
function pickSummary(source: RegistrySourceV1, pick: HappierPickV1, problem?: NonNullable<RegistryItemSummaryV1['problem']>): RegistryItemSummaryV1 {
  const url = new URL(pick.sourceUrl);
  return { sourceId: source.id, kind: pick.kind, itemId: pickItemId(pick),
    title: pick.display?.title ?? (pick.itemId || pick.path || url.pathname.split('/').filter(Boolean).at(-1) || url.hostname),
    ...(pick.display?.description === undefined ? {} : { description: pick.display.description }),
    flags: { pick: true }, ...(problem === undefined ? {} : { problem }) };
}
