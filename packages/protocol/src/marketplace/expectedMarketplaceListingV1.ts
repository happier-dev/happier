import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { NpmRegistryProfileIdV1Schema } from '../rpc/npmRegistryProfiles.js';

import {
  MarketplaceIndexEntryV1Schema,
  MarketplaceIndexSourceSnapshotV1Schema,
  type MarketplaceIndexItemV1,
} from './marketplaceIndexV1.js';
import {
  PluginUpdatePolicyV1Schema,
} from './pluginUpdatePolicyV1.js';

const entry = MarketplaceIndexEntryV1Schema.shape;
const distribution = entry.distribution.shape;
const source = MarketplaceIndexSourceSnapshotV1Schema.shape.source.shape;

/** The one synthesized community npm source id; it is never a persisted row. */
export const COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 = 'marketplace:community-npm';

/**
 * The untrusted exact distribution facts a present user acted on when they
 * chose a listing. Every field is the corresponding marketplace index listing
 * fact, so the daemon revalidates the request against the freshly resolved
 * listing rather than against a second, drifting shape. The host-owned
 * registry profile binding is the one addition: it never comes from a catalog
 * document.
 */
const ExpectedMarketplaceListingBaseShape = {
  pluginId: entry.pluginId,
  publisher: entry.publisher,
  packageName: distribution.packageName,
  registryOrigin: distribution.registryOrigin,
  registryProfileId: NpmRegistryProfileIdV1Schema.optional(),
  version: distribution.version,
  integrity: distribution.integrity,
  manifestDigest: entry.manifestDigest,
} as const;

const ApprovedListingReviewV1Schema = lazyZodSchema(() => z.object({
  status: z.literal('approved'),
  reviewedAt: z.string().datetime(),
  reason: entry.review.shape.reason,
}).strict());

const UnreviewedListingReviewV1Schema = lazyZodSchema(() => z.object({
  status: z.literal('unreviewed'),
  reviewedAt: z.null(),
}).strict());

export const ExpectedMarketplaceListingV1Schema = lazyZodSchema(() => z.union([
  z.object({
    source: z.object({
      id: source.id,
      kind: z.literal('curated'),
      sourceUrl: source.sourceUrl,
    }).strict(),
    ...ExpectedMarketplaceListingBaseShape,
    review: ApprovedListingReviewV1Schema,
    updatePolicy: PluginUpdatePolicyV1Schema,
  }).strict(),
  z.object({
    source: z.object({
      id: z.literal(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1),
      kind: z.literal('community-npm'),
      sourceUrl: source.sourceUrl,
    }).strict(),
    ...ExpectedMarketplaceListingBaseShape,
    registryProfileId: z.undefined().optional(),
    review: UnreviewedListingReviewV1Schema,
    updatePolicy: PluginUpdatePolicyV1Schema,
  }).strict(),
  z.object({
    // A user-added catalog names its own source id and may bind a private
    // registry host, but its listings stay unreviewed: the first install still
    // goes through Install and Trust.
    source: z.object({
      id: source.id,
      kind: z.literal('user'),
      sourceUrl: source.sourceUrl,
    }).strict(),
    ...ExpectedMarketplaceListingBaseShape,
    review: UnreviewedListingReviewV1Schema,
    updatePolicy: PluginUpdatePolicyV1Schema,
  }).strict(),
]));
export type ExpectedMarketplaceListingV1 = z.infer<typeof ExpectedMarketplaceListingV1Schema>;

/**
 * Projects the one commitment every caller submits from the marketplace index
 * listing a present user acted on.
 *
 * It lives beside its result type because more than one program produces the
 * commitment — the daemon's own exact-install path and the Temporary-computer
 * creator that seals a reviewed external Agent into a Runner launch — and a
 * second projector would let those two disagree about what a listing commits
 * to. The caller supplies the host-owned registry profile binding, which never
 * comes from a catalog document.
 */
export function projectExpectedMarketplaceListing(
  listing: MarketplaceIndexItemV1,
  registryProfileId: string | null,
): ExpectedMarketplaceListingV1 {
  const distribution = {
    pluginId: listing.pluginId,
    publisher: listing.publisher,
    packageName: listing.distribution.packageName,
    registryOrigin: listing.distribution.registryOrigin,
    version: listing.distribution.version,
    integrity: listing.distribution.integrity,
    manifestDigest: listing.manifestDigest,
  } as const;
  if (listing.source.kind === 'curated') {
    return {
      source: { id: listing.source.id, kind: 'curated', sourceUrl: listing.source.sourceUrl },
      ...distribution,
      ...(registryProfileId ? { registryProfileId } : {}),
      review: {
        status: 'approved',
        reviewedAt: listing.review.reviewedAt!,
        ...(listing.review.reason !== undefined ? { reason: listing.review.reason } : {}),
      },
      updatePolicy: listing.updatePolicy,
    };
  }
  // The unreviewed listing's declared policy travels unchanged: first-install
  // trust comes from the mandatory Install and Trust review, not from
  // curation, so every declared policy — including `allowed` for later explicit
  // updates — is submitted exactly as published.
  const review = {
    review: { status: 'unreviewed', reviewedAt: null },
    updatePolicy: listing.updatePolicy,
  } as const;
  if (listing.source.kind === 'community-npm') {
    // Community npm is the one synthesized source, never a persisted row, so
    // it carries the constant id and no private registry binding.
    return {
      source: {
        id: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
        kind: 'community-npm',
        sourceUrl: listing.source.sourceUrl,
      },
      ...distribution,
      ...review,
    };
  }
  return {
    source: { id: listing.source.id, kind: 'user', sourceUrl: listing.source.sourceUrl },
    ...distribution,
    // The persisted host binding travels with every persisted source kind: a
    // user catalog can name a private registry just as a curated one can.
    ...(registryProfileId ? { registryProfileId } : {}),
    ...review,
  };
}
