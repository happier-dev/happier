import { z } from 'zod';

import {
  HookCategoryV1Schema,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
} from '../../hooks/hookExecutionSemantics.js';
import { PluginLooseJsonObjectSchema, PluginOptionalStringSchema } from '../_shared.js';
import {
  PluginActionContributionV2Schema,
  PluginActionAvailabilityV2Schema,
  PluginJsonSchemaV2Schema,
  PluginToolContributionV2Schema,
} from '../actions/v2.js';
import {
  PluginNotificationCategoryContributionV2Schema,
  PluginNotificationChannelContributionV2Schema,
} from './notifications.js';
import {
  ScmHostingProviderContributionSchema,
} from './scmHostingProviders.js';
import {
  ScmBackendContributionSchema,
} from './scmBackends.js';
import {
  PluginManagedDependencyContributionV2Schema,
} from './managedDependencies.js';
import {
  PluginMcpContributesV1Schema,
} from './mcp.js';
import {
  PluginRequestInterceptorContributionV1Schema,
} from '../requestInterceptors/v1.js';
import {
  PluginSettingsContributionV2Schema,
} from './settings.js';
import {
  PluginExecutionRunProfileContributionV2Schema,
} from './executionRunProfiles.js';
import {
  PluginEventContributionV1Schema,
} from './events.js';
import {
  PluginHookIdV1Schema,
  PluginHookScopeV1Schema,
  type PluginHookScopeV1,
} from '../hooks/catalog.js';
import {
  PluginSystemToolContributionV1Schema,
} from './systemTools.js';
import {
  PluginPromptAssetContributionV1Schema,
} from './promptAssets.js';
import {
  PluginUiTranslationsContributionV1Schema,
} from './ui/i18n.js';
import {
  PluginStructuredMessageDescriptorV1Schema,
} from './ui/structuredMessages.js';
import {
  PluginSessionHeaderActionDescriptorV1Schema,
} from './ui/sessionHeaderActions.js';
import {
  PluginSurfacePlacementDescriptorV1Schema,
} from './ui/surfacePlacements.js';
import {
  PluginHostedWebContributionV1Schema,
} from './ui/hostedWeb.js';
import {
  PluginReactNativeBundleContributionV1Schema,
} from './ui/reactNativeBundles.js';
import {
  PluginUiArtifactContributionV1Schema,
} from './ui/artifacts.js';
import {
  PluginBrowserActionContributionV1Schema,
  PluginBrowserTargetContributionV1Schema,
} from './browser/v1.js';
import {
  buildPluginContributionFamilySchemaV2,
  definePluginContributionFamilyV2,
} from './families.js';
import { ProviderContributionV1Schema } from '../../providers/contributions/v1.js';
import { AgentProviderRequirementsV1Schema } from '../../providers/compatibility/v1.js';
import { VoiceModelPackContributionV1Schema } from '../../voice/modelPacks/contributionV1.js';
import { PluginVoiceProviderContributionV1Schema } from './voiceProviders.js';
import { PluginAgentAcpTransportSchema } from './agentAcpTransport.js';
import { PluginAgentCliMetadataSchema } from './agentCliMetadata.js';
import { MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION } from '../contributionLimits.js';
import {
  PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema,
  PluginBackendExternalSessionSourceDeclarationV1Schema,
} from '../backendDefinitionV1.js';
import { PluginUiContributionsV2Schema } from './ui/v2.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import { ConnectedAccountPurposeDeclarationsV1Schema } from '../../connect/connectedAccountPurposes.js';
import {
  PluginConnectedAccountAuthenticationV2Schema,
} from '../../connect/pluginConnectedAccountAuthenticationV2.js';

const LEGACY_ACTIVITY_PROVIDER_FAMILY = `activity${'Providers'}`;
const PluginVoiceModelPackContributionV2Schema = VoiceModelPackContributionV1Schema
  .omit({ id: true })
  .extend({ id: PluginContributionLocalIdSchema })
  .strict();

const PluginHookRegistrationFilterV1Schema = z.object({
  agentId: z.string().trim().min(1).optional(),
  runtimeTargetId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  cwdPrefix: z.string().trim().min(1).optional(),
  machineId: z.string().trim().min(1).optional(),
  eventNames: z.array(z.string().trim().min(1)).optional(),
}).strict();

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectForbiddenKey(
  ctx: z.RefinementCtx,
  key: string,
  message: string,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [key],
    message,
  });
}

export const PluginAgentRuntimeAcpV2Schema = z.object({
  kind: z.literal('acp'),
  transport: PluginAgentAcpTransportSchema,
}).strict();
export type PluginAgentRuntimeAcpV2 = z.infer<typeof PluginAgentRuntimeAcpV2Schema>;

export const PluginAgentRuntimeCustomV2Schema = z.object({
  kind: z.literal('custom'),
}).strict();
export type PluginAgentRuntimeCustomV2 = z.infer<typeof PluginAgentRuntimeCustomV2Schema>;

export const PluginAgentRuntimeV2Schema = z.discriminatedUnion('kind', [
  PluginAgentRuntimeAcpV2Schema,
  PluginAgentRuntimeCustomV2Schema,
]);
export type PluginAgentRuntimeV2 = z.infer<typeof PluginAgentRuntimeV2Schema>;

const PluginAgentGoalSetCapabilityV2Schema = z.object({
  fields: z.array(z.enum(['objective', 'status', 'tokenBudget'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  writableStatuses: z.array(z.enum(['active', 'paused', 'complete'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.').optional(),
}).strict();
const PluginAgentGoalControlModeV2Schema = z.object({
  get: z.literal(true).optional(), clear: z.literal(true).optional(), set: PluginAgentGoalSetCapabilityV2Schema.optional(),
}).strict().refine((value) => value.get || value.clear || value.set, 'At least one goal control capability is required.');
const activity = <T extends z.ZodTypeAny>(schema: T) => z.object({ active: schema.optional(), inactive: schema.optional() }).strict()
  .refine((value) => value.active !== undefined || value.inactive !== undefined, 'At least one activity capability is required.');
const PluginAgentGoalsV2Schema = z.object({
  active: PluginAgentGoalControlModeV2Schema.optional(),
  inactive: PluginAgentGoalControlModeV2Schema.optional(),
  source: z.string().trim().min(1),
}).strict().refine((value) => value.active !== undefined || value.inactive !== undefined, 'At least one activity capability is required.');
const PluginAgentSessionCapabilitiesV2Schema = z.object({
  open: z.array(z.enum(['create', 'resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  delivery: z.array(z.enum(['newTurn', 'steer', 'followUp'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'),
  cancel: z.boolean(), configuration: z.boolean().optional(),
  compaction: z.object({ events: z.literal(true), manual: z.literal(true).optional() }).strict().optional(),
  conversationRollback: z.literal(true).optional(),
  goals: PluginAgentGoalsV2Schema.optional(),
  catalog: activity(z.array(z.enum(['vendorPlugins', 'skills'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.')).optional(),
  usageLimitRecovery: activity(z.array(z.enum(['checkNow', 'consumeResetCredit'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.')).optional(),
  continuationVerification: z.object({ intents: z.array(z.enum(['resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'), requirement: z.enum(['required', 'advisory']) }).strict().optional(),
  workStateSources: z.array(z.object({ id: PluginContributionLocalIdSchema, itemKinds: z.array(z.enum(['goal', 'task', 'todo'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.') }).strict()).max(32).refine((values) => new Set(values.map((value) => value.id)).size === values.length, 'Work-state source ids must be unique.').optional(),
  runtimeActivitySnapshots: z.literal(true).optional(),
  startupInstructions: z.object({
    versions: z.tuple([z.literal(1)]),
  }).strict().optional(),
}).strict();
const PluginAgentExecutionRunCapabilitiesV2Schema = z.object({
  open: z.array(z.enum(['create', 'resume', 'fork'])).min(1).refine((values) => new Set(values).size === values.length, 'Entries must be unique.'), checkpoint: z.boolean(), stop: z.boolean(),
}).strict();
const auxiliary = { surfaces: z.array(z.enum(['terminal', 'externalSessions'])).refine((values) => new Set(values).size === values.length, 'Entries must be unique.').optional() };
const PluginAgentDisplayV2Shape = {
  id: PluginContributionLocalIdSchema, title: PluginLocalizedStringV2Schema, description: PluginLocalizedStringV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  connectedAccounts: ConnectedAccountPurposeDeclarationsV1Schema.optional(),
  providerRequirements: AgentProviderRequirementsV1Schema.optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  surfaces: z.object({
    externalSession: z.object({
      sources: z.array(PluginBackendExternalSessionSourceDeclarationV1Schema)
        .min(1)
        .max(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION),
      externalLinkedTakeover: z.object({
        writerSafety: PluginAgentExternalLinkedTakeoverWriterSafetyV1Schema,
      }).strict().optional(),
    }).strict(),
  }).strict().optional(),
  cli: PluginAgentCliMetadataSchema.optional(),
};
const PluginAgentSessionPrimaryShape = {
  primary: z.literal('sessions'),
  capabilities: z.object({ ...auxiliary, sessions: PluginAgentSessionCapabilitiesV2Schema, executionRuns: PluginAgentExecutionRunCapabilitiesV2Schema.optional() }).strict(),
};
const PluginAgentExecutionPrimaryShape = {
  primary: z.literal('executionRuns'),
  capabilities: z.object({ ...auxiliary, executionRuns: PluginAgentExecutionRunCapabilitiesV2Schema, sessions: PluginAgentSessionCapabilitiesV2Schema.optional() }).strict(),
};
const PluginAgentPrimaryContributionV2Schema = z.union([
  z.object({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeAcpV2Schema, ...PluginAgentSessionPrimaryShape }).strict(),
  z.object({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeCustomV2Schema, ...PluginAgentSessionPrimaryShape }).strict(),
  z.object({ ...PluginAgentDisplayV2Shape, runtime: PluginAgentRuntimeCustomV2Schema, ...PluginAgentExecutionPrimaryShape }).strict(),
]);
const PluginAgentExternalSessionsAuxiliaryV2Schema = z.object({
  ...PluginAgentDisplayV2Shape,
  capabilities: z.object({
    surfaces: z.array(z.enum(['terminal', 'externalSessions']))
      .min(1)
      .refine((values) => new Set(values).size === values.length, 'Entries must be unique.')
      .refine((values) => values.includes('externalSessions'), 'An auxiliary-only Agent must declare the externalSessions surface.'),
  }).strict(),
}).strict();

export const PluginAgentContributionV2Schema = z.union([
  PluginAgentPrimaryContributionV2Schema,
  PluginAgentExternalSessionsAuxiliaryV2Schema,
]).superRefine((value, ctx) => {
  const declaresExternalSessions = value.capabilities.surfaces?.includes('externalSessions') === true;
  const hasExternalSessionDescriptor = value.surfaces?.externalSession !== undefined;
  if (declaresExternalSessions && !hasExternalSessionDescriptor) {
    ctx.addIssue({
      code: 'custom',
      path: ['surfaces', 'externalSession'],
      message: 'The externalSessions capability requires an externalSession source descriptor.',
    });
  }
  if (hasExternalSessionDescriptor && !declaresExternalSessions) {
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities', 'surfaces'],
      message: 'External-session source descriptors require the externalSessions capability.',
    });
  }
});
export type PluginAgentContributionV2 = z.input<typeof PluginAgentContributionV2Schema>;
export type ParsedPluginAgentContributionV2 = z.output<typeof PluginAgentContributionV2Schema>;

export const PluginCommandVisibilityV2Schema = z.enum(['default', 'advanced']);
export type PluginCommandVisibilityV2 = z.infer<typeof PluginCommandVisibilityV2Schema>;

export const PluginCommandContributionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: z.union([z.string().trim().min(1), z.object({ key: z.string().trim().min(1), fallback: z.string().trim().min(1) }).strict()]),
  description: z.union([z.string().trim().min(1), z.object({ key: z.string().trim().min(1), fallback: z.string().trim().min(1) }).strict()]).optional(),
  path: z.array(z.string().trim().min(1)).min(1),
  action: z.union([z.string().trim().min(1), z.object({ pluginId: z.string().min(1), localId: z.string().min(1) }).strict()]),
  visibility: PluginCommandVisibilityV2Schema.optional(),
  arguments: PluginJsonSchemaV2Schema.optional(),
  tmux: z.enum(['inherit', 'required', 'forbidden']).optional(),
  availability: PluginActionAvailabilityV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginCommandContributionV2 = z.infer<typeof PluginCommandContributionV2Schema>;

export const PluginResourceKindV2Schema = z.enum(['prompt', 'skill', 'template', 'asset', 'config']);
export type PluginResourceKind = z.infer<typeof PluginResourceKindV2Schema>;
export type PluginResourceKindV2 = PluginResourceKind;

export const PluginResourceContributionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  kind: PluginResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: z.string().trim().min(1).optional(),
  contentType: z.string().trim().min(1),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginResourceContributionV2 = z.infer<typeof PluginResourceContributionV2Schema>;

export { PluginHookScopeV1Schema, type PluginHookScopeV1 };

export const PluginHookContributionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  on: PluginHookIdV1Schema,
  hookApiVersion: z.literal(1).default(1),
  category: HookCategoryV1Schema,
  scope: PluginHookScopeV1Schema,
  filters: PluginHookRegistrationFilterV1Schema.optional(),
  executionKind: HookExecutionKindV1Schema,
  priority: z.number().int().optional(),
  hostAccess: z.array(PluginContributionLocalIdSchema)
    .min(1)
    .refine((values) => new Set(values).size === values.length, 'Entries must be unique.')
    .optional(),
  compatibility: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginHookContributionV2 = z.infer<typeof PluginHookContributionV2Schema>;

export const PluginConnectedAccountDescriptorContributionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  authentication: PluginConnectedAccountAuthenticationV2Schema,
  capabilities: z.array(z.string().trim().min(1)).optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginConnectedAccountDescriptorContributionV2 =
  z.infer<typeof PluginConnectedAccountDescriptorContributionV2Schema>;

export {
  PluginConnectedAccountAuthenticationModeV2Schema,
  PluginConnectedAccountAuthenticationV2Schema,
  PluginConnectedAccountConfigurationFieldV2Schema,
  PluginConnectedAccountConfigurationV2Schema,
  type PluginConnectedAccountAuthenticationModeV2,
  type PluginConnectedAccountAuthenticationV2,
  type PluginConnectedAccountConfigurationFieldV2,
  type PluginConnectedAccountConfigurationV2,
} from '../../connect/pluginConnectedAccountAuthenticationV2.js';

export const PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 = [
  definePluginContributionFamilyV2({ family: 'agents', schema: PluginAgentContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'providers', schema: ProviderContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'actions', schema: PluginActionContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'commands', schema: PluginCommandContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'tools', schema: PluginToolContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'resources', schema: PluginResourceContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'structuredMessages', schema: PluginStructuredMessageDescriptorV1Schema }),
  definePluginContributionFamilyV2({ family: 'sessionHeaderActions', schema: PluginSessionHeaderActionDescriptorV1Schema }),
  definePluginContributionFamilyV2({ family: 'browserTargets', schema: PluginBrowserTargetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'browserActions', schema: PluginBrowserActionContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'settings', schema: PluginSettingsContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'events', schema: PluginEventContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'executionRunProfiles', schema: PluginExecutionRunProfileContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'notifications', schema: PluginNotificationCategoryContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'notificationChannels', schema: PluginNotificationChannelContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'scmHostingProviders', schema: ScmHostingProviderContributionSchema }),
  definePluginContributionFamilyV2({ family: 'scmBackends', schema: ScmBackendContributionSchema }),
  definePluginContributionFamilyV2({ family: 'connectedAccountDescriptors', schema: PluginConnectedAccountDescriptorContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'managedDependencies', schema: PluginManagedDependencyContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'systemTools', schema: PluginSystemToolContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'promptAssets', schema: PluginPromptAssetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'hooks', schema: PluginHookContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'requestInterceptors', schema: PluginRequestInterceptorContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'voiceModelPacks', schema: PluginVoiceModelPackContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'voiceProviders', schema: PluginVoiceProviderContributionV1Schema }),
] as const;

const PluginContributesV2BaseSchema = buildPluginContributionFamilySchemaV2(
  PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2,
);

const PluginContributesV2SchemaWithoutDefault = PluginContributesV2BaseSchema.extend({
  mcp: PluginMcpContributesV1Schema,
  ui: PluginUiContributionsV2Schema,
}).superRefine((value, ctx) => {
  if (hasOwn(value, LEGACY_ACTIVITY_PROVIDER_FAMILY)) {
    rejectForbiddenKey(ctx, LEGACY_ACTIVITY_PROVIDER_FAMILY, 'Activity providers were folded into contributes.notifications; use notification categories instead.');
  }
  const providerIds = new Set<string>();
  value.providers.forEach((provider, index) => {
    if (providerIds.has(provider.id)) {
      ctx.addIssue({ code: 'custom', path: ['providers', index, 'id'], message: 'Duplicate provider contribution id' });
    }
    providerIds.add(provider.id);
  });
  const voiceModelPackIds = new Set<string>();
  value.voiceModelPacks.forEach((modelPack, index) => {
    if (voiceModelPackIds.has(modelPack.id)) {
      ctx.addIssue({ code: 'custom', path: ['voiceModelPacks', index, 'id'], message: 'Duplicate voice model-pack contribution id' });
    }
    voiceModelPackIds.add(modelPack.id);
  });
  const voiceProviderIds = new Set<string>();
  value.voiceProviders.forEach((provider, index) => {
    if (voiceProviderIds.has(provider.id)) {
      ctx.addIssue({ code: 'custom', path: ['voiceProviders', index, 'id'], message: 'Duplicate voice provider contribution id' });
    }
    voiceProviderIds.add(provider.id);
  });
});

export const PluginContributesV2Schema = PluginContributesV2SchemaWithoutDefault.default(
  PluginContributesV2SchemaWithoutDefault.parse({}),
);
export type PluginContributesV2 = z.infer<typeof PluginContributesV2Schema>;

export {
  PluginVoiceProviderContributionV1Schema,
  type PluginVoiceProviderContributionV1,
  VoiceProviderAccountOperationKindV1Schema,
  type VoiceProviderAccountOperationKindV1,
} from './voiceProviders.js';

export {
  PluginSystemToolContributionV1Schema,
  type PluginSystemToolContributionV1,
} from './systemTools.js';

export {
  PluginPromptAssetContributionV1Schema,
  type PluginPromptAssetContributionV1,
} from './promptAssets.js';

export {
  PluginUiTranslationsContributionV1Schema,
  type PluginUiTranslationsContributionV1,
} from './ui/i18n.js';
export {
  MAX_PLUGIN_STRUCTURED_MESSAGE_REFERENCES_V1,
  PluginStructuredMessageDescriptorV1Schema,
  type PluginStructuredMessageDescriptorV1,
} from './ui/structuredMessages.js';
export {
  PluginSessionHeaderActionDescriptorV1Schema,
  type PluginSessionHeaderActionDescriptorV1,
} from './ui/sessionHeaderActions.js';
export {
  PluginSurfaceBrowserHostActionEffectV1Schema,
  PluginSurfaceBrowserHostActionPolicyOwnerV1Schema,
  PluginSurfaceHostActionDescriptorV1Schema,
  PluginSurfacePlacementDescriptorV1Schema,
  PluginSurfacePlacementKindV1Schema,
  PluginSurfaceRendererRefV1Schema,
  type PluginSurfaceBrowserHostActionEffectV1,
  type PluginSurfaceBrowserHostActionPolicyOwnerV1,
  type PluginSurfaceHostActionDescriptorV1,
  type PluginSurfacePlacementDescriptorV1,
  type PluginSurfacePlacementKindV1,
  type PluginSurfaceRendererRefV1,
} from './ui/surfacePlacements.js';
export {
  PluginBrowserPanelHostActionScopeV1Schema,
  PluginSurfaceAppTargetV1Schema,
  PluginSurfaceBrowserTargetV1Schema,
  PluginSurfaceProjectTargetV1Schema,
  PluginSurfaceSessionTargetV1Schema,
  PluginSurfaceTargetV1Schema,
  PluginSurfaceWorkspaceTargetV1Schema,
  type PluginBrowserPanelHostActionScopeV1,
  type PluginSurfaceTargetV1,
} from './ui/surfaceTargets.js';
export {
  PluginHostedWebContributionV1Schema,
  type PluginHostedWebContributionV1,
} from './ui/hostedWeb.js';
export {
  PluginHostedWebCspPolicyV1Schema,
  PluginHostedWebOriginV1Schema,
  PluginHostedWebSecurityPolicyV1Schema,
  buildPluginHostedWebStaticAssetContentSecurityPolicyV1,
  resolvePluginHostedWebSourceMapPolicyV1,
  type PluginHostedWebCspPolicyV1,
  type PluginHostedWebOriginV1,
  type PluginHostedWebSecurityPolicyV1,
} from './ui/hostedWebSecurity.js';
export {
  PluginReactNativeBundleContributionV1Schema,
  type PluginReactNativeBundleContributionV1,
} from './ui/reactNativeBundles.js';
export {
  PluginUiArtifactContributionV1Schema,
  type PluginUiArtifactContributionV1,
} from './ui/artifacts.js';
export {
  PluginBrowserActionContributionV1Schema,
  PluginBrowserTargetContributionV1Schema,
  type PluginBrowserActionContributionV1,
  type PluginBrowserTargetContributionV1,
} from './browser/v1.js';
