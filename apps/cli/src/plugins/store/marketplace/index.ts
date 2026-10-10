import { createHash } from 'node:crypto';

import semver from 'semver';

import { MarketplaceIndexQueryV1Schema, MarketplaceIndexSourceSnapshotV1Schema } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import type { MarketplaceIndexAdmissionV1, MarketplaceIndexItemV1, MarketplaceIndexQueryV1, MarketplaceIndexQueryResultV1, MarketplaceIndexSourceKindV1, MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';

type IndexDiagnostic = { code: string; message: string };

const SOURCE_PRIORITY: Readonly<Record<MarketplaceIndexSourceKindV1, number>> = {
  curated: 0,
  user: 1,
  'community-npm': 2,
};

/**
 * Curation recommends discovery; it is never hidden authorization for an
 * exact release. Every listing is admitted only through the full Install and
 * Trust review, regardless of its source kind or review status. Withdrawal is
 * a discovery fact carried by `review.status`, never a decision that disables
 * installed code.
 */
const FULL_REVIEW_ADMISSION: MarketplaceIndexAdmissionV1 = Object.freeze({
  install: 'full-review',
  mutatesInstalledTrust: false,
  disablesInstalledCode: false,
  directNpmRequiresFullReview: true,
});

function canonicalOrigin(origin: string): string {
  const url = new URL(origin);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function channelKey(entry: MarketplaceIndexSourceSnapshotV1['entries'][number]): string {
  return `${canonicalOrigin(entry.distribution.registryOrigin)}\u0000${entry.distribution.packageName.toLowerCase()}`;
}

function distributionKey(entry: MarketplaceIndexSourceSnapshotV1['entries'][number]): string {
  return `${channelKey(entry)}\u0000${entry.distribution.version}`;
}

function queryIdentity(query: ReturnType<typeof MarketplaceIndexQueryV1Schema.parse>): string {
  return createHash('sha256').update(JSON.stringify({ ...query, cursor: null })).digest('hex').slice(0, 24);
}

function decodeCursor(cursor: string | null, revision: number, identity: string): number {
  if (!cursor) return 0;
  const match = /^revision:(\d+):query:([a-f0-9]{24}):offset:(\d+)$/.exec(cursor);
  if (!match || Number(match[1]) !== revision) throw new Error('Marketplace index cursor revision is stale or invalid');
  if (match[2] !== identity) throw new Error('Marketplace index cursor does not match its query');
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Marketplace index cursor offset is invalid');
  return offset;
}

export function createMarketplaceIndex(params: Readonly<{
  revision: number;
  sources: readonly MarketplaceIndexSourceSnapshotV1[];
  query: unknown;
  diagnostics?: readonly IndexDiagnostic[];
}>): MarketplaceIndexQueryResultV1 {
  const query = MarketplaceIndexQueryV1Schema.parse(params.query);
  return createMarketplaceIndexFromNormalizedQuery({ ...params, query });
}

/**
 * Builds the index from the Protocol-normalized query already used to choose
 * source acquisition. The raw-input wrapper above remains the boundary for
 * direct index callers; the marketplace service uses this path so one parse
 * controls both acquisition and output validation.
 */
export function createMarketplaceIndexFromNormalizedQuery(params: Readonly<{
  revision: number;
  sources: readonly MarketplaceIndexSourceSnapshotV1[];
  query: MarketplaceIndexQueryV1;
  diagnostics?: readonly IndexDiagnostic[];
  offset?: number;
}>): MarketplaceIndexQueryResultV1 {
  const query = params.query;
  const sources = params.sources.map((source) => MarketplaceIndexSourceSnapshotV1Schema.parse(source)).sort((a, b) => {
    const priority = SOURCE_PRIORITY[a.source.kind] - SOURCE_PRIORITY[b.source.kind];
    return priority || a.source.id.localeCompare(b.source.id);
  });
  const diagnostics: IndexDiagnostic[] = [...(params.diagnostics ?? [])];
  const diagnose = (diagnostic: IndexDiagnostic): void => {
    diagnostics.push(diagnostic);
  };
  const listings = new Map<string, MarketplaceIndexItemV1>();
  const sourceDistributions = new Map<string, string>();

  for (const snapshot of sources) {
    for (const entry of snapshot.entries) {
      const listingKey = `${snapshot.source.id}\u0000${entry.pluginId}`;
      const channel = channelKey(entry);
      const prior = listings.get(listingKey);
      const boundChannel = prior ? channelKey(prior) : null;
      if (boundChannel && boundChannel !== channel) {
        diagnose({ code: 'marketplace_distribution_rebinding', message: `Source '${snapshot.source.id}' attempted to rebind plugin '${entry.pluginId}' to another registry/package channel` });
        continue;
      }
      const exactDistribution = distributionKey(entry);
      const sourceDistributionKey = `${snapshot.source.id}\u0000${exactDistribution}`;
      const priorDistributionPluginId = sourceDistributions.get(sourceDistributionKey);
      if (priorDistributionPluginId && priorDistributionPluginId !== entry.pluginId) {
        diagnose({ code: 'marketplace_distribution_identity_conflict', message: `Source '${snapshot.source.id}' assigned an existing distribution identity to plugin '${entry.pluginId}'` });
        continue;
      }
      if (prior && prior.distribution.version === entry.distribution.version && (prior.distribution.integrity !== entry.distribution.integrity || prior.manifestDigest !== entry.manifestDigest || prior.publisher.id !== entry.publisher.id)) {
        diagnose({ code: 'marketplace_distribution_metadata_conflict', message: `Source '${snapshot.source.id}' conflicts with the bound publisher/manifest identity for plugin '${entry.pluginId}'` });
        continue;
      }
      sourceDistributions.set(sourceDistributionKey, entry.pluginId);
      if (prior && prior.distribution.version === entry.distribution.version) {
        diagnose({ code: 'marketplace_duplicate_distribution_identity', message: `Source '${snapshot.source.id}' contains duplicate distribution identity for plugin '${entry.pluginId}'` });
        continue;
      }
      if (!prior || semver.gt(entry.distribution.version, prior.distribution.version)) listings.set(listingKey, {
        ...entry,
        source: snapshot.source,
        freshness: snapshot.freshness,
        admission: FULL_REVIEW_ADMISSION,
        artifactAccess: entry.distribution.registryProfileId
          ? { state: 'unverified-profile', registryProfileId: entry.distribution.registryProfileId }
          : { state: 'public', registryProfileId: null },
      });
    }
  }

  const text = query.text.toLocaleLowerCase('en-US');
  const items = [...listings.values()].filter((item) => {
    if (!query.filters.includeUnavailable && item.source.kind === 'curated' && item.review.status !== 'approved') return false;
    if (query.filters.categories?.length && !query.filters.categories.some((category) => item.categories.includes(category))) return false;
    if (query.filters.platforms?.length && !query.filters.platforms.some((platform) => item.compatibility.platforms.includes(platform))) return false;
    if (query.filters.sourceKinds?.length && !query.filters.sourceKinds.includes(item.source.kind)) return false;
    if (query.filters.sourceIds?.length && !query.filters.sourceIds.includes(item.source.id)) return false;
    if (query.filters.pluginIds?.length && !query.filters.pluginIds.includes(item.pluginId)) return false;
    return !text || `${item.pluginId}\n${item.display.title}\n${item.display.description ?? ''}\n${item.publisher.displayName}\n${item.categories.join('\n')}`.toLocaleLowerCase('en-US').includes(text);
  }).sort((a, b) => SOURCE_PRIORITY[a.source.kind] - SOURCE_PRIORITY[b.source.kind]
    || a.pluginId.localeCompare(b.pluginId)
    || semver.rcompare(a.distribution.version, b.distribution.version)
    || a.source.id.localeCompare(b.source.id));

  const identity = queryIdentity(query);
  const offset = params.offset ?? decodeCursor(query.cursor, params.revision, identity);
  if (offset > items.length) throw new Error('Marketplace index cursor offset is invalid');
  const page = items.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return {
    revision: params.revision,
    items: page,
    nextCursor: nextOffset < items.length ? `revision:${params.revision}:query:${identity}:offset:${nextOffset}` : null,
    sources: sources.map(({ source, freshness, diagnostics: sourceDiagnostics }) => ({ source, freshness, diagnostics: sourceDiagnostics })),
    diagnostics,
  };
}
