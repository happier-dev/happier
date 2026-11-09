import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { MachineAdminAccessObservationV1Schema } from '../machines/adminAccessV1.js';
import type { MachineDaemonRightsV1 } from '../machines/machineAuthorityV1.js';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginUpdatePolicyV1Schema, type PluginUpdatePolicyV1 } from './pluginUpdatePolicyV1.js';
import { MarketplaceIndexSourceKindV1Schema, type MarketplaceIndexSourceKindV1 } from './marketplaceIndexV1.js';
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

const ReviewNonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const ReviewStringListSchema = lazyZodSchema(() => z.array(ReviewNonEmptyStringSchema).check(z.refine((values) => new Set(values).size === values.length)));

/**
 * A compatibility diagnostic carried inside the review.
 *
 * Diagnostic codes are opaque bounded facts here: the closed producing-host
 * code vocabulary stays owned by that host's diagnostics schema, and the
 * review only promises that every rejected version explains itself with a
 * stable `code`/`message` pair.
 */
export const PluginInstallationReviewCompatibilityDiagnosticSchema = lazyZodSchema(() => z.strictObject({
  code: ReviewNonEmptyStringSchema,
  message: PluginDiagnosticTextV1Schema,
  contribution: zMini.optional(asProtocolZod(PluginContributionIdentityV1Schema)),
  details: zMini.optional(PluginJsonValueV2Schema),
  stage: zMini.optional(PluginDiagnosticStageV1Schema),
  /** Local-development realm only; see the host diagnostics source-location owner. */
  source: z.optional(z.strictObject({
    file: z.string().check(z.trim(), z.minLength(1)),
    line: z.optional(z.number().check(z.int(), z.positive())),
    column: z.optional(z.number().check(z.int(), z.nonnegative())),
  })),
  /** Local-development realm only: root-rebased, credential- and path-redacted. */
  stack: zMini.optional(PluginDiagnosticTextV1Schema),
}));
export type PluginInstallationReviewCompatibilityDiagnostic = z.infer<
  typeof PluginInstallationReviewCompatibilityDiagnosticSchema
>;

const ReviewBlockedNewerVersionSchema = lazyZodSchema(() => z.strictObject({
  version: ReviewNonEmptyStringSchema,
  diagnostics: z.array(PluginInstallationReviewCompatibilityDiagnosticSchema).check(z.minLength(1)),
}));

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

const ReviewRawCredentialSourceClassSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('savedSecret'),
    secretKinds: z.array(z.enum(['apiKey', 'token', 'password', 'other'])).check(z.minLength(1), z.maxLength(4), z.refine((values) => new Set(values).size === values.length)),
  }),
  z.strictObject({
    kind: z.literal('connectedAccount'),
    service: HostPluginContributionIdentityV1Schema,
  }),
]));

export const PluginInstallationReviewRawCredentialAccessSchema: z.ZodMiniType<PluginInstallationReviewRawCredentialAccess> = lazyZodSchema(() => z.strictObject({
  accessMode: z.literal('raw'),
  contribution: HostPluginContributionIdentityV1Schema,
  credentialSlot: z.strictObject({
    id: VoiceCredentialSlotIdSchema,
    title: ReviewNonEmptyStringSchema,
    purpose: ConnectedAccountPurposeIdSchema,
  }),
  sourceClass: ReviewRawCredentialSourceClassSchema,
  realm: z.enum(['web', 'ios', 'android', 'daemon']),
  phase: VoiceCredentialAccessPhaseSchema,
  request: ConnectedAccountMaterializationRequestSchema,
}));

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

export const PluginInstallationReviewRequestInterceptorSchema: z.ZodMiniType<PluginInstallationReviewRequestInterceptor> = (
  lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(zMini.pick(PluginRequestInterceptorContributionV1Schema, {
    id: true,
    origins: true,
    methods: true,
  }), {
    priority: z.number().check(z.int()),
  })))
);

export type PluginInstallationReview = Readonly<{
  /** Held daemon facts; no per-plugin probe. Missing historical facts remain unknown. */
  daemonRights?: MachineDaemonRightsV1;
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
          kind: MarketplaceIndexSourceKindV1;
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
     * Metadata-selection facts for versions newer than the staged
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

const ReviewHostAccessBaseShape = {
  id: ReviewNonEmptyStringSchema,
  capability: ReviewNonEmptyStringSchema,
  reason: ReviewNonEmptyStringSchema,
  normalizedScope: z.record(z.string(), PluginJsonValueV2Schema),
} as const;

export const PluginInstallationReviewSchema: z.ZodMiniType<PluginInstallationReview> = lazyZodSchema(() => z.strictObject({
  daemonRights: z.optional(z.strictObject({
    observation: z.nullable(MachineAdminAccessObservationV1Schema),
    freshness: z.enum(['current', 'stale']),
  })),
  pluginId: ReviewNonEmptyStringSchema,
  displayName: ReviewNonEmptyStringSchema,
  version: ReviewNonEmptyStringSchema,
  packageIdentity: z.strictObject({
    name: z.nullable(ReviewNonEmptyStringSchema),
    version: ReviewNonEmptyStringSchema,
  }),
  publisherIdentity: z.union([
    z.strictObject({ status: z.literal('unavailable') }),
    z.strictObject({
      status: z.literal('unverified'),
      id: ReviewNonEmptyStringSchema,
      displayName: ReviewNonEmptyStringSchema,
    }),
  ]),
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('path'),
      locator: ReviewNonEmptyStringSchema,
    }),
    z.strictObject({
      kind: z.literal('archive'),
      locator: ReviewNonEmptyStringSchema,
      integrity: ReviewNonEmptyStringSchema,
      integrityBasis: z.enum(['observed', 'expected']),
    }),
    z.strictObject({
      kind: z.literal('npm'),
      locator: ReviewNonEmptyStringSchema,
      integrity: ReviewNonEmptyStringSchema,
      integrityBasis: z.literal('expected'),
    }),
  ]),
  updateChannel: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('path'),
      locator: ReviewNonEmptyStringSchema,
      development: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('archive'),
      locator: ReviewNonEmptyStringSchema,
    }),
    z.strictObject({
      kind: z.literal('npm'),
      packageName: ReviewNonEmptyStringSchema,
      registryOrigin: ReviewNonEmptyStringSchema,
      registryProfileId: z.optional(ReviewNonEmptyStringSchema),
      marketplaceSource: z.optional(z.strictObject({
        id: ReviewNonEmptyStringSchema,
        kind: MarketplaceIndexSourceKindV1Schema,
        sourceUrl: ReviewNonEmptyStringSchema,
      })),
    }),
  ]),
  signature: z.union([
    z.strictObject({ status: z.literal('notProvided') }),
    z.strictObject({
      status: z.enum(['verified', 'unsupported']),
      keyId: ReviewNonEmptyStringSchema,
    }),
  ]),
  provenance: z.union([
    z.strictObject({ status: z.literal('notProvided') }),
    z.strictObject({
      status: z.literal('declaredUnverified'),
      predicateType: ReviewNonEmptyStringSchema,
    }),
    z.strictObject({
      status: z.literal('retrievedUnverified'),
      predicateTypes: ReviewStringListSchema.check(z.refine((values) => values.length > 0)),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      code: ReviewNonEmptyStringSchema,
    }),
  ]),
  curation: z.union([
    z.strictObject({ status: z.literal('notApplicable') }),
    z.strictObject({
      status: z.literal('approved'),
      sourceId: ReviewNonEmptyStringSchema,
      reviewedAt: ReviewNonEmptyStringSchema,
      reason: z.optional(z.nullable(ReviewNonEmptyStringSchema)),
    }),
    z.strictObject({
      status: z.literal('unreviewed'),
      sourceId: ReviewNonEmptyStringSchema,
    }),
  ]),
  executableRealms: z.array(z.enum(['daemon', 'reactNative', 'hostedWeb'])).check(z.maxLength(3), z.refine((values) => new Set(values).size === values.length)),
  contributions: z.array(z.strictObject({
    family: ReviewNonEmptyStringSchema,
    count: z.number().check(z.int(), z.positive(), z.int()),
  })).check(z.refine((values) => (
    new Set(values.map((entry) => entry.family)).size === values.length
  ))),
  requestInterceptors: z.array(PluginInstallationReviewRequestInterceptorSchema),
  uiArtifacts: z.strictObject({
    status: z.enum(['verified', 'none', 'unavailable']),
    contributionIds: ReviewStringListSchema,
  }).check(z.refine((value) => (
    value.status === 'none'
      ? value.contributionIds.length === 0
      : value.contributionIds.length > 0
  ))),
  requiredHostAccess: z.array(z.strictObject({
    ...ReviewHostAccessBaseShape,
    authorizationClass: z.enum([
      'cooperativeDisclosure',
      'hostResourceSelection',
      'presentIntentOrOs',
    ]),
  })),
  optionalHostAccess: z.array(z.strictObject({
    ...ReviewHostAccessBaseShape,
    authorizationClass: z.literal('hostResourceSelection'),
  })),
  rawCredentialAccess: z.array(PluginInstallationReviewRawCredentialAccessSchema),
  compatibility: z.strictObject({
    happier: z.optional(ReviewNonEmptyStringSchema),
    runtimeApiVersion: z.literal(1),
    blockedNewerVersions: z.optional(z.array(ReviewBlockedNewerVersionSchema)),
  }),
  updatePolicy: PluginUpdatePolicyV1Schema,
}));

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

export const PluginDevelopmentProjectTrustReviewSchema: z.ZodMiniType<PluginDevelopmentProjectTrustReview> = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({
    kind: z.literal('path'),
    locator: ReviewNonEmptyStringSchema,
  }),
}));

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
export const PluginChangePendingReviewResultSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('reviewRequired'),
    reviewKind: z.literal('projectTrust'),
    pendingChangeId: z.string().check(z.trim(), z.minLength(1)),
    review: PluginDevelopmentProjectTrustReviewSchema,
  }),
  z.strictObject({
    kind: z.literal('reviewRequired'),
    reviewKind: z.literal('installation'),
    pendingChangeId: z.string().check(z.trim(), z.minLength(1)),
    reason: z.enum(['firstInstall', 'authorityExpansion']),
    currentVersion: z.nullable(ReviewNonEmptyStringSchema),
    authorityExpansion: z.array(z.enum([
      'requiredHostAccess',
      'selectedOptionalHostAccess',
      'connectedAccountPurpose',
      'requestInterceptor',
      'rawCredentialAccess',
    ])).check(z.maxLength(5), z.refine((values) => new Set(values).size === values.length)),
    review: PluginInstallationReviewSchema,
  }),
]));

export type PluginChangePendingReviewResult = z.infer<typeof PluginChangePendingReviewResultSchema>;
