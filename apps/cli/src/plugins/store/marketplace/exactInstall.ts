import type { MarketplaceIndexItemV1, MarketplaceIndexQueryResultV1 } from '@happier-dev/protocol';

import { requestUserPluginChange, type UserPluginChangeResult } from '@/plugins/daemon/changeClient';

import {
  COMMUNITY_NPM_MARKETPLACE_SOURCE,
  createMarketplaceIndexService,
  type MarketplaceIndexSourceConfig,
} from './service';
import { createMarketplaceSourceRegistryStore } from './sources/store';

function readMarketplaceInstallAvailability(item: MarketplaceIndexItemV1):
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

export type ExactMarketplaceInstallResult =
  | Readonly<{
      ok: true;
      listing: MarketplaceIndexItemV1;
      change: UserPluginChangeResult;
    }>
  | Readonly<{
      ok: false;
      code: 'install_unavailable';
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
      dependencies.marketplaceIndexService ?? createMarketplaceIndexService({ happyHomeDir: params.happyHomeDir }),
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
    return { ok: false, code: 'install_unavailable', message: 'The persisted marketplace source binding changed while exact facts were loading.' };
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
    return { ok: false, code: 'install_unavailable', message: 'The exact private registry profile binding changed before installation.' };
  }

  const change = await (dependencies.requestChange ?? requestUserPluginChange)({
    request: {
      kind: 'installNpm',
      packageName: approvedListing.distribution.packageName,
      selector: approvedListing.distribution.version,
      registryOrigin: approvedListing.distribution.registryOrigin,
      ...(registryProfileId ? { registryProfileId } : {}),
      expectedMarketplaceListing: approvedListing.source.kind === 'community-npm' ? {
        source: {
          id: approvedListing.source.id,
          kind: 'community-npm',
          sourceUrl: approvedListing.source.sourceUrl,
        },
        pluginId: approvedListing.pluginId,
        publisher: approvedListing.publisher,
        packageName: approvedListing.distribution.packageName,
        registryOrigin: approvedListing.distribution.registryOrigin,
        version: approvedListing.distribution.version,
        integrity: approvedListing.distribution.integrity,
        manifestDigest: approvedListing.manifestDigest,
        review: { status: 'unreviewed', reviewedAt: null },
        updatePolicy: approvedListing.updatePolicy === 'pinned' ? 'pinned' : 'manual',
      } : {
        source: {
          id: approvedListing.source.id,
          kind: 'curated',
          sourceUrl: approvedListing.source.sourceUrl,
        },
        pluginId: approvedListing.pluginId,
        publisher: approvedListing.publisher,
        packageName: approvedListing.distribution.packageName,
        registryOrigin: approvedListing.distribution.registryOrigin,
        ...(registryProfileId ? { registryProfileId } : {}),
        version: approvedListing.distribution.version,
        integrity: approvedListing.distribution.integrity,
        manifestDigest: approvedListing.manifestDigest,
        review: {
          status: 'approved' as const,
          reviewedAt: approvedListing.review.reviewedAt!,
          ...(approvedListing.review.reason !== undefined ? { reason: approvedListing.review.reason } : {}),
        },
        updatePolicy: approvedListing.updatePolicy === 'curated-auto' ? 'automatic' : approvedListing.updatePolicy,
      },
    },
    approval: params.approval ?? 'none',
  });
  return { ok: true, listing: approvedListing, change };
}
