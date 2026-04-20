import { z } from 'zod';

import {
  ExtensionActionDangerLevelV2Schema,
  ExtensionActionPlacementV2Schema,
  ExtensionActionScopeV2Schema,
  ExtensionActionSurfaceV2Schema,
} from './extensions/actions/v2.js';
import {
  ExtensionResourceKindV2Schema,
  ExtensionUiDescriptorSurfaceV2Schema,
  ExtensionUiDescriptorToneV2Schema,
  ExtensionUiFieldV2Schema,
} from './extensions/contributions/v2.js';
import {
  ExtensionHookAggregationKindV1Schema,
  ExtensionHookFailureModeV1Schema,
  ExtensionHookScopeV1Schema,
} from './extensions/hooks/catalog.js';
import { OptionalStringSchema } from './extensions/_shared.js';
import { HookCategoryV1Schema } from './hooks/hookCategories.js';
import { HookExecutionKindV1Schema } from './hooks/hookExecutionSemantics.js';

/**
 * Daemon-scoped merged contribution registry projection.
 *
 * This is an internal UI/daemon contract used for projection (display + grouping),
 * not for plugin execution. Keep it additive and versioned.
 */

export const DaemonContributionRegistryProjectionProviderEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  title: OptionalStringSchema,
  subtitle: OptionalStringSchema,
  channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
  isBuiltIn: z.boolean().optional(),
  settingsBackendId: OptionalStringSchema,
  providerAgentId: OptionalStringSchema,
  iconAgentId: OptionalStringSchema,
}).passthrough();
export type DaemonContributionRegistryProjectionProviderEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionProviderEntryV1Schema
>;

export const DaemonContributionRegistryProjectionBackendEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  title: OptionalStringSchema,
  subtitle: OptionalStringSchema,
  providerAgentId: OptionalStringSchema,
  iconAgentId: OptionalStringSchema,
}).passthrough();
export type DaemonContributionRegistryProjectionBackendEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionBackendEntryV1Schema
>;

export const DaemonContributionRegistryProjectionActionEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: OptionalStringSchema,
  title: z.string().trim().min(1),
  description: OptionalStringSchema,
  safety: z.string().trim().min(1),
  surfaces: z.record(z.string(), z.boolean()).default({}),
  bindings: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();
export type DaemonContributionRegistryProjectionActionEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionActionEntryV1Schema
>;

export const DaemonContributionRegistryProjectionResourceEntryV1Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: OptionalStringSchema,
  type: z.string().trim().min(1),
  title: OptionalStringSchema,
  path: OptionalStringSchema,
  digest: OptionalStringSchema,
  contentType: OptionalStringSchema,
}).passthrough();
export type DaemonContributionRegistryProjectionResourceEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionResourceEntryV1Schema
>;

export const DaemonContributionRegistryProjectionUiFieldV1Schema = z.object({
  id: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: OptionalStringSchema,
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
  pluginId: OptionalStringSchema,
  surface: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: OptionalStringSchema,
  fields: z.array(DaemonContributionRegistryProjectionUiFieldV1Schema).default([]),
}).passthrough();
export type DaemonContributionRegistryProjectionUiDescriptorEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionUiDescriptorEntryV1Schema
>;

export const DaemonContributionRegistryProjectionV1Schema = z.object({
  v: z.literal(1),
  generationId: OptionalStringSchema,
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
    z.lazy(() => ExtensionProjectionV2Schema),
  ]),
}).passthrough();
export type DaemonContributionRegistryProjectionDescribeResponse = z.infer<
  typeof DaemonContributionRegistryProjectionDescribeResponseSchema
>;

export const ExtensionProjectionSourceV2Schema = z.object({
  kind: z.string().trim().min(1),
  locator: z.string().trim().min(1),
}).strict();
export type ExtensionProjectionSourceV2 = z.infer<typeof ExtensionProjectionSourceV2Schema>;

export const ExtensionProjectionInstalledPackageV2Schema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  version: OptionalStringSchema,
  enabled: z.boolean(),
  source: ExtensionProjectionSourceV2Schema,
  digest: OptionalStringSchema,
}).strict();
export type ExtensionProjectionInstalledPackageV2 = z.infer<typeof ExtensionProjectionInstalledPackageV2Schema>;

export const ExtensionProjectedContributionBaseV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: OptionalStringSchema,
});
export type ExtensionProjectedContributionBaseV2 = z.infer<typeof ExtensionProjectedContributionBaseV2Schema>;

export const ExtensionProjectedProviderV2Schema = z.object({
  id: z.string().trim().min(1),
  title: OptionalStringSchema,
  subtitle: OptionalStringSchema,
  channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
  isBuiltIn: z.boolean().optional(),
  settingsBackendId: OptionalStringSchema,
  providerAgentId: OptionalStringSchema,
  iconAgentId: OptionalStringSchema,
}).strict();
export type ExtensionProjectedProviderV2 = z.infer<typeof ExtensionProjectedProviderV2Schema>;

export const ExtensionProjectedBackendV2Schema = z.object({
  id: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  title: OptionalStringSchema,
  subtitle: OptionalStringSchema,
  providerAgentId: OptionalStringSchema,
  iconAgentId: OptionalStringSchema,
}).strict();
export type ExtensionProjectedBackendV2 = z.infer<typeof ExtensionProjectedBackendV2Schema>;

export const ExtensionProjectedActionV2Schema = ExtensionProjectedContributionBaseV2Schema.extend({
  scopes: z.array(ExtensionActionScopeV2Schema).min(1),
  surfaces: z.array(ExtensionActionSurfaceV2Schema).min(1),
  placement: ExtensionActionPlacementV2Schema,
  dangerLevel: ExtensionActionDangerLevelV2Schema,
  available: z.boolean().optional(),
}).strict();
export type ExtensionProjectedActionV2 = z.infer<typeof ExtensionProjectedActionV2Schema>;

export const ExtensionProjectedToolV2Schema = ExtensionProjectedContributionBaseV2Schema.extend({
  exposesToAgent: z.boolean().default(false),
}).strict();
export type ExtensionProjectedToolV2 = z.infer<typeof ExtensionProjectedToolV2Schema>;

export const ExtensionProjectedCommandSurfaceV2Schema = z.enum(['cli', 'agentSlash', 'commandPalette']);
export type ExtensionProjectedCommandSurfaceV2 = z.infer<typeof ExtensionProjectedCommandSurfaceV2Schema>;

export const ExtensionProjectedCommandV2Schema = ExtensionProjectedContributionBaseV2Schema.extend({
  surfaces: z.array(ExtensionProjectedCommandSurfaceV2Schema).min(1),
  tokens: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type ExtensionProjectedCommandV2 = z.infer<typeof ExtensionProjectedCommandV2Schema>;

export const ExtensionProjectedHookV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  eventId: z.string().trim().min(1),
  category: HookCategoryV1Schema.optional(),
  scope: ExtensionHookScopeV1Schema.optional(),
  executionKind: HookExecutionKindV1Schema.optional(),
  aggregation: ExtensionHookAggregationKindV1Schema.optional(),
  failureMode: ExtensionHookFailureModeV1Schema.optional(),
  priority: z.number().int().optional(),
}).strict();
export type ExtensionProjectedHookV2 = z.infer<typeof ExtensionProjectedHookV2Schema>;

export const ExtensionProjectedResourceV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  resourceKind: ExtensionResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: OptionalStringSchema,
  contentType: OptionalStringSchema,
}).strict();
export type ExtensionProjectedResourceV2 = z.infer<typeof ExtensionProjectedResourceV2Schema>;

export const ExtensionProjectedUiDescriptorV2Schema = ExtensionProjectedContributionBaseV2Schema.extend({
  surface: ExtensionUiDescriptorSurfaceV2Schema,
  order: z.number().int().optional(),
  tone: ExtensionUiDescriptorToneV2Schema.optional(),
  featureGate: OptionalStringSchema.nullable().optional(),
  helpUrl: OptionalStringSchema.nullable().optional(),
  fields: z.array(ExtensionUiFieldV2Schema).default([]),
}).strict();
export type ExtensionProjectedUiDescriptorV2 = z.infer<typeof ExtensionProjectedUiDescriptorV2Schema>;

export const ExtensionProjectionDiagnosticV2Schema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  pluginId: OptionalStringSchema,
}).strict();
export type ExtensionProjectionDiagnosticV2 = z.infer<typeof ExtensionProjectionDiagnosticV2Schema>;

export const ExtensionProjectionV2Schema = z.object({
  v: z.literal(2),
  generation: z.number().int().nonnegative(),
  installedPackagesById: z.record(z.string(), ExtensionProjectionInstalledPackageV2Schema).default({}),
  providersById: z.record(z.string(), ExtensionProjectedProviderV2Schema).default({}),
  backendsById: z.record(z.string(), ExtensionProjectedBackendV2Schema).default({}),
  actionsById: z.record(z.string(), ExtensionProjectedActionV2Schema).default({}),
  toolsById: z.record(z.string(), ExtensionProjectedToolV2Schema).default({}),
  commandsById: z.record(z.string(), ExtensionProjectedCommandV2Schema).default({}),
  hooksById: z.record(z.string(), ExtensionProjectedHookV2Schema).optional(),
  resourcesById: z.record(z.string(), ExtensionProjectedResourceV2Schema).default({}),
  uiDescriptorsById: z.record(z.string(), ExtensionProjectedUiDescriptorV2Schema).default({}),
  diagnostics: z.array(ExtensionProjectionDiagnosticV2Schema).default([]),
}).strict();
export type ExtensionProjectionV2 = z.infer<typeof ExtensionProjectionV2Schema>;

export type DaemonContributionRegistryProjection =
  | DaemonContributionRegistryProjectionV1
  | ExtensionProjectionV2;
