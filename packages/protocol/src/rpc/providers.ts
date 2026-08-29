import { z } from 'zod';

import { ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderMachineIdSchema, ProviderModelIdSchema } from '../providers/ids.js';
import { BackendTargetKeyV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { CustomProviderTemplateV1Schema } from '../providers/connections/customTemplateV1.js';
import {
  ProviderConnectionPurposeBindingDefaultsV1Schema,
  ProviderEndpointOverrideV1Schema,
} from '../providers/connections/v1.js';
import { ProviderErrorV1Schema } from '../providers/errors.js';
import {
  ProviderProbeObservationIdentityV1Schema,
  ProviderProbeRequestFingerprintV1Schema,
} from '../providers/fingerprints.js';
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
import { PROVIDER_SETTINGS_LIMITS_V1 } from '../providers/settings/v1.js';
import {
  ProviderDiscoveryCandidateIdV1Schema,
  ProviderDiscoveryCandidateV1Schema,
  ProviderLocalInstallationSummaryV1Schema,
} from '../providers/detection/v1.js';
import { ProviderHttpsUrlSchema } from '../providers/httpsUrlSchema.js';
import { ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema } from '../providers/contributions/v1.js';
import { LegacyProfileReviewedMappingV1Schema } from '../providers/migrations/legacyProfilesV1.js';
import { LegacyProfileMigrationConflictResolutionV1Schema } from '../providers/migrations/conflictsV1.js';
import { ProviderMigrationSourceProfileIdSchema } from '../providers/settings/v1.js';
import { ConnectedServiceIdSchema } from '../connect/connectedServiceBindings.js';
import {
  ConnectedAccountPurposeIdSchema,
  PluginConnectedAccountMaterializationKindsSchema,
} from '../connect/connectedAccountPurposes.js';
import { QualifiedConnectedAccountPurposeBindingTargetV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

const ProviderRpcIdentityV1Schema = z.object({
  connectionId: ProviderConnectionIdSchema,
  machineId: ProviderMachineIdSchema,
}).strict();

export const DaemonProviderDraftProbeRequestV1Schema = z.object({
  kind: z.literal('draft'),
  draftConnectionId: ProviderConnectionIdSchema,
  machineId: ProviderMachineIdSchema,
  template: CustomProviderTemplateV1Schema,
  savedSecretId: z.string().trim().min(1).max(256).nullable(),
  actionNonce: z.string().trim().min(16).max(256),
}).strict().superRefine((value, ctx) => {
  if ((value.template.credential === undefined && value.savedSecretId !== null)
    || (value.template.credential?.required === true && value.savedSecretId === null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['savedSecretId'],
      message: 'Draft SavedSecret identity must match the template credential contract',
    });
  }
});
export type DaemonProviderDraftProbeRequestV1 = z.infer<typeof DaemonProviderDraftProbeRequestV1Schema>;

export const DaemonProviderProbeRequestV1Schema = z.union([
  ProviderRpcIdentityV1Schema,
  DaemonProviderDraftProbeRequestV1Schema,
]);
export type DaemonProviderProbeRequestV1 = z.infer<typeof DaemonProviderProbeRequestV1Schema>;

export const DaemonProviderModelsRequestV1Schema = ProviderRpcIdentityV1Schema;
export type DaemonProviderModelsRequestV1 = z.infer<typeof DaemonProviderModelsRequestV1Schema>;

const DaemonProviderModelLoadIdentityV1Schema = ProviderRpcIdentityV1Schema.extend({
  modelId: ProviderModelIdSchema,
}).strict();

export const DaemonProviderModelLoadRequestV1Schema = z.discriminatedUnion('action', [
  DaemonProviderModelLoadIdentityV1Schema.extend({ action: z.literal('load') }).strict(),
  DaemonProviderModelLoadIdentityV1Schema.extend({ action: z.literal('cancel') }).strict(),
]);
export type DaemonProviderModelLoadRequestV1 = z.infer<typeof DaemonProviderModelLoadRequestV1Schema>;

export const DaemonProviderRpcErrorV1Schema = ProviderErrorV1Schema;

export const DaemonProviderModelRowV1Schema = z.object({
  id: ProviderModelIdSchema,
  name: z.string().trim().min(1).max(256).optional(),
  source: z.enum(['manual', 'static', 'probe']),
  stale: z.boolean(),
  loadState: z.enum(['loaded', 'unloaded', 'unknown']),
  visibility: z.enum(['visible', 'hidden_all_agents']),
}).strict();
export type DaemonProviderModelRowV1 = z.infer<typeof DaemonProviderModelRowV1Schema>;

export const DaemonProviderModelsResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    connectionId: ProviderConnectionIdSchema,
    connectionRevision: z.number().int().nonnegative(),
    manualModelPolicy: z.enum(['allowed', 'catalog-only']),
    modelLoadAction: z.enum(['available', 'descriptor_absent', 'feature_disabled']),
    models: z.array(DaemonProviderModelRowV1Schema).max(50_000),
  }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderModelsResponseV1 = z.infer<typeof DaemonProviderModelsResponseV1Schema>;

export const DaemonProviderProbeResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    models: ProviderCatalogProbeModelsV1Schema,
    requestFingerprint: ProviderProbeRequestFingerprintV1Schema,
  }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
  z.object({ status: z.literal('not_supported') }).strict(),
]);
export type DaemonProviderProbeResponseV1 = z.infer<typeof DaemonProviderProbeResponseV1Schema>;

export const DaemonProviderModelLoadResponseV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('loaded'), source: z.enum(['already_loaded', 'requested']) }).strict(),
  z.object({ status: z.literal('not_supported'), reason: z.enum(['feature_disabled', 'descriptor_absent']) }).strict(),
  z.object({ status: z.literal('cancelled'), providerMayContinue: z.literal(true) }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderModelLoadResponseV1 = z.infer<typeof DaemonProviderModelLoadResponseV1Schema>;

const ProviderAuthoringEndpointOverridesV1Schema = z.array(ProviderEndpointOverrideV1Schema)
  .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)
  .superRefine((overrides, ctx) => {
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
  });

export const DaemonProviderConnectionsDescribeRequestV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema.optional(),
  authoringPreview: z.object({
    connectionId: ProviderConnectionIdSchema,
    contributionKey: ProviderContributionKeySchema,
    displayName: z.string().trim().min(1).max(128).nullable(),
    selectedCandidateId: ProviderDiscoveryCandidateIdV1Schema.nullable(),
    endpointOverrides: ProviderAuthoringEndpointOverridesV1Schema.optional(),
  }).strict().optional(),
}).strict();
export type DaemonProviderConnectionsDescribeRequestV1 = z.infer<typeof DaemonProviderConnectionsDescribeRequestV1Schema>;

const ProviderConnectionRpcRuntimeSummaryV1Schema = z.object({
  health: ProviderConnectionSummaryHealthV1Schema,
  modelCount: z.number().int().nonnegative().max(50_000).nullable(),
  checkedAt: z.number().finite().nonnegative().nullable(),
  endpoints: z.array(z.object({
    endpointTemplateId: z.string().trim().min(1).max(128),
    status: ProviderEndpointHealthStatusV1Schema,
    activity: z.enum(['idle', 'checking']),
    observedAt: z.number().finite().nonnegative().nullable(),
    errorCode: z.string().trim().min(1).max(128).nullable(),
    retryAt: z.number().finite().nonnegative().nullable(),
  }).strict()).max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration).default([]),
}).strict();

const ProviderRpcDisplayEndpointUrlV1Schema = z.string().trim().min(1).max(2_048).superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: 'custom', message: 'Endpoint display URL must omit credentials, query, and fragment' });
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Endpoint display URL must be absolute' });
  }
});

const DaemonProviderAuthoringEndpointV1Schema = z.object({
  endpointTemplateId: z.string().trim().min(1).max(128),
  protocol: ProviderWireProtocolSchema,
  normalizedUrl: ProviderRpcDisplayEndpointUrlV1Schema,
  locality: z.enum(['public', 'private', 'loopback']),
  scope: z.enum(['account', 'machine']),
}).strict();

const DaemonProviderAuthoringDestinationV1Schema = z.object({
  scope: z.enum(['account', 'machine']),
  machineId: ProviderMachineIdSchema.nullable(),
  endpoints: z.array(DaemonProviderAuthoringEndpointV1Schema).min(1)
    .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration),
}).strict().superRefine((value, ctx) => {
  if ((value.scope === 'machine') !== (value.machineId !== null)) {
    ctx.addIssue({
      code: 'custom', path: ['machineId'],
      message: 'Machine-scoped authoring destinations require exactly one machine identity',
    });
  }
});

const DaemonProviderAuthoringCredentialV1Schema = z.object({
  slotId: z.literal('apiKey'),
  label: z.literal('api_key'),
  required: z.boolean(),
}).strict();

const ProviderAuthoringReviewFingerprintV1Schema = z.string().trim().min(1).max(256)
  .startsWith('authoring-review:v1:');

export const DaemonProviderContributionAuthoringPreviewV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('selection_required'),
    connectionId: ProviderConnectionIdSchema,
    contributionKey: ProviderContributionKeySchema,
    created: z.boolean(),
    credential: DaemonProviderAuthoringCredentialV1Schema.nullable(),
    candidates: z.array(z.object({
      candidateId: ProviderDiscoveryCandidateIdV1Schema,
      ...DaemonProviderAuthoringDestinationV1Schema.shape,
    }).strict().superRefine((value, ctx) => {
      if ((value.scope === 'machine') !== (value.machineId !== null)) {
        ctx.addIssue({ code: 'custom', path: ['machineId'], message: 'Candidate scope and machine identity disagree' });
      }
    })).min(2).max(32),
  }).strict(),
  z.object({
    status: z.literal('resolved'),
    connectionId: ProviderConnectionIdSchema,
    contributionKey: ProviderContributionKeySchema,
    created: z.boolean(),
    candidateId: ProviderDiscoveryCandidateIdV1Schema.nullable(),
    ...DaemonProviderAuthoringDestinationV1Schema.shape,
    credential: DaemonProviderAuthoringCredentialV1Schema.nullable(),
    fingerprint: ProviderAuthoringReviewFingerprintV1Schema,
    revision: z.number().int().nonnegative(),
  }).strict().superRefine((value, ctx) => {
    if ((value.scope === 'machine') !== (value.machineId !== null)) {
      ctx.addIssue({ code: 'custom', path: ['machineId'], message: 'Review scope and machine identity disagree' });
    }
  }),
]);
export type DaemonProviderContributionAuthoringPreviewV1 = z.infer<typeof DaemonProviderContributionAuthoringPreviewV1Schema>;

export const DaemonProviderConnectionEndpointViewV1Schema = z.object({
  endpointTemplateId: z.string().trim().min(1).max(128),
  protocol: ProviderWireProtocolSchema,
  baseUrl: ProviderRpcDisplayEndpointUrlV1Schema,
  effectiveSource: z.enum(['template', 'accountOverride', 'machineOverride']),
  defaultBaseUrl: ProviderRpcDisplayEndpointUrlV1Schema.nullable().default(null),
  accountOverrideBaseUrl: ProviderRpcDisplayEndpointUrlV1Schema.nullable().default(null),
  machineOverrideBaseUrl: ProviderRpcDisplayEndpointUrlV1Schema.nullable().default(null),
}).strict();

const DaemonProviderAgentCompatibilitySummaryBaseV1Schema = z.object({
  agentTargetKey: BackendTargetKeyV2Schema,
  agentName: z.string().trim().min(1).max(128),
});
export const DaemonProviderAgentCompatibilitySummaryV1Schema = z.discriminatedUnion('status', [
  DaemonProviderAgentCompatibilitySummaryBaseV1Schema.extend({
    status: z.literal('verified'),
    reasons: z.tuple([]),
  }).strict(),
  DaemonProviderAgentCompatibilitySummaryBaseV1Schema.extend({
    status: z.literal('experimental'),
    reasons: z.array(ProviderCompatibilityReasonCodeV1Schema).min(1).max(16),
  }).strict(),
  DaemonProviderAgentCompatibilitySummaryBaseV1Schema.extend({
    status: z.literal('incompatible'),
    reasons: z.array(ProviderCompatibilityReasonCodeV1Schema).min(1).max(16),
  }).strict(),
]);
export type DaemonProviderAgentCompatibilitySummaryV1 = z.infer<typeof DaemonProviderAgentCompatibilitySummaryV1Schema>;

const DaemonProviderManagedConnectedAccountPurposeDeclarationV1Schema =
  z.object({
  purpose: ConnectedAccountPurposeIdSchema,
  service: asProtocolZod(PluginContributionIdentityV1Schema),
  title: PluginLocalizedStringV2Schema.optional(),
  required: z.boolean(),
  materializationKinds: PluginConnectedAccountMaterializationKindsSchema.optional(),
}).strict();

const DaemonProviderManagedConnectedAccountPurposeV1Schema =
  DaemonProviderManagedConnectedAccountPurposeDeclarationV1Schema.extend({
  target: QualifiedConnectedAccountPurposeBindingTargetV1Schema,
}).strict().superRefine((value, context) => {
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
});

const DaemonProviderConnectionDeploymentV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('external'),
  }).strict(),
  z.object({
    kind: z.literal('managedLocal'),
    targetMachineId: ProviderMachineIdSchema,
    effects: z.object({
      implementationIdentity: asProtocolZod(PluginContributionIdentityV1Schema),
      protocols: z.array(ProviderWireProtocolSchema).min(1).max(16),
      connectedAccountPurposes: z.array(
        DaemonProviderManagedConnectedAccountPurposeV1Schema,
      ).max(32),
      connectedAccountPurposeBindingPolicy:
        ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema.optional(),
    }).strict().nullable(),
  }).strict(),
]);

export const DaemonProviderConnectionViewV1Schema = z.object({
  connectionId: ProviderConnectionIdSchema,
  contributionKey: ProviderContributionKeySchema.nullable(),
  provenance: z.enum(['first_party', 'external', 'custom']).default('first_party'),
  displayName: z.string().trim().min(1).max(128),
  providerName: z.string().trim().min(1).max(128),
  icon: z.string().trim().min(1).max(512).nullable(),
  websiteUrl: ProviderHttpsUrlSchema.optional(),
  role: z.enum(['default', 'named']),
  displayNameMode: z.enum(['automatic', 'custom']),
  sourceStatus: z.enum(['available', 'unavailable']),
  probeCapability: z.enum(['catalog', 'availability', 'none']),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  compatibility: z.array(DaemonProviderAgentCompatibilitySummaryV1Schema).max(128),
  grants: z.object({
    accountEnabled: z.boolean(),
    enabledMachineIds: z.array(ProviderMachineIdSchema),
    accountState: z.enum(['absent', 'valid', 'stale']).default('absent'),
    machineState: z.enum(['absent', 'valid', 'stale']).default('absent'),
    effectiveState: z.enum(['absent', 'valid', 'stale']).default('absent'),
  }).strict(),
  credential: z.object({
    required: z.boolean(),
    accountBound: z.boolean(),
    boundMachineIds: z.array(ProviderMachineIdSchema),
    keyUrl: ProviderHttpsUrlSchema.optional(),
  }).strict().nullable(),
  deployment: DaemonProviderConnectionDeploymentV1Schema.default({ kind: 'external' }),
  managedLocalOption: z.object({
    targetMachineId: ProviderMachineIdSchema,
    connectedAccountPurposes: z.array(
      DaemonProviderManagedConnectedAccountPurposeDeclarationV1Schema,
    ).max(32),
    connectedAccountPurposeBindingPolicy:
      ProviderManagedConnectedAccountPurposeBindingPolicyV1Schema.optional(),
  }).strict().nullable().default(null),
  endpoints: z.array(DaemonProviderConnectionEndpointViewV1Schema)
    .max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration),
  scope: z.enum(['account', 'machine']).nullable(),
  authorized: z.boolean(),
  authorizationError: ProviderErrorV1Schema.nullable(),
  revision: z.number().int().nonnegative(),
  probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.nullable().default(null),
  runtime: ProviderConnectionRpcRuntimeSummaryV1Schema,
}).strict().superRefine((value, context) => {
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
});
export type DaemonProviderConnectionViewV1 = z.infer<typeof DaemonProviderConnectionViewV1Schema>;

const ProviderConnectionMutationBaseV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  connectionId: ProviderConnectionIdSchema,
});

const DaemonProviderConnectionDeploymentUpdateV1Schema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('external') }).strict(),
    z.object({
      kind: z.literal('managedLocal'),
      purposeBindingDefaults:
        ProviderConnectionPurposeBindingDefaultsV1Schema,
    }).strict(),
  ],
);

export const DaemonProviderConnectionMutationRequestV1Schema = z.discriminatedUnion('action', [
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('createContribution'),
    contributionKey: ProviderContributionKeySchema,
    displayName: z.string().trim().min(1).max(128).nullable(),
    savedSecretId: z.string().trim().min(1).max(256).nullable(),
    enable: z.boolean(),
    authoringReview: z.object({
      candidateId: ProviderDiscoveryCandidateIdV1Schema.nullable(),
      fingerprint: ProviderAuthoringReviewFingerprintV1Schema,
      revision: z.number().int().nonnegative(),
      endpointOverrides: ProviderAuthoringEndpointOverridesV1Schema.optional(),
    }).strict(),
  }).strict(),
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('createCustom'),
    template: CustomProviderTemplateV1Schema,
    savedSecretId: z.string().trim().min(1).max(256).nullable(),
    enable: z.boolean(),
    manualModels: z.array(z.object({
      id: ProviderModelIdSchema,
      name: z.string().trim().min(1).max(256).optional(),
    }).strict()).max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection).default([]),
  }).strict().superRefine((value, ctx) => {
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
  }),
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('enableDetected'),
    candidateId: ProviderDiscoveryCandidateIdV1Schema,
    displayName: z.string().trim().min(1).max(128).nullable(),
    savedSecretId: z.string().trim().min(1).max(256).nullable(),
  }).strict(),
  z.object({
    action: z.literal('startLocal'),
    machineId: ProviderMachineIdSchema,
    // Compatibility reader for existing UI daemon-RPC callers; remove only
    // after those producers stop sending it. The semantic SDK request is
    // connection-free and its host projection never forwards an author value.
    connectionId: ProviderConnectionIdSchema.optional(),
    contributionKey: ProviderContributionKeySchema,
  }).strict(),
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('update'),
    expectedRevision: z.number().int().nonnegative(),
    displayName: z.string().trim().min(1).max(128).optional(),
    displayNameMode: z.enum(['automatic', 'custom']).optional(),
    deployment: DaemonProviderConnectionDeploymentUpdateV1Schema.optional(),
  }).strict(),
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('setEndpointOverride'),
    expectedRevision: z.number().int().nonnegative(),
    scope: z.enum(['account', 'machine']),
    endpointTemplateId: ProviderEndpointOverrideV1Schema.shape.endpointTemplateId,
    baseUrl: ProviderEndpointOverrideV1Schema.shape.baseUrl.nullable(),
  }).strict(),
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('duplicate'),
    newConnectionId: ProviderConnectionIdSchema,
    displayName: z.string().trim().min(1).max(128),
    mode: z.enum(['sameSource', 'asCustom']),
  }).strict(),
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('delete'),
  }).strict(),
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('setEnabled'),
    enabled: z.boolean(),
    scope: z.enum(['account', 'machine', 'connection']).optional(),
  }).strict().superRefine((value, ctx) => {
    if (!value.enabled && value.scope === undefined) {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Disable requires an explicit access scope' });
    }
    if (value.enabled && value.scope === 'connection') {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'All-scope mutation is disable-only' });
    }
  }),
  ProviderConnectionMutationBaseV1Schema.extend({
    action: z.literal('bindSecret'),
    credentialSlotId: z.literal('apiKey'),
    savedSecretId: z.string().trim().min(1).max(256).nullable(),
    scope: z.enum(['account', 'machine']),
  }).strict(),
]);
export type DaemonProviderConnectionMutationRequestV1 = z.infer<typeof DaemonProviderConnectionMutationRequestV1Schema>;

export const DaemonProviderConnectionsDescribeResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    connections: z.array(DaemonProviderConnectionViewV1Schema),
    available: z.array(z.object({
      contributionKey: ProviderContributionKeySchema,
      name: z.string().trim().min(1).max(128),
      kind: z.enum(['frontier', 'aggregator', 'cloud', 'local']),
      provenance: z.enum(['first_party', 'external']).default('first_party'),
      icon: z.string().trim().min(1).max(512).nullable(),
      websiteUrl: ProviderHttpsUrlSchema.optional(),
      credential: z.object({
        required: z.boolean(),
        keyUrl: ProviderHttpsUrlSchema.optional(),
      }).strict().nullable(),
      endpointTemplates: z.array(z.object({
        id: ProviderEndpointOverrideV1Schema.shape.endpointTemplateId,
        protocol: ProviderWireProtocolSchema,
      }).strict()).max(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration).default([]),
    }).strict()),
    discoveryCandidates: z.array(ProviderDiscoveryCandidateV1Schema),
    discoveryCandidatesTruncated: z.boolean().default(false),
    localInstallations: z.array(ProviderLocalInstallationSummaryV1Schema).max(4_096).default([]),
    diagnosticsTruncated: z.boolean(),
    diagnostics: z.array(z.object({
      path: z.string().trim().min(1).max(512),
      reason: z.string().trim().min(1).max(128),
    }).strict()).max(PROVIDER_SETTINGS_LIMITS_V1.readDiagnostics),
    availableTruncated: z.boolean(),
    authoringPreview: DaemonProviderContributionAuthoringPreviewV1Schema.optional(),
    deletedConnection: z.object({
      connectionId: ProviderConnectionIdSchema,
      contributionKey: ProviderContributionKeySchema.nullable(),
      lastDisplayName: z.string().trim().min(1).max(128),
      deletedAt: z.number().finite().nonnegative(),
    }).strict().nullable().optional(),
  }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderConnectionsDescribeResponseV1 = z.infer<typeof DaemonProviderConnectionsDescribeResponseV1Schema>;

export const DaemonProviderConnectionMutationResponseV1Schema = z.union([
  z.object({
    status: z.literal('success'),
    action: z.enum(['createContribution', 'createCustom', 'enableDetected', 'update', 'setEndpointOverride', 'duplicate', 'setEnabled', 'bindSecret']),
    connection: DaemonProviderConnectionViewV1Schema,
    created: z.boolean().optional(),
  }).strict(),
  z.object({ status: z.literal('success'), action: z.literal('delete'), deletedConnectionId: ProviderConnectionIdSchema }).strict(),
  z.object({
    status: z.literal('success'),
    action: z.literal('startLocal'),
    contributionKey: ProviderContributionKeySchema,
    phase: z.enum(['detecting', 'running']),
  }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderConnectionMutationResponseV1 = z.infer<typeof DaemonProviderConnectionMutationResponseV1Schema>;

export const DaemonProviderModelProjectionRequestV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  agentTargetKey: BackendTargetKeyV2Schema,
  mode: z.enum(['picker', 'management']).optional(),
  /** Explicit user retry; automatic reads stay backoff-aware. */
  forceRefresh: z.literal(true).optional(),
  currentSelection: ProviderBoundModelRefSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.currentSelection && value.currentSelection.agentTargetKey !== value.agentTargetKey) {
    ctx.addIssue({ code: 'custom', path: ['currentSelection', 'agentTargetKey'], message: 'Current selection belongs to another agent target' });
  }
});
export type DaemonProviderModelProjectionRequestV1 = z.infer<typeof DaemonProviderModelProjectionRequestV1Schema>;

const ProviderCompatibilityFingerprintV1Schema = z.string().trim().min(1).max(256)
  .startsWith('compatibility:v1:');

export const DaemonProviderModelProjectionRowV1Schema = z.object({
  ref: ProviderBoundModelRefSchema,
  descriptor: ProviderModelDescriptorV1Schema,
  sources: z.object({ manual: z.boolean(), static: z.boolean(), probe: z.boolean() }).strict(),
  confidence: z.enum(['manual', 'verified_static', 'probe', 'account_unverified']),
  compatibility: z.object({
    result: ProviderBindingCompatibilityV1Schema,
    compatibilityFingerprint: ProviderCompatibilityFingerprintV1Schema,
    confirmed: z.boolean(),
  }).strict(),
  endpointHealth: ProviderEndpointHealthStatusV1Schema,
  catalog: z.object({
    stale: z.boolean(),
    observedAt: z.number().finite().nonnegative().optional(),
    staleAt: z.number().finite().nonnegative().optional(),
  }).strict(),
  loadState: ProviderModelLoadStateV1Schema,
  visibility: z.enum(['visible', 'hidden_agent', 'hidden_all_agents', 'hidden_current_selection']),
}).strict();
export type DaemonProviderModelProjectionRowV1 = z.infer<typeof DaemonProviderModelProjectionRowV1Schema>;

export const DaemonProviderModelProjectionGroupV1Schema = z.object({
  connectionId: ProviderConnectionIdSchema,
  providerName: z.string().trim().min(1).max(128),
  connectionName: z.string().trim().min(1).max(128),
  connectionRole: z.enum(['default', 'named']),
  connectionDisplayNameMode: z.enum(['automatic', 'custom']),
  connectionRevision: z.number().int().nonnegative(),
  modelLoadAction: z.enum(['available', 'descriptor_absent', 'feature_disabled']),
  modelLoadPreflightPolicy: z.enum(['advisory', 'required']).nullable().optional(),
  authorization: z.union([
    z.object({ authorized: z.literal(true) }).strict(),
    z.object({ authorized: z.literal(false), error: ProviderErrorV1Schema }).strict(),
  ]),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  supportsFreeformModelIds: z.boolean(),
  suppressedConnectedServiceIds: z.array(ConnectedServiceIdSchema).max(32),
  rows: z.array(DaemonProviderModelProjectionRowV1Schema)
    .max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection + 1),
}).strict().superRefine((value, ctx) => {
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
});
export type DaemonProviderModelProjectionGroupV1 = z.infer<typeof DaemonProviderModelProjectionGroupV1Schema>;

export const DaemonProviderCurrentSelectionRecoveryV1Schema = z.object({
  kind: z.enum([
    'contribution_unavailable',
    'connection_deleted',
    'connection_missing',
    'model_not_found',
  ]),
  ref: ProviderBoundModelRefSchema,
  error: ProviderErrorV1Schema,
  displaySnapshot: z.object({
    providerName: z.string().trim().min(1).max(128).optional(),
    connectionName: z.string().trim().min(1).max(128).optional(),
    modelName: z.string().trim().min(1).max(256).optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.providerName === undefined
      && value.connectionName === undefined
      && value.modelName === undefined) {
      ctx.addIssue({ code: 'custom', message: 'A recovery display snapshot must contain a display fact' });
    }
  }).nullable(),
}).strict().superRefine((value, ctx) => {
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
});
export type DaemonProviderCurrentSelectionRecoveryV1 = z.infer<typeof DaemonProviderCurrentSelectionRecoveryV1Schema>;

/**
 * One connection whose requested refresh settled with the existing typed
 * Provider failure. A projection can still succeed partially: usable groups
 * render from their observations while every failed connection carries its
 * own typed recovery fact beside them.
 */
const DaemonProviderModelProjectionRefreshFailureV1Schema = z.object({
  connectionId: ProviderConnectionIdSchema,
  error: ProviderErrorV1Schema,
}).strict();
export type DaemonProviderModelProjectionRefreshFailureV1 = z.infer<
  typeof DaemonProviderModelProjectionRefreshFailureV1Schema
>;

export const DaemonProviderModelProjectionResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    agentTargetKey: BackendTargetKeyV2Schema,
    groups: z.array(DaemonProviderModelProjectionGroupV1Schema),
    currentSelectionRecovery: DaemonProviderCurrentSelectionRecoveryV1Schema.nullable().optional(),
    refreshFailures: z.array(DaemonProviderModelProjectionRefreshFailureV1Schema).optional(),
  }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderModelProjectionResponseV1 = z.infer<typeof DaemonProviderModelProjectionResponseV1Schema>;

const ProviderModelSettingsMutationBaseV1Schema = z.object({ machineId: ProviderMachineIdSchema });
const ProviderManualModelMutationInputV1Schema = z.object({
  id: ProviderModelIdSchema,
  name: z.string().trim().min(1).max(256).optional(),
}).strict();
export const DaemonProviderModelSettingsMutationRequestV1Schema = z.discriminatedUnion('action', [
  ProviderModelSettingsMutationBaseV1Schema.extend({
    action: z.literal('manualAdd'), connectionId: ProviderConnectionIdSchema,
    expectedConnectionRevision: z.number().int().nonnegative(),
    models: z.array(ProviderManualModelMutationInputV1Schema)
      .min(1)
      .max(PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection),
  }).strict().superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.models.forEach((model, index) => {
      if (seen.has(model.id)) {
        ctx.addIssue({ code: 'custom', path: ['models', index, 'id'], message: 'Duplicate manual model id' });
      }
      seen.add(model.id);
    });
  }),
  ProviderModelSettingsMutationBaseV1Schema.extend({
    action: z.literal('manualRemove'), connectionId: ProviderConnectionIdSchema, modelId: ProviderModelIdSchema,
    expectedConnectionRevision: z.number().int().nonnegative(),
  }).strict(),
  ProviderModelSettingsMutationBaseV1Schema.extend({
    action: z.literal('setVisibility'), ref: ModelVisibilityRefV1Schema, hidden: z.boolean(),
  }).strict(),
  ProviderModelSettingsMutationBaseV1Schema.extend({
    action: z.literal('resetVisibility'),
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('agent'), agentTargetKey: BackendTargetKeyV2Schema }).strict(),
      z.object({ kind: z.literal('connection'), connectionId: ProviderConnectionIdSchema }).strict(),
    ]),
  }).strict(),
  ProviderModelSettingsMutationBaseV1Schema.extend({
    action: z.literal('bulkVisibility'),
    changes: z.array(z.object({
      ref: ModelVisibilityRefV1Schema,
      hidden: z.boolean(),
    }).strict()).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection),
  }).strict().superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.changes.forEach((change, index) => {
      const key = serializeModelVisibilityRefV1(change.ref);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['changes', index, 'ref'], message: 'Duplicate model visibility ref' });
      }
      seen.add(key);
    });
  }),
  ProviderModelSettingsMutationBaseV1Schema.extend({
    action: z.literal('confirmExperimental'), connectionId: ProviderConnectionIdSchema,
    expectedConnectionRevision: z.number().int().nonnegative(),
    agentTargetKey: BackendTargetKeyV2Schema, modelId: ProviderModelIdSchema.nullable(),
    compatibilityFingerprint: ProviderCompatibilityFingerprintV1Schema,
  }).strict(),
]);
export type DaemonProviderModelSettingsMutationRequestV1 = z.infer<typeof DaemonProviderModelSettingsMutationRequestV1Schema>;

export const DaemonProviderModelSettingsMutationResponseV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), action: z.enum([
    'manualAdd', 'manualRemove', 'setVisibility', 'resetVisibility', 'bulkVisibility', 'confirmExperimental',
  ]) }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderModelSettingsMutationResponseV1 = z.infer<typeof DaemonProviderModelSettingsMutationResponseV1Schema>;

export const DaemonProviderBindingStatusRequestV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  agentTargetKey: BackendTargetKeyV2Schema,
  selection: SessionModelSelectionV1Schema,
  launchBinding: SessionProviderBindingMetadataV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.selection.ref.agentTargetKey !== value.agentTargetKey) {
    ctx.addIssue({ code: 'custom', path: ['selection', 'ref', 'agentTargetKey'], message: 'Selection belongs to another agent target' });
  }
  if (value.selection.ref.providerConnectionId === null
    || value.selection.ref.providerConnectionId !== value.launchBinding.connectionId) {
    ctx.addIssue({ code: 'custom', path: ['launchBinding', 'connectionId'], message: 'Launch binding does not match the provider selection' });
  }
});
export type DaemonProviderBindingStatusRequestV1 = z.infer<typeof DaemonProviderBindingStatusRequestV1Schema>;

export const DaemonProviderBindingStatusResponseV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('current') }).strict(),
  z.object({
    status: z.literal('changed'),
    nextBindingSecurityFingerprint: z.string().trim().min(1).max(256),
  }).strict(),
  ...(['connection_missing', 'contribution_unavailable', 'disabled', 'grant_stale', 'incompatible'] as const)
    .map((status) => z.object({ status: z.literal(status), error: ProviderErrorV1Schema }).strict()),
]);
export type DaemonProviderBindingStatusResponseV1 = z.infer<typeof DaemonProviderBindingStatusResponseV1Schema>;

const ProviderProfileMigrationSourceFingerprintV1Schema = z.string().trim().min(1).max(256)
  .startsWith('legacy-profile-migration-source:v1:');

const DaemonProviderProfileMigrationRequestBaseV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  sourceProfileId: ProviderMigrationSourceProfileIdSchema,
  reviewedMapping: LegacyProfileReviewedMappingV1Schema,
});

export const DaemonProviderProfileMigrationPreviewRequestV1Schema =
  DaemonProviderProfileMigrationRequestBaseV1Schema.strict();
export type DaemonProviderProfileMigrationPreviewRequestV1 = z.infer<
  typeof DaemonProviderProfileMigrationPreviewRequestV1Schema
>;

export const DaemonProviderProfileMigrationPreviewResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    sourceFingerprint: ProviderProfileMigrationSourceFingerprintV1Schema,
  }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderProfileMigrationPreviewResponseV1 = z.infer<
  typeof DaemonProviderProfileMigrationPreviewResponseV1Schema
>;

export const DaemonProviderProfileMigrationConfirmRequestV1Schema =
  DaemonProviderProfileMigrationRequestBaseV1Schema.extend({
    expectedSourceFingerprint: ProviderProfileMigrationSourceFingerprintV1Schema,
  }).strict();
export type DaemonProviderProfileMigrationConfirmRequestV1 = z.infer<
  typeof DaemonProviderProfileMigrationConfirmRequestV1Schema
>;

export const DaemonProviderProfileMigrationConfirmResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    connectionId: ProviderConnectionIdSchema,
    settingsVersion: z.number().int().nonnegative(),
  }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderProfileMigrationConfirmResponseV1 = z.infer<
  typeof DaemonProviderProfileMigrationConfirmResponseV1Schema
>;

export const DaemonProviderProfileMigrationConflictConfirmRequestV1Schema = z.object({
  machineId: ProviderMachineIdSchema,
  sourceProfileId: LegacyProfileMigrationConflictResolutionV1Schema.shape.sourceProfileId,
  expectedCandidateFingerprint:
    LegacyProfileMigrationConflictResolutionV1Schema.shape.expectedCandidateFingerprint,
  decision: LegacyProfileMigrationConflictResolutionV1Schema.shape.decision,
}).strict();
export type DaemonProviderProfileMigrationConflictConfirmRequestV1 = z.infer<
  typeof DaemonProviderProfileMigrationConflictConfirmRequestV1Schema
>;

export const DaemonProviderProfileMigrationConflictConfirmResponseV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    connectionId: ProviderConnectionIdSchema,
    settingsVersion: z.number().int().nonnegative(),
  }).strict(),
  z.object({ status: z.literal('error'), error: ProviderErrorV1Schema }).strict(),
]);
export type DaemonProviderProfileMigrationConflictConfirmResponseV1 = z.infer<
  typeof DaemonProviderProfileMigrationConflictConfirmResponseV1Schema
>;
