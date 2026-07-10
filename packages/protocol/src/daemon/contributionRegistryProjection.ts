import { z } from 'zod';

import {
  PluginActionDangerLevelV2Schema,
  PluginActionPlacementV2Schema,
  PluginActionScopeV2Schema,
  PluginActionSurfaceV2Schema,
} from '../plugins/actions/v2.js';
import { PluginUiArtifactDigestV1Schema } from '../plugins/ui/artifactIntegrity.js';
import {
  PluginResourceKindV2Schema,
  PluginUiDescriptorSurfaceV2Schema,
  PluginUiDescriptorToneV2Schema,
  PluginUiFieldV2Schema,
} from '../plugins/contributions/v2.js';
import {
  PluginDescriptorClearWhenEmptyV1Schema,
  PluginDescriptorRedactionV1Schema,
} from '../plugins/contributions/_descriptors.js';
import {
  PluginSettingsControlKindV1Schema,
} from '../plugins/contributions/settings.js';
import { PluginHookIdV1Schema } from '../plugins/hooks/catalog.js';
import { PluginOptionalStringSchema } from '../plugins/_shared.js';
import { PluginBackendCapabilitiesV1Schema } from '../plugins/backendDefinitionV1.js';
import { HookCategoryV1Schema } from '../hooks/hookCategories.js';
import { HookExecutionKindV1Schema } from '../hooks/hookExecutionSemantics.js';
import { HookScopeV1Schema } from '../hooks/hookScopes.js';

const PluginHookAggregationKindV1Schema = z.enum([
  'none',
  'replace',
  'orderedList',
  'mergeObject',
  'firstDecision',
  'allDecisions',
]);
const PluginHookFailureModeV1Schema = z.enum(['bestEffort', 'failClosed']);

function asProjectionRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeLegacyStringAliases(
  value: unknown,
  aliases: readonly Readonly<{ legacy: string; canonical: string }>[],
): unknown {
  const record = asProjectionRecord(value);
  if (!record) return value;

  let next = record;
  for (const { legacy, canonical } of aliases) {
    if (!Object.hasOwn(next, legacy)) continue;
    const legacyValue = typeof next[legacy] === 'string' ? next[legacy].trim() : '';
    const hasCanonicalValue = Object.hasOwn(next, canonical);
    const canonicalValue = typeof next[canonical] === 'string' ? next[canonical].trim() : '';
    if (!legacyValue || (hasCanonicalValue && (!canonicalValue || canonicalValue !== legacyValue))) {
      return undefined;
    }
    const { [legacy]: _legacyValue, ...rest } = next;
    next = hasCanonicalValue ? rest : { ...rest, [canonical]: legacyValue };
  }
  return next;
}

function normalizeLegacyProjectionCollections(value: unknown): unknown {
  const record = asProjectionRecord(value);
  if (!record || !Object.hasOwn(record, 'providersById')) return value;
  if (Object.hasOwn(record, 'agentsById')) return undefined;
  const { providersById, ...rest } = record;
  return { ...rest, agentsById: providersById };
}

const normalizeLegacyProjectedAgent = (value: unknown): unknown => normalizeLegacyStringAliases(value, [
  { legacy: 'providerId', canonical: 'id' },
  { legacy: 'providerAgentId', canonical: 'catalogAgentId' },
]);

const normalizeLegacyProjectedBackend = (value: unknown): unknown => normalizeLegacyStringAliases(value, [
  { legacy: 'providerId', canonical: 'agentId' },
  { legacy: 'providerAgentId', canonical: 'catalogAgentId' },
]);

/**
 * Daemon-scoped merged contribution registry projection.
 *
 * This is an internal UI/daemon contract used for projection (display + grouping),
 * not for plugin execution. Keep it additive and versioned.
 */

export const DaemonContributionRegistryProjectionAgentEntryV1Schema = z.preprocess(
  normalizeLegacyProjectedAgent,
  z.object({
    id: z.string().trim().min(1),
    title: PluginOptionalStringSchema,
    subtitle: PluginOptionalStringSchema,
    channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
    isBuiltIn: z.boolean().optional(),
    settingsBackendId: PluginOptionalStringSchema,
    catalogAgentId: PluginOptionalStringSchema,
    iconAgentId: PluginOptionalStringSchema,
  }).passthrough(),
);
export type DaemonContributionRegistryProjectionAgentEntryV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAgentEntryV1Schema
>;

export const DaemonContributionRegistryProjectionBackendEntryV1Schema = z.preprocess(
  normalizeLegacyProjectedBackend,
  z.object({
    id: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    title: PluginOptionalStringSchema,
    subtitle: PluginOptionalStringSchema,
    catalogAgentId: PluginOptionalStringSchema,
    iconAgentId: PluginOptionalStringSchema,
  }).passthrough(),
);
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

export const DaemonContributionRegistryProjectionV1Schema = z.preprocess(
  normalizeLegacyProjectionCollections,
  z.object({
    v: z.literal(1),
    generationId: PluginOptionalStringSchema,
    agentsById: z.record(z.string(), DaemonContributionRegistryProjectionAgentEntryV1Schema).default({}),
    backendsById: z.record(z.string(), DaemonContributionRegistryProjectionBackendEntryV1Schema).default({}),
    actionsById: z.record(z.string(), DaemonContributionRegistryProjectionActionEntryV1Schema).default({}),
    resourcesById: z.record(z.string(), DaemonContributionRegistryProjectionResourceEntryV1Schema).default({}),
    uiDescriptorsById: z.record(z.string(), DaemonContributionRegistryProjectionUiDescriptorEntryV1Schema).default({}),
  }).passthrough(),
);
export type DaemonContributionRegistryProjectionV1 = z.infer<typeof DaemonContributionRegistryProjectionV1Schema>;

const DaemonReactNativeHostRuntimeIdentityStringV1Schema = z.string().trim().min(1);
const DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema =
  DaemonReactNativeHostRuntimeIdentityStringV1Schema.refine(
    (value) => value !== '*' && !value.includes('x'),
    { message: 'runtime identity versions must be exact' },
  );

/**
 * ScriptManager readiness reported by the UI/native host probe (PR-13).
 *
 * Readiness ORIGINATES from the UI native probe (the Re.Pack loader-backend
 * resolution) and travels to the daemon as part of the reported host-runtime
 * identity. The daemon CONSUMES these bits; it never asserts or infers them.
 * Both bits are required when the field is present so a partial report cannot
 * silently flip the gate; the whole field is optional so an older client (or
 * web/desktop, where no native runtime exists) reports nothing and the daemon
 * stays fail-closed.
 */
export const DaemonReactNativeHostRuntimeScriptManagerReadinessV1Schema = z.object({
  integrated: z.boolean(),
  installedArtifactLoaderAvailable: z.boolean(),
}).strict();
export type DaemonReactNativeHostRuntimeScriptManagerReadinessV1 = z.infer<
  typeof DaemonReactNativeHostRuntimeScriptManagerReadinessV1Schema
>;

export const DaemonReactNativeHostRuntimeIdentityV1Schema = z.object({
  platform: z.enum(['android', 'ios']),
  channel: z.enum(['development', 'internal', 'store']),
  rawUpdateChannel: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  appVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  nativeApplicationVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  nativeBuildVersion: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  applicationId: DaemonReactNativeHostRuntimeIdentityStringV1Schema.optional(),
  reactVersion: DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema.optional(),
  reactNativeVersion: DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema.optional(),
  expoRuntimeVersion: DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema.optional(),
  hermesVersion: DaemonReactNativeHostRuntimeIdentityExactVersionV1Schema.optional(),
  availableNativeCapabilities: z.array(DaemonReactNativeHostRuntimeIdentityStringV1Schema).default([]),
  scriptManagerRuntime: DaemonReactNativeHostRuntimeScriptManagerReadinessV1Schema.optional(),
}).strict();
export type DaemonReactNativeHostRuntimeIdentityV1 = z.infer<
  typeof DaemonReactNativeHostRuntimeIdentityV1Schema
>;

/**
 * Embedded-web deployment CSP capability reported by the UI host (Phase 6.2).
 *
 * The capability ORIGINATES from the running UI deployment, which is the only
 * layer that knows whether its own Content-Security-Policy permits same-origin
 * module URLs or `blob:` module imports for `import()`. It travels to the daemon
 * in the describe request; the daemon CONSUMES it to gate the embedded-web load
 * decision and never asserts or infers it. Both bits are required when present
 * so a partial report cannot silently flip the gate; the field is optional so an
 * older client reports nothing and the daemon stays fail-closed.
 */
export const DaemonEmbeddedWebDeploymentCspCapabilityV1Schema = z.object({
  supportsSameOriginModuleUrl: z.boolean(),
  allowsBlobModuleImport: z.boolean(),
}).strict();
export type DaemonEmbeddedWebDeploymentCspCapabilityV1 = z.infer<
  typeof DaemonEmbeddedWebDeploymentCspCapabilityV1Schema
>;

export const DaemonContributionRegistryProjectionDescribeRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  reactNativeHostRuntimeIdentity: DaemonReactNativeHostRuntimeIdentityV1Schema.optional(),
  embeddedWebCspCapability: DaemonEmbeddedWebDeploymentCspCapabilityV1Schema.optional(),
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

export const DaemonPluginSettingsGetRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
}).strict();
export type DaemonPluginSettingsGetRequest = z.infer<
  typeof DaemonPluginSettingsGetRequestSchema
>;

export const DaemonPluginSettingsSetRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  fieldId: z.string().trim().min(1),
  value: z.unknown(),
}).strict();
export type DaemonPluginSettingsSetRequest = z.infer<
  typeof DaemonPluginSettingsSetRequestSchema
>;

export const DaemonPluginSettingsSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  pluginId: z.string().trim().min(1),
  storageScope: z.literal('pluginLocal'),
  values: z.record(z.string(), z.unknown()).default({}),
  redactedKeys: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type DaemonPluginSettingsSnapshot = z.infer<
  typeof DaemonPluginSettingsSnapshotSchema
>;

export const DaemonPluginSettingsGetResponseSchema = DaemonPluginSettingsSnapshotSchema;
export type DaemonPluginSettingsGetResponse = DaemonPluginSettingsSnapshot;

export const DaemonPluginSettingsSetResponseSchema = DaemonPluginSettingsSnapshotSchema;
export type DaemonPluginSettingsSetResponse = DaemonPluginSettingsSnapshot;

export const DaemonPluginReactNativeBundleCacheIdentityV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostAppVersion: z.string().trim().min(1),
  hostUiApiVersion: z.string().trim().min(1),
  reactVersion: z.string().trim().min(1),
  reactNativeVersion: z.string().trim().min(1),
  expoRuntimeVersion: z.string().trim().min(1).optional(),
  hermesVersion: z.string().trim().min(1).optional(),
  platform: z.string().trim().min(1),
  channel: z.string().trim().min(1),
  nativeCapabilitiesDigest: PluginUiArtifactDigestV1Schema,
  projectionGeneration: z.number().int().nonnegative(),
}).strict();
export type DaemonPluginReactNativeBundleCacheIdentityV1 = z.infer<
  typeof DaemonPluginReactNativeBundleCacheIdentityV1Schema
>;

export const DaemonPluginEmbeddedWebBundleCacheIdentityV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostAppVersion: z.string().trim().min(1),
  hostUiApiVersion: z.string().trim().min(1),
  reactVersion: z.string().trim().min(1),
  platform: z.literal('web'),
  channel: z.string().trim().min(1),
  projectionGeneration: z.number().int().nonnegative(),
}).strict();
export type DaemonPluginEmbeddedWebBundleCacheIdentityV1 = z.infer<
  typeof DaemonPluginEmbeddedWebBundleCacheIdentityV1Schema
>;

export const DaemonPluginUiArtifactBytesCacheIdentityV1Schema = z.union([
  DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  DaemonPluginEmbeddedWebBundleCacheIdentityV1Schema,
]);
export type DaemonPluginUiArtifactBytesCacheIdentityV1 = z.infer<
  typeof DaemonPluginUiArtifactBytesCacheIdentityV1Schema
>;

export const DaemonPluginUiArtifactFileBytesV1Schema = z.object({
  relativePath: z.string().trim().min(1),
  digest: PluginUiArtifactDigestV1Schema,
  byteSize: z.number().int().nonnegative(),
  bytesBase64: z.string().trim().min(1),
}).strict();
export type DaemonPluginUiArtifactFileBytesV1 = z.infer<
  typeof DaemonPluginUiArtifactFileBytesV1Schema
>;

export const DaemonPluginUiArtifactBytesReadRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  cacheIdentity: DaemonPluginUiArtifactBytesCacheIdentityV1Schema,
}).passthrough();
export type DaemonPluginUiArtifactBytesReadRequest = z.infer<
  typeof DaemonPluginUiArtifactBytesReadRequestSchema
>;

export const DaemonPluginUiArtifactBytesReadResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
    artifact: z.object({
      pluginId: z.string().trim().min(1),
      contributionId: z.string().trim().min(1),
      artifactKind: z.literal('reactNativeBundle'),
      digest: PluginUiArtifactDigestV1Schema,
      format: z.literal('plainJs'),
      byteSize: z.number().int().nonnegative(),
    }).strict(),
    bytesBase64: z.string().trim().min(1),
    files: z.array(DaemonPluginUiArtifactFileBytesV1Schema).min(1).optional(),
  }).strict(),
  z.object({
    ok: z.literal(true),
    cacheIdentity: DaemonPluginEmbeddedWebBundleCacheIdentityV1Schema,
    artifact: z.object({
      pluginId: z.string().trim().min(1),
      contributionId: z.string().trim().min(1),
      artifactKind: z.literal('embeddedWebBundle'),
      digest: PluginUiArtifactDigestV1Schema,
      contentType: z.enum(['text/javascript', 'application/javascript']),
      byteSize: z.number().int().nonnegative(),
    }).strict(),
    bytesBase64: z.string().trim().min(1),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'invalid_request',
      'artifact_not_found',
      'artifact_unavailable',
      'artifact_read_failed',
      'artifact_integrity_failed',
      'unsupported_artifact_format',
    ]),
    diagnostics: z.array(z.string().trim().min(1)).default([]),
  }).strict(),
]);
export type DaemonPluginUiArtifactBytesReadResponse = z.infer<
  typeof DaemonPluginUiArtifactBytesReadResponseSchema
>;

export const DaemonPluginReactNativeCrashReportReasonV1Schema = z.enum([
  'render_error_threshold',
  'startup_ack_timeout_threshold',
]);
export type DaemonPluginReactNativeCrashReportReasonV1 = z.infer<
  typeof DaemonPluginReactNativeCrashReportReasonV1Schema
>;

const DaemonPluginReactNativeCrashReportDiagnosticsV1Schema = z.array(
  z.string().trim().min(1).max(256),
).max(16).default([]);

export const DaemonPluginReactNativeCrashReportV1Schema = z.object({
  surfaceId: z.string().trim().min(1),
  cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  disabledReason: DaemonPluginReactNativeCrashReportReasonV1Schema,
  crashCount: z.number().int().nonnegative().default(0),
  startupFailureCount: z.number().int().nonnegative().default(0),
  observedAtMs: z.number().int().nonnegative().optional(),
  diagnostics: DaemonPluginReactNativeCrashReportDiagnosticsV1Schema,
}).strict();
export type DaemonPluginReactNativeCrashReportV1 = z.infer<
  typeof DaemonPluginReactNativeCrashReportV1Schema
>;

export const DaemonPluginReactNativeCrashReportRequestV1Schema = z.object({
  protocolVersion: z.literal(1),
  machineId: z.string().trim().min(1),
  report: DaemonPluginReactNativeCrashReportV1Schema,
}).strict();
export type DaemonPluginReactNativeCrashReportRequestV1 = z.infer<
  typeof DaemonPluginReactNativeCrashReportRequestV1Schema
>;

export const DaemonPluginReactNativeCrashReportResponseV1Schema = z.union([
  z.object({
    protocolVersion: z.literal(1),
    ok: z.literal(true),
    contributionKey: z.string().trim().min(1),
    disabled: z.literal(true),
  }).strict(),
  z.object({
    protocolVersion: z.literal(1),
    ok: z.literal(false),
    code: z.enum([
      'invalid_request',
      'projection_identity_mismatch',
      'state_write_failed',
    ]),
    diagnostics: z.array(z.string().trim().min(1).max(256)).max(16).default([]),
  }).strict(),
]);
export type DaemonPluginReactNativeCrashReportResponseV1 = z.infer<
  typeof DaemonPluginReactNativeCrashReportResponseV1Schema
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

export const PluginProjectedAgentV2Schema = z.preprocess(
  normalizeLegacyProjectedAgent,
  z.object({
    id: z.string().trim().min(1),
    title: PluginOptionalStringSchema,
    subtitle: PluginOptionalStringSchema,
    channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
    isBuiltIn: z.boolean().optional(),
    settingsBackendId: PluginOptionalStringSchema,
    catalogAgentId: PluginOptionalStringSchema,
    iconAgentId: PluginOptionalStringSchema,
  }).strict(),
);
export type PluginProjectedAgentV2 = z.infer<typeof PluginProjectedAgentV2Schema>;

export const PluginProjectedBackendV2Schema = z.preprocess(
  normalizeLegacyProjectedBackend,
  z.object({
    id: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
    title: PluginOptionalStringSchema,
    subtitle: PluginOptionalStringSchema,
    catalogAgentId: PluginOptionalStringSchema,
    iconAgentId: PluginOptionalStringSchema,
    capabilities: PluginBackendCapabilitiesV1Schema,
  }).strict(),
);
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
  eventId: PluginHookIdV1Schema,
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

export const PluginProjectedSettingsStorageScopeV2Schema = z.literal('pluginLocal');
export type PluginProjectedSettingsStorageScopeV2 = z.infer<
  typeof PluginProjectedSettingsStorageScopeV2Schema
>;

const PluginProjectedSettingsValueSchemaV2Schema = z.object({
  type: z.enum(['string', 'boolean', 'number', 'integer', 'object', 'array', 'null']),
}).strict();

export const PluginProjectedSettingsFieldV2Schema = z.object({
  id: z.string().trim().min(1),
  kind: z.literal('settings.field'),
  version: z.string().trim().min(1),
  valueSchema: PluginProjectedSettingsValueSchemaV2Schema,
  control: PluginSettingsControlKindV1Schema,
  displayKey: z.string().trim().min(1),
  descriptionKey: PluginOptionalStringSchema,
  groupId: PluginOptionalStringSchema.nullable().optional(),
  order: z.number().int().optional(),
  capabilityGates: z.array(z.string().trim().min(1)).default([]),
  permissionGates: z.array(z.string().trim().min(1)).default([]),
  redaction: PluginDescriptorRedactionV1Schema.default('none'),
  clearWhenEmpty: PluginDescriptorClearWhenEmptyV1Schema.default('persist'),
  defaultBooleanValue: z.boolean().optional(),
}).strict();
export type PluginProjectedSettingsFieldV2 = z.infer<typeof PluginProjectedSettingsFieldV2Schema>;

export const PluginProjectedSettingsV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  storageScope: PluginProjectedSettingsStorageScopeV2Schema,
  fields: z.array(PluginProjectedSettingsFieldV2Schema).default([]),
}).strict();
export type PluginProjectedSettingsV2 = z.infer<typeof PluginProjectedSettingsV2Schema>;

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

export const PluginProjectionV2Schema = z.preprocess(
  normalizeLegacyProjectionCollections,
  z.object({
    v: z.literal(2),
    generation: z.number().int().nonnegative(),
    installedPackagesById: z.record(z.string(), PluginProjectionInstalledPackageV2Schema).default({}),
    agentsById: z.record(z.string(), PluginProjectedAgentV2Schema).default({}),
    backendsById: z.record(z.string(), PluginProjectedBackendV2Schema).default({}),
    actionsById: z.record(z.string(), PluginProjectedActionV2Schema).default({}),
    toolsById: z.record(z.string(), PluginProjectedToolV2Schema).default({}),
    commandsById: z.record(z.string(), PluginProjectedCommandV2Schema).default({}),
    hooksById: z.record(z.string(), PluginProjectedHookV2Schema).optional(),
    resourcesById: z.record(z.string(), PluginProjectedResourceV2Schema).default({}),
    uiDescriptorsById: z.record(z.string(), PluginProjectedUiDescriptorV2Schema).default({}),
    settingsById: z.record(z.string(), PluginProjectedSettingsV2Schema).default({}),
    familiesById: z.record(z.string(), PluginProjectedFamilyV2Schema).default({}),
    diagnostics: z.array(PluginProjectionDiagnosticV2Schema).default([]),
  }).strict(),
);
export type PluginProjectionV2 = z.infer<typeof PluginProjectionV2Schema>;

export type DaemonContributionRegistryProjection =
  | DaemonContributionRegistryProjectionV1
  | PluginProjectionV2;
