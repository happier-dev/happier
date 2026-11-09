import { isDeepStrictEqual } from 'node:util';

import { decideMarketplaceListingInstallV1, decideMarketplaceListingReviewV1, readMarketplaceListingRegistryProfileRequirementV1 } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import type { MarketplaceIndexItemV1, MarketplaceListingInstallBlockV1 } from '@happier-dev/protocol';

import { projectExpectedMarketplaceListing } from '@happier-dev/protocol/marketplace/internal';
import type { ExpectedMarketplaceListingV1 } from '@happier-dev/protocol/marketplace/internal';

import type { PluginRegistryProfileRequirement } from '@/plugins/daemon/changeContract';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';

import {
  createMarketplaceIndexService,
  type MarketplaceIndexSourceConfig,
} from './service';

// The commitment projector lives with its result type so the daemon's exact
// install path and the Temporary-computer creator that seals a reviewed
// external Agent cannot drift apart. Re-exported here because this module is
// the CLI's established import site for it.
export { projectExpectedMarketplaceListing };

/** The CLI's user-facing copy for each shared Protocol install block. */
function marketplaceInstallBlockMessage(block: MarketplaceListingInstallBlockV1): string {
  switch (block) {
    case 'unsupported-source-kind':
      return 'Only exact curated, user, or community npm listings can use this Install and trust action.';
    case 'curated-review-withdrawn':
      return 'This marketplace listing was withdrawn and cannot be installed.';
    case 'curated-review-not-approved':
      return 'This marketplace listing does not have a current approved review.';
    case 'full-review-unavailable':
      return 'This marketplace listing is not available for full review.';
    case 'source-not-fresh':
      return 'Fresh marketplace source facts are required before installation.';
    case 'artifact-unavailable':
      return 'The marketplace artifact requires a registry profile whose exact host binding is unavailable.';
  }
}

export function readMarketplaceInstallAvailability(item: MarketplaceIndexItemV1):
  | Readonly<{ ok: true; listing: MarketplaceIndexItemV1 }>
  | Readonly<{ ok: false; message: string }> {
  const decision = decideMarketplaceListingInstallV1(item);
  if (decision.installable) {
    return { ok: true, listing: item };
  }
  return { ok: false, message: marketplaceInstallBlockMessage(decision.block) };
}

export function marketplaceInstallUnavailableReason(item: MarketplaceIndexItemV1): string | null {
  const availability = readMarketplaceInstallAvailability(item);
  return availability.ok ? null : availability.message;
}


export type ExactMarketplaceListingResolution = Readonly<{
  source: MarketplaceIndexSourceConfig;
  listing: MarketplaceIndexItemV1;
  registryProfileId: string | null;
}>;

export function marketplaceListingMatchesExpected(
  expected: ExpectedMarketplaceListingV1,
  listing: MarketplaceIndexItemV1,
): boolean {
  if (!decideMarketplaceListingReviewV1(listing).installable) return false;
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
    /**
     * The package name of the listing the user acted on. It is untrusted
     * caller input used only to target the source before acquisition; every
     * fact installed afterwards comes from the source's own answer.
     */
    packageName?: string;
    /** The already reviewed release; omitted for latest-listing discovery. */
    version?: string;
    /** A sealed caller commitment uses this operation's admitted source facts. */
    expectedSourceBinding?: Pick<ExpectedMarketplaceListingV1, 'source' | 'registryProfileId'>;
  }>,
  serviceOverride?: Pick<ReturnType<typeof createMarketplaceIndexService>, 'queryExactListing'>,
): Promise<
  | Readonly<{ ok: true; resolution: ExactMarketplaceListingResolution }>
  | Readonly<{ ok: false; code: 'install_unavailable' | 'source_changed'; message: string }>
  | Readonly<{
      ok: false;
      code: 'registry_profile_required';
      message: string;
      requirement: PluginRegistryProfileRequirement;
    }>
> {
  const sourceId = params.sourceId.trim();
  const pluginId = params.pluginId.trim();
  if (!sourceId || !pluginId) {
    return { ok: false, code: 'install_unavailable', message: 'A persisted marketplace source identity and plugin ID are required.' };
  }

  const service = serviceOverride ?? createMarketplaceIndexService({ happyHomeDir: params.happyHomeDir });
  const exact = await service.queryExactListing({
    sourceId,
    pluginId,
    ...(params.packageName ? { packageName: params.packageName } : {}),
    ...(params.version !== undefined ? { version: params.version } : {}),
  });
  if (!exact.ok) {
    return exact;
  }
  const source = exact.source;
  const expectedSource = params.expectedSourceBinding;
  if (expectedSource && (source.origin !== expectedSource.source.kind
    || source.sourceUrl !== expectedSource.source.sourceUrl
    || (source.registryProfileId ?? undefined) !== expectedSource.registryProfileId)) {
    return { ok: false, code: 'source_changed', message: 'The exact marketplace source binding changed before installation.' };
  }
  const result = exact.result;

  const listing = result.items.find((item) => (
    item.pluginId === pluginId
    && item.source.id === source.id
    && item.source.sourceUrl === source.sourceUrl
    && (!params.packageName || item.distribution.packageName === params.packageName)
    && (params.version === undefined || item.distribution.version === params.version)
  )) ?? null;
  if (!listing) {
    return { ok: false, code: 'install_unavailable', message: `No installable exact marketplace listing was found for ${pluginId}.` };
  }
  const availability = readMarketplaceInstallAvailability(listing);
  if (!availability.ok) {
    // Only when artifact access is the one remaining block does a registry
    // selection make the listing installable; the Protocol rule owns that.
    const requirement = readMarketplaceListingRegistryProfileRequirementV1(
      listing,
      (await createNpmRegistryProfileService({ happyHomeDir: params.happyHomeDir }).snapshot()).profiles,
    );
    return requirement
      ? { ok: false, code: 'registry_profile_required', message: availability.message, requirement }
      : { ok: false, code: 'install_unavailable', message: availability.message };
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
