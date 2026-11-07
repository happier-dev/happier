import type { RegistryContentRefV1, RegistryItemSummaryV1, RegistryItemV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1, type RegistryListPageV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryFormatAdapterV1, RegistryFetchContextV1 } from './registryFormatAdapterV1.js';
import { normalizeDokployTemplateV1 } from './dokployTemplateNormalizationV1.js';
import { templateRecordV1 } from './composeTemplateNormalizationV1.js';
import { readGitHubRepositoryV1, registryRelativePathV1 } from './github.js';
import { appCatalogContentRefV1, appCatalogFileUrlV1, appCatalogRefVersionV1, appCatalogSummaryV1, appCatalogTreeRefV1,
  readAppCatalogIndexV1, readAppCatalogTreeV1, requireCatalogHttpV1, withAppCatalogReadV1, type AppCatalogLocationV1 } from './registryAppCatalogV1.js';

const indexPath = 'meta.json';
function itemId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('/') || registryRelativePathV1(value) !== value) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return value;
}
function parseIndex(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const entries = new Map<string, Record<string, unknown>>();
  for (const raw of value) {
    const entry = templateRecordV1(raw);
    if (!entry) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const id = itemId(entry.id);
    if (entries.has(id)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    entries.set(id, entry);
  }
  return entries;
}
function paths(location: AppCatalogLocationV1, id: string) {
  const prefix = `${location.root}blueprints/${itemId(id)}/`;
  return { compose: `${prefix}docker-compose.yml`, template: `${prefix}template.toml`, metadata: `${prefix}meta.json` };
}
function summary(source: RegistrySourceV1, location: AppCatalogLocationV1, id: string, metadata: Record<string, unknown>, version?: string): RegistryItemSummaryV1 {
  const result = appCatalogSummaryV1(source, id, metadata, version, location);
  if (typeof metadata.logo !== 'string' || metadata.logo.startsWith('https://')) return result;
  let logo: string;
  try { logo = registryRelativePathV1(metadata.logo); } catch { return { ...result, iconUrl: undefined }; }
  return { ...result, iconUrl: appCatalogFileUrlV1(location, `${location.root}blueprints/${id}/${logo}`) };
}
async function readIndex(ctx: RegistryFetchContextV1, location: AppCatalogLocationV1) {
  if (!location.repo) {
    const index = await readAppCatalogIndexV1(ctx, location);
    return { entries: parseIndex(index.value), fetchedAt: index.fetchedAt };
  }
  const tree = await readAppCatalogTreeV1(ctx, location);
  if (tree.has(location.indexPath)) {
    const index = await readAppCatalogIndexV1(ctx, location);
    return { entries: parseIndex(index.value), fetchedAt: index.fetchedAt };
  }
  // Current upstream generates its aggregate only when publishing. The Git
  // tree is the metadata-only directory index; read metadata only on selection.
  const entries = new Map<string, Record<string, unknown>>();
  const prefix = `${location.root}blueprints/`;
  for (const path of tree.keys()) {
    if (!path.startsWith(prefix) || !path.endsWith('/meta.json')) continue;
    const id = path.slice(prefix.length, -'/meta.json'.length);
    if (!id || id.includes('/')) continue;
    const selected = paths(location, id);
    if (tree.has(selected.compose) && tree.has(selected.template)) entries.set(id, {});
  }
  if (!entries.size) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return { entries, fetchedAt: 0 };
}
async function selectedFiles(ctx: RegistryFetchContextV1, location: AppCatalogLocationV1, id: string) {
  const selected = paths(location, id);
  const responses = await Promise.all([selected.compose, selected.template].map(async path => {
    const response = await ctx.http.getText(appCatalogFileUrlV1(location, path), { source: location.source });
    return { path, content: requireCatalogHttpV1(response), fetchedAt: response.ok ? response.fetchedAt : 0 };
  }));
  return { files: responses, compose: responses[0]!.content, template: responses[1]!.content,
    fetchedAt: Math.max(...responses.map(response => response.fetchedAt)) };
}
function projectListQuery(page: RegistryListPageV1, input: string): RegistryListPageV1 {
  const query = input.trim().toLowerCase();
  if (!query) return page;
  const items = page.items.filter(item => `${item.itemId} ${item.title} ${item.description ?? ''} ${item.appMetadata?.tags?.join(' ') ?? ''}`.toLowerCase().includes(query));
  return { ...page, items, ...(page.total === undefined ? {} : { total: items.length }) };
}
export const composeTomlCatalogRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'dokploy-templates', kinds: ['app'], browserFetchable: () => true, supportsQuery: true,
  projectListQuery,
  async detect(ctx, url) {
    const repo = readGitHubRepositoryV1(url);
    if (!repo && !url.endsWith('/meta.json')) return null;
    const source: RegistrySourceV1 = { id: url, title: url, format: 'dokploy-templates', kinds: ['app'], url, enabled: true, addedAt: 0 };
    try {
      return await withAppCatalogReadV1(ctx, source, indexPath, undefined, async (ctx, location) => {
        const index = await readIndex(ctx, location);
        return { format: 'dokploy-templates', kinds: ['app'], title: repo?.repo ?? new URL(url).hostname, itemCount: index.entries.size };
      });
    } catch (error) {
      if (!(error instanceof RegistryFetchErrorV1)) throw error;
      if (error.status.state === 'rate_limited') throw error;
      return null;
    }
  },
  async list(ctx, req): Promise<RegistryListPageV1> {
    try {
      if (req.kind !== 'app') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      return await withAppCatalogReadV1(ctx, req.source, indexPath, undefined, async (ctx, location) => {
        const index = await readIndex(ctx, location);
        const items = [...index.entries].map(([id, metadata]) => summary(req.source, location, id, metadata, location.commit));
        return projectListQuery({ sourceId: req.source.id, status: { state: 'ok', fetchedAt: index.fetchedAt }, items, total: items.length, nextCursor: null }, req.query ?? '');
      });
    } catch (error) {
      if (!(error instanceof RegistryFetchErrorV1)) throw error;
      return { sourceId: req.source.id, status: error.status, items: [], nextCursor: null };
    }
  },
  async read(ctx, req): Promise<RegistryItemV1> {
    if (req.kind !== 'app') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return withAppCatalogReadV1(ctx, req.source, indexPath, req.version, async (ctx, location) => {
      const id = itemId(req.itemId);
      let metadata: Record<string, unknown> | undefined;
      if (location.repo) {
        metadata = templateRecordV1(requireCatalogHttpV1(await ctx.http.getJson(appCatalogFileUrlV1(location, paths(location, id).metadata), { source: req.source })));
        if (!metadata || metadata.id !== id) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      } else metadata = (await readIndex(ctx, location)).entries.get(id);
      if (!metadata) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const selected = await selectedFiles(ctx, location, id);
      const ref = appCatalogContentRefV1(location, selected.files);
      const version = appCatalogRefVersionV1(ref);
      if (req.version !== undefined && req.version !== version) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const listing = summary(req.source, location, id, metadata, version);
      const normalized = normalizeDokployTemplateV1({ document: selected.compose, template: selected.template, title: listing.title,
        ...(listing.description === undefined ? {} : { description: listing.description }),
        ...(ctx.appTemplateHints?.domainHealthChecks ? { domainHealthChecks: ctx.appTemplateHints.domainHealthChecks } : {}) });
      return { summary: { ...listing, ...(normalized.state === 'needs_review' ? { problem: { code: 'needs_review', diagnostics: normalized.diagnostics } } : {}) },
        payload: normalized.state === 'ready' ? { kind: 'app', state: 'ready', app: normalized.app, ref }
          : { kind: 'app', state: 'needs_review', diagnostics: normalized.diagnostics, ref }, fetchedAt: selected.fetchedAt };
    });
  },
  async latest(ctx, items, options) {
    const result = new Map<string, RegistryContentRefV1 | 'removed'>();
    if (!items.length) return result;
    if (!options?.source) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return withAppCatalogReadV1(ctx, options.source, indexPath, undefined, async (ctx, location) => {
      if (location.repo) {
        const tree = await readAppCatalogTreeV1(ctx, location);
        const publishedIds = tree.has(location.indexPath) ? parseIndex((await readAppCatalogIndexV1(ctx, location)).value) : undefined;
        for (const item of items) {
          const selected = paths(location, item.itemId);
          if (publishedIds ? !publishedIds.has(item.itemId) : !tree.has(selected.metadata)) {
            result.set(item.itemId, 'removed'); continue;
          }
          const files = [selected.compose, selected.template].flatMap(path => { const blobSha = tree.get(path); return blobSha ? [{ path, blobSha }] : []; });
          result.set(item.itemId, files.length === 2 ? appCatalogTreeRefV1(location, files) : 'removed');
        }
      } else {
        const index = await readIndex(ctx, location);
        for (const item of items) if (!result.has(item.itemId)) result.set(item.itemId, index.entries.has(item.itemId)
          ? appCatalogContentRefV1(location, (await selectedFiles(ctx, location, item.itemId)).files) : 'removed');
      }
      return result;
    });
  },
};
