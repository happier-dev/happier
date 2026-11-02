import type { RegistryContentRefV1, RegistryItemV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1, type RegistryListPageV1 } from '../registryListV1.js';
import type { RegistryFormatAdapterV1, RegistryFetchContextV1 } from './registryFormatAdapterV1.js';
import { normalizeComposeTemplateV1, templateRecordV1, type TemplateDiagnosticV1 } from './composeTemplateNormalizationV1.js';
import { readGitHubRepositoryV1, registryRelativePathV1 } from './github.js';
import { appCatalogContentRefV1, appCatalogFileUrlV1, appCatalogRefVersionV1, appCatalogSummaryV1, appCatalogTreeRefV1,
  readAppCatalogIndexV1, readAppCatalogTreeV1, requireCatalogHttpV1, withAppCatalogReadV1, type AppCatalogLocationV1 } from './registryAppCatalogV1.js';

type CatalogEntry = Readonly<{ metadata: Record<string, unknown>; diagnostics: TemplateDiagnosticV1[] }>;
function parseIndex(value: unknown): ReadonlyMap<string, CatalogEntry> {
  const record = templateRecordV1(value);
  const candidates: Array<[string, unknown]> = record ? Object.entries(record) : Array.isArray(value)
    ? value.flatMap(entry => { const item = templateRecordV1(entry); return typeof item?.name === 'string' ? [[item.name, item]] : []; }) : [];
  if (!record && !Array.isArray(value)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const entries = new Map<string, CatalogEntry>();
  for (const [id, candidate] of candidates) {
    const entry = templateRecordV1(candidate);
    if (entry?.ignore === true || entry?.ignore === 'true') continue;
    try { if (registryRelativePathV1(id) !== id || id.includes('/') || !id) continue; } catch { continue; }
    const prior = entries.get(id);
    entries.set(id, { metadata: entry ?? {}, diagnostics: prior
      ? [{ field: 'itemId', reason: 'duplicate_item' }]
      : !entry ? [{ field: 'metadata', reason: 'invalid_metadata' }] : [] });
  }
  return entries;
}
function bodyPath(location: AppCatalogLocationV1, id: string, entry: Record<string, unknown>): string {
  const file = typeof entry.filename === 'string' ? registryRelativePathV1(entry.filename) : `${id}.yaml`;
  if (file.includes('/') || !/\.ya?ml$/.test(file)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return `${location.root}compose/${file}`;
}
async function readSelected(ctx: RegistryFetchContextV1, location: AppCatalogLocationV1, path: string) {
  const response = await ctx.http.getText(appCatalogFileUrlV1(location, path), { source: location.source });
  if (!response.ok && response.status.state === 'invalid_source' && path.endsWith('.yaml')) {
    const alternate = path.replace(/\.yaml$/, '.yml');
    const next = await ctx.http.getText(appCatalogFileUrlV1(location, alternate), { source: location.source });
    return { path: alternate, document: requireCatalogHttpV1(next), fetchedAt: next.ok ? next.fetchedAt : 0 };
  }
  return { path, document: requireCatalogHttpV1(response), fetchedAt: response.ok ? response.fetchedAt : 0 };
}
export const composeCatalogRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'coolify-templates', kinds: ['app'], browserFetchable: () => true, supportsQuery: true,
  async detect(ctx, url) {
    const repo = readGitHubRepositoryV1(url);
    if (!repo && !url.endsWith('/service-templates.json')) return null;
    const root = repo ? registryRelativePathV1(repo.path ?? '') : '';
    const path = root.endsWith('.json') ? root : [root, 'templates/service-templates.json'].filter(Boolean).join('/');
    const response = await ctx.http.getJson(repo
      ? `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(repo.ref ?? 'HEAD')}/${path}` : url);
    if (!response.ok && response.status.state === 'rate_limited') throw new RegistryFetchErrorV1(response.status);
    if (!response.ok) return null;
    try { const entries = parseIndex(response.value);
      if (![...entries.values()].some(entry => typeof entry.metadata.compose === 'string' || typeof entry.metadata.slogan === 'string')) return null;
      return { format: 'coolify-templates', kinds: ['app'], title: repo?.repo ?? new URL(url).hostname, itemCount: entries.size }; }
    catch (error) { if (error instanceof RegistryFetchErrorV1) return null; throw error; }
  },
  async list(ctx, req) {
    try {
      if (req.kind !== 'app') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      return await withAppCatalogReadV1<RegistryListPageV1>(ctx, req.source, 'templates/service-templates.json', undefined, async (ctx, location) => {
      const index = await readAppCatalogIndexV1(ctx, location);
      const query = (req.query ?? '').trim().toLowerCase();
      const items = [...parseIndex(index.value)].map(([id, entry]) => ({ ...appCatalogSummaryV1(req.source, id, entry.metadata, location.commit, location),
        ...(entry.diagnostics.length ? { problem: { code: 'needs_review' as const, diagnostics: entry.diagnostics } } : {}) }))
        .filter(item => !query || `${item.itemId} ${item.title} ${item.description ?? ''} ${item.appMetadata?.category ?? ''} ${item.appMetadata?.tags?.join(' ') ?? ''}`.toLowerCase().includes(query));
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: index.fetchedAt }, items, total: items.length, nextCursor: null };
      });
    } catch (error) {
      if (!(error instanceof RegistryFetchErrorV1)) throw error;
      return { sourceId: req.source.id, status: error.status, items: [], nextCursor: null };
    }
  },
  async read(ctx, req) {
    if (req.kind !== 'app') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return withAppCatalogReadV1<RegistryItemV1>(ctx, req.source, 'templates/service-templates.json', req.version, async (ctx, location) => {
    const index = await readAppCatalogIndexV1(ctx, location);
    const listing = parseIndex(index.value).get(req.itemId);
    if (!listing) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const entry = listing.metadata;
    const path = bodyPath(location, req.itemId, entry);
    let selected: Awaited<ReturnType<typeof readSelected>>;
    try { selected = await readSelected(ctx, location, path); }
    catch (error) {
      if (!(error instanceof RegistryFetchErrorV1) || error.status.state !== 'invalid_source') throw error;
      let ref: RegistryContentRefV1;
      let reviewListing = listing;
      let fetchedAt = index.fetchedAt;
      if (location.repo && location.commit) {
        const indexBlob = (await readAppCatalogTreeV1(ctx, location)).get(location.indexPath);
        if (!indexBlob) throw error;
        ref = appCatalogTreeRefV1(location, [{ path: location.indexPath, blobSha: indexBlob }]);
      } else {
        // The decoded browse index cannot identify its original bytes. Acquire
        // just that file for this review-only pin, and use its current metadata.
        const response = await ctx.http.getText(appCatalogFileUrlV1(location, location.indexPath), { source: location.source });
        const document = requireCatalogHttpV1(response);
        let value: unknown;
        try { value = JSON.parse(document); } catch { throw error; }
        const current = parseIndex(value).get(req.itemId);
        if (!current) throw error;
        reviewListing = current;
        fetchedAt = response.ok ? response.fetchedAt : index.fetchedAt;
        ref = appCatalogContentRefV1(location, [{ path: location.indexPath, content: document }]);
      }
      // This review-only pin identifies the available index input, not a missing
      // selected body. It cannot supply an installable app or update baseline.
      const version = appCatalogRefVersionV1(ref);
      if (req.version !== undefined && req.version !== version) throw error;
      const diagnostics = [...reviewListing.diagnostics, { field: 'compose.document', reason: 'body_unavailable' }];
      return { summary: { ...appCatalogSummaryV1(req.source, req.itemId, reviewListing.metadata, version, location),
        problem: { code: 'needs_review', diagnostics } },
        payload: { kind: 'app', state: 'needs_review', ref, diagnostics }, fetchedAt };
    }
    const summary = appCatalogSummaryV1(req.source, req.itemId, entry, undefined, location);
    const normalized = normalizeComposeTemplateV1({ document: selected.document,
      title: summary.title,
      ...(typeof entry.slogan === 'string' ? { description: entry.slogan } : {}),
      ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
      ...(typeof entry.documentation === 'string' ? { documentationUrl: entry.documentation } : {}) });
    if (normalized.ignored) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const ref = appCatalogContentRefV1(location, [{ path: selected.path, content: selected.document }]);
    const version = appCatalogRefVersionV1(ref);
    if (req.version !== undefined && req.version !== version) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const diagnostics = [...listing.diagnostics, ...normalized.diagnostics];
    return { summary: { ...summary, version,
      ...(diagnostics.length ? { problem: { code: 'needs_review' as const, diagnostics } } : {}) },
      payload: normalized.state === 'needs_review' || diagnostics.length > 0
        ? { kind: 'app', state: 'needs_review', ref, diagnostics }
        : { kind: 'app', state: 'ready', app: normalized.app, ref }, fetchedAt: selected.fetchedAt };
    });
  },
  async latest(ctx, items, options) {
    const result = new Map<string, RegistryContentRefV1 | 'removed'>();
    if (!items.length) return result;
    const source = options?.source;
    if (!source) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return withAppCatalogReadV1(ctx, source, 'templates/service-templates.json', undefined, async (ctx, location) => {
    const index = parseIndex((await readAppCatalogIndexV1(ctx, location)).value);
    const demanded = items.filter(item => index.has(item.itemId));
    for (const item of items) if (!index.has(item.itemId)) result.set(item.itemId, 'removed');
    if (!demanded.length) return result;
    const tree = location.repo ? await readAppCatalogTreeV1(ctx, location) : undefined;
    for (const item of demanded) {
      if (result.has(item.itemId)) continue;
      const listing = index.get(item.itemId)!;
      if (listing.diagnostics.length) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const path = bodyPath(location, item.itemId, listing.metadata);
      if (!tree) {
        // HTTP catalogs have no Git blob metadata. Hash only the demanded raw
        // body through the same selected-file reader and pin owner as read().
        const selected = await readSelected(ctx, location, path);
        result.set(item.itemId, appCatalogContentRefV1(location, [{ path: selected.path, content: selected.document }]));
        continue;
      }
      const selected = tree.has(path) ? path : path.endsWith('.yaml') ? path.replace(/\.yaml$/, '.yml') : path;
      const blobSha = tree.get(selected);
      result.set(item.itemId, blobSha ? appCatalogTreeRefV1(location, [{ path: selected, blobSha }]) : 'removed');
    }
    return result;
    });
  },
};
