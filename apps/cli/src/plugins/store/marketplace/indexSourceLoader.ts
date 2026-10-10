import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createMarketplaceNpmDiscoveryProjectionV1, deriveMarketplaceNpmCompatibilityPlatformsV1, MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1, MarketplaceIndexEntryV1Schema, MarketplaceIndexSourceSnapshotV1Schema, marketplaceNpmDiscoveryProjectionEqualV1 } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import type { MarketplaceIndexSourceKindV1, MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';
import { parseMarketplaceIndexSourceSnapshotV1, readMarketplaceNpmDiscoveryProjectionV1 } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';

import {
  assertRemoteAcquisitionUrl,
  openRemoteAcquisition,
  type RemoteAcquisitionAddressResolver,
  type RemoteAcquisitionDestinationPolicy,
} from '@/plugins/discovery/remote/acquisition';
import { readRemoteJsonResponseWithLimits, resolvePluginRemoteCatalogMaxBytes, resolvePluginRemoteFetchTimeoutMs } from '@/plugins/discovery/remote/fetch';
import { createNpmRegistryHttpsClient } from '@/plugins/distribution/npm/httpsClient';
import { normalizeNpmArtifactRequest } from '@/plugins/distribution/npm/normalize';
import { resolveNpmArtifactMetadata, type NpmRegistryJsonClient } from '@/plugins/distribution/npm/resolver';
import type { ResolvedNpmArtifact } from '@/plugins/distribution/npm/types';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { isNetworkConnectionErrorCode } from '@/api/client/classifyServerEndpointError';

/**
 * Community npm discovery is scoped to the plugin ecosystem keyword. It is
 * composed with the caller's search text rather than replaced by it, so a
 * user query narrows the ecosystem instead of leaving it.
 */
const COMMUNITY_NPM_ECOSYSTEM_QUALIFIER = 'keywords:happier-plugin';
/**
 * npm search serves one bounded snapshot per query. The merged marketplace
 * index owns paging across sources, so each cursor page is cut from the same
 * source snapshot instead of refetching a wider or differently offset result.
 * 100 matches the marketplace query owner's maximum processing page size;
 * npm's total and returned counts remain visible for continuation. It is not
 * a total catalog limit or an asserted npm transport ceiling.
 */
/**
 * npm ranks an exact package name first but still answers with neighbours, so
 * the parser keeps only the named package. Targeted and browsing requests
 * share the index owner's processing page; targeting still acquires at most
 * one package's metadata.
 */
const INDEX_SOURCE_ERROR_LABEL = 'Marketplace index source';
/**
 * A configured index source is a published catalog: it must be reachable over
 * HTTPS, stay on the origin the operator configured, and never resolve into a
 * private, loopback or reserved network. The shared acquisition owner enforces
 * all three and pins each hop to the addresses it assessed.
 */
const INDEX_SOURCE_ACQUISITION_POLICY: RemoteAcquisitionDestinationPolicy = Object.freeze({
  scheme: 'https',
  redirects: 'sameOrigin',
  privateNetwork: 'refuse',
});
const inFlight = new Map<string, Promise<MarketplaceIndexSourceSnapshotV1>>();

type CacheRecord = Readonly<{
  t: 'happier_marketplace_index_source_cache_v1';
  /** The configured source identity the snapshot belongs to. */
  sourceUrl: string;
  /**
   * The exact request that produced the snapshot. A slot file is shared by
   * every query of its slot kind, so a record is served — fresh, stale or
   * 304-revalidated — only when this equals the request being loaded.
   */
  requestUrl: string;
  fetchedAtMs: number;
  etag: string | null;
  lastModified: string | null;
  snapshot: MarketplaceIndexSourceSnapshotV1;
  communityNpmPage: CommunityNpmPage | null;
}>;

type CommunityNpmSearchCandidate = Readonly<{
  request: ReturnType<typeof normalizeNpmArtifactRequest>;
  publisher: Readonly<{ id: string; displayName: string }>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A configured source's title is editable local presentation metadata; it
 * never participates in matching a remote catalog to its binding. Serving
 * overlays the configured title so a local rename neither rejects the remote
 * document nor discards cached authority.
 */
function withConfiguredSourcePresentation(
  snapshot: MarketplaceIndexSourceSnapshotV1,
  sourceTitle: string,
): MarketplaceIndexSourceSnapshotV1 {
  return { ...snapshot, source: { ...snapshot.source, title: sourceTitle } };
}

function readCommunityNpmPublisher(candidate: Readonly<Record<string, unknown>>): CommunityNpmSearchCandidate['publisher'] | null {
  const publisher = candidate.publisher;
  if (!isRecord(publisher) || typeof publisher.username !== 'string') return null;
  const username = publisher.username.trim();
  return username ? { id: username, displayName: username } : null;
}

/**
 * The one query a marketplace source serves. A community npm source turns it
 * into exactly one search request; a published catalog document ignores it.
 *
 * `exactPackageName` targets the source at one package before any acquisition,
 * which is how an exact listing is re-resolved without scanning the bounded
 * discovery snapshot.
 */
export type MarketplaceIndexSourceQuery = Readonly<{
  text: string;
  exactPackageName?: string;
  from?: number;
  size?: number;
}>;

export type CommunityNpmPage = Readonly<{
  from: number;
  size: number;
  returned: number;
  total: number;
}>;

export type LoadedMarketplaceIndexSource = MarketplaceIndexSourceSnapshotV1 & Readonly<{
  communityNpmPage?: CommunityNpmPage;
}>;

/**
 * Builds the query-driven npm search request. The stable source URL stays the
 * identity of the community npm source; the query only shapes this one
 * request.
 */
export function buildCommunityNpmSearchUrl(sourceUrl: string, query?: MarketplaceIndexSourceQuery): string {
  const url = new URL(sourceUrl);
  const terms = [
    COMMUNITY_NPM_ECOSYSTEM_QUALIFIER,
    ...(query?.exactPackageName ? [query.exactPackageName] : []),
    ...(query?.exactPackageName ? [] : [(query?.text ?? '').trim()]),
  ].filter((term) => term.length > 0);
  url.searchParams.set('text', terms.join(' '));
  const size = query?.exactPackageName
    ? MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1
    : Math.max(1, Math.min(query?.size ?? MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1, MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1));
  const from = query?.exactPackageName ? 0 : Math.max(0, query?.from ?? 0);
  url.searchParams.set('from', String(from));
  url.searchParams.set('size', String(size));
  return url.toString();
}

export async function parseCommunityNpmDiscovery(
  raw: unknown,
  source: { id: string; title: string; sourceUrl: string; kind: 'community-npm' },
  dependencies: Readonly<{
    client: NpmRegistryJsonClient;
    metadataMaxBytes?: number | null;
    deadlineAtMonotonicMs?: number;
    signal?: AbortSignal;
    /** Upper bound of search candidates this query resolves metadata for. */
    maxCandidates?: number;
    /**
     * When the request targeted one package, only that package's search hit is
     * a candidate. npm ranks the exact name first but still returns neighbours,
     * and resolving metadata for them would be an untargeted scan.
     */
    exactPackageName?: string;
    from?: number;
    size?: number;
  }>,
): Promise<LoadedMarketplaceIndexSource> {
  const maxCandidates = Math.max(1, Math.min(dependencies.maxCandidates ?? MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1, MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1));
  const searchHits: readonly unknown[] = isRecord(raw) && Array.isArray(raw.objects) ? raw.objects : [];
  const total = isRecord(raw) && Number.isSafeInteger(raw.total) && Number(raw.total) >= 0
    ? Number(raw.total)
    : searchHits.length;
  const from = Math.max(0, dependencies.from ?? 0);
  const size = Math.max(1, Math.min(dependencies.size ?? maxCandidates, MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1));
  // A targeted request keeps only the named package, then the window bound
  // applies. Bounding first would let the neighbours npm returned ahead of the
  // exact hit push it out of the window.
  const objects = (dependencies.exactPackageName
    ? searchHits.filter((candidate) => (
      isRecord(candidate) && isRecord(candidate.package) && candidate.package.name === dependencies.exactPackageName
    ))
    : searchHits).slice(0, maxCandidates);

  const registryOrigin = new URL(source.sourceUrl).origin;
  const requests: CommunityNpmSearchCandidate[] = objects.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const pkg = candidate.package;
    if (!isRecord(pkg)) return [];
    const packageName = pkg.name;
    const version = pkg.version;
    const publisher = readCommunityNpmPublisher(pkg);
    if (typeof packageName !== 'string' || typeof version !== 'string') return [];
    if (!publisher) return [];
    try {
      const request = normalizeNpmArtifactRequest({
        packageName,
        selector: version,
        curatedExactOrigin: registryOrigin,
      });
      if (request.selector.kind !== 'exact' || request.selector.value !== version) return [];
      return [{ request, publisher }];
    } catch {
      return [];
    }
  });

  const entries: MarketplaceIndexSourceSnapshotV1['entries'] = [];
  let skippedMetadataCandidates = 0;
  let skippedUnsupportedDiscoveryVersions = 0;
  const resolved = await Promise.allSettled(requests.map(async (candidate) => ({
    artifact: await resolveNpmArtifactMetadata({
      request: candidate.request,
      client: dependencies.client,
      metadataMaxBytes: dependencies.metadataMaxBytes,
      deadlineAtMonotonicMs: dependencies.deadlineAtMonotonicMs,
      signal: dependencies.signal,
    }),
    publisher: candidate.publisher,
  })));
  dependencies.signal?.throwIfAborted();
  for (const result of resolved) {
    if (result.status === 'rejected') {
      skippedMetadataCandidates += 1;
      continue;
    }
    const outcome = parseCommunityNpmMetadataEntry(result.value.artifact, result.value.publisher);
    if (outcome.status === 'listed') {
      entries.push(outcome.entry);
    } else if (outcome.reason === 'unsupported-discovery-version') {
      skippedUnsupportedDiscoveryVersions += 1;
    } else {
      skippedMetadataCandidates += 1;
    }
  }

  const diagnostics: MarketplaceIndexSourceSnapshotV1['diagnostics'] = [];
  if (skippedMetadataCandidates > 0) {
    diagnostics.push({
      code: 'community_npm_metadata_skipped',
      message: `Skipped metadata for ${skippedMetadataCandidates} community npm package${skippedMetadataCandidates === 1 ? '' : 's'}.`,
    });
  }
  if (skippedUnsupportedDiscoveryVersions > 0) {
    diagnostics.push({
      code: 'community_npm_discovery_version_unsupported',
      message: `Skipped ${skippedUnsupportedDiscoveryVersions} community npm package${skippedUnsupportedDiscoveryVersions === 1 ? '' : 's'} publishing an unsupported marketplaceDiscovery version.`,
    });
  }

  const snapshot = MarketplaceIndexSourceSnapshotV1Schema.parse({
    source,
    freshness: { state: 'fresh', fetchedAtMs: null },
    entries,
    diagnostics,
  });
  return { ...snapshot, communityNpmPage: { from, size, returned: searchHits.length, total } };
}

type CommunityNpmMetadataEntryOutcome =
  | Readonly<{ status: 'listed'; entry: MarketplaceIndexSourceSnapshotV1['entries'][number] }>
  | Readonly<{ status: 'skipped'; reason: 'unsupported-discovery-version' | 'unusable-metadata' }>;

function parseCommunityNpmMetadataEntry(
  artifact: ResolvedNpmArtifact,
  publisher: Readonly<{ id: string; displayName: string }>,
): CommunityNpmMetadataEntryOutcome {
  const happier = artifact.versionMetadata.happier;
  if (!isRecord(happier)) return { status: 'skipped', reason: 'unusable-metadata' };
  // Forward-compatible reader admission: unknown additive fields are
  // normalized away, malformed or missing known fields skip the package, and
  // a newer projection version gets its own diagnostic reason.
  const discovery = readMarketplaceNpmDiscoveryProjectionV1(happier.marketplaceDiscovery);
  if (discovery.status === 'unsupported-version') return { status: 'skipped', reason: 'unsupported-discovery-version' };
  if (discovery.status !== 'parsed' || !artifact.compatibility?.projection) return { status: 'skipped', reason: 'unusable-metadata' };
  let expectedDiscovery;
  try {
    expectedDiscovery = createMarketplaceNpmDiscoveryProjectionV1({
      compatibility: artifact.compatibility.projection,
      manifestDigest: discovery.projection.manifestDigest,
    });
  } catch {
    return { status: 'skipped', reason: 'unusable-metadata' };
  }
  if (!marketplaceNpmDiscoveryProjectionEqualV1(discovery.projection, expectedDiscovery)) return { status: 'skipped', reason: 'unusable-metadata' };
  const happierRange = artifact.compatibility.projection.manifest.engines?.happier;
  const parsed = MarketplaceIndexEntryV1Schema.safeParse({
    pluginId: discovery.projection.pluginId,
    publisher,
    display: discovery.projection.display,
    distribution: {
      kind: 'npm',
      registryOrigin: artifact.registryOrigin,
      packageName: artifact.packageName,
      version: artifact.version,
      integrity: artifact.integrity,
    },
    manifestDigest: discovery.projection.manifestDigest,
    compatibility: {
      ...(happierRange === undefined ? {} : { happier: happierRange }),
      platforms: deriveMarketplaceNpmCompatibilityPlatformsV1(artifact.compatibility.projection),
    },
    summary: discovery.projection.summary,
    review: { status: 'unreviewed', reviewedAt: null },
    categories: [],
    media: [],
    updatePolicy: 'allowed',
    links: {},
  });
  if (!parsed.success) return { status: 'skipped', reason: 'unusable-metadata' };
  return { status: 'listed', entry: parsed.data };
}

/**
 * Cache slots are bounded by source, not by query: one replaceable discovery
 * slot per configured source, plus — only where the exact lookup's request
 * URL differs from every discovery request URL, which is true for community
 * npm — one exact-lookup slot. The file name derives from the configured
 * source URL because community npm request URLs embed arbitrary search text;
 * hashing those grew one unretired file per unique search. Query identity
 * lives in the record's `requestUrl`, which gates every serving path.
 */
type MarketplaceIndexSourceCacheSlot = 'discovery' | 'exact';

function sourceCachePath(happyHomeDir: string | undefined, sourceUrl: string, slot: MarketplaceIndexSourceCacheSlot): string {
  const paths = resolvePluginStorePaths({ happyHomeDir });
  const digest = createHash('sha256').update(sourceUrl).digest('hex');
  return resolve(paths.cacheDir, 'marketplace-index', slot === 'discovery' ? `${digest}.json` : `${digest}.exact.json`);
}

function validateSourceUrl(sourceUrl: string): string {
  return assertRemoteAcquisitionUrl(sourceUrl, INDEX_SOURCE_ACQUISITION_POLICY, INDEX_SOURCE_ERROR_LABEL).toString();
}

async function readCache(
  path: string,
  source: { id: string; title: string; kind: MarketplaceIndexSourceKindV1; sourceUrl: string },
  nowMs: number,
): Promise<Readonly<{ record: CacheRecord | null; corrupt: boolean }>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(raw)) return { record: null, corrupt: true };
    const record = raw as Partial<CacheRecord>;
    if (record.t !== 'happier_marketplace_index_source_cache_v1' || record.sourceUrl !== source.sourceUrl || typeof record.requestUrl !== 'string' || typeof record.fetchedAtMs !== 'number' || record.fetchedAtMs > nowMs) return { record: null, corrupt: true };
    const snapshot = MarketplaceIndexSourceSnapshotV1Schema.safeParse(record.snapshot);
    if (!snapshot.success) return { record: null, corrupt: true };
    if (snapshot.data.source.id !== source.id || snapshot.data.source.kind !== source.kind || snapshot.data.source.sourceUrl !== source.sourceUrl) return { record: null, corrupt: true };
    const page = isRecord(record.communityNpmPage)
      && Number.isSafeInteger(record.communityNpmPage.from)
      && Number.isSafeInteger(record.communityNpmPage.size)
      && Number.isSafeInteger(record.communityNpmPage.returned)
      && Number.isSafeInteger(record.communityNpmPage.total)
      ? record.communityNpmPage as CommunityNpmPage
      : null;
    return { record: { t: record.t, sourceUrl: source.sourceUrl, requestUrl: record.requestUrl, fetchedAtMs: record.fetchedAtMs, etag: typeof record.etag === 'string' ? record.etag : null, lastModified: typeof record.lastModified === 'string' ? record.lastModified : null, snapshot: snapshot.data, communityNpmPage: page }, corrupt: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null, corrupt: false };
    return { record: null, corrupt: true };
  }
}

function isOfflineRefreshError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (isNetworkConnectionErrorCode(code)) return true;
  return error instanceof Error && /\boffline\b|timed out|network connection/u.test(error.message);
}

export async function loadMarketplaceIndexSource(params: Readonly<{
  source: { id: string; title: string; sourceUrl: string; kind: MarketplaceIndexSourceKindV1 };
  happyHomeDir?: string;
  /** The discovery query; community npm search requests are built from it. */
  query?: MarketplaceIndexSourceQuery;
  now?: () => number;
  fetchImpl?: typeof fetch;
  resolveAddresses?: RemoteAcquisitionAddressResolver;
  communityNpmClient?: NpmRegistryJsonClient;
}>): Promise<LoadedMarketplaceIndexSource> {
  const sourceUrl = validateSourceUrl(params.source.sourceUrl);
  const requestUrl = params.source.kind === 'community-npm'
    ? validateSourceUrl(buildCommunityNpmSearchUrl(sourceUrl, params.query))
    : sourceUrl;
  // The exact lookup gets its own slot only where its request URL differs
  // structurally from discovery (community npm): one shared slot would let
  // every search evict the exact record and vice versa, turning each
  // alternating refresh into a full refetch. Catalog sources answer every
  // query from the same request URL, so they keep the single discovery slot.
  const exactLookupSlot = params.source.kind === 'community-npm' && Boolean(params.query?.exactPackageName);
  const cachePath = sourceCachePath(params.happyHomeDir, sourceUrl, exactLookupSlot ? 'exact' : 'discovery');
  // The slot path no longer distinguishes queries, so the request identity
  // joins the in-flight key: two concurrent searches for one source must
  // never merge into one fetch and hand one query's snapshot to the other.
  const key = `${cachePath}\u0000${requestUrl}\u0000${params.source.id}`;
  const existing = inFlight.get(key);
  if (existing) return await existing;
  const operation: Promise<MarketplaceIndexSourceSnapshotV1> = (async (): Promise<MarketplaceIndexSourceSnapshotV1> => {
    const now = params.now ?? Date.now;
    const cacheRead = await readCache(cachePath, { ...params.source, sourceUrl }, now());
    const cached = cacheRead.record;
    const revalidatable = cached?.requestUrl === requestUrl ? cached : null;
    try {
      const opened = await openRemoteAcquisition({
        url: requestUrl,
        headers: { accept: 'application/json', ...(revalidatable?.etag ? { 'if-none-match': revalidatable.etag } : {}), ...(revalidatable?.lastModified ? { 'if-modified-since': revalidatable.lastModified } : {}) },
        policy: INDEX_SOURCE_ACQUISITION_POLICY,
        timeoutMs: resolvePluginRemoteFetchTimeoutMs(),
        errorLabel: INDEX_SOURCE_ERROR_LABEL,
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
        ...(params.resolveAddresses ? { resolveAddresses: params.resolveAddresses } : {}),
      });
      try {
        const response = opened.response;
        if (response.status === 304 && revalidatable) {
          const snapshot: LoadedMarketplaceIndexSource = { ...withConfiguredSourcePresentation(revalidatable.snapshot, params.source.title), freshness: { state: 'fresh', fetchedAtMs: now() }, ...(revalidatable.communityNpmPage ? { communityNpmPage: revalidatable.communityNpmPage } : {}) };
          await writeJsonAtomic(cachePath, { ...revalidatable, fetchedAtMs: now(), snapshot } satisfies CacheRecord);
          return snapshot;
        }
        if (!response.ok) throw new Error(`Marketplace index source fetch failed with ${response.status}`);
        const body = await readRemoteJsonResponseWithLimits<unknown>({ response, signal: opened.signal, errorLabel: INDEX_SOURCE_ERROR_LABEL });
        let parsed: LoadedMarketplaceIndexSource;
        if (params.source.kind === 'community-npm') {
          const size = Number(new URL(requestUrl).searchParams.get('size'));
          parsed = await parseCommunityNpmDiscovery(body, { ...params.source, kind: 'community-npm' }, {
            client: params.communityNpmClient ?? createNpmRegistryHttpsClient({
              registryOrigin: new URL(sourceUrl).origin,
            }),
            metadataMaxBytes: resolvePluginRemoteCatalogMaxBytes(),
            signal: opened.signal,
            maxCandidates: Number.isSafeInteger(size) && size > 0 ? size : undefined,
            from: params.query?.from,
            size: Number.isSafeInteger(size) && size > 0 ? size : undefined,
            ...(params.query?.exactPackageName ? { exactPackageName: params.query.exactPackageName } : {}),
          });
        } else {
          parsed = parseMarketplaceIndexSourceSnapshotV1(body);
        }
        // Immutable identity decides the binding match; the editable local
        // title is overlaid as presentation metadata, never compared.
        if (parsed.source.id !== params.source.id || parsed.source.kind !== params.source.kind || parsed.source.sourceUrl !== sourceUrl) throw new Error('Marketplace index source identity does not match its configured binding');
        const { communityNpmPage = null, ...parsedSnapshot } = parsed;
        const boundSnapshot = withConfiguredSourcePresentation(parsedSnapshot, params.source.title);
        const snapshot: LoadedMarketplaceIndexSource = { ...boundSnapshot, freshness: { state: 'fresh', fetchedAtMs: now() }, ...(communityNpmPage ? { communityNpmPage } : {}) };
        await writeJsonAtomic(cachePath, { t: 'happier_marketplace_index_source_cache_v1', sourceUrl, requestUrl, fetchedAtMs: now(), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), snapshot: boundSnapshot, communityNpmPage } satisfies CacheRecord);
        return snapshot;
      } finally {
        await opened.dispose().catch(() => undefined);
      }
    } catch (error) {
      const message = projectPluginFailureText(error);
      // Stale bytes answer only the exact request that produced them: the
      // slot may hold another query's snapshot, and serving that as this
      // query's result would let one search masquerade as another.
      if (revalidatable && now() - revalidatable.fetchedAtMs >= 0) {
        return { ...withConfiguredSourcePresentation(revalidatable.snapshot, params.source.title), freshness: { state: isOfflineRefreshError(error) ? 'stale-offline' : 'stale', fetchedAtMs: revalidatable.fetchedAtMs, staleSinceMs: now() }, diagnostics: [...revalidatable.snapshot.diagnostics, { code: 'marketplace_source_refresh_failed', message }], ...(revalidatable.communityNpmPage ? { communityNpmPage: revalidatable.communityNpmPage } : {}) };
      }
      return {
        source: params.source,
        freshness: { state: cacheRead.corrupt ? 'corrupt' : 'unavailable', fetchedAtMs: null },
        entries: [],
        diagnostics: [{ code: cacheRead.corrupt ? 'marketplace_cache_corrupt' : 'marketplace_source_unavailable', message }],
      };
    }
  })();
  inFlight.set(key, operation);
  try { return await operation; } finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
}
