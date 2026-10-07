import { z } from 'zod';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginUpdatePolicyV1Schema, type PluginUpdatePolicyV1 } from './pluginUpdatePolicyV1.js';
import {
  ConnectedAccountMaterializationRequestSchema,
  ConnectedAccountPurposeIdSchema,
  type ConnectedAccountMaterializationRequest,
} from '../connect/connectedAccountPurposes.js';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import {
  PluginRequestInterceptorContributionV1Schema,
  type PluginRequestInterceptorContributionV1,
} from '../plugins/requestInterceptors/v1.js';
import {
  VoiceCredentialAccessPhaseSchema,
  VoiceCredentialSlotIdSchema,
} from '../plugins/contributions/voiceProviders.js';
import { PluginJsonValueV2Schema, type PluginJsonValueV2 } from '../plugins/contributions/jsonSchema.js';
import {
  PluginDiagnosticStageV1Schema,
  PluginDiagnosticTextV1Schema,
} from '../daemon/pluginContributionIntrospection.js';

/**
 * The serialized installation-review and pending-change review facts a plugin
 * daemon hands to a present user through any Happier client.
 *
 * This is the one cross-process schema for that fact set. The daemon-side
 * projector (`projectPluginInstallationReview` in the CLI daemon change
 * preparers) emits values conforming to {@link PluginInstallationReviewSchema},
 * and every client — CLI control client and app UI — parses the exact same
 * schema, so the decision a human sees can never disagree with the candidate
 * the daemon staged.
 */

export const MAX_PLUGIN_INSTALLATION_REVIEW_STRING_LENGTH = 32_768;
const ReviewNonEmptyStringSchema = z.string().trim().min(1).max(MAX_PLUGIN_INSTALLATION_REVIEW_STRING_LENGTH);
const ReviewStringListSchema = z.array(ReviewNonEmptyStringSchema).max(64)
  .refine((values) => new Set(values).size === values.length);

/**
 * A compatibility diagnostic carried inside the review.
 *
 * Diagnostic codes are opaque bounded facts here: the closed producing-host
 * code vocabulary stays owned by that host's diagnostics schema, and the
 * review only promises that every rejected version explains itself with a
 * stable `code`/`message` pair.
 */
export const PluginInstallationReviewCompatibilityDiagnosticSchema = z.object({
  code: ReviewNonEmptyStringSchema,
  message: PluginDiagnosticTextV1Schema,
  contribution: asProtocolZod(PluginContributionIdentityV1Schema).optional(),
  details: PluginJsonValueV2Schema.optional(),
  stage: PluginDiagnosticStageV1Schema.optional(),
  /** Local-development realm only; see the host diagnostics source-location owner. */
  source: z.object({
    file: z.string().trim().min(1),
    line: z.number().int().positive().optional(),
    column: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  /** Local-development realm only: root-rebased, credential- and path-redacted. */
  stack: PluginDiagnosticTextV1Schema.optional(),
}).strict();
export type PluginInstallationReviewCompatibilityDiagnostic = z.infer<
  typeof PluginInstallationReviewCompatibilityDiagnosticSchema
>;

const ReviewBlockedNewerVersionSchema = z.object({
  version: ReviewNonEmptyStringSchema,
  diagnostics: z.array(PluginInstallationReviewCompatibilityDiagnosticSchema).min(1).max(4),
}).strict();

const HostPluginContributionIdentityV1Schema = asProtocolZod(
  PluginContributionIdentityV1Schema,
);

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

export const PluginInstallationReviewRawCredentialAccessSchema: z.ZodType<PluginInstallationReviewRawCredentialAccess> = z.object({
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

export const PluginInstallationReviewRequestInterceptorSchema: z.ZodType<PluginInstallationReviewRequestInterceptor> = (
  PluginRequestInterceptorContributionV1Schema.pick({
    id: true,
    origins: true,
    methods: true,
  }).extend({
    priority: z.number().int(),
  }).strict()
);

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
        kind: 'archive';
        locator: string;
        integrity: string;
        integrityBasis: 'observed' | 'expected';
      }>
    | Readonly<{
        kind: 'npm';
        locator: string;
        integrity: string;
        integrityBasis: 'expected';
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
          kind: 'curated' | 'community-npm' | 'user';
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
  executableRealms: readonly ('daemon' | 'reactNative' | 'hostedWeb')[];
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
      diagnostics: readonly PluginInstallationReviewCompatibilityDiagnostic[];
    }>[];
  }>;
  updatePolicy: PluginUpdatePolicyV1;
}>;

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
      integrity: ReviewNonEmptyStringSchema,
      integrityBasis: z.enum(['observed', 'expected']),
    }).strict(),
    z.object({
      kind: z.literal('npm'),
      locator: ReviewNonEmptyStringSchema,
      integrity: ReviewNonEmptyStringSchema,
      integrityBasis: z.literal('expected'),
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
        kind: z.enum(['curated', 'community-npm', 'user']),
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
  executableRealms: z.array(z.enum(['daemon', 'reactNative', 'hostedWeb'])).max(3)
    .refine((values) => new Set(values).size === values.length),
  contributions: z.array(z.object({
    family: ReviewNonEmptyStringSchema,
    count: z.number().int().positive().safe(),
  }).strict()).max(64).refine((values) => (
    new Set(values.map((entry) => entry.family)).size === values.length
  )),
  requestInterceptors: z.array(PluginInstallationReviewRequestInterceptorSchema),
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
  rawCredentialAccess: z.array(PluginInstallationReviewRawCredentialAccessSchema),
  compatibility: z.object({
    happier: ReviewNonEmptyStringSchema.optional(),
    runtimeApiVersion: z.literal(1),
    blockedNewerVersions: z.array(ReviewBlockedNewerVersionSchema).max(32).optional(),
  }).strict(),
  updatePolicy: PluginUpdatePolicyV1Schema,
}).strict();

/**
 * Authorization to evaluate executable code from a local development source
 * root, before any package is reviewed or committed.
 *
 * This is deliberately a separate decision from the installation review: the
 * user is being asked about a **filesystem location**, not about a package
 * identity, digests or host access — none of which exist yet, because the
 * daemon has not been allowed to read that root. The locator is the whole
 * security payload, so it is carried verbatim and shown verbatim.
 */
export type PluginDevelopmentProjectTrustReview = Readonly<{
  source: Readonly<{
    kind: 'path';
    locator: string;
  }>;
}>;

export const PluginDevelopmentProjectTrustReviewSchema: z.ZodType<PluginDevelopmentProjectTrustReview> = z.object({
  source: z.object({
    kind: z.literal('path'),
    locator: ReviewNonEmptyStringSchema,
  }).strict(),
}).strict();

/**
 * A daemon-issued change that is waiting on a present user, in the exactly two
 * shapes a present user can be asked about: trust this folder, or install and
 * trust this package.
 *
 * Every producer and consumer of a pending review — the daemon change service,
 * the CLI control client, and each client app's rejoin, listing, and
 * continuation paths — uses this one envelope, so the decision a screen offers
 * can never disagree with the stage the daemon is actually at.
 */
export const PluginChangePendingReviewResultSchema = z.union([
  z.object({
    kind: z.literal('reviewRequired'),
    reviewKind: z.literal('projectTrust'),
    pendingChangeId: z.string().trim().min(1).max(256),
    review: PluginDevelopmentProjectTrustReviewSchema,
  }).strict(),
  z.object({
    kind: z.literal('reviewRequired'),
    reviewKind: z.literal('installation'),
    pendingChangeId: z.string().trim().min(1).max(256),
    reason: z.enum(['firstInstall', 'authorityExpansion']),
    currentVersion: ReviewNonEmptyStringSchema.nullable(),
    authorityExpansion: z.array(z.enum([
      'requiredHostAccess',
      'selectedOptionalHostAccess',
      'connectedAccountPurpose',
      'requestInterceptor',
      'rawCredentialAccess',
    ])).max(5).refine((values) => new Set(values).size === values.length),
    review: PluginInstallationReviewSchema,
  }).strict(),
]);

export type PluginChangePendingReviewResult = z.infer<typeof PluginChangePendingReviewResultSchema>;
