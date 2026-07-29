import { z } from 'zod';
import semver from 'semver';

import { PluginIdSchema } from '../plugins/pluginId.js';
import { NpmRegistryOriginV1Schema } from '../rpc/npmRegistryProfiles.js';

const BoundedText = z.string().trim().min(1).max(512);
const Identifier = z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
const OpaqueId = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const HttpsUrl = z.string().trim().max(2048).url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
}, 'Expected a credential-free HTTPS URL');
const ManifestDigest = z.string().trim().regex(/^sha256:[a-f0-9]{64}$/);
const NpmIntegrity = z.string().trim().regex(/^sha512-[A-Za-z0-9+/]{86}==$/, 'Expected a complete SHA-512 SRI value');
const ExactNpmVersion = z.string().trim().min(1).max(128)
  .refine((value) => semver.valid(value) === value, 'Expected an exact canonical npm semver version');

export const MarketplaceIndexSourceKindV1Schema = z.enum(['curated', 'user', 'community-npm']);
export type MarketplaceIndexSourceKindV1 = z.infer<typeof MarketplaceIndexSourceKindV1Schema>;

export const MarketplaceReviewStatusV1Schema = z.enum(['approved', 'withdrawn', 'blocked', 'unreviewed']);
export type MarketplaceReviewStatusV1 = z.infer<typeof MarketplaceReviewStatusV1Schema>;

export const MarketplaceIndexEntryV1Schema = z.object({
  pluginId: PluginIdSchema,
  publisher: z.object({ id: Identifier, displayName: BoundedText }).strict(),
  display: z.object({ title: BoundedText, description: z.string().trim().max(4_096).nullable() }).strict(),
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
    happier: z.string().trim().min(1).max(256),
    platforms: z.array(z.enum(['darwin', 'linux', 'windows', 'web', 'ios', 'android'])).max(6),
  }).strict(),
  summary: z.object({
    contributions: z.array(OpaqueId).max(64),
    requiredHostAccess: z.array(OpaqueId).max(64),
    optionalHostAccess: z.array(OpaqueId).max(64),
    executableRealms: z.array(z.enum(['daemon', 'client', 'hosted-web'])).max(3),
  }).strict(),
  review: z.object({
    status: MarketplaceReviewStatusV1Schema,
    reviewedAt: z.string().datetime().nullable(),
    reason: z.string().trim().min(1).max(1_024).nullable().optional(),
  }).strict(),
  categories: z.array(Identifier).max(32),
  media: z.array(HttpsUrl).max(16),
  updatePolicy: z.enum(['curated-auto', 'manual', 'pinned']),
  links: z.object({
    homepage: HttpsUrl.nullable().optional(),
    repository: HttpsUrl.nullable().optional(),
    support: HttpsUrl.nullable().optional(),
    universal: HttpsUrl.nullable().optional(),
  }).strict(),
}).strict();
export type MarketplaceIndexEntryV1 = z.infer<typeof MarketplaceIndexEntryV1Schema>;

export const MarketplaceIndexSourceSnapshotV1Schema = z.object({
  source: z.object({ id: OpaqueId, title: BoundedText, kind: MarketplaceIndexSourceKindV1Schema, sourceUrl: HttpsUrl }).strict(),
  freshness: z.object({
    state: z.enum(['fresh', 'stale', 'stale-offline', 'unavailable', 'auth-unavailable', 'corrupt']),
    fetchedAtMs: z.number().int().nonnegative().nullable(),
    staleSinceMs: z.number().int().nonnegative().optional(),
  }).strict(),
  entries: z.array(MarketplaceIndexEntryV1Schema).max(5_000),
  diagnostics: z.array(z.object({ code: Identifier, message: z.string().trim().min(1).max(2_048) }).strict()).max(128),
}).strict().superRefine((value, context) => {
  value.entries.forEach((entry, index) => {
    const invalid = value.source.kind === 'curated'
      ? entry.review.status === 'unreviewed'
      : entry.review.status !== 'unreviewed' || entry.updatePolicy === 'curated-auto';
    if (invalid) context.addIssue({ code: 'custom', path: ['entries', index, 'review', 'status'], message: 'Review status/update policy is not valid for this marketplace source kind' });
  });
});
export type MarketplaceIndexSourceSnapshotV1 = z.infer<typeof MarketplaceIndexSourceSnapshotV1Schema>;

export const MarketplaceIndexQueryV1Schema = z.object({
  text: z.string().trim().max(256).default(''),
  cursor: z.string().trim().min(1).max(256).nullable().default(null),
  limit: z.number().int().min(1).max(100).default(50),
  filters: z.object({
    categories: z.array(Identifier).max(16).optional(),
    platforms: z.array(z.enum(['darwin', 'linux', 'windows', 'web', 'ios', 'android'])).max(6).optional(),
    sourceKinds: z.array(MarketplaceIndexSourceKindV1Schema).max(3).optional(),
    sourceIds: z.array(OpaqueId).max(32).optional(),
    includeUnavailable: z.boolean().optional(),
  }).strict().default({}),
}).strict();
export type MarketplaceIndexQueryV1 = z.infer<typeof MarketplaceIndexQueryV1Schema>;

export const MarketplaceIndexAdmissionV1Schema = z.object({
  curatedInstall: z.enum(['allowed', 'refused', 'full-review']),
  curatedUpdate: z.enum(['allowed', 'refused', 'not-applicable']),
  warning: z.boolean(),
  mutatesInstalledTrust: z.literal(false),
  disablesInstalledCode: z.literal(false),
  directNpmRequiresFullReview: z.literal(true),
}).strict();
export type MarketplaceIndexAdmissionV1 = z.infer<typeof MarketplaceIndexAdmissionV1Schema>;

export const MarketplaceIndexItemV1Schema = MarketplaceIndexEntryV1Schema.extend({
  source: MarketplaceIndexSourceSnapshotV1Schema.shape.source,
  freshness: MarketplaceIndexSourceSnapshotV1Schema.shape.freshness,
  admission: MarketplaceIndexAdmissionV1Schema,
  artifactAccess: z.object({
    state: z.enum(['public', 'available', 'auth-unavailable', 'offline', 'source-removed', 'unverified-profile']),
    registryProfileId: OpaqueId.nullable(),
  }).strict(),
}).strict();
export type MarketplaceIndexItemV1 = z.infer<typeof MarketplaceIndexItemV1Schema>;

const MarketplaceDiagnosticV1Schema = z.object({ code: Identifier, message: z.string().trim().min(1).max(2_048) }).strict();
export const MarketplaceIndexQueryResultV1Schema = z.object({
  revision: z.number().int().nonnegative().safe(),
  items: z.array(MarketplaceIndexItemV1Schema).max(100),
  nextCursor: z.string().trim().min(1).max(256).nullable(),
  sources: z.array(z.object({
    source: MarketplaceIndexSourceSnapshotV1Schema.shape.source,
    freshness: MarketplaceIndexSourceSnapshotV1Schema.shape.freshness,
    diagnostics: z.array(MarketplaceDiagnosticV1Schema).max(128),
  }).strict()).max(65),
  diagnostics: z.array(MarketplaceDiagnosticV1Schema).max(128),
}).strict();
export type MarketplaceIndexQueryResultV1 = z.infer<typeof MarketplaceIndexQueryResultV1Schema>;
