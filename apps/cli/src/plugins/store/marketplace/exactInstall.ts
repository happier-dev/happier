import { isDeepStrictEqual } from 'node:util';

import type { MarketplaceIndexItemV1, MarketplaceIndexQueryResultV1 } from '@happier-dev/protocol';

import { requestUserPluginChange, type UserPluginChangeResult } from '@/plugins/daemon/changeClient';
import type { ExpectedMarketplaceListing } from '@/plugins/daemon/changeContract';

import {
  COMMUNITY_NPM_MARKETPLACE_SOURCE,
  createMarketplaceIndexService,
  type MarketplaceIndexSourceConfig,
} from './service';
import { createMarketplaceSourceRegistryStore } from './sources/store';

export function readMarketplaceInstallAvailability(item: MarketplaceIndexItemV1):
  | Readonly<{ ok: true; listing: MarketplaceIndexItemV1 }>
  | Readonly<{ ok: false; message: string }> {
  if (item.source.kind !== 'curated' && item.source.kind !== 'community-npm') {
    return { ok: false, message: 'Only exact curated or community npm listings can use this Install and trust action.' };
  }
  if (item.source.kind === 'curated' && (item.review.status !== 'approved' || item.review.reviewedAt === null)) {
    return { ok: false, message: item.review.status === 'withdrawn'
      ? 'This marketplace listing was withdrawn and cannot be installed.'
      : 'This marketplace listing does not have a current approved review.' };
  }
  if (item.source.kind === 'curated' && item.admission.curatedInstall !== 'allowed') {
    return { ok: false, message: 'This marketplace listing is not admitted for curated installation.' };
  }
  if (item.source.kind === 'community-npm'
    && (item.review.status !== 'unreviewed' || item.admission.curatedInstall !== 'full-review')) {
    return { ok: false, message: 'This community npm listing is not available for full review.' };
  }
  if (item.freshness.state !== 'fresh') {
    return { ok: false, message: 'Fresh marketplace source facts are required before installation.' };
  }
  if (item.artifactAccess.state !== 'public' && item.artifactAccess.state !== 'available') {
    return { ok: false, message: 'The marketplace artifact requires a registry profile whose exact host binding is unavailable.' };
  }
  return { ok: true, listing: item };
}

export function marketplaceInstallUnavailableReason(item: MarketplaceIndexItemV1): string | null {
  const availability = readMarketplaceInstallAvailability(item);
  return availability.ok ? null : availability.message;
}

export async function queryAllMarketplaceSourceItems(
  source: MarketplaceIndexSourceConfig,
  service: Pick<ReturnType<typeof createMarketplaceIndexService>, 'querySources'> = createMarketplaceIndexService(),
): Promise<MarketplaceIndexQueryResultV1> {
  const items: MarketplaceIndexItemV1[] = [];
  let cursor: string | null = null;
  let latest: MarketplaceIndexQueryResultV1 | null = null;
  do {
    latest = await service.querySources({ text: '', cursor, limit: 100, filters: { sourceIds: [source.id], includeUnavailable: true } }, [source]);
    items.push(...latest.items);
    cursor = latest.nextCursor;
  } while (cursor !== null);
  if (!latest) throw new Error('Marketplace index query returned no result');
  return { ...latest, items, nextCursor: null };
}

export type ExactMarketplaceListingResolution = Readonly<{
  source: MarketplaceIndexSourceConfig;
  listing: MarketplaceIndexItemV1;
  registryProfileId: string | null;
}>;

export function projectExpectedMarketplaceListing(
  listing: MarketplaceIndexItemV1,
  registryProfileId: string | null,
): ExpectedMarketplaceListing {
  return listing.source.kind === 'community-npm' ? {
    source: {
      id: listing.source.id,
      kind: 'community-npm',
      sourceUrl: listing.source.sourceUrl,
    },
    pluginId: listing.pluginId,
    publisher: listing.publisher,
    packageName: listing.distribution.packageName,
    registryOrigin: listing.distribution.registryOrigin,
    version: listing.distribution.version,
    integrity: listing.distribution.integrity,
    manifestDigest: listing.manifestDigest,
    review: { status: 'unreviewed', reviewedAt: null },
    updatePolicy: listing.updatePolicy === 'pinned' ? 'pinned' : 'manual',
  } : {
    source: {
      id: listing.source.id,
      kind: 'curated',
      sourceUrl: listing.source.sourceUrl,
    },
    pluginId: listing.pluginId,
    publisher: listing.publisher,
    packageName: listing.distribution.packageName,
    registryOrigin: listing.distribution.registryOrigin,
    ...(registryProfileId ? { registryProfileId } : {}),
    version: listing.distribution.version,
    integrity: listing.distribution.integrity,
    manifestDigest: listing.manifestDigest,
    review: {
      status: 'approved',
      reviewedAt: listing.review.reviewedAt!,
      ...(listing.review.reason !== undefined ? { reason: listing.review.reason } : {}),
    },
    updatePolicy: listing.updatePolicy === 'curated-auto' ? 'automatic' : listing.updatePolicy,
  };
}

export function marketplaceListingMatchesExpected(
  expected: ExpectedMarketplaceListing,
  listing: MarketplaceIndexItemV1,
): boolean {
  const registryProfileId = listing.artifactAccess.state === 'available'
    ? listing.artifactAccess.registryProfileId
    : null;
  return isDeepStrictEqual(projectExpectedMarketplaceListing(listing, registryProfileId), expected);
}

export async function resolveExactMarketplaceListingForInstall(
  params: Readonly<{
    happyHomeDir: string;
    sourceId: string;
    pluginId: string;
  }>,
  service?: Pick<ReturnType<typeof createMarketplaceIndexService>, 'querySources'>,
): Promise<
  | Readonly<{ ok: true; resolution: ExactMarketplaceListingResolution }>
  | Readonly<{ ok: false; code: 'install_unavailable' | 'source_changed'; message: string }>
> {
  const sourceId = params.sourceId.trim();
  const pluginId = params.pluginId.trim();
  if (!sourceId || !pluginId) {
    return { ok: false, code: 'install_unavailable', message: 'A persisted marketplace source identity and plugin ID are required.' };
  }

  const sourceRegistryStore = createMarketplaceSourceRegistryStore({ happyHomeDir: params.happyHomeDir });
  const registry = await sourceRegistryStore.read();
  const configuredSource = registry.sources.find((entry) => entry.id === sourceId) ?? null;
  const source: MarketplaceIndexSourceConfig | null = configuredSource
    ?? (sourceId === COMMUNITY_NPM_MARKETPLACE_SOURCE.id ? COMMUNITY_NPM_MARKETPLACE_SOURCE : null);
  if (!source || !source.enabled || (source.origin !== 'curated' && source.origin !== 'community-npm')) {
    return { ok: false, code: 'install_unavailable', message: 'No enabled exact marketplace source is configured for this Install and trust action.' };
  }

  let result: MarketplaceIndexQueryResultV1;
  try {
    result = await queryAllMarketplaceSourceItems(
      source,
      service ?? createMarketplaceIndexService({ happyHomeDir: params.happyHomeDir }),
    );
  } catch {
    return { ok: false, code: 'install_unavailable', message: 'The exact marketplace source facts are currently unavailable.' };
  }
  const currentSource = source.origin === 'community-npm'
    ? COMMUNITY_NPM_MARKETPLACE_SOURCE
    : (await sourceRegistryStore.read()).sources.find((entry) => entry.id === source.id) ?? null;
  if (!currentSource
    || !currentSource.enabled
    || currentSource.origin !== source.origin
    || currentSource.sourceUrl !== source.sourceUrl
    || (currentSource.registryProfileId ?? null) !== (source.registryProfileId ?? null)) {
    return { ok: false, code: 'source_changed', message: 'The persisted marketplace source binding changed while exact facts were loading.' };
  }

  const listing = result.items.find((item) => (
    item.pluginId === pluginId
    && item.source.id === source.id
    && item.source.sourceUrl === source.sourceUrl
  )) ?? null;
  if (!listing) {
    return { ok: false, code: 'install_unavailable', message: `No installable exact marketplace listing was found for ${pluginId}.` };
  }
  const availability = readMarketplaceInstallAvailability(listing);
  if (!availability.ok) {
    return { ok: false, code: 'install_unavailable', message: availability.message };
  }
  const approvedListing = availability.listing;
  const registryProfileId = approvedListing.artifactAccess.state === 'available'
    ? approvedListing.artifactAccess.registryProfileId
    : null;
  if ((source.registryProfileId ?? null) !== registryProfileId) {
    return { ok: false, code: 'source_changed', message: 'The exact private registry profile binding changed before installation.' };
  }
  return { ok: true, resolution: { source, listing: approvedListing, registryProfileId } };
}

export type ExactMarketplaceInstallResult =
  | Readonly<{
      ok: true;
      listing: MarketplaceIndexItemV1;
      change: UserPluginChangeResult;
    }>
  | Readonly<{
      ok: false;
      code: 'install_unavailable' | 'source_changed';
      message: string;
    }>;

export async function requestExactMarketplaceInstall(
  params: Readonly<{
    happyHomeDir: string;
    sourceId: string;
    pluginId: string;
    approval?: 'prompt' | 'none';
  }>,
  dependencies: Readonly<{
    marketplaceIndexService?: Pick<ReturnType<typeof createMarketplaceIndexService>, 'querySources'>;
    requestChange?: typeof requestUserPluginChange;
  }> = {},
): Promise<ExactMarketplaceInstallResult> {
  const resolution = await resolveExactMarketplaceListingForInstall({
    happyHomeDir: params.happyHomeDir,
    sourceId: params.sourceId,
    pluginId: params.pluginId,
  }, dependencies.marketplaceIndexService);
  if (!resolution.ok) {
    return { ok: false, code: resolution.code, message: resolution.message };
  }
  const { listing: approvedListing, registryProfileId } = resolution.resolution;

  const change = await (dependencies.requestChange ?? requestUserPluginChange)({
    request: {
      kind: 'installNpm',
      packageName: approvedListing.distribution.packageName,
      selector: approvedListing.distribution.version,
      registryOrigin: approvedListing.distribution.registryOrigin,
      ...(registryProfileId ? { registryProfileId } : {}),
      expectedMarketplaceListing: projectExpectedMarketplaceListing(approvedListing, registryProfileId),
    },
    approval: params.approval ?? 'none',
  });
  return { ok: true, listing: approvedListing, change };
}
