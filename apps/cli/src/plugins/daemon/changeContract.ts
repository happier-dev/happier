import { z } from 'zod';

export type AuthenticatedUserInteraction = Readonly<{
  kind: 'authenticatedLocalUser';
  interactionId: string;
  occurredAtMs: number;
}>;

type ExpectedMarketplaceListingBase = Readonly<{
  pluginId: string;
  publisher: Readonly<{ id: string; displayName: string }>;
  packageName: string;
  registryOrigin: string;
  registryProfileId?: string;
  version: string;
  integrity: string;
  manifestDigest: string;
}>;

export type ExpectedMarketplaceListing = ExpectedMarketplaceListingBase & (
  | Readonly<{
      source: Readonly<{ id: string; kind: 'curated'; sourceUrl: string }>;
      review: Readonly<{ status: 'approved'; reviewedAt: string; reason?: string | null }>;
      updatePolicy: 'automatic' | 'manual' | 'pinned';
    }>
  | Readonly<{
      source: Readonly<{ id: string; kind: 'community-npm'; sourceUrl: string }>;
      review: Readonly<{ status: 'unreviewed'; reviewedAt: null }>;
      updatePolicy: 'manual' | 'pinned';
    }>
);

export type PluginChangeRequest =
  | Readonly<{ kind: 'installPath'; locator: string; development: boolean; sdkRegistryOrigin?: string }>
  | Readonly<{ kind: 'installArchive'; locator: string; expectedIntegrity?: string }>
  | Readonly<{
      kind: 'installNpm';
      packageName: string;
      selector?: string;
      registryOrigin?: string;
      registryProfileId?: string;
      expectedMarketplaceListing?: ExpectedMarketplaceListing;
    }>
  | Readonly<{ kind: 'update'; pluginId: string }>
  | Readonly<{
      kind: 'development';
      pluginId: string;
      sourceRootPath: string;
      changedPaths?: readonly string[];
      sdkRegistryOrigin?: string;
    }>
  | Readonly<{ kind: 'enable' | 'disable' | 'rollback' | 'forgetTrust'; pluginId: string }>
  | Readonly<{ kind: 'uninstall'; pluginId: string; clearHealthHistory?: false }>
  | Readonly<{
      kind: 'uninstall';
      pluginId: string;
      clearHealthHistory: true;
      actorEvidence: AuthenticatedUserInteraction;
    }>;

export type PluginInstallationReview = Readonly<{
  pluginId: string;
  displayName: string;
  version: string;
  packageIdentity: Readonly<{
    name: string | null;
    version: string;
  }>;
  publisherIdentity:
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'unverified'; id: string; displayName: string }>;
  source: Readonly<{
    kind: 'path' | 'archive' | 'npm';
    locator: string;
    integrity?: string;
  }>;
  updateChannel:
    | Readonly<{ kind: 'path'; locator: string; development: boolean }>
    | Readonly<{ kind: 'archive'; locator: string }>
    | Readonly<{
        kind: 'npm';
        packageName: string;
        registryOrigin: string;
        registryProfileId?: string;
        marketplaceSource?: Readonly<{
          id: string;
          kind: 'curated' | 'community-npm';
          sourceUrl: string;
        }>;
      }>;
  integrity: Readonly<{
    packageDigest: string;
    manifestDigest: string;
    uiArtifactDigest: string;
  }>;
  signature:
    | Readonly<{ status: 'notProvided' }>
    | Readonly<{ status: 'verified' | 'unsupported'; keyId: string }>;
  provenance:
    | Readonly<{ status: 'notProvided' }>
    | Readonly<{ status: 'declaredUnverified'; predicateType: string }>
    | Readonly<{ status: 'retrievedUnverified'; predicateTypes: readonly string[] }>
    | Readonly<{ status: 'unavailable'; code: string }>;
  curation:
    | Readonly<{ status: 'notApplicable' }>
    | Readonly<{
        status: 'approved';
        sourceId: string;
        reviewedAt: string;
        reason?: string | null;
      }>
    | Readonly<{ status: 'unreviewed'; sourceId: string }>;
  executableRealms: readonly ('daemon' | 'reactNative')[];
  contributions: readonly Readonly<{ family: string; count: number }>[];
  uiArtifacts: Readonly<{
    status: 'verified' | 'none' | 'unavailable';
    contributionIds: readonly string[];
  }>;
  requiredHostAccess: readonly Readonly<{
    id: string;
    capability: string;
    reason: string;
    authorizationClass: 'cooperativeDisclosure' | 'hostResourceSelection' | 'presentIntentOrOs';
    normalizedScope: Readonly<Record<string, unknown>>;
  }>[];
  optionalHostAccess: readonly Readonly<{
    id: string;
    capability: string;
    reason: string;
    authorizationClass: 'hostResourceSelection';
    normalizedScope: Readonly<Record<string, unknown>>;
  }>[];
  compatibility: Readonly<{
    happier: string;
    runtimeApiVersion: 1;
  }>;
  updatePolicy: 'automatic' | 'manual' | 'pinned';
}>;

const ReviewNonEmptyStringSchema = z.string().trim().min(1).max(32_768);
const ReviewDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const ReviewStringListSchema = z.array(ReviewNonEmptyStringSchema).max(64)
  .refine((values) => new Set(values).size === values.length);

function isBoundedReviewJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 4_096;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 256
      && value.every((entry) => isBoundedReviewJsonValue(entry, depth + 1));
  }
  if (typeof value !== 'object' || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(([key, entry]) => (
    key.length <= 256 && isBoundedReviewJsonValue(entry, depth + 1)
  ));
}

const ReviewHostAccessBaseShape = {
  id: ReviewNonEmptyStringSchema,
  capability: ReviewNonEmptyStringSchema,
  reason: ReviewNonEmptyStringSchema,
  normalizedScope: z.record(z.string(), z.unknown()).refine(isBoundedReviewJsonValue),
} as const;

export const PluginInstallationReviewSchema: z.ZodType<PluginInstallationReview> = z.object({
  pluginId: ReviewNonEmptyStringSchema,
  displayName: ReviewNonEmptyStringSchema,
  version: ReviewNonEmptyStringSchema,
  packageIdentity: z.object({
    name: ReviewNonEmptyStringSchema.nullable(),
    version: ReviewNonEmptyStringSchema,
  }).strict(),
  publisherIdentity: z.union([
    z.object({ status: z.literal('unavailable') }).strict(),
    z.object({
      status: z.literal('unverified'),
      id: ReviewNonEmptyStringSchema,
      displayName: ReviewNonEmptyStringSchema,
    }).strict(),
  ]),
  source: z.object({
    kind: z.enum(['path', 'archive', 'npm']),
    locator: ReviewNonEmptyStringSchema,
    integrity: ReviewNonEmptyStringSchema.optional(),
  }).strict(),
  updateChannel: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('path'),
      locator: ReviewNonEmptyStringSchema,
      development: z.boolean(),
    }).strict(),
    z.object({
      kind: z.literal('archive'),
      locator: ReviewNonEmptyStringSchema,
    }).strict(),
    z.object({
      kind: z.literal('npm'),
      packageName: ReviewNonEmptyStringSchema,
      registryOrigin: ReviewNonEmptyStringSchema,
      registryProfileId: ReviewNonEmptyStringSchema.optional(),
      marketplaceSource: z.object({
        id: ReviewNonEmptyStringSchema,
        kind: z.enum(['curated', 'community-npm']),
        sourceUrl: ReviewNonEmptyStringSchema,
      }).strict().optional(),
    }).strict(),
  ]),
  integrity: z.object({
    packageDigest: ReviewDigestSchema,
    manifestDigest: ReviewDigestSchema,
    uiArtifactDigest: ReviewDigestSchema,
  }).strict(),
  signature: z.union([
    z.object({ status: z.literal('notProvided') }).strict(),
    z.object({
      status: z.enum(['verified', 'unsupported']),
      keyId: ReviewNonEmptyStringSchema,
    }).strict(),
  ]),
  provenance: z.union([
    z.object({ status: z.literal('notProvided') }).strict(),
    z.object({
      status: z.literal('declaredUnverified'),
      predicateType: ReviewNonEmptyStringSchema,
    }).strict(),
    z.object({
      status: z.literal('retrievedUnverified'),
      predicateTypes: ReviewStringListSchema.refine((values) => values.length > 0),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      code: ReviewNonEmptyStringSchema,
    }).strict(),
  ]),
  curation: z.union([
    z.object({ status: z.literal('notApplicable') }).strict(),
    z.object({
      status: z.literal('approved'),
      sourceId: ReviewNonEmptyStringSchema,
      reviewedAt: ReviewNonEmptyStringSchema,
      reason: ReviewNonEmptyStringSchema.nullable().optional(),
    }).strict(),
    z.object({
      status: z.literal('unreviewed'),
      sourceId: ReviewNonEmptyStringSchema,
    }).strict(),
  ]),
  executableRealms: z.array(z.enum(['daemon', 'reactNative'])).max(2)
    .refine((values) => new Set(values).size === values.length),
  contributions: z.array(z.object({
    family: ReviewNonEmptyStringSchema,
    count: z.number().int().positive().safe(),
  }).strict()).max(64).refine((values) => (
    new Set(values.map((entry) => entry.family)).size === values.length
  )),
  uiArtifacts: z.object({
    status: z.enum(['verified', 'none', 'unavailable']),
    contributionIds: ReviewStringListSchema,
  }).strict().refine((value) => (
    value.status === 'none'
      ? value.contributionIds.length === 0
      : value.contributionIds.length > 0
  )),
  requiredHostAccess: z.array(z.object({
    ...ReviewHostAccessBaseShape,
    authorizationClass: z.enum([
      'cooperativeDisclosure',
      'hostResourceSelection',
      'presentIntentOrOs',
    ]),
  }).strict()).max(128),
  optionalHostAccess: z.array(z.object({
    ...ReviewHostAccessBaseShape,
    authorizationClass: z.literal('hostResourceSelection'),
  }).strict()).max(128),
  compatibility: z.object({
    happier: ReviewNonEmptyStringSchema,
    runtimeApiVersion: z.literal(1),
  }).strict(),
  updatePolicy: z.enum(['automatic', 'manual', 'pinned']),
}).strict();

export type PluginResourceSelection = Readonly<{
  accessId: string;
  selected: boolean;
}>;

export type PluginChangePendingSurface =
  | 'reconciliation'
  | 'retirement'
  | 'cleanup'
  | 'temporaryCandidateCleanup';

export type PluginChangeSuccess = Readonly<{
  kind: 'committed';
  pluginId: string;
  desiredGeneration: string | null;
  appliedGeneration: string | null;
  pendingSurfaces: readonly PluginChangePendingSurface[];
}>;

export type PluginChangeApplyResult =
  | PluginChangeSuccess
  | Readonly<{ kind: 'unavailable'; code: string }>
  | Readonly<{ kind: 'conflict'; pluginId: string }>
  | Readonly<{ kind: 'failed'; code: string; message?: string }>
  | Readonly<{ kind: 'outcomeUnknown'; pluginId: string; expectedCandidate?: string }>;

export type PluginChangeRequestResult =
  | Readonly<{
      kind: 'reviewRequired';
      pendingChangeId: string;
      review: PluginInstallationReview;
    }>
  | PluginChangeApplyResult
  | Readonly<{ kind: 'busy'; pluginId: string }>;

export type PluginChangeDecision =
  | Readonly<{
      pendingChangeId: string;
      decision: 'installAndTrust';
      actorEvidence: AuthenticatedUserInteraction;
      optionalSelections?: readonly PluginResourceSelection[];
    }>
  | Readonly<{
      pendingChangeId: string;
      decision: 'cancel';
    }>;

export type PluginChangeDecisionResult =
  | PluginChangeApplyResult
  | Readonly<{ kind: 'cancelled' | 'expired' }>
  | Readonly<{ kind: 'busy'; pluginId: string }>;

export type PreparedDaemonPluginChange = Readonly<{
  pluginId: string;
  review?: PluginInstallationReview;
  requiresReview?: boolean;
  apply: (decision?: Readonly<{
    actorEvidence: AuthenticatedUserInteraction;
    optionalSelections: readonly PluginResourceSelection[];
  }>, control?: Readonly<{
    /** Releases same-plugin apply exclusivity after the serving lease is swapped. */
    onApplied: () => void;
  }>) => Promise<PluginChangeApplyResult>;
  cleanup: () => Promise<void>;
}>;
