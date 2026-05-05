import { z } from 'zod';

import {
  PluginActionDangerLevelV2Schema,
  PluginActionPlacementV2Schema,
  PluginActionScopeV2Schema,
  PluginActionSurfaceV2Schema,
} from './plugins/actions/v2.js';
import {
  PluginResourceKindV2Schema,
  PluginUiDescriptorSurfaceV2Schema,
  PluginUiDescriptorToneV2Schema,
  PluginUiFieldV2Schema,
} from './plugins/contributions/v2.js';
import { PluginOptionalStringSchema } from './plugins/_shared.js';
import { HookCategoryV1Schema } from './hooks/hookCategories.js';
import { HookExecutionKindV1Schema } from './hooks/hookExecutionSemantics.js';
import { HookScopeV1Schema } from './hooks/hookScopes.js';

const PluginHookAggregationKindV1Schema = z.enum([
  'none',
  'replace',
  'orderedList',
  'mergeObject',
  'firstDecision',
  'allDecisions',
]);
const PluginHookFailureModeV1Schema = z.enum(['bestEffort', 'failClosed']);

/**
 * Daemon-scoped merged contribution registry projection.
 *
 * This is an internal UI/daemon contract used for projection (display + grouping),
 * not for plugin execution. Keep it additive and versioned.
 */

export const DaemonContributionRegistryProjectionProviderEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  subtitle: PluginOptionalStringSchema,
  channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
  isBuiltIn: z.boolean().optional(),
  settingsBackendId: PluginOptionalStringSchema,
  providerAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
}).passthrough();
export type DaemonContributionRegistryProjectionProviderEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionProviderEntryV1Schema
>;

export const DaemonContributionRegistryProjectionBackendEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  subtitle: PluginOptionalStringSchema,
  providerAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
}).passthrough();
export type DaemonContributionRegistryProjectionBackendEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionBackendEntryV1Schema
>;

export const DaemonContributionRegistryProjectionActionEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  safety: z.string().trim().min(1),
  surfaces: z.record(z.string(), z.boolean()).default({}),
  bindings: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();
export type DaemonContributionRegistryProjectionActionEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionActionEntryV1Schema
>;

export const DaemonContributionRegistryProjectionResourceEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
  type: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  path: PluginOptionalStringSchema,
  digest: PluginOptionalStringSchema,
  contentType: PluginOptionalStringSchema,
}).passthrough();
export type DaemonContributionRegistryProjectionResourceEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionResourceEntryV1Schema
>;

export const DaemonContributionRegistryProjectionUiFieldV1Schema = z.object({
  id: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  options: z.array(z.object({
    value: z.string().trim().min(1),
    label: z.string().trim().min(1),
  }).passthrough()).default([]),
}).passthrough();
export type DaemonContributionRegistryProjectionUiFieldV1 = z.infer<
  typeof DaemonContributionRegistryProjectionUiFieldV1Schema
>;

export const DaemonContributionRegistryProjectionUiDescriptorEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
  surface: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  fields: z.array(DaemonContributionRegistryProjectionUiFieldV1Schema).default([]),
}).passthrough();
export type DaemonContributionRegistryProjectionUiDescriptorEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionUiDescriptorEntryV1Schema
>;

export const DaemonContributionRegistryProjectionV1Schema = z.object({
  v: z.literal(1),
  generationId: PluginOptionalStringSchema,
  providersById: z.record(z.string(), DaemonContributionRegistryProjectionProviderEntryV1Schema).default({}),
  backendsById: z.record(z.string(), DaemonContributionRegistryProjectionBackendEntryV1Schema).default({}),
  actionsById: z.record(z.string(), DaemonContributionRegistryProjectionActionEntryV1Schema).default({}),
  resourcesById: z.record(z.string(), DaemonContributionRegistryProjectionResourceEntryV1Schema).default({}),
  uiDescriptorsById: z.record(z.string(), DaemonContributionRegistryProjectionUiDescriptorEntryV1Schema).default({}),
}).passthrough();
export type DaemonContributionRegistryProjectionV1 = z.infer<typeof DaemonContributionRegistryProjectionV1Schema>;

export const DaemonContributionRegistryProjectionDescribeRequestSchema = z.object({
  machineId: z.string().trim().min(1),
}).passthrough();
export type DaemonContributionRegistryProjectionDescribeRequest = z.infer<
  typeof DaemonContributionRegistryProjectionDescribeRequestSchema
>;

export const DaemonContributionRegistryProjectionDescribeResponseSchema = z.object({
  protocolVersion: z.literal(1),
  projection: z.union([
    DaemonContributionRegistryProjectionV1Schema,
    z.lazy(() => PluginProjectionV2Schema),
  ]),
}).passthrough();
export type DaemonContributionRegistryProjectionDescribeResponse = z.infer<
  typeof DaemonContributionRegistryProjectionDescribeResponseSchema
>;

export const PluginProjectionSourceV2Schema = z.object({
  kind: z.string().trim().min(1),
  locator: z.string().trim().min(1),
}).strict();
export type PluginProjectionSourceV2 = z.infer<typeof PluginProjectionSourceV2Schema>;

export const PluginProjectionInstalledPackageV2Schema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  version: PluginOptionalStringSchema,
  enabled: z.boolean(),
  source: PluginProjectionSourceV2Schema,
  digest: PluginOptionalStringSchema,
}).strict();
export type PluginProjectionInstalledPackageV2 = z.infer<typeof PluginProjectionInstalledPackageV2Schema>;

export const PluginProjectedContributionBaseV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
});
export type PluginProjectedContributionBaseV2 = z.infer<typeof PluginProjectedContributionBaseV2Schema>;

export const PluginProjectedProviderV2Schema = z.object({
  id: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  subtitle: PluginOptionalStringSchema,
  channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
  isBuiltIn: z.boolean().optional(),
  settingsBackendId: PluginOptionalStringSchema,
  providerAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
}).strict();
export type PluginProjectedProviderV2 = z.infer<typeof PluginProjectedProviderV2Schema>;

export const PluginProjectedBackendV2Schema = z.object({
  id: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  title: PluginOptionalStringSchema,
  subtitle: PluginOptionalStringSchema,
  providerAgentId: PluginOptionalStringSchema,
  iconAgentId: PluginOptionalStringSchema,
}).strict();
export type PluginProjectedBackendV2 = z.infer<typeof PluginProjectedBackendV2Schema>;

export const PluginProjectedActionV2Schema = PluginProjectedContributionBaseV2Schema.extend({
  scopes: z.array(PluginActionScopeV2Schema).min(1),
  surfaces: z.array(PluginActionSurfaceV2Schema).min(1),
  placement: PluginActionPlacementV2Schema,
  dangerLevel: PluginActionDangerLevelV2Schema,
  available: z.boolean().optional(),
}).strict();
export type PluginProjectedActionV2 = z.infer<typeof PluginProjectedActionV2Schema>;

export const PluginProjectedToolV2Schema = PluginProjectedContributionBaseV2Schema.extend({
  exposesToAgent: z.boolean().default(false),
}).strict();
export type PluginProjectedToolV2 = z.infer<typeof PluginProjectedToolV2Schema>;

export const PluginProjectedCommandSurfaceV2Schema = z.enum(['cli', 'agentSlash', 'commandPalette']);
export type PluginProjectedCommandSurfaceV2 = z.infer<typeof PluginProjectedCommandSurfaceV2Schema>;

export const PluginProjectedCommandV2Schema = PluginProjectedContributionBaseV2Schema.extend({
  surfaces: z.array(PluginProjectedCommandSurfaceV2Schema).min(1),
  tokens: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginProjectedCommandV2 = z.infer<typeof PluginProjectedCommandV2Schema>;

export const PluginProjectedHookV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  eventId: z.string().trim().min(1),
  category: HookCategoryV1Schema.optional(),
  scope: HookScopeV1Schema.optional(),
  executionKind: HookExecutionKindV1Schema.optional(),
  aggregation: PluginHookAggregationKindV1Schema.optional(),
  failureMode: PluginHookFailureModeV1Schema.optional(),
  priority: z.number().int().optional(),
}).strict();
export type PluginProjectedHookV2 = z.infer<typeof PluginProjectedHookV2Schema>;

export const PluginProjectedResourceV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  resourceKind: PluginResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: PluginOptionalStringSchema,
  contentType: PluginOptionalStringSchema,
}).strict();
export type PluginProjectedResourceV2 = z.infer<typeof PluginProjectedResourceV2Schema>;

export const PluginProjectedUiDescriptorV2Schema = PluginProjectedContributionBaseV2Schema.extend({
  surface: PluginUiDescriptorSurfaceV2Schema,
  order: z.number().int().optional(),
  tone: PluginUiDescriptorToneV2Schema.optional(),
  featureGate: PluginOptionalStringSchema.nullable().optional(),
  helpUrl: PluginOptionalStringSchema.nullable().optional(),
  fields: z.array(PluginUiFieldV2Schema).default([]),
}).strict();
export type PluginProjectedUiDescriptorV2 = z.infer<typeof PluginProjectedUiDescriptorV2Schema>;

export const PluginProjectionDiagnosticV2Schema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
}).strict();
export type PluginProjectionDiagnosticV2 = z.infer<typeof PluginProjectionDiagnosticV2Schema>;

export const PluginProjectedFamilyEntryV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
}).passthrough();
export type PluginProjectedFamilyEntryV2 = z.infer<typeof PluginProjectedFamilyEntryV2Schema>;

export const PluginProjectedFamilyV2Schema = z.object({
  family: z.string().trim().min(1),
  entriesById: z.record(z.string(), PluginProjectedFamilyEntryV2Schema).default({}),
}).strict();
export type PluginProjectedFamilyV2 = z.infer<typeof PluginProjectedFamilyV2Schema>;

export const PluginProjectionV2Schema = z.object({
  v: z.literal(2),
  generation: z.number().int().nonnegative(),
  installedPackagesById: z.record(z.string(), PluginProjectionInstalledPackageV2Schema).default({}),
  providersById: z.record(z.string(), PluginProjectedProviderV2Schema).default({}),
  backendsById: z.record(z.string(), PluginProjectedBackendV2Schema).default({}),
  actionsById: z.record(z.string(), PluginProjectedActionV2Schema).default({}),
  toolsById: z.record(z.string(), PluginProjectedToolV2Schema).default({}),
  commandsById: z.record(z.string(), PluginProjectedCommandV2Schema).default({}),
  hooksById: z.record(z.string(), PluginProjectedHookV2Schema).optional(),
  resourcesById: z.record(z.string(), PluginProjectedResourceV2Schema).default({}),
  uiDescriptorsById: z.record(z.string(), PluginProjectedUiDescriptorV2Schema).default({}),
  familiesById: z.record(z.string(), PluginProjectedFamilyV2Schema).default({}),
  diagnostics: z.array(PluginProjectionDiagnosticV2Schema).default([]),
}).strict();
export type PluginProjectionV2 = z.infer<typeof PluginProjectionV2Schema>;

export type DaemonContributionRegistryProjection =
  | DaemonContributionRegistryProjectionV1
  | PluginProjectionV2;
