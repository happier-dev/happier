import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import semver from 'semver';

import { PluginDiagnosticTextV1Schema } from '../daemon/pluginContributionIntrospection.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import type { PluginCompatibilityProjectionV1 } from '../plugins/availability/v1.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { PluginEnginesV2Schema } from '../plugins/manifest/v2.js';
import { NpmRegistryOriginV1Schema } from '../rpc/npmRegistryProfiles.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { PluginUpdatePolicyV1Schema } from './pluginUpdatePolicyV1.js';

const NonEmptyText = z.string().trim().min(1);
const Identifier = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/);
const OpaqueId = z.string().trim().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const HttpsUrl = z.string().trim().url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
}, 'Expected a credential-free HTTPS URL');
const ManifestDigest = z.string().trim().regex(/^sha256:[a-f0-9]{64}$/);
const NpmIntegrity = z.string().trim().regex(/^sha512-[A-Za-z0-9+/]{86}==$/, 'Expected a complete SHA-512 SRI value');
const ExactNpmVersion = z.string().trim().min(1)
  .refine((value) => semver.valid(value) === value, 'Expected an exact canonical npm semver version');
const MarketplaceDiagnosticV1Schema = lazyZodSchema(() => z.object({
  code: Identifier,
  message: PluginDiagnosticTextV1Schema,
}).strict());

export const MarketplaceIndexSourceKindV1Schema = lazyZodSchema(() => z.enum(['curated', 'user', 'community-npm']));
export type MarketplaceIndexSourceKindV1 = z.infer<typeof MarketplaceIndexSourceKindV1Schema>;

export const MarketplaceReviewStatusV1Schema = lazyZodSchema(() => z.enum(['approved', 'withdrawn', 'blocked', 'unreviewed']));
export type MarketplaceReviewStatusV1 = z.infer<typeof MarketplaceReviewStatusV1Schema>;

/**
 * Listing presentation and contribution-summary shapes shared by the
 * catalog entry and the npm discovery projection. Each owner chooses its own
 * unknown-key policy: canonical projections stay closed, while ingress readers
 * normalize additive presentation fields away before publishing those shapes.
 */
const ListingDisplayShapeV1 = {
  title: NonEmptyText,
  description: z.string().trim().nullable(),
};
const ListingSummaryShapeV1 = {
  contributions: z.array(OpaqueId),
  requiredHostAccess: z.array(OpaqueId),
  optionalHostAccess: z.array(OpaqueId),
  executableRealms: z.array(z.enum(['daemon', 'client', 'hosted-web'])),
};

export const MarketplaceIndexEntryV1Schema = lazyZodSchema(() => z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  publisher: z.object({ id: Identifier, displayName: NonEmptyText }).strict(),
  display: z.object(ListingDisplayShapeV1).strict(),
  distribution: z.object({
    kind: z.literal('npm'),
    registryOrigin: NpmRegistryOriginV1Schema,
    packageName: z.string().trim().min(1).max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
    version: ExactNpmVersion,
    integrity: NpmIntegrity,
    registryProfileId: OpaqueId.nullable().optional(),
  }).strict(),
  manifestDigest: ManifestDigest,
  compatibility: z.object({
    happier: PluginEnginesV2Schema.unwrap().shape.happier.unwrap().optional(),
    platforms: z.array(z.enum(['darwin', 'linux', 'windows', 'web', 'ios', 'android'])),
  }).strict(),
  summary: z.object(ListingSummaryShapeV1).strict(),
  review: z.object({
    status: MarketplaceReviewStatusV1Schema,
    reviewedAt: z.string().datetime().nullable(),
    reason: z.string().trim().min(1).nullable().optional(),
  }).strict(),
  categories: z.array(Identifier),
  media: z.array(HttpsUrl),
  /** The listing's declared update policy; see {@link PluginUpdatePolicyV1Schema}. */
  updatePolicy: PluginUpdatePolicyV1Schema,
  links: z.object({
    homepage: HttpsUrl.nullable().optional(),
    repository: HttpsUrl.nullable().optional(),
    support: HttpsUrl.nullable().optional(),
    universal: HttpsUrl.nullable().optional(),
  }).strict(),
}).strict());
export type MarketplaceIndexEntryV1 = z.infer<typeof MarketplaceIndexEntryV1Schema>;

/**
 * The generated, pre-install package metadata a community npm listing needs.
 * npm owns the selected package coordinate and SRI; compatibility remains in
 * its existing generated projection rather than being copied here.
 */
export const MarketplaceNpmDiscoveryProjectionV1Schema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  pluginId: asProtocolZod(PluginIdSchema),
  manifestDigest: ManifestDigest,
  display: z.object(ListingDisplayShapeV1).strict(),
  summary: z.object(ListingSummaryShapeV1).strict(),
}).strict());
export type MarketplaceNpmDiscoveryProjectionV1 = z.infer<typeof MarketplaceNpmDiscoveryProjectionV1Schema>;

/**
 * Reader-side admission for a published `happier.marketplaceDiscovery` fact.
 * It is forward-compatible for additive evolution only: unknown fields at the
 * top level and inside `display`/`summary` are admitted and normalized away,
 * every known V1 core field keeps its exact validation and remains required,
 * and a numeric projection version other than `1` is reported as unsupported
 * so callers can skip the package diagnostically. The canonical pack writer
 * keeps emitting the closed {@link MarketplaceNpmDiscoveryProjectionV1Schema}.
 */
const MarketplaceNpmDiscoveryProjectionReaderV1Schema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  pluginId: asProtocolZod(PluginIdSchema),
  manifestDigest: ManifestDigest,
  display: z.object(ListingDisplayShapeV1),
  summary: z.object(ListingSummaryShapeV1),
}));

export type MarketplaceNpmDiscoveryProjectionReadV1Result =
  | Readonly<{ status: 'parsed'; projection: MarketplaceNpmDiscoveryProjectionV1 }>
  | Readonly<{ status: 'unsupported-version' }>
  | Readonly<{ status: 'invalid' }>;

export function readMarketplaceNpmDiscoveryProjectionV1(value: unknown): MarketplaceNpmDiscoveryProjectionReadV1Result {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const version = (value as Readonly<Record<string, unknown>>).version;
    if (typeof version === 'number' && version !== 1) return { status: 'unsupported-version' };
  }
  const parsed = MarketplaceNpmDiscoveryProjectionReaderV1Schema.safeParse(value);
  return parsed.success
    ? { status: 'parsed', projection: parsed.data }
    : { status: 'invalid' };
}

function localizedFallback(value: string | Readonly<{ fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
}

function containsContributions(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((entry) => containsContributions(entry));
}

/**
 * One canonical listing projection from the compatibility evidence emitted by
 * pack/stage owners. This keeps package metadata from becoming an independent
 * manifest or compatibility authority.
 */
export function createMarketplaceNpmDiscoveryProjectionV1(input: Readonly<{
  compatibility: PluginCompatibilityProjectionV1;
  manifestDigest: string;
}>): MarketplaceNpmDiscoveryProjectionV1 {
  const { manifest, uiArtifacts } = input.compatibility;
  const executableRealms = new Set<'daemon' | 'client' | 'hosted-web'>();
  if (manifest.entrypoints?.daemon) executableRealms.add('daemon');
  for (const artifact of uiArtifacts.entries) {
    if (artifact.tier === 'reactNative') executableRealms.add('client');
    if (artifact.tier === 'hostedWeb') executableRealms.add('hosted-web');
  }
  const executableRealmOrder: readonly ('daemon' | 'client' | 'hosted-web')[] = [
    'daemon',
    'client',
    'hosted-web',
  ];
  return MarketplaceNpmDiscoveryProjectionV1Schema.parse({
    version: 1,
    pluginId: manifest.id,
    manifestDigest: input.manifestDigest,
    display: {
      title: localizedFallback(manifest.displayName),
      description: manifest.description === undefined ? null : localizedFallback(manifest.description),
    },
    summary: {
      contributions: Object.entries(manifest.contributes)
        .filter(([, declaration]) => containsContributions(declaration))
        .map(([family]) => family),
      requiredHostAccess: manifest.hostAccess.required.map((request) => request.id),
      optionalHostAccess: manifest.hostAccess.optional.map((request) => request.id),
      executableRealms: executableRealmOrder.filter((realm) => executableRealms.has(realm)),
    },
  });
}

/**
 * Equality of the normalized known V1 core: additive unknown fields are
 * normalized away before comparison, and any input the reader cannot admit —
 * malformed known fields, missing critical fields, or an unsupported
 * projection version — compares unequal instead of throwing.
 */
export function marketplaceNpmDiscoveryProjectionEqualV1(left: unknown, right: unknown): boolean {
  const leftRead = readMarketplaceNpmDiscoveryProjectionV1(left);
  const rightRead = readMarketplaceNpmDiscoveryProjectionV1(right);
  if (leftRead.status !== 'parsed' || rightRead.status !== 'parsed') return false;
  return createCanonicalJsonSigningInput(leftRead.projection)
    === createCanonicalJsonSigningInput(rightRead.projection);
}

/** Platform availability comes from the generated compatibility inventory, not npm search metadata. */
export function deriveMarketplaceNpmCompatibilityPlatformsV1(
  compatibility: PluginCompatibilityProjectionV1,
): readonly ('darwin' | 'linux' | 'windows' | 'web' | 'ios' | 'android')[] {
  const supported = new Set<'darwin' | 'linux' | 'windows' | 'web' | 'ios' | 'android'>();
  for (const artifact of compatibility.uiArtifacts.entries) {
    supported.add('web');
    if (artifact.tier === 'reactNative') {
      supported.add('ios');
      supported.add('android');
    }
  }
  const platformOrder: readonly ('darwin' | 'linux' | 'windows' | 'web' | 'ios' | 'android')[] = [
    'darwin',
    'linux',
    'windows',
    'web',
    'ios',
    'android',
  ];
  return platformOrder.filter((platform) => supported.has(platform));
}

export const MarketplaceIndexSourceSnapshotV1Schema = lazyZodSchema(() => z.object({
  source: z.object({ id: OpaqueId, title: NonEmptyText, kind: MarketplaceIndexSourceKindV1Schema, sourceUrl: HttpsUrl }).strict(),
  freshness: z.object({
    state: z.enum(['fresh', 'stale', 'stale-offline', 'unavailable', 'auth-unavailable', 'corrupt']),
    fetchedAtMs: z.number().int().nonnegative().nullable(),
    staleSinceMs: z.number().int().nonnegative().optional(),
  }).strict(),
  entries: z.array(MarketplaceIndexEntryV1Schema),
  diagnostics: z.array(MarketplaceDiagnosticV1Schema),
}).strict().superRefine((value, context) => {
  value.entries.forEach((entry, index) => {
    const invalid = value.source.kind === 'curated'
      ? entry.review.status === 'unreviewed'
      : entry.review.status !== 'unreviewed';
    if (invalid) context.addIssue({ code: 'custom', path: ['entries', index, 'review', 'status'], message: 'Review status/update policy is not valid for this marketplace source kind' });
  });
}));
export type MarketplaceIndexSourceSnapshotV1 = z.infer<typeof MarketplaceIndexSourceSnapshotV1Schema>;

/**
 * Catalog ingress drops only additive presentation in display, summary, and
 * links. Source/entry identity, publisher identity, distribution, compatibility,
 * review, freshness and diagnostic envelopes stay closed; known fields and the
 * source-kind review refinement keep the canonical writer's validation.
 * Unknown presentation never reaches cached snapshots or exact-install facts.
 */
const MarketplaceIndexSourceSnapshotReaderV1Schema = lazyZodSchema(() => MarketplaceIndexSourceSnapshotV1Schema.safeExtend({
  entries: z.array(MarketplaceIndexEntryV1Schema.extend({
    display: MarketplaceIndexEntryV1Schema.shape.display.strip(),
    summary: MarketplaceIndexEntryV1Schema.shape.summary.strip(),
    links: MarketplaceIndexEntryV1Schema.shape.links.strip(),
  })),
}));

export function parseMarketplaceIndexSourceSnapshotV1(value: unknown): MarketplaceIndexSourceSnapshotV1 {
  return MarketplaceIndexSourceSnapshotReaderV1Schema.parse(value);
}

/** A processing page, not a catalog capacity; continuation retains the rest. */
export const MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1 = 100;

export const MarketplaceIndexQueryV1Schema = lazyZodSchema(() => z.object({
  text: z.string().trim().default(''),
  cursor: z.string().trim().min(1).nullable().default(null),
  limit: z.number().int().min(1).max(MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1).default(50),
  filters: z.object({
    categories: z.array(Identifier).optional(),
    platforms: z.array(z.enum(['darwin', 'linux', 'windows', 'web', 'ios', 'android'])).optional(),
    sourceKinds: z.array(MarketplaceIndexSourceKindV1Schema).optional(),
    sourceIds: z.array(OpaqueId).optional(),
    /** Exact-listing lookup: one query resolves one source's listing by plugin id. */
    pluginIds: z.array(asProtocolZod(PluginIdSchema)).optional(),
    includeUnavailable: z.boolean().optional(),
  }).strict().default({}),
}).strict());
export type MarketplaceIndexQueryV1 = z.infer<typeof MarketplaceIndexQueryV1Schema>;

/**
 * The one admission projection for a listing.
 *
 * Curation recommends discovery; it is never hidden authorization for an
 * exact release. Every install — curated, user, or community npm — reaches
 * the full Install and Trust review, so `install` is the constant
 * `full-review` rather than an allow/refuse decision.
 */
export const MarketplaceIndexAdmissionV1Schema = lazyZodSchema(() => z.object({
  install: z.literal('full-review'),
  mutatesInstalledTrust: z.literal(false),
  disablesInstalledCode: z.literal(false),
  directNpmRequiresFullReview: z.literal(true),
}).strict());
export type MarketplaceIndexAdmissionV1 = z.infer<typeof MarketplaceIndexAdmissionV1Schema>;

export const MarketplaceIndexItemV1Schema = lazyZodSchema(() => MarketplaceIndexEntryV1Schema.extend({
  source: MarketplaceIndexSourceSnapshotV1Schema.shape.source,
  freshness: MarketplaceIndexSourceSnapshotV1Schema.shape.freshness,
  admission: MarketplaceIndexAdmissionV1Schema,
  artifactAccess: z.object({
    state: z.enum(['public', 'available', 'auth-unavailable', 'offline', 'source-removed', 'unverified-profile']),
    registryProfileId: OpaqueId.nullable(),
  }).strict(),
}).strict());
export type MarketplaceIndexItemV1 = z.infer<typeof MarketplaceIndexItemV1Schema>;

/**
 * Why an exact listing cannot be installed right now, decided in one order
 * for every consumer: an unintelligible source kind first, then the durable
 * trust/review facts, then the transient machine-reachability facts (source
 * freshness, then artifact access). Presentation layers map each block to
 * their own user-facing copy.
 */
export type MarketplaceListingInstallBlockV1 =
  | 'unsupported-source-kind'
  | 'curated-review-withdrawn'
  | 'curated-review-not-approved'
  | 'full-review-unavailable'
  | 'source-not-fresh'
  | 'artifact-unavailable';

export type MarketplaceListingInstallDecisionV1 =
  | Readonly<{ installable: true }>
  | Readonly<{ installable: false; block: MarketplaceListingInstallBlockV1 }>;

/**
 * The one installability decision for a marketplace listing, shared by the
 * CLI exact-install revalidation and the UI catalog projection. It refines
 * {@link MarketplaceIndexAdmissionV1} with the per-kind review facts: a
 * curated listing needs its current approved review, user and community npm
 * listings stay unreviewed on the constant full-review path, and an exact
 * install additionally requires fresh source facts and a reachable artifact.
 * This decides listing admission only — exact package/version/SRI/registry
 * verification stays with the daemon acquisition owner.
 */
export function decideMarketplaceListingInstallV1(item: MarketplaceIndexItemV1): MarketplaceListingInstallDecisionV1 {
  if (item.source.kind !== 'curated' && item.source.kind !== 'user' && item.source.kind !== 'community-npm') {
    return { installable: false, block: 'unsupported-source-kind' };
  }
  if (item.source.kind === 'curated') {
    if (item.review.status === 'withdrawn') {
      return { installable: false, block: 'curated-review-withdrawn' };
    }
    if (item.review.status !== 'approved' || item.review.reviewedAt === null) {
      return { installable: false, block: 'curated-review-not-approved' };
    }
  } else if (item.review.status !== 'unreviewed' || item.admission.install !== 'full-review') {
    return { installable: false, block: 'full-review-unavailable' };
  }
  if (item.freshness.state !== 'fresh') {
    return { installable: false, block: 'source-not-fresh' };
  }
  if (item.artifactAccess.state !== 'public' && item.artifactAccess.state !== 'available') {
    return { installable: false, block: 'artifact-unavailable' };
  }
  return { installable: true };
}

/**
 * The npm registry a listing's artifact is served by, when the Home that
 * installs it has no usable profile for that registry: none serves the origin,
 * the source binding names none or a removed one, or the bound profile must
 * sign in again. Registry authentication is always an explicit selection on
 * the installing Home, never inferred from anyone else's credentials.
 */
export const MarketplaceRegistryProfileRequirementV1Schema = lazyZodSchema(() => z.object({
  registryOrigin: NpmRegistryOriginV1Schema,
  packageName: MarketplaceIndexEntryV1Schema.shape.distribution.shape.packageName,
  /**
   * This Home's profile for that registry, when one exists — it may only need
   * signing in again. `null` when no profile on this Home is known to serve it.
   */
  registryProfileId: OpaqueId.nullable(),
}).strict());
export type MarketplaceRegistryProfileRequirementV1 = z.infer<typeof MarketplaceRegistryProfileRequirementV1Schema>;

/** The change-owner result that asks the present user for that registry selection. */
export const MarketplaceRegistryProfileRequiredResultV1Schema = lazyZodSchema(() => MarketplaceRegistryProfileRequirementV1Schema.extend({
  kind: z.literal('registryProfileRequired'),
}).strict());
export type MarketplaceRegistryProfileRequiredResultV1 = z.infer<typeof MarketplaceRegistryProfileRequiredResultV1Schema>;

/**
 * Reads the registry selection a listing's artifact access still needs, the
 * one rule shared by the daemon preparer, the exact-install resolver and the
 * Discover projection. An offline profile is reachability, not a selection, so
 * it is not a requirement. The named profile is the bound one when it only
 * needs signing in again, and otherwise this Home's profile for that origin
 * among `profiles`, if one exists, as the candidate the user may select.
 */
export function readMarketplaceRegistryProfileRequirementV1(params: Readonly<{
  artifactAccess: MarketplaceIndexItemV1['artifactAccess'];
  packageName: string;
  registryOrigin: string;
  profiles: readonly Readonly<{ profileId: string; origin: string }>[];
}>): MarketplaceRegistryProfileRequirementV1 | null {
  const { state, registryProfileId } = params.artifactAccess;
  if (state !== 'auth-unavailable' && state !== 'unverified-profile' && state !== 'source-removed') return null;
  const candidate = state === 'auth-unavailable'
    ? registryProfileId
    : params.profiles.find((profile) => profile.origin === params.registryOrigin)?.profileId ?? null;
  return {
    registryOrigin: params.registryOrigin,
    packageName: params.packageName,
    registryProfileId: candidate,
  };
}

/**
 * The profile a Home adds when it has none for the required registry: named
 * after the registry host and serving exactly the package's scope, or unscoped
 * packages when the package has none. It is a starting point the user may
 * edit, never a credential and never another Home's profile.
 */
export function draftMarketplaceRegistryProfileV1(requirement: Pick<
  MarketplaceRegistryProfileRequirementV1,
  'registryOrigin' | 'packageName'
>): Readonly<{
  displayName: string;
  origin: string;
  scopes: readonly string[];
  useAsDefault: boolean;
  allowPrivateNetwork: boolean;
}> {
  const scope = requirement.packageName.startsWith('@')
    ? requirement.packageName.slice(0, requirement.packageName.indexOf('/'))
    : null;
  return {
    displayName: new URL(requirement.registryOrigin).hostname,
    origin: requirement.registryOrigin,
    scopes: scope ? [scope] : [],
    useAsDefault: scope === null,
    allowPrivateNetwork: false,
  };
}

/**
 * The registry selection that would make an exact listing installable, or
 * `null`. Only when artifact access is the one remaining block does a
 * registry selection help; a durable review or freshness block stays a plain
 * refusal.
 */
export function readMarketplaceListingRegistryProfileRequirementV1(
  item: MarketplaceIndexItemV1,
  profiles: readonly Readonly<{ profileId: string; origin: string }>[],
): MarketplaceRegistryProfileRequirementV1 | null {
  const decision = decideMarketplaceListingInstallV1(item);
  if (decision.installable || decision.block !== 'artifact-unavailable') return null;
  return readMarketplaceRegistryProfileRequirementV1({
    artifactAccess: item.artifactAccess,
    packageName: item.distribution.packageName,
    registryOrigin: item.distribution.registryOrigin,
    profiles,
  });
}

export const MarketplaceIndexQueryResultV1Schema = lazyZodSchema(() => z.object({
  revision: z.number().int().nonnegative().safe(),
  items: z.array(MarketplaceIndexItemV1Schema).max(MARKETPLACE_INDEX_PAGE_MAX_SIZE_V1),
  nextCursor: z.string().trim().min(1).nullable(),
  sources: z.array(z.object({
    source: MarketplaceIndexSourceSnapshotV1Schema.shape.source,
    freshness: MarketplaceIndexSourceSnapshotV1Schema.shape.freshness,
    diagnostics: z.array(MarketplaceDiagnosticV1Schema),
  }).strict()),
  diagnostics: z.array(MarketplaceDiagnosticV1Schema),
}).strict());
export type MarketplaceIndexQueryResultV1 = z.infer<typeof MarketplaceIndexQueryResultV1Schema>;
