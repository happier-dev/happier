import { z } from 'zod/mini';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema, ProviderMachineIdSchema, ProviderModelIdSchema } from '../providers/ids.js';
import { BackendTargetKeyV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { CustomProviderTemplateV1Schema } from '../providers/connections/customTemplateV1.js';
import {
  ProviderClaudeHelperModelsV1Schema,
  ProviderConnectionPurposeBindingDefaultsV1Schema,
  ProviderEndpointOverrideV1Schema,
  ProviderGatewayPlacementV1Schema,
} from '../providers/connections/v1.js';
import { ProviderErrorV1Schema } from '../providers/errors.js';
import {
  ProviderConnectionSecurityFingerprintV1Schema,
  ProviderCompatibilityFingerprintV1Schema,
  ProviderProbeObservationIdentityV1Schema,
  ProviderProbeRequestFingerprintV1Schema,
} from '../providers/fingerprints.js';
import { ProviderBrokerApplicationBindingV1Schema } from '../providers/brokerRouteGrantV1.js';
import { ProviderCredentialTransportV1Schema } from '../providers/credentials/v1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../providers/endpointUrlSchema.js';
import { ProviderPublicHeadersV1Schema } from '../providers/publicHeadersSchema.js';
import { ProviderEndpointPolicyV1Shape } from '../providers/endpointPolicyV1.js';
import { ProviderModelDescriptorV1Schema } from '../models/descriptor.js';
import {
  ProviderConnectionSummaryHealthV1Schema,
  ProviderEndpointHealthStatusV1Schema,
  ProviderModelLoadStateV1Schema,
} from '../providers/runtimeState/v1.js';
import {
  ProviderBindingCompatibilityV1Schema,
  ProviderCompatibilityReasonCodeV1Schema,
} from '../providers/compatibility/v1.js';
import { ModelVisibilityRefV1Schema, ProviderBoundModelRefSchema, serializeModelVisibilityRefV1 } from '../providers/selection/v1.js';
import { SessionModelSelectionV1Schema } from '../providers/selection/v1.js';
import { SessionProviderBindingMetadataV1Schema } from '../providers/sessions/bindingMetadataV1.js';
import {
  PROVIDER_WIRE_PROTOCOL_LIMITS_V1,
  ProviderWireProtocolSchema,
} from '../providers/capabilities/v1.js';
import { PROVIDER_CATALOG_LIMITS_V1 } from '../providers/catalog/limits.js';
import { ProviderCatalogProbeModelsV1Schema } from '../providers/catalog/merge.js';
import { QualifiedConnectedAccountPurposeBindingV1Schema, QualifiedConnectedAccountPurposeBindingTargetV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { PROVIDER_SETTINGS_LIMITS_V1, ProviderManualModelInputV1Schema } from '../providers/settings/v1.js';
import {
  ProviderDiscoveryCandidateIdV1Schema,
  ProviderDiscoveryCandidateV1Schema,
  ProviderLocalInstallationSummaryV1Schema,
} from '../providers/detection/v1.js';
import { ProviderHttpsUrlSchema } from '../providers/httpsUrlSchema.js';
import { ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema } from '../providers/contributions/v1.js';
import { LegacyProfileReviewedMappingV1Schema } from '../providers/migrations/legacyProfilesV1.js';
import { LegacyProfileMigrationConflictResolutionV1Schema } from '../providers/migrations/conflictsV1.js';
import { ProfileRecordV1Schema } from '../profiles/profileRecordSchemaV1.js';
import { LegacyProfileRecordPreparationDiagnosticV1Schema } from '../profiles/read.js';
import { ProviderMigrationSourceProfileIdSchema } from '../providers/settings/v1.js';
import { ConnectedServiceIdSchema } from '../connect/connectedServiceBindings.js';
import {
  ConnectedAccountPurposeIdSchema,
  PluginConnectedAccountMaterializationKindsSchema,
} from '../connect/connectedAccountPurposes.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { TeamCredentialSourceBindingV1Schema } from '../teams/credentials/sourceBindingV1.js';
import { TeamCredentialResourceTestApplicationRequestV1Schema } from '../teams/credentials/externalProviderApiV1.js';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '../teams/credentials/resourceV1.js';
import { ProviderModelBindingSourceV1Schema, ProviderModelConfirmationSourceV1Schema, ProviderModelConfirmationSourceKeyV1Schema } from '../providers/compatibility/sourceFacts.js';

const ProviderRpcIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  machineId: ProviderMachineIdSchema,
}));

export const DaemonProviderDraftProbeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('draft'),
  draftConnectionId: ProviderConnectionIdSchema,
  machineId: ProviderMachineIdSchema,
  template: CustomProviderTemplateV1Schema,
  savedSecretId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  actionNonce: z.string().check(z.trim(), z.minLength(16), z.maxLength(256)),
}).check(z.superRefine((value, ctx) => {
  if ((value.template.credential === undefined && value.savedSecretId !== null)
    || (value.template.credential?.required === true && value.savedSecretId === null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['savedSecretId'],
      message: 'Draft SavedSecret identity must match the template credential contract',
    });
  }
})));
export type DaemonProviderDraftProbeRequestV1 = z.infer<typeof DaemonProviderDraftProbeRequestV1Schema>;

export const DaemonProviderProbeRequestV1Schema = lazyZodSchema(() => z.union([
  ProviderRpcIdentityV1Schema,
  DaemonProviderDraftProbeRequestV1Schema,
]));
export type DaemonProviderProbeRequestV1 = z.infer<typeof DaemonProviderProbeRequestV1Schema>;

export const DaemonProviderModelsRequestV1Schema = ProviderRpcIdentityV1Schema;
export type DaemonProviderModelsRequestV1 = z.infer<typeof DaemonProviderModelsRequestV1Schema>;

/**
 * Server-to-broker-Machine request for the daemon-owned, deterministic test
 * candidate. The public Action carries only resource identity; current source
 * and revision are pinned here so stale daemon work fails closed.
 */
export const DaemonProviderTeamCredentialResourceTestCandidateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ProviderMachineIdSchema,
  teamId: z.string().check(z.minLength(1), z.maxLength(256)),
  resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  source: TeamCredentialSourceBindingV1Schema,
  /** Pool fanout reads current source observations without scheduling work on
   * every candidate Machine. Exact-Machine Tests retain their normal demand. */
  refreshPolicy: z.optional(z.literal('current_only')),
}));
export type DaemonProviderTeamCredentialResourceTestCandidateRequestV1 = z.infer<
  typeof DaemonProviderTeamCredentialResourceTestCandidateRequestV1Schema
>;

export const DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    application: ProviderBrokerApplicationBindingV1Schema,
    request: TeamCredentialResourceTestApplicationRequestV1Schema,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['source_unavailable', 'application_unavailable', 'model_unavailable']),
  }),
]));
export type DaemonProviderTeamCredentialResourceTestCandidateResponseV1 = z.infer<
  typeof DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema
>;

/** One Machine-local, side-effect-free source/application eligibility check.
 * The Home fans this exact operation across its verified Pool snapshot and
 * retains the Machine-id association; the response discloses no settings,
 * credentials, endpoint details, model catalog, or application bytes. */
const DaemonProviderTeamCredentialBrokerEligibilityRequestBaseV1Schema = lazyZodSchema(() => z.object({
  machineId: ProviderMachineIdSchema,
  teamId: z.string().check(z.minLength(1), z.maxLength(256)),
  resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  source: TeamCredentialSourceBindingV1Schema,
}));

export const DaemonProviderTeamCredentialBrokerEligibilityRequestV1Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderTeamCredentialBrokerEligibilityRequestBaseV1Schema, {
    application: ProviderBrokerApplicationBindingV1Schema,
    modelId: ProviderModelIdSchema,
    sourceRevision: z.string().check(z.minLength(1), z.maxLength(512)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderTeamCredentialBrokerEligibilityRequestBaseV1Schema, {
    scope: z.literal('source_any'),
  })),
]));
export type DaemonProviderTeamCredentialBrokerEligibilityRequestV1 = z.infer<
  typeof DaemonProviderTeamCredentialBrokerEligibilityRequestV1Schema
>;

export const DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('eligible') }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['source_unavailable', 'application_unavailable', 'model_unavailable', 'source_changed']),
  }),
]));
export type DaemonProviderTeamCredentialBrokerEligibilityResponseV1 = z.infer<
  typeof DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema
>;

const DaemonProviderModelLoadIdentityV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderRpcIdentityV1Schema, {
  modelId: ProviderModelIdSchema,
})));

export const DaemonProviderModelLoadRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderModelLoadIdentityV1Schema, { action: z.literal('load') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderModelLoadIdentityV1Schema, { action: z.literal('cancel') })),
]));
export type DaemonProviderModelLoadRequestV1 = z.infer<typeof DaemonProviderModelLoadRequestV1Schema>;

export const DaemonProviderRpcErrorV1Schema = ProviderErrorV1Schema;

export const DaemonProviderModelRowV1Schema = lazyZodSchema(() => z.strictObject({
  id: ProviderModelIdSchema,
  name: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  source: z.enum(['manual', 'static', 'probe']),
  stale: z.boolean(),
  loadState: z.enum(['loaded', 'unloaded', 'unknown']),
  visibility: z.enum(['visible', 'hidden_all_agents']),
}));
export type DaemonProviderModelRowV1 = z.infer<typeof DaemonProviderModelRowV1Schema>;

export const DaemonProviderModelsResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    connectionId: ProviderConnectionIdSchema,
    connectionRevision: z.number().check(z.int(), z.nonnegative()),
    manualModelPolicy: z.enum(['allowed', 'catalog-only']),
    modelLoadAction: z.enum(['available', 'descriptor_absent', 'feature_disabled', 'machine_required']),
    models: z.array(DaemonProviderModelRowV1Schema).check(z.maxLength(50_000)),
  }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderModelsResponseV1 = z.infer<typeof DaemonProviderModelsResponseV1Schema>;

export const DaemonProviderProbeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    models: ProviderCatalogProbeModelsV1Schema,
    requestFingerprint: ProviderProbeRequestFingerprintV1Schema,
  }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
  z.strictObject({ status: z.literal('not_supported') }),
]));
export type DaemonProviderProbeResponseV1 = z.infer<typeof DaemonProviderProbeResponseV1Schema>;

export const DaemonProviderModelLoadResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('loaded'), source: z.enum(['already_loaded', 'requested']) }),
  z.strictObject({ status: z.literal('not_supported'), reason: z.enum(['feature_disabled', 'descriptor_absent']) }),
  z.strictObject({ status: z.literal('cancelled'), providerMayContinue: z.literal(true) }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderModelLoadResponseV1 = z.infer<typeof DaemonProviderModelLoadResponseV1Schema>;

const ProviderAuthoringEndpointOverridesV1Schema = lazyZodSchema(() => z.array(ProviderEndpointOverrideV1Schema).check(z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration), z.superRefine((overrides, ctx) => {
    const endpointIds = new Set<string>();
    overrides.forEach((override, index) => {
      if (endpointIds.has(override.endpointTemplateId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'endpointTemplateId'],
          message: 'Duplicate endpoint override',
        });
      }
      endpointIds.add(override.endpointTemplateId);
    });
  })));

export const DaemonProviderConnectionsDescribeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ProviderMachineIdSchema,
  connectionId: z.optional(ProviderConnectionIdSchema),
  authoringPreview: z.optional(z.strictObject({
    connectionId: ProviderConnectionIdSchema,
    contributionKey: ProviderContributionKeySchema,
    displayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    selectedCandidateId: z.nullable(ProviderDiscoveryCandidateIdV1Schema),
    endpointOverrides: z.optional(ProviderAuthoringEndpointOverridesV1Schema),
  })),
}));
export type DaemonProviderConnectionsDescribeRequestV1 = z.infer<typeof DaemonProviderConnectionsDescribeRequestV1Schema>;

const ProviderConnectionRpcRuntimeSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  health: ProviderConnectionSummaryHealthV1Schema,
  // Process custody and peer reachability are separate from endpoint probe health.
  gateway: z.optional(z.strictObject({
    status: z.enum(['not_checked', 'idle', 'running']),
    reachability: z.enum(['not_checked', 'reachable', 'unreachable']),
  })),
  modelCount: z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(50_000))),
  checkedAt: z.nullable(z.number().check(z.nonnegative())),
  endpoints: z._default(z.array(z.strictObject({
    endpointTemplateId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    status: ProviderEndpointHealthStatusV1Schema,
    activity: z.enum(['idle', 'checking']),
    observedAt: z.nullable(z.number().check(z.nonnegative())),
    errorCode: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    retryAt: z.nullable(z.number().check(z.nonnegative())),
  })).check(z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)), []),
}));

const ProviderRpcDisplayEndpointUrlV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048), z.superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: 'custom', message: 'Endpoint display URL must omit credentials, query, and fragment' });
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Endpoint display URL must be absolute' });
  }
})));

const DaemonProviderAuthoringEndpointV1Schema = lazyZodSchema(() => z.strictObject({
  endpointTemplateId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  protocol: ProviderWireProtocolSchema,
  normalizedUrl: ProviderRpcDisplayEndpointUrlV1Schema,
  locality: z.enum(['public', 'private', 'loopback', 'unknown']),
  scope: z.enum(['account', 'machine']),
}));

const DaemonProviderAuthoringDestinationV1Schema = lazyZodSchema(() => z.strictObject({
  scope: z.enum(['account', 'machine']),
  machineId: z.nullable(ProviderMachineIdSchema),
  endpoints: z.array(DaemonProviderAuthoringEndpointV1Schema).check(z.minLength(1), z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)),
}).check(z.superRefine((value, ctx) => {
  if ((value.scope === 'machine') !== (value.machineId !== null)) {
    ctx.addIssue({
      code: 'custom', path: ['machineId'],
      message: 'Machine-scoped authoring destinations require exactly one machine identity',
    });
  }
})));

const DaemonProviderAuthoringCredentialV1Schema = lazyZodSchema(() => z.strictObject({
  slotId: z.literal('apiKey'),
  label: z.literal('api_key'),
  required: z.boolean(),
}));

const ProviderAuthoringReviewFingerprintV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256), z.startsWith('authoring-review:v1:')));

export const DaemonProviderContributionAuthoringPreviewV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('selection_required'),
    connectionId: ProviderConnectionIdSchema,
    contributionKey: ProviderContributionKeySchema,
    created: z.boolean(),
    credential: z.nullable(DaemonProviderAuthoringCredentialV1Schema),
    candidates: z.array(z.strictObject({
      candidateId: ProviderDiscoveryCandidateIdV1Schema,
      ...DaemonProviderAuthoringDestinationV1Schema.shape,
    }).check(z.superRefine((value, ctx) => {
      if ((value.scope === 'machine') !== (value.machineId !== null)) {
        ctx.addIssue({ code: 'custom', path: ['machineId'], message: 'Candidate scope and machine identity disagree' });
      }
    }))).check(z.minLength(2), z.maxLength(32)),
  }),
  z.strictObject({
    status: z.literal('resolved'),
    connectionId: ProviderConnectionIdSchema,
    contributionKey: ProviderContributionKeySchema,
    created: z.boolean(),
    candidateId: z.nullable(ProviderDiscoveryCandidateIdV1Schema),
    ...DaemonProviderAuthoringDestinationV1Schema.shape,
    credential: z.nullable(DaemonProviderAuthoringCredentialV1Schema),
    fingerprint: ProviderAuthoringReviewFingerprintV1Schema,
    revision: z.number().check(z.int(), z.nonnegative()),
    verification: z.optional(z.literal('declaration')),
  }).check(z.superRefine((value, ctx) => {
    if ((value.scope === 'machine') !== (value.machineId !== null)) {
      ctx.addIssue({ code: 'custom', path: ['machineId'], message: 'Review scope and machine identity disagree' });
    }
  })),
]));
export type DaemonProviderContributionAuthoringPreviewV1 = z.infer<typeof DaemonProviderContributionAuthoringPreviewV1Schema>;

export const DaemonProviderConnectionEndpointViewV1Schema = lazyZodSchema(() => z.strictObject({
  endpointTemplateId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  protocol: ProviderWireProtocolSchema,
  baseUrl: z.nullable(ProviderRpcDisplayEndpointUrlV1Schema),
  effectiveSource: z.enum(['template', 'accountOverride', 'machineOverride']),
  defaultBaseUrl: z._default(z.nullable(ProviderRpcDisplayEndpointUrlV1Schema), null),
  accountOverrideBaseUrl: z._default(z.nullable(ProviderRpcDisplayEndpointUrlV1Schema), null),
  machineOverrideBaseUrl: z._default(z.nullable(ProviderRpcDisplayEndpointUrlV1Schema), null),
  publicHeaders: z._default(ProviderPublicHeadersV1Schema, {}),
  defaultPublicHeaders: z._default(ProviderPublicHeadersV1Schema, {}),
  accountOverridePublicHeaders: z._default(z.nullable(ProviderPublicHeadersV1Schema), null),
  machineOverridePublicHeaders: z._default(z.nullable(ProviderPublicHeadersV1Schema), null),
  publicHeaderSources: z._default(z.record(z.string(), z.enum(['template', 'accountOverride', 'machineOverride'])), {}),
  ...ProviderEndpointPolicyV1Shape,
}));

const DaemonProviderAgentCompatibilitySummaryBaseV1Schema = lazyZodSchema(() => z.object({
  agentTargetKey: BackendTargetKeyV2Schema,
  agentName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
}));
export const DaemonProviderAgentCompatibilitySummaryV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderAgentCompatibilitySummaryBaseV1Schema, {
    status: z.literal('verified'),
    reasons: z.tuple([]),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderAgentCompatibilitySummaryBaseV1Schema, {
    status: z.literal('experimental'),
    reasons: z.array(ProviderCompatibilityReasonCodeV1Schema).check(z.minLength(1), z.maxLength(16)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderAgentCompatibilitySummaryBaseV1Schema, {
    status: z.literal('incompatible'),
    reasons: z.array(ProviderCompatibilityReasonCodeV1Schema).check(z.minLength(1), z.maxLength(16)),
  })),
]));
export type DaemonProviderAgentCompatibilitySummaryV1 = z.infer<typeof DaemonProviderAgentCompatibilitySummaryV1Schema>;

const DaemonProviderManagedConnectedAccountPurposeDeclarationV1Schema =
  lazyZodSchema(() => z.strictObject({
  purpose: ConnectedAccountPurposeIdSchema,
  service: asProtocolZod(PluginContributionIdentityV1Schema),
  title: z.optional(PluginLocalizedStringV2Schema),
  required: z.boolean(),
  materializationKinds: z.optional(PluginConnectedAccountMaterializationKindsSchema),
}));

const DaemonProviderManagedConnectedAccountPurposeV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderManagedConnectedAccountPurposeDeclarationV1Schema, {
  target: QualifiedConnectedAccountPurposeBindingTargetV1Schema,
})).check(z.superRefine((value, context) => {
  const targetService = value.target.kind === 'account'
    ? value.target.account.service
    : value.target.service;
  if (
    value.service.pluginId !== targetService.pluginId
    || value.service.localId !== targetService.localId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['target'],
      message: 'Managed Provider purpose target must use its declared Connected Account service',
    });
  }
})));

const DaemonProviderConnectionDeploymentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('external'),
  }),
  z.strictObject({
    kind: z.literal('managedLocal'),
    targetMachineId: z.nullable(ProviderMachineIdSchema),
    effects: z.nullable(z.strictObject({
      implementationIdentity: asProtocolZod(PluginContributionIdentityV1Schema),
      protocols: z.array(ProviderWireProtocolSchema).check(z.minLength(1), z.maxLength(16)),
      connectedAccountPurposes: z.array(
        DaemonProviderManagedConnectedAccountPurposeV1Schema,
      ).check(z.maxLength(32)),
      connectedAccountPurposeBindingPolicy:
        z.optional(ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema),
    })),
  }),
]));

export const DaemonProviderConnectionViewV1Schema = lazyZodSchema(() => z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  contributionKey: z.nullable(ProviderContributionKeySchema),
  provenance: z._default(z.enum(['first_party', 'external', 'custom']), 'first_party'),
  displayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  providerName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  icon: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  websiteUrl: z.optional(ProviderHttpsUrlSchema),
  role: z.enum(['default', 'named']),
  displayNameMode: z.enum(['automatic', 'custom']),
  sourceStatus: z.enum(['available', 'unavailable']),
  probeCapability: z.enum(['catalog', 'availability', 'none']),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  compatibility: z.array(DaemonProviderAgentCompatibilitySummaryV1Schema).check(z.maxLength(128)),
  grants: z.strictObject({
    accountEnabled: z.boolean(),
    enabledMachineIds: z.array(ProviderMachineIdSchema),
    accountState: z._default(z.enum(['absent', 'valid', 'stale']), 'absent'),
    machineState: z._default(z.enum(['absent', 'valid', 'stale']), 'absent'),
    effectiveState: z._default(z.enum(['absent', 'valid', 'stale']), 'absent'),
  }),
  credential: z.nullable(z.strictObject({
    required: z.boolean(),
    accountBound: z.boolean(),
    boundMachineIds: z.array(ProviderMachineIdSchema),
    keyUrl: z.optional(ProviderHttpsUrlSchema),
    authorityDescription: z.optional(PluginLocalizedStringV2Schema),
  })),
  /**
   * Exact, content-free witness accepted by Team credential resource creation.
   * It is produced by the canonical local Provider resolver because the Home
   * cannot read E2EE Account Settings and the UI must not reconstruct a source
   * fingerprint from administrative presentation rows.
   */
  teamCredentialSourceOffer: z._default(z.nullable(z.strictObject({
    connectionId: ProviderConnectionIdSchema,
    connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema,
    credentialSlotId: ProviderLocalIdSchema,
    label: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  })), null),
  deployment: z._default(DaemonProviderConnectionDeploymentV1Schema, { kind: 'external' }),
  gatewayPlacement: z.optional(ProviderGatewayPlacementV1Schema),
  claudeHelperModels: z.optional(ProviderClaudeHelperModelsV1Schema),
  managedLocalOption: z._default(z.nullable(z.strictObject({
    targetMachineId: z.nullable(ProviderMachineIdSchema),
    connectedAccountPurposes: z.array(
      DaemonProviderManagedConnectedAccountPurposeDeclarationV1Schema,
    ).check(z.maxLength(32)),
    connectedAccountPurposeBindingPolicy:
      z.optional(ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema),
  })), null),
  endpoints: z.array(DaemonProviderConnectionEndpointViewV1Schema).check(z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)),
  scope: z.nullable(z.enum(['account', 'machine'])),
  authorized: z.boolean(),
  authorizationError: z.nullable(ProviderErrorV1Schema),
  revision: z.number().check(z.int(), z.nonnegative()),
  probeObservationIdentity: z._default(z.nullable(ProviderProbeObservationIdentityV1Schema), null),
  runtime: ProviderConnectionRpcRuntimeSummaryV1Schema,
}).check(z.superRefine((value, context) => {
  for (const field of ['gatewayPlacement', 'claudeHelperModels'] as const) {
    if (value[field] !== undefined && (value.deployment.kind !== 'managedLocal' || value.contributionKey === null)) {
      context.addIssue({
        code: 'custom', path: [field], message: 'Gateway configuration requires a managed contribution connection',
      });
    }
  }
  if (value.managedLocalOption !== null && value.contributionKey === null) {
    context.addIssue({
      code: 'custom',
      path: ['managedLocalOption'],
      message:
        'Managed Provider authoring requires a contribution identity',
    });
  }
  if (value.deployment.kind === 'managedLocal' && value.endpoints.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['endpoints'],
      message: 'Managed Provider connection views must not expose durable endpoints',
    });
  }
})));
export type DaemonProviderConnectionViewV1 = z.infer<typeof DaemonProviderConnectionViewV1Schema>;

const ProviderConnectionMutationBaseV1Schema = lazyZodSchema(() => z.object({
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
}));

const DaemonProviderConnectionDeploymentUpdateV1Schema = lazyZodSchema(() => z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('external') }),
    z.strictObject({
      kind: z.literal('managedLocal'),
      purposeBindingDefaults:
        ProviderConnectionPurposeBindingDefaultsV1Schema,
    }),
  ],
));

export const DaemonProviderConnectionMutationRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('createContribution'),
    contributionKey: ProviderContributionKeySchema,
    displayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    savedSecretId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    enable: z.boolean(),
    authoringReview: z.strictObject({
      candidateId: z.nullable(ProviderDiscoveryCandidateIdV1Schema),
      fingerprint: ProviderAuthoringReviewFingerprintV1Schema,
      revision: z.number().check(z.int(), z.nonnegative()),
      endpointOverrides: z.optional(ProviderAuthoringEndpointOverridesV1Schema),
    }),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('createCustom'),
    template: CustomProviderTemplateV1Schema,
    savedSecretId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    enable: z.boolean(),
    manualModels: z._default(z.array(ProviderManualModelInputV1Schema)
      .check(z.maxLength(PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection)), []),
  })).check(z.superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.manualModels.forEach((model, index) => {
      if (ids.has(model.id)) {
        ctx.addIssue({ code: 'custom', path: ['manualModels', index, 'id'], message: 'Duplicate manual model id' });
      }
      ids.add(model.id);
    });
    if (value.template.catalog.manualModelPolicy === 'catalog-only' && value.manualModels.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['manualModels'], message: 'Catalog-only providers cannot persist manual models' });
    }
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('enableDetected'),
    candidateId: ProviderDiscoveryCandidateIdV1Schema,
    displayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    savedSecretId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  })),
  z.strictObject({
    action: z.literal('startLocal'),
    machineId: ProviderMachineIdSchema,
    // Compatibility reader for existing UI daemon-RPC callers; remove only
    // after those producers stop sending it. The semantic SDK request is
    // connection-free and its host projection never forwards an author value.
    connectionId: z.optional(ProviderConnectionIdSchema),
    contributionKey: ProviderContributionKeySchema,
  }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('update'),
    expectedRevision: z.number().check(z.int(), z.nonnegative()),
    displayName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    displayNameMode: z.optional(z.enum(['automatic', 'custom'])),
    template: z.optional(CustomProviderTemplateV1Schema),
    deployment: z.optional(DaemonProviderConnectionDeploymentUpdateV1Schema),
    gatewayPlacement: z.optional(z.nullable(ProviderGatewayPlacementV1Schema)),
    claudeHelperModels: z.optional(z.nullable(ProviderClaudeHelperModelsV1Schema)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('setEndpointOverride'),
    expectedRevision: z.number().check(z.int(), z.nonnegative()),
    scope: z.enum(['account', 'machine']),
    endpointTemplateId: ProviderEndpointOverrideV1Schema.shape.endpointTemplateId,
    baseUrl: z.nullable(ProviderEndpointOverrideV1Schema.shape.baseUrl),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('duplicate'),
    newConnectionId: ProviderConnectionIdSchema,
    displayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    mode: z.enum(['sameSource', 'asCustom']),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('delete'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('setEnabled'),
    enabled: z.boolean(),
    scope: z.enum(['account', 'machine', 'connection']),
  })).check(z.superRefine((value, ctx) => {
    if (value.enabled && value.scope === 'connection') {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'All-scope mutation is disable-only' });
    }
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderConnectionMutationBaseV1Schema, {
    action: z.literal('bindSecret'),
    credentialSlotId: z.literal('apiKey'),
    savedSecretId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    scope: z.enum(['account', 'machine']),
  })),
]));
export type DaemonProviderConnectionMutationRequestV1 = z.infer<typeof DaemonProviderConnectionMutationRequestV1Schema>;

export const DaemonProviderConnectionsDescribeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    connections: z.array(DaemonProviderConnectionViewV1Schema),
    available: z.array(z.strictObject({
      contributionKey: ProviderContributionKeySchema,
      name: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
      kind: z.enum(['frontier', 'aggregator', 'cloud', 'local']),
      provenance: z._default(z.enum(['first_party', 'external']), 'first_party'),
      icon: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
      websiteUrl: z.optional(ProviderHttpsUrlSchema),
      credential: z.nullable(z.strictObject({
        required: z.boolean(),
        keyUrl: z.optional(ProviderHttpsUrlSchema),
      })),
      endpointTemplates: z._default(z.array(z.strictObject({
        id: ProviderEndpointOverrideV1Schema.shape.endpointTemplateId,
        protocol: ProviderWireProtocolSchema,
      })).check(z.maxLength(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)), []),
    })),
    discoveryCandidates: z.array(ProviderDiscoveryCandidateV1Schema),
    discoveryCandidatesTruncated: z._default(z.boolean(), false),
    localInstallations: z._default(z.array(ProviderLocalInstallationSummaryV1Schema).check(z.maxLength(4_096)), []),
    localInstallationsStatus: z.optional(z.enum(['complete', 'incomplete'])),
    diagnosticsTruncated: z.boolean(),
    diagnostics: z.array(z.strictObject({
      path: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
      reason: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    })).check(z.maxLength(PROVIDER_SETTINGS_LIMITS_V1.readDiagnostics)),
    availableTruncated: z.boolean(),
    authoringPreview: z.optional(DaemonProviderContributionAuthoringPreviewV1Schema),
    deletedConnection: z.optional(z.nullable(z.strictObject({
      connectionId: ProviderConnectionIdSchema,
      contributionKey: z.nullable(ProviderContributionKeySchema),
      lastDisplayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
      deletedAt: z.number().check(z.nonnegative()),
    }))),
  }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderConnectionsDescribeResponseV1 = z.infer<typeof DaemonProviderConnectionsDescribeResponseV1Schema>;

export const DaemonProviderConnectionMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    status: z.literal('success'),
    action: z.enum(['createContribution', 'createCustom', 'enableDetected', 'update', 'setEndpointOverride', 'duplicate', 'setEnabled', 'bindSecret']),
    connection: DaemonProviderConnectionViewV1Schema,
    created: z.optional(z.boolean()),
  }),
  z.strictObject({ status: z.literal('success'), action: z.literal('delete'), deletedConnectionId: ProviderConnectionIdSchema }),
  z.strictObject({
    status: z.literal('success'),
    action: z.literal('startLocal'),
    contributionKey: ProviderContributionKeySchema,
    phase: z.enum(['detecting', 'running']),
  }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderConnectionMutationResponseV1 = z.infer<typeof DaemonProviderConnectionMutationResponseV1Schema>;

export const DaemonProviderModelProjectionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ProviderMachineIdSchema,
  agentTargetKey: BackendTargetKeyV2Schema,
  application: z.optional(ProviderBrokerApplicationBindingV1Schema),
  /** Opt-in keeps older broker-only callers compatible with the strict response schema. */
  includeDirectMaterialization: z.optional(z.literal(true)),
  /** Opt-in keeps strict older projection consumers on their unchanged row shape. */
  includeTeamCredentialRequestPolicySupport: z.optional(z.literal(true)),
  providerConnection: z.optional(z.strictObject({
    connectionId: ProviderConnectionIdSchema,
    expectedConnectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema,
  })),
  connectedAccountTarget: z.optional(QualifiedConnectedAccountPurposeBindingTargetV1Schema),
  /** Team source facts do not require the recipient Agent on this Machine. */
  sourceCatalog: z.optional(z.literal(true)),
  /** Recipient-side projection: compatibility is recomputed by this Machine. */
  teamCredentialModel: z.optional(TeamCredentialProviderModelCatalogEntryV1Schema),
  mode: z.optional(z.enum(['picker', 'management'])),
  /** Presentation scope; selecting a source alone never mutates session intent. */
  sourceConnectionId: z.optional(ProviderConnectionIdSchema),
  favoriteSelections: z.optional(z.array(ProviderBoundModelRefSchema)),
  /** Internal current-observation read used by bounded Pool fanout. It must not
   * schedule Provider refresh/materialization on every candidate Machine. */
  refreshPolicy: z.optional(z.literal('current_only')),
  /** Explicit user retry; automatic reads stay backoff-aware. */
  forceRefresh: z.optional(z.literal(true)),
  currentSelection: z.optional(ProviderBoundModelRefSchema),
}).check(z.superRefine((value, ctx) => {
  if (value.teamCredentialModel && (value.teamCredentialModel.selection.agentTargetKey !== value.agentTargetKey
    || value.providerConnection || value.connectedAccountTarget || value.sourceCatalog)) {
    ctx.addIssue({ code: 'custom', path: ['teamCredentialModel'], message: 'Recipient model projection requires one matching Team model source' });
  }
  if (value.currentSelection && value.currentSelection.agentTargetKey !== value.agentTargetKey) {
    ctx.addIssue({ code: 'custom', path: ['currentSelection', 'agentTargetKey'], message: 'Current selection belongs to another agent target' });
  }
  value.favoriteSelections?.forEach((ref, index) => {
    if (ref.agentTargetKey !== value.agentTargetKey) ctx.addIssue({ code: 'custom',
      path: ['favoriteSelections', index, 'agentTargetKey'], message: 'Favorite belongs to another agent target' });
  });
  if (value.application && value.application.agentTargetKey !== value.agentTargetKey) {
    ctx.addIssue({ code: 'custom', path: ['application', 'agentTargetKey'], message: 'Application belongs to another agent target' });
  }
  if (value.providerConnection && value.connectedAccountTarget) {
    ctx.addIssue({ code: 'custom', path: ['providerConnection'], message: 'Provider and Connected Account source filters are mutually exclusive' });
  }
  if (value.refreshPolicy === 'current_only' && value.forceRefresh) {
    ctx.addIssue({ code: 'custom', path: ['forceRefresh'], message: 'Current-only projection cannot force refresh' });
  }
})));
export type DaemonProviderModelProjectionRequestV1 = z.infer<typeof DaemonProviderModelProjectionRequestV1Schema>;

const DaemonProviderReasoningEffortSupportV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ supported: z.literal(false) }),
  z.strictObject({
    supported: z.literal(true),
    allowedValues: z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))).check(z.minLength(1), z.maxLength(128)),
    defaultValue: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }).check(z.superRefine((value, ctx) => {
    if (new Set(value.allowedValues).size !== value.allowedValues.length) {
      ctx.addIssue({ code: 'custom', path: ['allowedValues'], message: 'Reasoning effort values must be unique' });
    }
    if (!value.allowedValues.includes(value.defaultValue)) {
      ctx.addIssue({ code: 'custom', path: ['defaultValue'], message: 'Reasoning effort default must be supported' });
    }
  })),
]));

export const DaemonProviderTeamCredentialRequestPolicySupportV1Schema = lazyZodSchema(() => z.strictObject({
  /** Value-free current catalog metadata required by the Home projection. */
  descriptor: ProviderModelDescriptorV1Schema,
  application: ProviderBrokerApplicationBindingV1Schema,
  sourceRevision: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  protocolKind: z.enum([
    'openai_responses',
    'openai_chat_completions',
    'anthropic_messages',
  ]),
  model: z.strictObject({
    canonicalId: ProviderModelIdSchema,
    aliases: z.array(ProviderModelIdSchema).check(z.maxLength(64)),
  }).check(z.superRefine((value, ctx) => {
    if (new Set(value.aliases).size !== value.aliases.length) {
      ctx.addIssue({ code: 'custom', path: ['aliases'], message: 'Model aliases must be unique' });
    }
    if (value.aliases.includes(value.canonicalId)) {
      ctx.addIssue({ code: 'custom', path: ['aliases'], message: 'A canonical model id cannot alias itself' });
    }
  })),
  reasoningEffort: DaemonProviderReasoningEffortSupportV1Schema,
}).check(z.superRefine((value, ctx) => {
  const expectedProtocolKind = value.application.protocol === 'openai-responses'
    ? 'openai_responses'
    : value.application.protocol === 'openai-chat'
      ? 'openai_chat_completions'
      : value.application.protocol === 'anthropic'
        ? 'anthropic_messages'
        : null;
  if (value.protocolKind !== expectedProtocolKind) {
    ctx.addIssue({ code: 'custom', path: ['protocolKind'], message: 'Request-policy protocol must match the exact application protocol' });
  }
  if (value.descriptor.id !== value.model.canonicalId) {
    ctx.addIssue({ code: 'custom', path: ['descriptor', 'id'], message: 'Request-policy descriptor must match the canonical model id' });
  }
  const descriptorAliases = value.descriptor.aliases ?? [];
  if (descriptorAliases.length !== value.model.aliases.length
    || descriptorAliases.some((alias, index) => alias !== value.model.aliases[index])) {
    ctx.addIssue({ code: 'custom', path: ['descriptor', 'aliases'], message: 'Request-policy descriptor aliases must match the model aliases' });
  }
})));
export type DaemonProviderTeamCredentialRequestPolicySupportV1 = z.infer<
  typeof DaemonProviderTeamCredentialRequestPolicySupportV1Schema
>;

/** Exact source-only discovery; the daemon enumerates its current Agent/application
 * bindings so no UI or Home caller authors executable Provider identity. */
export const DaemonProviderTeamCredentialRequestPolicySupportRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ProviderMachineIdSchema,
  source: TeamCredentialSourceBindingV1Schema,
  refreshPolicy: z.optional(z.literal('current_only')),
}));
export type DaemonProviderTeamCredentialRequestPolicySupportRequestV1 = z.infer<
  typeof DaemonProviderTeamCredentialRequestPolicySupportRequestV1Schema
>;

export const DaemonProviderTeamCredentialRequestPolicySupportResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    models: z.array(DaemonProviderTeamCredentialRequestPolicySupportV1Schema),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['source_unavailable', 'application_unavailable', 'model_unavailable']),
  }),
]));
export type DaemonProviderTeamCredentialRequestPolicySupportResponseV1 = z.infer<
  typeof DaemonProviderTeamCredentialRequestPolicySupportResponseV1Schema
>;

export const DaemonProviderModelProjectionRowV1Schema = lazyZodSchema(() => z.strictObject({
  ref: ProviderBoundModelRefSchema,
  descriptor: ProviderModelDescriptorV1Schema,
  /** Admitted source slots for grouping, independent of the selected downstream protocol. */
  gatewaySlots: z.optional(z.array(QualifiedConnectedAccountPurposeBindingV1Schema)),
  application: z.optional(ProviderBrokerApplicationBindingV1Schema),
  sourceFacts: z.optional(ProviderModelBindingSourceV1Schema),
  confirmationSource: z.optional(ProviderModelConfirmationSourceV1Schema),
  requestPolicySupport: z.optional(DaemonProviderTeamCredentialRequestPolicySupportV1Schema),
  /** Non-secret source-owned facts needed to materialize an admitted direct API key. */
  directMaterialization: z.optional(z.strictObject({
    endpoint: z.strictObject({
      endpointTemplateId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
      normalizedUrl: ProviderEndpointUrlSyntaxSchema,
      protocol: ProviderWireProtocolSchema,
      publicHeaders: z.record(z.string(), z.string()),
    }),
    credentialTransport: ProviderCredentialTransportV1Schema,
  })),
  sources: z.strictObject({ manual: z.boolean(), static: z.boolean(), probe: z.boolean() }),
  confidence: z.enum(['manual', 'verified_static', 'probe', 'account_unverified']),
  compatibility: z.strictObject({
    result: ProviderBindingCompatibilityV1Schema,
    compatibilityFingerprint: ProviderCompatibilityFingerprintV1Schema,
    confirmed: z.boolean(),
  }),
  endpointHealth: ProviderEndpointHealthStatusV1Schema,
  catalog: z.strictObject({
    stale: z.boolean(),
    observedAt: z.optional(z.number().check(z.nonnegative())),
    staleAt: z.optional(z.number().check(z.nonnegative())),
  }),
  loadState: ProviderModelLoadStateV1Schema,
  visibility: z.enum(['visible', 'hidden_agent', 'hidden_all_agents', 'hidden_current_selection']),
}));
export type DaemonProviderModelProjectionRowV1 = z.infer<typeof DaemonProviderModelProjectionRowV1Schema>;

export const DaemonProviderModelProjectionGroupV1Schema = lazyZodSchema(() => z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  connectedAccountTarget: z.optional(QualifiedConnectedAccountPurposeBindingTargetV1Schema),
  providerName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  connectionName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  connectionRole: z.enum(['default', 'named']),
  connectionDisplayNameMode: z.enum(['automatic', 'custom']),
  connectionRevision: z.number().check(z.int(), z.nonnegative()),
  /**
   * Current source-owned Provider identity and security binding. This is
   * intentionally absent for custom-template connections: consumers that
   * require a first-party Provider identity must fail closed rather than infer
   * one from the executable application.
   */
  sourceAuthority: z.optional(z.strictObject({
    provider: z.strictObject({
      identity: asProtocolZod(PluginContributionIdentityV1Schema),
      definitionRevision: z.literal(1),
    }),
    connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema,
  })),
  sourceRevision: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  modelLoadAction: z.enum(['available', 'descriptor_absent', 'feature_disabled', 'machine_required']),
  modelLoadPreflightPolicy: z.optional(z.nullable(z.enum(['advisory', 'required']))),
  authorization: z.union([
    z.strictObject({ authorized: z.literal(true) }),
    z.strictObject({ authorized: z.literal(false), error: ProviderErrorV1Schema }),
  ]),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  supportsFreeformModelIds: z.boolean(),
  suppressedConnectedServiceIds: z.array(ConnectedServiceIdSchema).check(z.maxLength(32)),
  rows: z.array(DaemonProviderModelProjectionRowV1Schema).check(z.maxLength(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection + 1)),
}).check(z.superRefine((value, ctx) => {
  value.rows.forEach((row, index) => {
    const support = row.requestPolicySupport;
    if (!support) return;
    if (value.sourceRevision !== support.sourceRevision) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', index, 'requestPolicySupport', 'sourceRevision'],
        message: 'Request-policy support must match the projected source revision',
      });
    }
    const application = row.application;
    if (!application
      || application.agentTargetKey !== support.application.agentTargetKey
      || application.implementationIdentity.pluginId !== support.application.implementationIdentity.pluginId
      || application.implementationIdentity.localId !== support.application.implementationIdentity.localId
      || application.endpointTemplateId !== support.application.endpointTemplateId
      || application.protocol !== support.application.protocol) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', index, 'requestPolicySupport', 'application'],
        message: 'Request-policy support must match the projected application',
      });
    }
    if (row.ref.modelId !== support.model.canonicalId) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', index, 'requestPolicySupport', 'model', 'canonicalId'],
        message: 'Request-policy support must match the projected canonical model',
      });
    }
    const descriptorAliases = row.descriptor.aliases ?? [];
    if (descriptorAliases.length !== support.model.aliases.length
      || descriptorAliases.some((alias, aliasIndex) => alias !== support.model.aliases[aliasIndex])) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', index, 'requestPolicySupport', 'model', 'aliases'],
        message: 'Request-policy support must match the projected model aliases',
      });
    }
  });
  if (new Set(value.suppressedConnectedServiceIds).size !== value.suppressedConnectedServiceIds.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['suppressedConnectedServiceIds'],
      message: 'Suppressed connected-service ids must be unique',
    });
  }
  // The picker projection appends at most one stale-current row. Unlike
  // stale observations from a retained snapshot, that recovery row has no
  // observation timestamps; keep this boundary explicit so a second stale
  // row cannot hide behind the one-row allowance.
  const staleCurrentRows = value.rows.filter((row) => (
    row.catalog.stale
    && row.catalog.observedAt === undefined
    && row.catalog.staleAt === undefined
  ));
  if (staleCurrentRows.length > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['rows'],
      message: 'A Provider model projection may contain at most one stale-current recovery row',
    });
  }
  if (
    value.rows.length > PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection
    && staleCurrentRows.length !== 1
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['rows'],
      message: 'A Provider model projection may exceed the active model limit only for one stale-current recovery row',
    });
  }
})));
export type DaemonProviderModelProjectionGroupV1 = z.infer<typeof DaemonProviderModelProjectionGroupV1Schema>;

export const DaemonProviderCurrentSelectionRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum([
    'contribution_unavailable',
    'connection_deleted',
    'connection_missing',
    'model_not_found',
  ]),
  ref: ProviderBoundModelRefSchema,
  error: ProviderErrorV1Schema,
  displaySnapshot: z.nullable(z.strictObject({
    providerName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    connectionName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    modelName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  }).check(z.superRefine((value, ctx) => {
    if (value.providerName === undefined
      && value.connectionName === undefined
      && value.modelName === undefined) {
      ctx.addIssue({ code: 'custom', message: 'A recovery display snapshot must contain a display fact' });
    }
  }))),
}).check(z.superRefine((value, ctx) => {
  if (value.ref.providerConnectionId === null) {
    ctx.addIssue({ code: 'custom', path: ['ref', 'providerConnectionId'], message: 'Provider recovery requires a connection-bound ref' });
  }
  const expectedCode = value.kind === 'contribution_unavailable'
    ? 'provider_contribution_unavailable'
    : value.kind === 'model_not_found'
      ? 'provider_model_not_found'
      : 'provider_connection_not_found';
  if (value.error.code !== expectedCode) {
    ctx.addIssue({ code: 'custom', path: ['error', 'code'], message: 'Recovery error must match its closed recovery kind' });
  }
  if (value.error.connectionId !== value.ref.providerConnectionId) {
    ctx.addIssue({ code: 'custom', path: ['error', 'connectionId'], message: 'Recovery error must match the selected connection' });
  }
})));
export type DaemonProviderCurrentSelectionRecoveryV1 = z.infer<typeof DaemonProviderCurrentSelectionRecoveryV1Schema>;

/**
 * One connection whose requested refresh settled with the existing typed
 * Provider failure. A projection can still succeed partially: usable groups
 * render from their observations while every failed connection carries its
 * own typed recovery fact beside them.
 */
const DaemonProviderModelProjectionRefreshFailureV1Schema = lazyZodSchema(() => z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  error: ProviderErrorV1Schema,
}));
export type DaemonProviderModelProjectionRefreshFailureV1 = z.infer<
  typeof DaemonProviderModelProjectionRefreshFailureV1Schema
>;

/**
 * A source switched off for the model picker that still offers this Agent compatible models.
 * Ordinary browse names it so it stays reachable; browsing it explicitly projects its rows.
 */
export const DaemonProviderModelProjectionHiddenSourceV1Schema = lazyZodSchema(() => z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  providerName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  connectionName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  connectionRole: z.enum(['default', 'named']),
  connectionDisplayNameMode: z.enum(['automatic', 'custom']),
  // Withheld rows only: zero when every compatible model is retained as an exception.
  modelCount: z.number().check(z.int(), z.nonnegative()),
}));
export type DaemonProviderModelProjectionHiddenSourceV1 = z.infer<typeof DaemonProviderModelProjectionHiddenSourceV1Schema>;

export const DaemonProviderModelProjectionResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    agentTargetKey: BackendTargetKeyV2Schema,
    groups: z.array(DaemonProviderModelProjectionGroupV1Schema),
    /** Additive presentation fact; older readers ignore it, older daemons omit it. */
    hiddenSources: z.optional(z.array(DaemonProviderModelProjectionHiddenSourceV1Schema)),
    currentSelectionRecovery: z.optional(z.nullable(DaemonProviderCurrentSelectionRecoveryV1Schema)),
    refreshFailures: z.optional(z.array(DaemonProviderModelProjectionRefreshFailureV1Schema)),
  }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderModelProjectionResponseV1 = z.infer<typeof DaemonProviderModelProjectionResponseV1Schema>;

export type TeamCredentialSourceModelProjectionFailureV1 = Readonly<{
  status: 'unavailable';
  reason: 'response_invalid' | 'projection_unavailable' | 'not_granted' | 'incompatible';
  error?: z.infer<typeof ProviderErrorV1Schema>;
}>;

/** Shared source-row admission for recipient projection and broker execution.
 * This reads source facts only; entitlement, Team policy and disclosure remain
 * at their respective owners. The strict RPC reader is also used in-process. */
export function admitTeamCredentialSourceModelRowsV1(response: unknown):
  | TeamCredentialSourceModelProjectionFailureV1
  | Readonly<{ status: 'success'; rows: readonly Readonly<{
      group: DaemonProviderModelProjectionGroupV1;
      row: DaemonProviderModelProjectionRowV1 & { application: z.infer<typeof ProviderBrokerApplicationBindingV1Schema> };
      sourceRevision: string;
    }>[] }> {
  const parsed = DaemonProviderModelProjectionResponseV1Schema.safeParse(response);
  if (!parsed.success) return { status: 'unavailable', reason: 'response_invalid' };
  if (parsed.data.status === 'error') {
    return { status: 'unavailable', reason: 'projection_unavailable', error: parsed.data.error };
  }
  const projection = parsed.data;
  let failure: TeamCredentialSourceModelProjectionFailureV1 | undefined;
  const rows = projection.groups.flatMap(group => {
    if (!group.authorization.authorized) {
      failure ??= { status: 'unavailable', reason: 'not_granted', error: group.authorization.error };
      return [];
    }
    if (!group.sourceRevision) {
      failure ??= { status: 'unavailable', reason: 'projection_unavailable' };
      return [];
    }
    const sourceRevision = group.sourceRevision;
    return group.rows.flatMap(row => {
      if (row.visibility !== 'visible') return [];
      if (row.catalog.stale) {
        failure ??= { status: 'unavailable', reason: 'projection_unavailable' };
        return [];
      }
      if (!row.application || row.ref.modelId !== row.descriptor.id
        || row.application.agentTargetKey !== projection.agentTargetKey
        || row.ref.agentTargetKey !== row.application.agentTargetKey) {
        failure ??= { status: 'unavailable', reason: 'response_invalid' };
        return [];
      }
      if (!row.sourceFacts && row.compatibility.result.status === 'incompatible') {
        failure ??= { status: 'unavailable', reason: 'incompatible' };
        return [];
      }
      return [{ group, row: { ...row, application: row.application }, sourceRevision }];
    });
  });
  if (rows.length > 0) return { status: 'success', rows };
  const refreshFailure = projection.refreshFailures?.[0];
  if (refreshFailure) return { status: 'unavailable', reason: 'projection_unavailable', error: refreshFailure.error };
  return failure ?? { status: 'success', rows: [] };
}

const ProviderModelSettingsMutationBaseV1Schema = lazyZodSchema(() => z.object({ machineId: ProviderMachineIdSchema }));
export const DaemonProviderModelSettingsMutationRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderModelSettingsMutationBaseV1Schema, {
    action: z.literal('manualAdd'), connectionId: ProviderConnectionIdSchema,
    expectedConnectionRevision: z.number().check(z.int(), z.nonnegative()),
    models: z.array(ProviderManualModelInputV1Schema).check(z.minLength(1), z.maxLength(PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection)),
  })).check(z.superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.models.forEach((model, index) => {
      if (seen.has(model.id)) {
        ctx.addIssue({ code: 'custom', path: ['models', index, 'id'], message: 'Duplicate manual model id' });
      }
      seen.add(model.id);
    });
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderModelSettingsMutationBaseV1Schema, {
    action: z.literal('manualRemove'), connectionId: ProviderConnectionIdSchema, modelId: ProviderModelIdSchema,
    expectedConnectionRevision: z.number().check(z.int(), z.nonnegative()),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderModelSettingsMutationBaseV1Schema, {
    action: z.literal('setVisibility'), ref: ModelVisibilityRefV1Schema, hidden: z.boolean(),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderModelSettingsMutationBaseV1Schema, {
    action: z.literal('resetVisibility'),
    scope: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('agent'), agentTargetKey: BackendTargetKeyV2Schema }),
      z.strictObject({ kind: z.literal('connection'), connectionId: ProviderConnectionIdSchema }),
    ]),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderModelSettingsMutationBaseV1Schema, {
    action: z.literal('bulkVisibility'),
    changes: z.array(z.strictObject({
      ref: ModelVisibilityRefV1Schema,
      hidden: z.boolean(),
    })).check(z.minLength(1), z.maxLength(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection)),
  })).check(z.superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.changes.forEach((change, index) => {
      const key = serializeModelVisibilityRefV1(change.ref);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['changes', index, 'ref'], message: 'Duplicate model visibility ref' });
      }
      seen.add(key);
    });
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProviderModelSettingsMutationBaseV1Schema, {
    action: z.literal('confirmExperimental'), connectionId: ProviderConnectionIdSchema,
    connectedAccountTarget: z.optional(QualifiedConnectedAccountPurposeBindingTargetV1Schema),
    catalogSourceKey: z.optional(ProviderModelConfirmationSourceKeyV1Schema),
    expectedConnectionRevision: z.number().check(z.int(), z.nonnegative()),
    agentTargetKey: BackendTargetKeyV2Schema, modelId: z.nullable(ProviderModelIdSchema),
    compatibilityFingerprint: ProviderCompatibilityFingerprintV1Schema,
  })),
]));
export type DaemonProviderModelSettingsMutationRequestV1 = z.infer<typeof DaemonProviderModelSettingsMutationRequestV1Schema>;

export const DaemonProviderModelSettingsMutationResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), action: z.enum([
    'manualAdd', 'manualRemove', 'setVisibility', 'resetVisibility', 'bulkVisibility', 'confirmExperimental',
  ]) }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderModelSettingsMutationResponseV1 = z.infer<typeof DaemonProviderModelSettingsMutationResponseV1Schema>;

export const DaemonProviderBindingStatusRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ProviderMachineIdSchema,
  agentTargetKey: BackendTargetKeyV2Schema,
  selection: SessionModelSelectionV1Schema,
  launchBinding: SessionProviderBindingMetadataV1Schema,
}).check(z.superRefine((value, ctx) => {
  if (value.selection.ref.agentTargetKey !== value.agentTargetKey) {
    ctx.addIssue({ code: 'custom', path: ['selection', 'ref', 'agentTargetKey'], message: 'Selection belongs to another agent target' });
  }
  if (value.selection.ref.providerConnectionId === null
    || value.selection.ref.providerConnectionId !== value.launchBinding.connectionId) {
    ctx.addIssue({ code: 'custom', path: ['launchBinding', 'connectionId'], message: 'Launch binding does not match the provider selection' });
  }
})));
export type DaemonProviderBindingStatusRequestV1 = z.infer<typeof DaemonProviderBindingStatusRequestV1Schema>;

export const DaemonProviderBindingStatusResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('current') }),
  z.strictObject({
    status: z.literal('changed'),
    nextBindingSecurityFingerprint: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }),
  ...(['connection_missing', 'contribution_unavailable', 'disabled', 'grant_stale', 'incompatible'] as const)
    .map((status) => z.strictObject({ status: z.literal(status), error: ProviderErrorV1Schema })),
]));
export type DaemonProviderBindingStatusResponseV1 = z.infer<typeof DaemonProviderBindingStatusResponseV1Schema>;

export const DaemonProviderProfileMigrationPrepareSourceRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ProviderMachineIdSchema,
  expectedSettingsVersion: z.number().check(z.int(), z.nonnegative()),
}));
export type DaemonProviderProfileMigrationPrepareSourceRequestV1 = z.infer<typeof DaemonProviderProfileMigrationPrepareSourceRequestV1Schema>;

export const DaemonProviderProfileMigrationPrepareSourceResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), settingsVersion: z.number().check(z.int(), z.nonnegative()), records: z.array(ProfileRecordV1Schema) }),
  z.strictObject({ status: z.literal('partial'), settingsVersion: z.number().check(z.int(), z.nonnegative()), diagnostics: z.array(LegacyProfileRecordPreparationDiagnosticV1Schema) }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderProfileMigrationPrepareSourceResponseV1 = z.infer<typeof DaemonProviderProfileMigrationPrepareSourceResponseV1Schema>;

const ProviderProfileMigrationSourceFingerprintV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256), z.startsWith('legacy-profile-migration-source:v1:')));

const DaemonProviderProfileMigrationRequestBaseV1Schema = lazyZodSchema(() => z.object({
  machineId: ProviderMachineIdSchema,
  sourceProfileId: ProviderMigrationSourceProfileIdSchema,
  reviewedMapping: LegacyProfileReviewedMappingV1Schema,
}));

export const DaemonProviderProfileMigrationPreviewRequestV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(DaemonProviderProfileMigrationRequestBaseV1Schema));
export type DaemonProviderProfileMigrationPreviewRequestV1 = z.infer<
  typeof DaemonProviderProfileMigrationPreviewRequestV1Schema
>;

export const DaemonProviderProfileMigrationPreviewResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    sourceFingerprint: ProviderProfileMigrationSourceFingerprintV1Schema,
  }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderProfileMigrationPreviewResponseV1 = z.infer<
  typeof DaemonProviderProfileMigrationPreviewResponseV1Schema
>;

export const DaemonProviderProfileMigrationConfirmRequestV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonProviderProfileMigrationRequestBaseV1Schema, {
    expectedSourceFingerprint: ProviderProfileMigrationSourceFingerprintV1Schema,
  })));
export type DaemonProviderProfileMigrationConfirmRequestV1 = z.infer<
  typeof DaemonProviderProfileMigrationConfirmRequestV1Schema
>;

export const DaemonProviderProfileMigrationConfirmResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    connectionId: ProviderConnectionIdSchema,
    settingsVersion: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderProfileMigrationConfirmResponseV1 = z.infer<
  typeof DaemonProviderProfileMigrationConfirmResponseV1Schema
>;

export const DaemonProviderProfileMigrationConflictConfirmRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ProviderMachineIdSchema,
  sourceProfileId: LegacyProfileMigrationConflictResolutionV1Schema.shape.sourceProfileId,
  expectedCandidateFingerprint:
    LegacyProfileMigrationConflictResolutionV1Schema.shape.expectedCandidateFingerprint,
  decision: LegacyProfileMigrationConflictResolutionV1Schema.shape.decision,
}));
export type DaemonProviderProfileMigrationConflictConfirmRequestV1 = z.infer<
  typeof DaemonProviderProfileMigrationConflictConfirmRequestV1Schema
>;

export const DaemonProviderProfileMigrationConflictConfirmResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    connectionId: ProviderConnectionIdSchema,
    settingsVersion: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({ status: z.literal('error'), error: ProviderErrorV1Schema }),
]));
export type DaemonProviderProfileMigrationConflictConfirmResponseV1 = z.infer<
  typeof DaemonProviderProfileMigrationConflictConfirmResponseV1Schema
>;
