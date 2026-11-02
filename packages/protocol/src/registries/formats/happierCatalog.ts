import { parseMarketplaceIndexSourceSnapshotV1, type HappierPickV1 } from '../../marketplace/marketplaceIndexV1.js';
import { readMarketplaceSourceListingsV1 } from '../../marketplace/marketplaceSourceListingsV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1 } from './registryFormatAdapterV1.js';
import { REGISTRY_FORMAT_KINDS_V1, deriveRegistrySourceIdV1, type RegistrySourceV1 } from '../registrySourcesV1.js';
import { RegistryItemV1Schema, type RegistryContentRefV1, type RegistryItemSummaryV1, type RegistryProvenanceV1 } from '../registryItemsV1.js';
import { REGISTRY_FORMAT_ADAPTERS_V1 } from './index.js';
import { registryPluginItemV1, registryPluginSummaryV1, registryPluginSupportsKindV1 } from './registryPluginListingV1.js';
import { bindRegistryMarketplaceCatalogV1 } from './registryMarketplaceCatalogBindingV1.js';
import { readHappierBrowserExtensionCatalogItemV1, registryBrowserExtensionSummaryV1 } from './happierBrowserExtensionCatalog.js';

async function readCatalog(ctx: RegistryFetchContextV1, source: RegistrySourceV1,
  pinned?: Readonly<{ pluginId: string; version: string }>) {
  const response = await ctx.http.getJson(source.url, { source });
  if (!response.ok) throw new RegistryFetchErrorV1(response.status);
  let catalog;
  try { catalog = parseMarketplaceIndexSourceSnapshotV1(response.value); }
  catch { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
  catalog = bindRegistryMarketplaceCatalogV1(catalog, source);
  return { catalog: { ...catalog, ...readMarketplaceSourceListingsV1(catalog, pinned) }, fetchedAt: response.fetchedAt };
}

export const happierCatalogRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'happier-catalog', kinds: REGISTRY_FORMAT_KINDS_V1['happier-catalog'], browserFetchable: () => true, supportsQuery: true,
  async detect(ctx, url) {
    const response = await ctx.http.getJson(url);
    if (!response.ok) return null;
    try { const catalog = parseMarketplaceIndexSourceSnapshotV1(response.value);
      return { format: 'happier-catalog', kinds: [...new Set(['plugin' as const, ...catalog.picks.map(pick => pick.kind),
        ...(catalog.entries.some(entry => registryPluginSupportsKindV1(entry, 'agent')) ? ['agent' as const] : []),
        ...(catalog.browserExtensions?.length ? ['browserExtension' as const] : [])])],
        title: catalog.source.title, itemCount: catalog.entries.length + catalog.picks.length + (catalog.browserExtensions?.length ?? 0) };
    } catch { return null; }
  },
  async list(ctx, req) {
    try {
      const { catalog, fetchedAt } = await readCatalog(ctx, req.source);
      const query = (req.query ?? '').trim().toLocaleLowerCase();
      if (req.kind === 'browserExtension') {
        const items = (catalog.browserExtensions ?? []).map(entry => registryBrowserExtensionSummaryV1(req.source.id, entry))
          .filter(item => !query || `${item.title} ${item.description ?? ''} ${item.itemId}`.toLocaleLowerCase().includes(query));
        return { sourceId: req.source.id, status: { state: 'ok', fetchedAt }, items, total: items.length, nextCursor: null };
      }
      if (req.kind !== 'plugin') {
        const picks = catalog.picks.filter(pick => pick.kind === req.kind);
        const counts = new Map<string, number>();
        for (const pick of picks) { const id = pickItemId(pick); counts.set(id, (counts.get(id) ?? 0) + 1); }
        const items = (await Promise.all(picks.map(async pick => {
          const itemId = pickItemId(pick);
          if (counts.get(itemId)! > 1) {
            return pickSummary(req.source, pick, { code: 'unsupported_entry', reason: 'distribution' });
          }
          const adapter = targetAdapter(pick);
          if (!adapter) return pickSummary(req.source, pick, { code: 'unsupported_entry', reason: 'distribution' });
          try {
            const target = { source: pickSource(pick), kind: pick.kind, itemId: pick.itemId };
            const read = ctx.readTargetItem ? await ctx.readTargetItem(target) : await adapter.read(ctx, target);
            if (read === null) return pickSummary(req.source, pick);
            const item = RegistryItemV1Schema.parse(read);
            return { ...item.summary, sourceId: req.source.id, itemId, flags: { ...item.summary.flags, pick: true as const } };
          } catch (error) {
            if (!(error instanceof RegistryFetchErrorV1)) throw error;
            // An unavailable target is not proof of removal. Its own registry
            // retains the typed recovery; recommendations quietly omit it.
            if (error.status.state !== 'invalid_source') return null;
            const page = await adapter.list(ctx, { source: pickSource(pick), kind: pick.kind });
            if (page.status.state !== 'ok') return null;
            const listed = page.items.find(item => item.itemId === pick.itemId);
            if (!listed) return pickSummary(req.source, pick, { code: 'removed_from_source' });
            return listed.problem ? { ...listed, sourceId: req.source.id, itemId, flags: { ...listed.flags, pick: true as const } } : null;
          }
        }))).filter((item): item is RegistryItemSummaryV1 => item !== null)
          .filter(item => !query || `${item.title} ${item.description ?? ''} ${item.itemId}`.toLocaleLowerCase().includes(query));
        const plugins = catalog.entries.filter(entry => registryPluginSupportsKindV1(entry, req.kind)
          && (!query || `${entry.display.title} ${entry.display.description ?? ''} ${entry.pluginId}`.toLocaleLowerCase().includes(query)))
          .map(entry => registryPluginSummaryV1(req.source, entry));
        return { sourceId: req.source.id, status: { state: 'ok', fetchedAt }, total: items.length + plugins.length,
          items: [...items, ...plugins], nextCursor: null };
      }
      const entries = catalog.entries.filter(entry => !query || `${entry.display.title} ${entry.display.description ?? ''} ${entry.pluginId}`.toLocaleLowerCase().includes(query));
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt }, total: entries.length,
        items: entries.map(entry => registryPluginSummaryV1(req.source, entry)), nextCursor: null };
    } catch (error) { if (error instanceof RegistryFetchErrorV1) return { sourceId: req.source.id, status: error.status, items: [], nextCursor: null }; throw error; }
  },
  async read(ctx, req) {
    const { catalog, fetchedAt } = await readCatalog(ctx, req.source,
      (req.kind === 'plugin' || req.kind === 'agent') && req.version ? { pluginId: req.itemId, version: req.version } : undefined);
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
      const target = { source: pickSource(pick), kind: pick.kind, itemId: pick.itemId, ...(req.version === undefined ? {} : { version: req.version }) };
      const read = ctx.readTargetItem ? await ctx.readTargetItem(target) : await adapter.read(ctx, target);
      if (read === null) throw new RegistryFetchErrorV1({ state: 'needs_machine' });
      const item = RegistryItemV1Schema.parse(read);
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
    const { catalog } = await readCatalog(ctx, source);
    const groups = new Map<string, { source: RegistrySourceV1; adapter: RegistryFormatAdapterV1;
      items: { catalogId: string; provenance: RegistryProvenanceV1 }[] }>();
    for (const item of items) {
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
    return result;
  },
};

/** Root skills from different repositories share their native item id. The
 * catalog pointer retains the complete location while target payload refs stay native. */
function pickItemId(pick: HappierPickV1): string {
  return pick.kind === 'skill' ? `pick:${JSON.stringify([pick.format, pick.sourceUrl, pick.path ?? '', pick.itemId])}` : pick.itemId;
}
function pickSource(pick: HappierPickV1): RegistrySourceV1 {
  return { id: deriveRegistrySourceIdV1(pick.sourceUrl), title: new URL(pick.sourceUrl).hostname,
    format: pick.format, kinds: [pick.kind], url: pick.sourceUrl, ...(pick.path === undefined ? {} : { path: pick.path }), enabled: true, addedAt: 0 };
}
function targetAdapter(pick: HappierPickV1): RegistryFormatAdapterV1 | undefined {
  return (REGISTRY_FORMAT_ADAPTERS_V1 as Partial<Record<HappierPickV1['format'], RegistryFormatAdapterV1>>)[pick.format];
}
function pickSummary(source: RegistrySourceV1, pick: HappierPickV1, problem?: NonNullable<RegistryItemSummaryV1['problem']>): RegistryItemSummaryV1 {
  const url = new URL(pick.sourceUrl);
  return { sourceId: source.id, kind: pick.kind, itemId: pickItemId(pick), title: pick.itemId || pick.path || url.pathname.split('/').filter(Boolean).at(-1) || url.hostname,
    flags: { pick: true }, ...(problem === undefined ? {} : { problem }) };
}
