import { z } from 'zod';

import {
  ConnectedAccountMaterializationRequestSchema,
  ConnectedAccountPurposeIdSchema,
  PluginContributionIdentityV1Schema,
  PluginRequestInterceptorContributionV1Schema,
  VoiceCredentialAccessPhaseSchema,
  VoiceCredentialSlotIdSchema,
  type ConnectedAccountMaterializationRequest,
  type PluginRequestInterceptorContributionV1,
} from '@happier-dev/protocol';

import {
  PluginCompatibilityDiagnosticSchema,
  type PluginCompatibilityDiagnostic,
} from '@/plugins/validation/diagnostics/types';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const HostPluginContributionIdentityV1Schema = asHostProtocolZod(
  PluginContributionIdentityV1Schema,
);

export type PluginChangeActorProvenance = Readonly<{
  /** A present user supplied `happier plugins install --trust`. */
  kind: 'explicitCliTrustFlag';
  command: 'plugins install';
  flag: '--trust';
  source: Readonly<{
    kind: 'path';
    locator: string;
  }>;
  /** Available only after the daemon has identified the reviewed package. */
  pluginId?: string;
}>;

export type AuthenticatedUserInteraction = Readonly<{
  kind: 'authenticatedLocalUser';
  interactionId: string;
  occurredAtMs: number;
  provenance?: PluginChangeActorProvenance;
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
      pluginId?: string;
      sourceRootPath: string;
      changedPaths?: readonly string[];
      sdkRegistryOrigin?: string;
    }>
  | Readonly<{ kind: 'enable' | 'disable' | 'rollback' | 'forgetTrust'; pluginId: string }>
  | Readonly<{ kind: 'uninstall'; pluginId: string; allowAlreadyAbsent?: false }>
  | Readonly<{
      kind: 'uninstall';
      pluginId: string;
      allowAlreadyAbsent: true;
      actorEvidence: AuthenticatedUserInteraction;
    }>;

export type PluginInstallationReviewRawCredentialAccess = Readonly<{
  accessMode: 'raw';
  contribution: Readonly<{
    pluginId: string;
    localId: string;
  }>;
  credentialSlot: Readonly<{
    id: string;
    title: string;
    purpose: string;
  }>;
  sourceClass:
    | Readonly<{
        kind: 'savedSecret';
        secretKinds: readonly ('apiKey' | 'token' | 'password' | 'other')[];
      }>
    | Readonly<{
        kind: 'connectedAccount';
        service: Readonly<{
          pluginId: string;
          localId: string;
        }>;
      }>;
  realm: 'web' | 'ios' | 'android' | 'daemon';
  phase: 'settings' | 'prepare' | 'connection' | 'speech';
  request: ConnectedAccountMaterializationRequest;
}>;

type PluginInstallationReviewHttpMethod = NonNullable<
  PluginRequestInterceptorContributionV1['methods']
>[number];

/**
 * The semantic request-policy declaration a human reviews before trust. It
 * deliberately excludes author metadata and preserves the fetch-relevant id,
 * scope, and chain priority.
 */
export type PluginInstallationReviewRequestInterceptor = Readonly<{
  id: string;
  origins: readonly string[];
  methods?: readonly PluginInstallationReviewHttpMethod[];
  priority: number;
}>;

export function projectPluginInstallationReviewRequestInterceptor(
  contribution: PluginRequestInterceptorContributionV1,
): PluginInstallationReviewRequestInterceptor {
  return Object.freeze({
    id: contribution.id,
    origins: Object.freeze([...contribution.origins].sort()),
    ...(contribution.methods === undefined
      ? {}
      : { methods: Object.freeze([...contribution.methods].sort()) }),
    priority: contribution.priority ?? 0,
  });
}

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
  source:
    | Readonly<{
        kind: 'path';
        locator: string;
      }>
    | Readonly<{
        kind: 'archive' | 'npm';
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
  requestInterceptors: readonly PluginInstallationReviewRequestInterceptor[];
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
  /**
   * One fact for every declared Voice raw-credential grant. This review
   * projection carries no selected account, secret identity/material, grant
   * generation, or materialization response.
   */
  rawCredentialAccess: readonly PluginInstallationReviewRawCredentialAccess[];
  compatibility: Readonly<{
    happier?: string;
    runtimeApiVersion: 1;
    /**
     * Bounded metadata-selection facts for versions newer than the staged
     * candidate. They explain an intentional compatible fallback; they do not
     * make a second compatibility decision at the review boundary.
     */
    blockedNewerVersions?: readonly Readonly<{
      version: string;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>[];
  }>;
  updatePolicy: 'automatic' | 'manual' | 'pinned';
}>;

export type PluginDevelopmentSourceRootReview = Readonly<{
  source: Readonly<{
    kind: 'path';
    locator: string;
  }>;
}>;

export const MAX_PLUGIN_INSTALLATION_REVIEW_STRING_LENGTH = 32_768;
const ReviewNonEmptyStringSchema = z.string().trim().min(1).max(MAX_PLUGIN_INSTALLATION_REVIEW_STRING_LENGTH);
export const PluginDevelopmentSourceRootReviewSchema: z.ZodType<PluginDevelopmentSourceRootReview> = z.object({
  source: z.object({
    kind: z.literal('path'),
    locator: ReviewNonEmptyStringSchema,
  }).strict(),
}).strict();
const ReviewStringListSchema = z.array(ReviewNonEmptyStringSchema).max(64)
  .refine((values) => new Set(values).size === values.length);
const ReviewCompatibilityDiagnosticSchema = PluginCompatibilityDiagnosticSchema.extend({
  message: ReviewNonEmptyStringSchema,
});
const ReviewBlockedNewerVersionSchema = z.object({
  version: ReviewNonEmptyStringSchema,
  diagnostics: z.array(ReviewCompatibilityDiagnosticSchema).min(1).max(4),
}).strict();
const ReviewRawCredentialSourceClassSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('savedSecret'),
    secretKinds: z.array(z.enum(['apiKey', 'token', 'password', 'other'])).min(1).max(4)
      .refine((values) => new Set(values).size === values.length),
  }).strict(),
  z.object({
    kind: z.literal('connectedAccount'),
    service: HostPluginContributionIdentityV1Schema,
  }).strict(),
]);
const ReviewRawCredentialAccessSchema: z.ZodType<PluginInstallationReviewRawCredentialAccess> = z.object({
  accessMode: z.literal('raw'),
  contribution: HostPluginContributionIdentityV1Schema,
  credentialSlot: z.object({
    id: VoiceCredentialSlotIdSchema,
    title: ReviewNonEmptyStringSchema,
    purpose: ConnectedAccountPurposeIdSchema,
  }).strict(),
  sourceClass: ReviewRawCredentialSourceClassSchema,
  realm: z.enum(['web', 'ios', 'android', 'daemon']),
  phase: VoiceCredentialAccessPhaseSchema,
  request: ConnectedAccountMaterializationRequestSchema,
}).strict();
const ReviewRequestInterceptorSchema: z.ZodType<PluginInstallationReviewRequestInterceptor> = (
  PluginRequestInterceptorContributionV1Schema.pick({
    id: true,
    origins: true,
    methods: true,
  }).extend({
    priority: z.number().int(),
  }).strict()
);

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
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('path'),
      locator: ReviewNonEmptyStringSchema,
    }).strict(),
    z.object({
      kind: z.literal('archive'),
      locator: ReviewNonEmptyStringSchema,
      integrity: ReviewNonEmptyStringSchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('npm'),
      locator: ReviewNonEmptyStringSchema,
      integrity: ReviewNonEmptyStringSchema.optional(),
    }).strict(),
  ]),
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
  requestInterceptors: z.array(ReviewRequestInterceptorSchema),
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
  rawCredentialAccess: z.array(ReviewRawCredentialAccessSchema),
  compatibility: z.object({
    happier: ReviewNonEmptyStringSchema.optional(),
    runtimeApiVersion: z.literal(1),
    blockedNewerVersions: z.array(ReviewBlockedNewerVersionSchema).max(32).optional(),
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
      kind: 'sourceRootReviewRequired';
      pendingChangeId: string;
      review: PluginDevelopmentSourceRootReview;
    }>
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
      decision: 'trustSourceRoot';
      actorEvidence: AuthenticatedUserInteraction;
    }>
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
  | PluginChangeRequestResult
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'busy'; pluginId: string }>;

/**
 * A reconnect carries only the daemon-issued pending id. It never recreates a
 * candidate or supplies approval evidence.
 */
export type PluginChangeStatusRequest = Readonly<{
  pendingChangeId: string;
}>;

export type PluginChangePendingReviewResult = Extract<
  PluginChangeRequestResult,
  Readonly<{ kind: 'sourceRootReviewRequired' | 'reviewRequired' }>
>;

export type PluginChangeTerminalResult = Exclude<
  PluginChangeDecisionResult,
  PluginChangePendingReviewResult | Readonly<{ kind: 'expired' }>
>;

/**
 * One daemon-lifetime pending change, as enumerated for a present user.
 *
 * It is exactly the subset of {@link PluginChangeStatusResult} that is still
 * waiting on, or executing, a decision. A terminal or expired change is nobody's
 * outstanding decision and is therefore never listed. Enumeration exists because
 * a change an Agent prepared has no caller left to hand the issued id to: the
 * change owner is the only place that knows a present user still owes a
 * decision.
 */
export type PluginPendingChangeEntry =
  | PluginChangePendingReviewResult
  | Readonly<{
      kind: 'applying';
      pendingChangeId: string;
    }>;

export type PluginChangeListResult = Readonly<{
  changes: readonly PluginPendingChangeEntry[];
}>;

/**
 * Daemon-lifetime only rejoin projection. A new daemon has no claim over a
 * predecessor's in-memory candidates, so callers receive `expired` after a
 * restart rather than a synthetic recovery record.
 */
export type PluginChangeStatusResult =
  | PluginChangePendingReviewResult
  | Readonly<{
      kind: 'applying';
      pendingChangeId: string;
    }>
  | Readonly<{
      kind: 'terminal';
      pendingChangeId: string;
      result: PluginChangeTerminalResult;
    }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'daemonUnavailable' }>;

export type PreparedDaemonPluginChangeCandidate = Readonly<{
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

export type PreparedDaemonPluginSourceRootApproval = Readonly<{
  kind: 'sourceRootApprovalRequired';
  pendingKey: string;
  review: PluginDevelopmentSourceRootReview;
  continueAfterSourceRootApproval: (
    actorEvidence: AuthenticatedUserInteraction,
  ) => Promise<PreparedDaemonPluginChangeCandidate>;
  cleanup: () => Promise<void>;
}>;

export type PreparedDaemonPluginChange =
  | PreparedDaemonPluginChangeCandidate
  | PreparedDaemonPluginSourceRootApproval;
