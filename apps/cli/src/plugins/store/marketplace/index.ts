import { createHash } from 'node:crypto';

import semver from 'semver';

import {
  MarketplaceIndexQueryV1Schema,
  MarketplaceIndexSourceSnapshotV1Schema,
  type MarketplaceIndexAdmissionV1,
  type MarketplaceIndexItemV1,
  type MarketplaceIndexQueryResultV1,
  type MarketplaceIndexSourceKindV1,
  type MarketplaceIndexSourceSnapshotV1,
} from '@happier-dev/protocol';

type IndexDiagnostic = { code: string; message: string };

const SOURCE_PRIORITY: Readonly<Record<MarketplaceIndexSourceKindV1, number>> = {
  curated: 0,
  user: 1,
  'community-npm': 2,
};
const MAX_INDEX_DIAGNOSTICS = 128;

function admissionFor(item: MarketplaceIndexSourceSnapshotV1['entries'][number], kind: MarketplaceIndexSourceKindV1): MarketplaceIndexAdmissionV1 {
  if (kind !== 'curated' || item.review.status === 'unreviewed') {
    return { curatedInstall: 'full-review', curatedUpdate: 'not-applicable', warning: true, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true };
  }
  const allowed = item.review.status === 'approved';
  const updateAllowed = allowed && item.updatePolicy === 'curated-auto';
  return { curatedInstall: allowed ? 'allowed' : 'refused', curatedUpdate: updateAllowed ? 'allowed' : 'refused', warning: !allowed, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true };
}

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
  const sources = params.sources.map((source) => MarketplaceIndexSourceSnapshotV1Schema.parse(source)).sort((a, b) => {
    const priority = SOURCE_PRIORITY[a.source.kind] - SOURCE_PRIORITY[b.source.kind];
    return priority || a.source.id.localeCompare(b.source.id);
  });
  const diagnostics: IndexDiagnostic[] = [...(params.diagnostics ?? [])].slice(0, MAX_INDEX_DIAGNOSTICS);
  const diagnose = (diagnostic: IndexDiagnostic): void => {
    if (diagnostics.length < MAX_INDEX_DIAGNOSTICS) diagnostics.push(diagnostic);
  };
  const pluginChannels = new Map<string, string>();
  const distributions = new Map<string, MarketplaceIndexItemV1>();

  for (const snapshot of sources) {
    for (const entry of snapshot.entries) {
      const channel = channelKey(entry);
      const boundChannel = pluginChannels.get(entry.pluginId);
      if (boundChannel && boundChannel !== channel) {
        diagnose({ code: 'marketplace_distribution_rebinding', message: `Source '${snapshot.source.id}' attempted to rebind plugin '${entry.pluginId}' to another registry/package channel` });
        continue;
      }
      const exactDistribution = distributionKey(entry);
      const prior = distributions.get(exactDistribution);
      if (prior && prior.pluginId !== entry.pluginId) {
        diagnose({ code: 'marketplace_distribution_identity_conflict', message: `Source '${snapshot.source.id}' assigned an existing distribution identity to plugin '${entry.pluginId}'` });
        continue;
      }
      if (prior && (prior.distribution.integrity !== entry.distribution.integrity || prior.manifestDigest !== entry.manifestDigest || prior.publisher.id !== entry.publisher.id)) {
        diagnose({ code: 'marketplace_distribution_metadata_conflict', message: `Source '${snapshot.source.id}' conflicts with the bound publisher/manifest identity for plugin '${entry.pluginId}'` });
        continue;
      }
      pluginChannels.set(entry.pluginId, channel);
      if (prior?.source.id === snapshot.source.id) {
        diagnose({ code: 'marketplace_duplicate_distribution_identity', message: `Source '${snapshot.source.id}' contains duplicate distribution identity for plugin '${entry.pluginId}'` });
        continue;
      }
      if (!prior) distributions.set(exactDistribution, {
        ...entry,
        source: snapshot.source,
        freshness: snapshot.freshness,
        admission: admissionFor(entry, snapshot.source.kind),
        artifactAccess: entry.distribution.registryProfileId
          ? { state: 'unverified-profile', registryProfileId: entry.distribution.registryProfileId }
          : { state: 'public', registryProfileId: null },
      });
    }
  }

  const text = query.text.toLocaleLowerCase('en-US');
  const filteredItems = [...distributions.values()].filter((item) => {
    if (!query.filters.includeUnavailable && item.source.kind === 'curated' && item.review.status !== 'approved') return false;
    if (query.filters.categories?.length && !query.filters.categories.some((category) => item.categories.includes(category))) return false;
    if (query.filters.platforms?.length && !query.filters.platforms.some((platform) => item.compatibility.platforms.includes(platform))) return false;
    if (query.filters.sourceKinds?.length && !query.filters.sourceKinds.includes(item.source.kind)) return false;
    if (query.filters.sourceIds?.length && !query.filters.sourceIds.includes(item.source.id)) return false;
    return !text || `${item.pluginId}\n${item.display.title}\n${item.display.description ?? ''}\n${item.publisher.displayName}\n${item.categories.join('\n')}`.toLocaleLowerCase('en-US').includes(text);
  }).sort((a, b) => SOURCE_PRIORITY[a.source.kind] - SOURCE_PRIORITY[b.source.kind]
    || a.pluginId.localeCompare(b.pluginId)
    || semver.rcompare(a.distribution.version, b.distribution.version)
    || a.source.id.localeCompare(b.source.id));

  const seenPluginIds = new Set<string>();
  const items = filteredItems.filter((item) => {
    if (seenPluginIds.has(item.pluginId)) return false;
    seenPluginIds.add(item.pluginId);
    return true;
  });

  const identity = queryIdentity(query);
  const offset = decodeCursor(query.cursor, params.revision, identity);
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
