import { z } from '../zodRuntimePolicy.js';

import { PluginCompatibilityProjectionV1Schema } from '../plugins/availability/compatibilityProjectionV1.js';
export { PUBLIC_NPM_REGISTRY_ORIGIN_V1 } from './marketplaceSourceRegistryV1.js';
import {
  createMarketplaceNpmDiscoveryProjectionV1,
  deriveMarketplaceNpmCompatibilityPlatformsV1,
  MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1,
  MarketplaceIndexEntryV1Schema,
  marketplaceNpmDiscoveryProjectionEqualV1,
  readMarketplaceNpmDiscoveryProjectionV1,
  marketplaceNpmContributionKeywordV1,
  type MarketplaceIndexEntryV1,
} from './marketplaceIndexV1.js';

function candidateSchema() {
  const distribution = MarketplaceIndexEntryV1Schema.shape.distribution.shape;
  return z.object({ name: distribution.packageName, version: distribution.version,
    publisher: z.object({ username: MarketplaceIndexEntryV1Schema.shape.publisher.shape.id }) });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function buildCommunityNpmSearchUrlV1(registryOrigin: string, query: Readonly<{
  text: string; exactPackageName?: string; contributionFamily?: string; from?: number; size?: number;
}>): string {
  const url = new URL('/-/v1/search', registryOrigin);
  url.searchParams.set('text', ['keywords:happier-plugin',
    ...(query.contributionFamily ? [`keywords:${marketplaceNpmContributionKeywordV1(query.contributionFamily)}`] : []),
    query.exactPackageName ?? query.text.trim()].filter(Boolean).join(' '));
  url.searchParams.set('from', String(query.exactPackageName ? 0 : Math.max(0, query.from ?? 0)));
  // Reuse the marketplace processing page, not a new total-catalog bound.
  url.searchParams.set('size', String(query.exactPackageName ? MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1
    : Math.max(1, Math.min(query.size ?? MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1, MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1))));
  return url.toString();
}

export function readCommunityNpmSearchV1(raw: unknown, window: Readonly<{
  exactPackageName?: string; from: number; size: number;
}>): Readonly<{
  candidates: readonly Readonly<{ packageName: string; version: string; publisher: { id: string; displayName: string } }>[];
  total: number;
}> {
  const objects: readonly unknown[] = record(raw) && Array.isArray(raw.objects) ? raw.objects : [];
  const total = record(raw) && Number.isSafeInteger(raw.total) && Number(raw.total) >= 0 ? Number(raw.total) : objects.length;
  const selected = (window.exactPackageName ? objects.filter(value => record(value) && record(value.package)
    && value.package.name === window.exactPackageName) : objects).slice(0, window.size);
  const candidate = candidateSchema();
  return { total, candidates: selected.flatMap(value => {
    const parsed = candidate.safeParse(record(value) ? value.package : null);
    return parsed.success ? [{ packageName: parsed.data.name, version: parsed.data.version,
      publisher: { id: parsed.data.publisher.username, displayName: parsed.data.publisher.username } }] : [];
  }) };
}

export function readCommunityNpmPackumentVersionV1(packument: unknown, input: Readonly<{
  packageName: string; version: string; registryOrigin: string;
}>): Readonly<{
  ok: true; versionMetadata: Readonly<Record<string, unknown>>; integrity: string; tarballUrl: string;
} | { ok: false; reason: 'identity_mismatch' | 'dist_invalid' }> {
  if (!record(packument) || packument.name !== input.packageName || !record(packument.versions)) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  const metadata = packument.versions[input.version];
  if (!record(metadata) || metadata.name !== input.packageName || metadata.version !== input.version) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  const dist = metadata.dist;
  if (!record(dist) || typeof dist.integrity !== 'string' || !dist.integrity.trim() || typeof dist.tarball !== 'string') {
    return { ok: false, reason: 'dist_invalid' };
  }
  try {
    const url = new URL(dist.tarball);
    if (url.protocol !== 'https:' || url.origin !== input.registryOrigin || url.username || url.password) {
      return { ok: false, reason: 'dist_invalid' };
    }
    return { ok: true, versionMetadata: metadata, integrity: dist.integrity.trim(), tarballUrl: url.toString() };
  } catch { return { ok: false, reason: 'dist_invalid' }; }
}

export function projectCommunityNpmListingV1(input: Readonly<{
  versionMetadata: Readonly<Record<string, unknown>>; packageName: string; version: string;
  integrity: string; registryOrigin: string; publisher: { id: string; displayName: string };
}>): Readonly<{ status: 'listed'; entry: MarketplaceIndexEntryV1 }
  | { status: 'skipped'; reason: 'unsupported-discovery-version' | 'unusable-metadata' }> {
  const happier = input.versionMetadata.happier;
  if (!record(happier)) return { status: 'skipped', reason: 'unusable-metadata' };
  const discovery = readMarketplaceNpmDiscoveryProjectionV1(happier.marketplaceDiscovery);
  if (discovery.status === 'unsupported-version') return { status: 'skipped', reason: 'unsupported-discovery-version' };
  const compatibility = PluginCompatibilityProjectionV1Schema.safeParse(happier.compatibilityProjection);
  if (discovery.status !== 'parsed' || !compatibility.success) return { status: 'skipped', reason: 'unusable-metadata' };
  let expected;
  try { expected = createMarketplaceNpmDiscoveryProjectionV1({ compatibility: compatibility.data,
    manifestDigest: discovery.projection.manifestDigest }); }
  catch { return { status: 'skipped', reason: 'unusable-metadata' }; }
  if (!marketplaceNpmDiscoveryProjectionEqualV1(discovery.projection, expected)) return { status: 'skipped', reason: 'unusable-metadata' };
  const happierRange = compatibility.data.manifest.engines?.happier;
  const parsed = MarketplaceIndexEntryV1Schema.safeParse({
    pluginId: discovery.projection.pluginId, publisher: input.publisher, display: discovery.projection.display,
    distribution: { kind: 'npm', registryOrigin: input.registryOrigin, packageName: input.packageName,
      version: input.version, integrity: input.integrity },
    manifestDigest: discovery.projection.manifestDigest,
    compatibility: { ...(happierRange === undefined ? {} : { happier: happierRange }),
      platforms: deriveMarketplaceNpmCompatibilityPlatformsV1(compatibility.data) },
    summary: discovery.projection.summary, review: { status: 'unreviewed', reviewedAt: null },
    categories: [], media: [], updatePolicy: 'allowed', links: {},
  });
  return parsed.success ? { status: 'listed', entry: parsed.data } : { status: 'skipped', reason: 'unusable-metadata' };
}
