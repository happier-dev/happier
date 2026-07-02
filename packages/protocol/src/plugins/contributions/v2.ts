import { z } from 'zod';

import {
  HookCategoryV1Schema,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
} from '../../hooks/hookExecutionSemantics.js';
import { AgentDefinitionV1Schema } from '../agentDefinitionV1.js';
import { PluginBackendDefinitionV1BaseSchema } from '../backendDefinitionV1.js';
import { PluginLooseJsonObjectSchema, PluginOptionalStringSchema } from '../_shared.js';
import {
  PluginActionContributionV2Schema,
  PluginExecutableHandlerRefV1Schema,
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
  PluginConnectedAccountDescriptorSchema,
} from '../../connect/connectedAccountDescriptors.js';
import {
  PluginInstallableContributionV2Schema,
} from './installables.js';
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
  PluginSessionSurfaceDescriptorV1Schema,
} from './ui/sessionSurfaces.js';
import {
  PluginSessionHeaderActionDescriptorV1Schema,
} from './ui/sessionHeaderActions.js';
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
  buildPluginContributionFamilySchemaV2,
  definePluginContributionFamilyV2,
} from './families.js';

const PluginHookHandlerTargetV1Schema = z.enum(['plugin']);
const LEGACY_ACTIVITY_PROVIDER_FAMILY = `activity${'Providers'}`;

const PluginHookRegistrationFilterV1Schema = z.object({
  agentId: z.string().trim().min(1).optional(),
  backendId: z.string().trim().min(1).optional(),
  backendTargetId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  cwdPrefix: z.string().trim().min(1).optional(),
  machineId: z.string().trim().min(1).optional(),
  eventNames: z.array(z.string().trim().min(1)).optional(),
}).passthrough();

const PluginHookHandlerRefV1Schema = z.object({
  target: PluginHookHandlerTargetV1Schema,
  exportName: z.string().trim().min(1).optional(),
}).passthrough();

const STALE_ACP_TIMEOUT_KEYS = [
  'handshakeMs',
  'promptMs',
  'permissionDecisionMs',
  'fsOperationMs',
  'authProbeMs',
  'shutdownMs',
  'reconnectMs',
] as const;

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

export const PluginBackendTargetSourceKindV2Schema = z.enum(['first_party', 'external', 'configured']);
export type PluginBackendTargetSourceKindV2 = z.infer<typeof PluginBackendTargetSourceKindV2Schema>;

export const PluginBackendTargetV2Schema = z.object({
  sourceKind: PluginBackendTargetSourceKindV2Schema,
  id: z.string().trim().min(1),
}).strict();
export type PluginBackendTargetV2 = z.infer<typeof PluginBackendTargetV2Schema>;

export const PluginAgentContributionV2Schema = AgentDefinitionV1Schema;
export type PluginAgentContributionV2 = z.infer<typeof PluginAgentContributionV2Schema>;

export const PluginBackendEngineLaunchV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent-cli'),
    agentId: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }).passthrough(),
  z.object({
    kind: z.literal('executable'),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }).passthrough(),
]);
export type PluginBackendEngineLaunchV2 = z.infer<typeof PluginBackendEngineLaunchV2Schema>;

export const PluginBackendEngineAcpTimeoutsV2Schema = z.object({
  initMs: z.number().int().positive().optional(),
  initDelayMs: z.number().int().positive().optional(),
  idleMs: z.number().int().positive().optional(),
  toolCallMs: z.number().int().positive().optional(),
  promptLivenessMs: z.number().int().positive().optional(),
  postPromptNoUpdatesMs: z.number().int().positive().optional(),
  postToolCallIdleMs: z.number().int().positive().optional(),
  idleWithoutAssistantMessageMs: z.number().int().positive().optional(),
  preToolCallIdleMs: z.number().int().positive().optional(),
}).passthrough().superRefine((value, ctx) => {
  for (const key of STALE_ACP_TIMEOUT_KEYS) {
    if (hasOwn(value, key)) {
      rejectForbiddenKey(ctx, key, `ACP transport timeouts use the V1 T.4 names; '${key}' is not supported.`);
    }
  }
});
export type PluginBackendEngineAcpTimeoutsV2 = z.infer<typeof PluginBackendEngineAcpTimeoutsV2Schema>;

export const PluginBackendEngineAcpTransportV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stdio'),
    launch: PluginBackendEngineLaunchV2Schema,
    timeouts: PluginBackendEngineAcpTimeoutsV2Schema.optional(),
  }).passthrough(),
  z.object({
    kind: z.literal('ws'),
    url: z.string().trim().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    timeouts: PluginBackendEngineAcpTimeoutsV2Schema.optional(),
  }).passthrough(),
  z.object({
    kind: z.literal('tcp'),
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    timeouts: PluginBackendEngineAcpTimeoutsV2Schema.optional(),
  }).passthrough(),
]);
export type PluginBackendEngineAcpTransportV2 = z.infer<typeof PluginBackendEngineAcpTransportV2Schema>;

export const PluginBackendEngineAcpV2Schema = z.object({
  kind: z.literal('acp'),
  transport: PluginBackendEngineAcpTransportV2Schema,
  ux: z.object({
    name: PluginOptionalStringSchema,
    title: PluginOptionalStringSchema,
    description: PluginOptionalStringSchema,
    defaultMode: PluginOptionalStringSchema,
    defaultModel: PluginOptionalStringSchema,
  }).passthrough().optional(),
  launchEnv: z.record(z.string(), z.string()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  auth: PluginLooseJsonObjectSchema.optional(),
  fsEnabled: z.boolean().optional(),
  permissionModeArgv: PluginLooseJsonObjectSchema.optional(),
  sessionIdHeaderName: PluginOptionalStringSchema,
  bootstrap: PluginLooseJsonObjectSchema.optional(),
  messageMeta: PluginLooseJsonObjectSchema.optional(),
  mcp: z.object({
    policy: z.enum(['pass_through', 'drop']),
  }).passthrough().optional(),
}).passthrough();
export type PluginBackendEngineAcpV2 = z.infer<typeof PluginBackendEngineAcpV2Schema>;

export const PluginBackendEngineCustomV2Schema = z.object({
  kind: z.literal('custom'),
}).strict();
export type PluginBackendEngineCustomV2 = z.infer<typeof PluginBackendEngineCustomV2Schema>;

export const PluginBackendEngineV2Schema = z.discriminatedUnion('kind', [
  PluginBackendEngineAcpV2Schema,
  PluginBackendEngineCustomV2Schema,
]).superRefine((value, ctx) => {
  if (value.kind === 'acp' && hasOwn(value, 'timeouts')) {
    rejectForbiddenKey(ctx, 'timeouts', 'Plugin ACP timeouts are transport-owned; use engine.transport.timeouts.');
  }
});
export type PluginBackendEngineV2 = z.infer<typeof PluginBackendEngineV2Schema>;

export const PluginBackendContributionV2Schema = PluginBackendDefinitionV1BaseSchema.extend({
  engine: PluginBackendEngineV2Schema,
  target: PluginBackendTargetV2Schema.optional(),
}).passthrough().superRefine((value, ctx) => {
  if (hasOwn(value, 'runtimeAdapters')) {
    rejectForbiddenKey(ctx, 'runtimeAdapters', 'Backend surface declarations must use surfaceHandlers; runtimeAdapters is not final SDK vocabulary.');
  }
  if (hasOwn(value, 'runtimeCoreHooks')) {
    rejectForbiddenKey(ctx, 'runtimeCoreHooks', 'Backend surface declarations must use surfaceHandlers; runtimeCoreHooks is not final SDK vocabulary.');
  }
  if (hasOwn(value, 'providerId')) {
    rejectForbiddenKey(ctx, 'providerId', 'Plugin backend manifests must use agentId.');
  }
  if (hasOwn(value, 'providerAgentId')) {
    rejectForbiddenKey(ctx, 'providerAgentId', 'Plugin backend manifests must use catalogAgentId.');
  }
  if (hasOwn(value, 'runtimeKind')) {
    rejectForbiddenKey(ctx, 'runtimeKind', 'Plugin backend manifests must use backends[].engine.kind; top-level runtimeKind is not supported.');
  }
  if (hasOwn(value, 'acp')) {
    rejectForbiddenKey(ctx, 'acp', 'Plugin backend manifests must use backends[].engine.kind = acp; loose .acp wire is not supported.');
  }
});
export type PluginBackendContributionV2 = z.input<typeof PluginBackendContributionV2Schema>;
export type ParsedPluginBackendContributionV2 = z.output<typeof PluginBackendContributionV2Schema>;

export const PluginCommandVisibilityV2Schema = z.enum(['default', 'advanced', 'internal']);
export type PluginCommandVisibilityV2 = z.infer<typeof PluginCommandVisibilityV2Schema>;

export const PluginCommandContributionV2Schema = z.object({
  id: z.string().trim().min(1),
  command: z.string().trim().min(1),
  rootHelpLabel: PluginOptionalStringSchema,
  rootHelpDescription: PluginOptionalStringSchema,
  rootHelpDetail: PluginOptionalStringSchema,
  allowTmux: z.boolean().default(false),
  visibility: PluginCommandVisibilityV2Schema.optional(),
  featureGate: PluginOptionalStringSchema,
  handler: PluginExecutableHandlerRefV1Schema,
}).strict();
export type PluginCommandContributionV2 = z.infer<typeof PluginCommandContributionV2Schema>;

export const PluginResourceKindV2Schema = z.enum(['prompt', 'skill', 'template', 'asset', 'config']);
export type PluginResourceKindV2 = z.infer<typeof PluginResourceKindV2Schema>;

export const PluginResourceContributionV2Schema = z.object({
  id: z.string().trim().min(1),
  resourceKind: PluginResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: z.string().trim().min(1).optional(),
  contentType: PluginOptionalStringSchema,
}).strict();
export type PluginResourceContributionV2 = z.infer<typeof PluginResourceContributionV2Schema>;

export const PluginUiDescriptorSurfaceV2Schema = z.enum([
  'settings',
  'setup',
  'status',
  'agentSettings',
  'backendSettings',
]);
export type PluginUiDescriptorSurfaceV2 = z.infer<typeof PluginUiDescriptorSurfaceV2Schema>;

const NullableOptionalStringSchema = z.string().trim().min(1).nullable().optional();

export const PluginUiDescriptorToneV2Schema = z.enum(['neutral', 'info', 'success', 'warning', 'danger']);
export type PluginUiDescriptorToneV2 = z.infer<typeof PluginUiDescriptorToneV2Schema>;

export const PluginUiFieldTypeV2Schema = z.enum([
  'text',
  'boolean',
  'select',
  'secret',
  'number',
  'markdown',
  'action',
]);
export type PluginUiFieldTypeV2 = z.infer<typeof PluginUiFieldTypeV2Schema>;

export const PluginUiFieldOptionV2Schema = z.object({
  value: z.string().trim().min(1),
  label: z.string().trim().min(1),
}).strict();
export type PluginUiFieldOptionV2 = z.infer<typeof PluginUiFieldOptionV2Schema>;

export const PluginUiFieldV2Schema = z.object({
  id: z.string().trim().min(1),
  type: PluginUiFieldTypeV2Schema,
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  order: z.number().int().optional(),
  groupId: NullableOptionalStringSchema,
  featureGate: NullableOptionalStringSchema,
  actionId: NullableOptionalStringSchema,
  options: z.array(PluginUiFieldOptionV2Schema).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.type === 'action' && (typeof value.actionId !== 'string' || value.actionId.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'actionId is required when type is action',
      path: ['actionId'],
    });
  }
});
export type PluginUiFieldV2 = z.infer<typeof PluginUiFieldV2Schema>;

export const PluginUiDescriptorContributionV2Schema = z.object({
  id: z.string().trim().min(1),
  surface: PluginUiDescriptorSurfaceV2Schema,
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  order: z.number().int().optional(),
  tone: PluginUiDescriptorToneV2Schema.optional(),
  featureGate: NullableOptionalStringSchema,
  helpUrl: NullableOptionalStringSchema,
  fields: z.array(PluginUiFieldV2Schema).default([]),
}).strict();
export type PluginUiDescriptorContributionV2 = z.infer<typeof PluginUiDescriptorContributionV2Schema>;

export { PluginHookScopeV1Schema, type PluginHookScopeV1 };

export const PluginHookContributionV2Schema = z.object({
  id: PluginHookIdV1Schema,
  hookApiVersion: z.literal(1).default(1),
  category: HookCategoryV1Schema,
  scope: PluginHookScopeV1Schema,
  filters: PluginHookRegistrationFilterV1Schema.optional(),
  executionKind: HookExecutionKindV1Schema,
  handler: PluginHookHandlerRefV1Schema,
  priority: z.number().int().optional(),
  compatibility: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type PluginHookContributionV2 = z.infer<typeof PluginHookContributionV2Schema>;

export const PluginLifecycleEventV2Schema = z.enum(['activated', 'deactivating']);
export type PluginLifecycleEventV2 = z.infer<typeof PluginLifecycleEventV2Schema>;

export const PluginLifecycleHandlerContributionV2Schema = z.object({
  id: PluginOptionalStringSchema,
  event: PluginLifecycleEventV2Schema,
  priority: z.number().int().optional(),
  handler: PluginExecutableHandlerRefV1Schema,
}).strict();
export type PluginLifecycleHandlerContributionV2 = z.infer<typeof PluginLifecycleHandlerContributionV2Schema>;

export const PluginConnectedAccountDescriptorContributionV2Schema =
  PluginConnectedAccountDescriptorSchema;
export type PluginConnectedAccountDescriptorContributionV2 =
  z.infer<typeof PluginConnectedAccountDescriptorContributionV2Schema>;

export const PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 = [
  definePluginContributionFamilyV2({ family: 'agents', schema: PluginAgentContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'backends', schema: PluginBackendContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'actions', schema: PluginActionContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'commands', schema: PluginCommandContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'tools', schema: PluginToolContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'resources', schema: PluginResourceContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'uiDescriptors', schema: PluginUiDescriptorContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'uiTranslations', schema: PluginUiTranslationsContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'structuredMessages', schema: PluginStructuredMessageDescriptorV1Schema }),
  definePluginContributionFamilyV2({ family: 'sessionSurfaces', schema: PluginSessionSurfaceDescriptorV1Schema }),
  definePluginContributionFamilyV2({ family: 'sessionHeaderActions', schema: PluginSessionHeaderActionDescriptorV1Schema }),
  definePluginContributionFamilyV2({ family: 'hostedWeb', schema: PluginHostedWebContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'reactNativeBundles', schema: PluginReactNativeBundleContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'uiArtifacts', schema: PluginUiArtifactContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'settings', schema: PluginSettingsContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'events', schema: PluginEventContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'executionRunProfiles', schema: PluginExecutionRunProfileContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'notifications', schema: PluginNotificationCategoryContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'notificationChannels', schema: PluginNotificationChannelContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'scmHostingProviders', schema: ScmHostingProviderContributionSchema }),
  definePluginContributionFamilyV2({ family: 'scmBackends', schema: ScmBackendContributionSchema }),
  definePluginContributionFamilyV2({ family: 'connectedAccountDescriptors', schema: PluginConnectedAccountDescriptorContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'installables', schema: PluginInstallableContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'systemTools', schema: PluginSystemToolContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'promptAssets', schema: PluginPromptAssetContributionV1Schema }),
  definePluginContributionFamilyV2({ family: 'hooks', schema: PluginHookContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'lifecycleHandlers', schema: PluginLifecycleHandlerContributionV2Schema }),
  definePluginContributionFamilyV2({ family: 'requestInterceptors', schema: PluginRequestInterceptorContributionV1Schema }),
] as const;

const PluginContributesV2BaseSchema = buildPluginContributionFamilySchemaV2(
  PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2,
);

export const PluginContributesV2Schema = PluginContributesV2BaseSchema.extend({
  mcp: PluginMcpContributesV1Schema,
}).superRefine((value, ctx) => {
  if (hasOwn(value, LEGACY_ACTIVITY_PROVIDER_FAMILY)) {
    rejectForbiddenKey(ctx, LEGACY_ACTIVITY_PROVIDER_FAMILY, 'Activity providers were folded into contributes.notifications; use notification categories instead.');
  }
}).default({});
export type PluginContributesV2 = z.infer<typeof PluginContributesV2Schema>;

export {
  PluginSystemToolContributionV1Schema,
  PluginSystemToolSourceV1Schema,
  type PluginSystemToolContributionV1,
  type PluginSystemToolSourceV1,
} from './systemTools.js';

export {
  PluginPromptAssetAdapterKindV1Schema,
  PluginPromptAssetContributionV1Schema,
  type PluginPromptAssetAdapterKindV1,
  type PluginPromptAssetContributionV1,
} from './promptAssets.js';

export {
  PluginUiTranslationsContributionV1Schema,
  type PluginUiTranslationsContributionV1,
} from './ui/i18n.js';
export {
  PluginStructuredMessageDescriptorV1Schema,
  type PluginStructuredMessageDescriptorV1,
} from './ui/structuredMessages.js';
export {
  PluginSessionSurfaceDescriptorV1Schema,
  type PluginSessionSurfaceDescriptorV1,
} from './ui/sessionSurfaces.js';
export {
  PluginSessionHeaderActionDescriptorV1Schema,
  type PluginSessionHeaderActionDescriptorV1,
} from './ui/sessionHeaderActions.js';
export {
  PluginHostedWebContributionV1Schema,
  type PluginHostedWebContributionV1,
} from './ui/hostedWeb.js';
export {
  PluginReactNativeBundleContributionV1Schema,
  type PluginReactNativeBundleContributionV1,
} from './ui/reactNativeBundles.js';
export {
  PluginUiArtifactContributionV1Schema,
  type PluginUiArtifactContributionV1,
} from './ui/artifacts.js';
