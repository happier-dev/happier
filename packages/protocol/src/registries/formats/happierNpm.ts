import {
  buildCommunityNpmSearchUrlV1, readCommunityNpmSearchV1,
  readCommunityNpmPackumentVersionV1, projectCommunityNpmListingV1,
} from '../../marketplace/communityNpmDiscoveryV1.js';
import { MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1, type MarketplaceIndexEntryV1 } from '../../marketplace/marketplaceIndexV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryFetchContextV1, RegistryFormatAdapterV1 } from './registryFormatAdapterV1.js';
import { registryPluginItemV1, registryPluginSummaryV1, registryPluginSupportsKindV1 } from './registryPluginListingV1.js';

async function readListing(ctx: RegistryFetchContextV1, source: RegistrySourceV1, packageName: string, version?: string) {
  const response = await ctx.http.getJson(`${new URL(source.url).origin}/${encodeURIComponent(packageName)}`, { source });
  if (!response.ok) throw new RegistryFetchErrorV1(response.status);
  const raw = response.value;
  if (!version && raw !== null && typeof raw === 'object' && 'dist-tags' in raw) {
    const tags = raw['dist-tags'];
    if (tags !== null && typeof tags === 'object' && 'latest' in tags && typeof tags.latest === 'string') version = tags.latest;
  }
  if (!version) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const registryOrigin = new URL(source.url).origin;
  const metadata = readCommunityNpmPackumentVersionV1(raw, { packageName, version, registryOrigin });
  if (!metadata.ok) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const happier = metadata.versionMetadata;
  const publisherRecord = happier._npmUser;
  const username = publisherRecord !== null && typeof publisherRecord === 'object' && 'name' in publisherRecord
    && typeof publisherRecord.name === 'string' ? publisherRecord.name : null;
  return { response, metadata, packageName, version, registryOrigin, username };
}

export const happierNpmRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'happier-npm', kinds: ['plugin', 'agent'], browserFetchable: () => true, supportsQuery: true,
  supportsContributionFamily: true,
  async list(ctx, req) {
    const from = req.cursor ? Number(req.cursor) : 0;
    if (!Number.isSafeInteger(from) || from < 0 || req.cursor && !/^\d+$/.test(req.cursor)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const response = await ctx.http.getJson(buildCommunityNpmSearchUrlV1(new URL(req.source.url).origin,
      { text: req.query ?? '', contributionFamily: req.contributionFamily, from, size: MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1 }), { source: req.source });
    if (!response.ok) return { sourceId: req.source.id, status: response.status, items: [], nextCursor: null };
    const search = readCommunityNpmSearchV1(response.value, { from, size: MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1 });
    const outcomes = await Promise.allSettled(search.candidates.map(async candidate => {
      const resolved = await readListing(ctx, req.source, candidate.packageName, candidate.version);
      return projectCommunityNpmListingV1({ ...resolved.metadata, packageName: candidate.packageName,
        version: candidate.version, registryOrigin: resolved.registryOrigin, publisher: candidate.publisher });
    }));
    ctx.signal?.throwIfAborted();
    const entries: MarketplaceIndexEntryV1[] = outcomes.flatMap(outcome => outcome.status === 'fulfilled' && outcome.value.status === 'listed' ? [outcome.value.entry] : []);
    const body = response.value;
    const returned = body !== null && typeof body === 'object' && 'objects' in body && Array.isArray(body.objects) ? body.objects.length : 0;
    return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: response.fetchedAt },
      items: entries.filter(entry => registryPluginSupportsKindV1(entry, req.kind)
        && (!req.contributionFamily || entry.summary.contributions.includes(req.contributionFamily)))
        .map(entry => registryPluginSummaryV1(req.source, entry)),
      ...(req.kind === 'plugin' && !req.contributionFamily ? { total: search.total } : {}),
      nextCursor: returned > 0 && from + returned < search.total ? String(from + returned) : null };
  },
  async read(ctx, req) {
    const resolved = await readListing(ctx, req.source, req.itemId, req.version);
    // A packument's version publisher is the exact released-version authority.
    // Older npm documents may omit it; the targeted search supplies that label.
    let username = resolved.username;
    if (!username) {
      const response = await ctx.http.getJson(buildCommunityNpmSearchUrlV1(resolved.registryOrigin,
        { text: '', exactPackageName: req.itemId }), { source: req.source });
      if (!response.ok) throw new RegistryFetchErrorV1(response.status);
      username = readCommunityNpmSearchV1(response.value, { exactPackageName: req.itemId, from: 0,
        size: MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1 }).candidates.find(candidate => candidate.version === resolved.version)?.publisher.id ?? null;
    }
    if (!username) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    const listing = projectCommunityNpmListingV1({ ...resolved.metadata, packageName: resolved.packageName,
      version: resolved.version, registryOrigin: resolved.registryOrigin, publisher: { id: username, displayName: username } });
    if (listing.status !== 'listed' || !registryPluginSupportsKindV1(listing.entry, req.kind)) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return registryPluginItemV1(req.source, listing.entry, resolved.response.fetchedAt);
  },
  async latest() { return new Map(); }, // Plugins keep the plugin update-policy owner.
};
