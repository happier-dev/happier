import { z } from 'zod';

import {
  PluginActionConfirmationV2Schema,
  PluginActionDangerLevelV2Schema,
  PluginActionPlacementV2Schema,
  PluginActionScopeV2Schema,
  PluginActionSurfaceV2Schema,
} from '../plugins/actions/v2.js';
import { PluginUiArtifactDigestV1Schema } from '../plugins/ui/artifactIntegrity.js';
import { PluginResourceKindV2Schema } from '../plugins/contributions/v2.js';
import {
  PluginDescriptorClearWhenEmptyV1Schema,
  PluginDescriptorRedactionV1Schema,
} from '../plugins/contributions/_descriptors.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../plugins/contributions/publicTypes.js';
import {
  PluginSettingAnalyticsV2Schema,
  PluginSettingFieldPresentationV2Schema,
  PluginSettingFieldSchemaV2Schema,
  PluginSettingsPresentationV2Schema,
} from '../plugins/contributions/settings.js';
import { MAX_PLUGIN_STRUCTURED_MESSAGE_REFERENCES_V1 } from '../plugins/contributions/ui/structuredMessages.js';
import { PluginAgentCliMetadataSchema } from '../plugins/contributions/agentCliMetadata.js';
import { PluginOptionalStringSchema } from '../plugins/_shared.js';
import {
  PluginBackendCapabilitiesV1Schema,
  PluginBackendExternalSessionSourceDeclarationV1Schema,
} from '../plugins/backendDefinitionV1.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import {
  assertPluginProjectionFamilyIdsV2,
} from '../plugins/contributions/catalog.js';
import { ConnectedAccountUiProjectionEntryV1Schema } from '../connect/connectedAccountUiProjectionV1.js';
import {
  PluginContributionIntrospectionProjectionV1Schema,
  PluginDiagnosticRecordV1Schema,
} from './pluginContributionIntrospection.js';

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

export const DaemonContributionRegistryProjectionV1Schema = z.preprocess(
  normalizeLegacyProjectionCollections,
  z.object({
    v: z.literal(1),
    generationId: PluginOptionalStringSchema,
    agentsById: z.record(z.string(), DaemonContributionRegistryProjectionAgentEntryV1Schema).default({}),
    backendsById: z.record(z.string(), DaemonContributionRegistryProjectionBackendEntryV1Schema).default({}),
    actionsById: z.record(z.string(), DaemonContributionRegistryProjectionActionEntryV1Schema).default({}),
    resourcesById: z.record(z.string(), DaemonContributionRegistryProjectionResourceEntryV1Schema).default({}),
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

/** Installed-artifact loader readiness reported by a React Native web host. */
export const DaemonReactNativeWebLoaderCapabilityV1Schema = z.object({
  integrated: z.boolean(),
  installedArtifactLoaderAvailable: z.boolean(),
}).strict();
export type DaemonReactNativeWebLoaderCapabilityV1 = z.infer<
  typeof DaemonReactNativeWebLoaderCapabilityV1Schema
>;

export const DaemonContributionRegistryProjectionDescribeRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  reactNativeHostRuntimeIdentity: DaemonReactNativeHostRuntimeIdentityV1Schema.optional(),
  reactNativeWebLoaderCapability: DaemonReactNativeWebLoaderCapabilityV1Schema.optional(),
}).passthrough().refine(
  (value) => !(value.reactNativeHostRuntimeIdentity && value.reactNativeWebLoaderCapability),
  { message: 'native runtime identity and web loader capability are mutually exclusive' },
);
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

export const PluginProjectedSettingsStorageScopeV2Schema = z.enum([
  'local',
  'synced',
  'project',
  'session',
]);
export type PluginProjectedSettingsStorageScopeV2 = z.infer<
  typeof PluginProjectedSettingsStorageScopeV2Schema
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
  expectedRevision: z.string().trim().min(1).optional(),
}).strict();
export type DaemonPluginSettingsSetRequest = z.infer<
  typeof DaemonPluginSettingsSetRequestSchema
>;

export const DaemonPluginSettingsSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  pluginId: z.string().trim().min(1),
  storageScope: PluginProjectedSettingsStorageScopeV2Schema,
  revision: z.string().trim().min(1),
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

const DaemonPluginQualifiedContributionReferenceV1Schema = z.object({
  identity: z.object({
    pluginId: z.string().trim().min(1),
    localId: z.string().trim().min(1),
  }).strict(),
  qualifiedId: z.string().trim().min(1),
  generation: z.string().trim().min(1),
}).strict();

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function isCanonicalBase64(value: string): boolean {
  if (!CANONICAL_BASE64_PATTERN.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 0) return true;
  const lastSextet = BASE64_ALPHABET.indexOf(value[value.length - padding - 1] ?? '');
  return padding === 2 ? lastSextet % 16 === 0 : lastSextet % 4 === 0;
}

export const DaemonPluginStructuredMessageResolveRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  expectedGeneration: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  payload: PluginJsonValueV2Schema,
  resourceRefs: z.array(PluginContributionReferenceV2Schema)
    .max(MAX_PLUGIN_STRUCTURED_MESSAGE_REFERENCES_V1)
    .optional(),
  facts: z.record(z.string(), z.union([
    z.boolean(),
    z.string(),
    z.array(z.string()),
  ])).default({}),
}).strict();
export type DaemonPluginStructuredMessageResolveRequest = z.infer<
  typeof DaemonPluginStructuredMessageResolveRequestSchema
>;

export const DaemonPluginStructuredMessageResolveResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    model: z.object({
      identity: z.object({
        pluginId: z.string().trim().min(1),
        localId: z.string().trim().min(1),
        qualifiedId: z.string().trim().min(1),
        generation: z.string().trim().min(1),
      }).strict(),
      kind: z.string().trim().min(1),
      title: PluginLocalizedStringV2Schema,
      description: PluginLocalizedStringV2Schema.optional(),
      payload: PluginJsonValueV2Schema,
      renderer: DaemonPluginQualifiedContributionReferenceV1Schema,
      actions: z.array(DaemonPluginQualifiedContributionReferenceV1Schema.extend({ enabled: z.boolean() })),
      resources: z.array(DaemonPluginQualifiedContributionReferenceV1Schema),
      fallback: z.union([
        z.object({ kind: z.literal('summary'), template: z.string() }).strict(),
        z.object({ kind: z.literal('hidden') }).strict(),
      ]),
      visible: z.boolean(),
      metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
    }).strict(),
    renderer: z.object({
      identity: z.object({
        pluginId: z.string().trim().min(1),
        localId: z.string().trim().min(1),
        qualifiedId: z.string().trim().min(1),
        generation: z.string().trim().min(1),
      }).strict(),
      visible: z.boolean(),
      requiredHostMethods: z.array(z.string()),
      root: PluginJsonValueV2Schema,
      nodes: z.array(PluginJsonValueV2Schema),
    }).strict(),
    resources: z.array(z.object({
      reference: DaemonPluginQualifiedContributionReferenceV1Schema,
      kind: PluginResourceKindV2Schema,
      contentType: z.string().trim().min(1),
      digest: PluginUiArtifactDigestV1Schema,
      bytesBase64: z.string().refine(isCanonicalBase64),
    }).strict()),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.string().trim().min(1),
    reason: z.enum(['invalid_payload', 'stale_generation', 'unavailable', 'unknown_kind']),
  }).strict(),
]);
export type DaemonPluginStructuredMessageResolveResponse = z.infer<
  typeof DaemonPluginStructuredMessageResolveResponseSchema
>;

export const DaemonPluginStructuredMessageActionExecuteRequestSchema = z.object({
  machineId: z.string().trim().min(1),
  expectedGeneration: z.string().trim().min(1),
  qualifiedActionId: z.string().trim().min(1),
  input: PluginJsonValueV2Schema,
  sessionId: z.string().trim().min(1).optional(),
  executionSurface: z.enum(['cli', 'ui']).optional(),
}).strict();
export type DaemonPluginStructuredMessageActionExecuteRequest = z.infer<
  typeof DaemonPluginStructuredMessageActionExecuteRequestSchema
>;

export const DaemonPluginStructuredMessageActionExecuteResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: PluginJsonValueV2Schema }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.string().trim().min(1),
  }).strict(),
]);
export type DaemonPluginStructuredMessageActionExecuteResponse = z.infer<
  typeof DaemonPluginStructuredMessageActionExecuteResponseSchema
>;

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

export const DaemonPluginUiArtifactBytesCacheIdentityV1Schema =
  DaemonPluginReactNativeBundleCacheIdentityV1Schema;
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
  reactNativeHostRuntimeIdentity: DaemonReactNativeHostRuntimeIdentityV1Schema.optional(),
  reactNativeWebLoaderCapability: DaemonReactNativeWebLoaderCapabilityV1Schema.optional(),
}).passthrough().refine(
  (value) => !(value.reactNativeHostRuntimeIdentity && value.reactNativeWebLoaderCapability),
  { message: 'native runtime identity and web loader capability are mutually exclusive' },
);
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

const PluginProjectedProviderOwnedEnvironmentKeysV2Schema = z.array(
  z.string().min(1).max(256).regex(/^[A-Z_][A-Z0-9_]*$/u),
).max(64).superRefine((keys, ctx) => {
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: 'custom', message: 'Provider-owned environment keys must be unique' });
  }
});

export const PluginProjectedAgentExternalSessionsOperationsV2Schema = z.object({
  listCandidates: z.boolean(),
  resolveLinkIdentity: z.boolean(),
  pageTranscript: z.boolean(),
  readAfterTranscript: z.boolean(),
}).strict();
export type PluginProjectedAgentExternalSessionsOperationsV2 = z.infer<
  typeof PluginProjectedAgentExternalSessionsOperationsV2Schema
>;

export const PluginProjectedAgentExternalSessionsV2Schema = z.object({
  agent: PluginContributionIdentityV1Schema,
  generation: z.number().int().nonnegative(),
  operations: PluginProjectedAgentExternalSessionsOperationsV2Schema,
  sources: z.array(PluginBackendExternalSessionSourceDeclarationV1Schema).min(1),
}).strict();
export type PluginProjectedAgentExternalSessionsV2 = z.infer<
  typeof PluginProjectedAgentExternalSessionsV2Schema
>;

export const PluginProjectedAgentV2Schema = z.preprocess(
  normalizeLegacyProjectedAgent,
  z.object({
    id: z.string().trim().min(1),
    identity: PluginContributionIdentityV1Schema.optional(),
    title: PluginOptionalStringSchema,
    subtitle: PluginOptionalStringSchema,
    channel: z.union([z.enum(['stable', 'experimental', 'plugin']), z.string()]).optional(),
    isBuiltIn: z.boolean().optional(),
    settingsBackendId: PluginOptionalStringSchema,
    catalogAgentId: PluginOptionalStringSchema,
    iconAgentId: PluginOptionalStringSchema,
    providerOwnedEnvironmentKeys: PluginProjectedProviderOwnedEnvironmentKeysV2Schema.default([]),
    capabilities: z.object({
      sessions: z.object({
        startupInstructions: z.object({
          versions: z.tuple([z.literal(1)]),
        }).strict().optional(),
      }).strict().optional(),
    }).strict().optional(),
    cli: PluginAgentCliMetadataSchema.optional(),
    externalSessions: PluginProjectedAgentExternalSessionsV2Schema.optional(),
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
  confirmation: PluginActionConfirmationV2Schema.optional(),
  available: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.dangerLevel === 'safe' && value.confirmation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirmation'],
      message: 'Safe projected actions cannot request confirmation.',
    });
    return;
  }
  if (value.dangerLevel === 'safe' || value.confirmation) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['confirmation'],
    message: 'Non-safe projected actions must carry host confirmation presentation metadata.',
  });
});
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

export const PluginProjectedResourceV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  resourceKind: PluginResourceKindV2Schema,
  path: z.string().trim().min(1),
  digest: PluginOptionalStringSchema,
  contentType: PluginOptionalStringSchema,
}).strict();
export type PluginProjectedResourceV2 = z.infer<typeof PluginProjectedResourceV2Schema>;

export const PluginProjectedSettingsFieldV2Schema = z.object({
  id: z.string().trim().min(1),
  kind: z.literal('settings.field'),
  version: z.string().trim().min(1),
  valueSchema: PluginSettingFieldSchemaV2Schema,
  valueType: z.enum(['string', 'boolean', 'number', 'integer', 'object', 'array', 'null']),
  control: z.enum([
    'auto',
    'text',
    'password',
    'textarea',
    'switch',
    'select',
    'multiSelect',
    'number',
    'json',
  ]),
  displayKey: z.string().trim().min(1),
  descriptionKey: PluginOptionalStringSchema,
  presentation: PluginSettingFieldPresentationV2Schema.optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  analytics: PluginSettingAnalyticsV2Schema.optional(),
  groupId: PluginOptionalStringSchema.nullable().optional(),
  order: z.number().int().optional(),
  capabilityGates: z.array(z.string().trim().min(1)).default([]),
  permissionGates: z.array(z.string().trim().min(1)).default([]),
  redaction: PluginDescriptorRedactionV1Schema.default('none'),
  clearWhenEmpty: PluginDescriptorClearWhenEmptyV1Schema.default('persist'),
  defaultBooleanValue: z.boolean().optional(),
  defaultValue: PluginJsonValueV2Schema.optional(),
}).strict();
export type PluginProjectedSettingsFieldV2 = z.infer<typeof PluginProjectedSettingsFieldV2Schema>;

export const PluginProjectedSettingsV2Schema = z.object({
  id: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  version: z.literal(1),
  title: z.string().trim().min(1),
  description: PluginOptionalStringSchema,
  storageScope: PluginProjectedSettingsStorageScopeV2Schema,
  presentation: PluginSettingsPresentationV2Schema,
  target: z.union([
    z.object({ kind: z.literal('plugin') }).strict(),
    z.object({
      kind: z.literal('agent'),
      agent: z.object({
        pluginId: z.string().trim().min(1),
        localId: z.string().trim().min(1),
      }).strict(),
    }).strict(),
  ]),
  fields: z.array(PluginProjectedSettingsFieldV2Schema).default([]),
}).strict();
export type PluginProjectedSettingsV2 = z.infer<typeof PluginProjectedSettingsV2Schema>;

const PluginProjectedFamilyEntryBaseV2Shape = {
  id: z.string().trim().min(1),
  pluginId: PluginOptionalStringSchema,
} as const;

function strictProjectedFamilyEntrySchema<const Keys extends readonly string[]>(keys: Keys) {
  const optionalFields = Object.fromEntries(
    keys.map((key) => [key, z.unknown().optional()]),
  ) as { [Key in Keys[number]]: z.ZodOptional<z.ZodUnknown> };
  return z.object({
    ...PluginProjectedFamilyEntryBaseV2Shape,
    ...optionalFields,
  }).strict();
}

const PluginProjectedDefinitionEntryV2Schema = strictProjectedFamilyEntrySchema([
  'generation',
  'contributionKey',
  'definition',
] as const);
const PluginProjectedVoiceProviderEntryV2Schema = strictProjectedFamilyEntrySchema([
  'generation',
  'contributionKey',
  'definition',
  'recipientContract',
  'recipientContractDigest',
] as const);
const PluginProjectedScmHostingProviderEntryV2Schema = strictProjectedFamilyEntrySchema([
  'localId',
  'kind',
  'displayName',
  'description',
  'baseUrl',
  'urlSafety',
  'capabilities',
  'operations',
  'authService',
  'metadata',
] as const);
const PluginProjectedScmBackendEntryV2Schema = strictProjectedFamilyEntrySchema([
  'localId',
  'title',
  'displayName',
  'description',
  'kind',
  'capabilities',
  'operations',
  'metadata',
] as const);
const PluginProjectedManagedDependencyEntryV2Schema = strictProjectedFamilyEntrySchema([
  'key',
  'kind',
  'title',
  'version',
  'capabilityId',
  'sourceKind',
  'display',
  'description',
  'source',
  'sources',
  'binary',
  'defaultPolicy',
  'consent',
  'ui',
  'stability',
  'experimental',
  'displayKey',
  'descriptionKey',
  'groupId',
  'order',
  'capabilityGates',
  'permissionGates',
  'redaction',
  'hidden',
  'defaultValue',
  'clearWhenEmpty',
  'platforms',
  'architectures',
  'executable',
  'health',
  'metadata',
] as const);
const PluginProjectedMcpEntryV2Schema = strictProjectedFamilyEntrySchema([
  'contributionKind',
  'title',
  'description',
  'kind',
  'transport',
  'sessionScope',
  'resultSchema',
  'availability',
] as const);
const PluginProjectedBrowserEntryV2Schema = strictProjectedFamilyEntrySchema([
  'contributionKind',
  'contributionId',
  'target',
  'display',
  'currentUrl',
  'launchMode',
  'profileMode',
  'description',
  'availability',
  'metadata',
  'qualifiedActionId',
  'targetId',
  'placement',
  'order',
] as const);
const PluginProjectedUiEntryV2Schema = strictProjectedFamilyEntrySchema([
  'contributionKind',
  'pluginVersion',
  'descriptorId',
  'contributionId',
  'contributionFamily',
  'artifactId',
  'artifactKind',
  'generatedV2',
  'generatedOwnerKind',
  'defaultLocale',
  'locales',
  'bundles',
  'digest',
  'families',
  'title',
  'description',
  'action',
  'kind',
  'order',
  'availability',
  'metadata',
  'fallback',
  'source',
  'service',
  'runtimeMode',
  'runtimeDiagnostics',
  'runtime',
  'entry',
  'bridge',
  'sandbox',
  'security',
  'display',
  'compatibility',
  'artifactGraph',
  'bundle',
  'hostApi',
  'nativeCapabilities',
  'availablePlatforms',
  'policy',
  'requiredHostMethods',
  'placement',
  'target',
  'renderer',
  'visibility',
  'enabled',
  'featureGate',
  'badge',
  'actions',
  'hostActions',
  'rightSidebar',
  'fallbackRenderers',
  'platform',
  'channel',
  'integrity',
  'byteSize',
  'contentType',
  'assetPath',
  'url',
  'cacheKey',
  'diagnostics',
] as const);

export const PluginProjectedFamilyEntryV2Schema = z.union([
  PluginProjectedDefinitionEntryV2Schema,
  PluginProjectedVoiceProviderEntryV2Schema,
  ConnectedAccountUiProjectionEntryV1Schema,
  PluginProjectedScmHostingProviderEntryV2Schema,
  PluginProjectedScmBackendEntryV2Schema,
  PluginProjectedManagedDependencyEntryV2Schema,
  PluginProjectedMcpEntryV2Schema,
  PluginProjectedBrowserEntryV2Schema,
  PluginProjectedUiEntryV2Schema,
]);
export type PluginProjectedFamilyEntryV2 = z.infer<typeof PluginProjectedFamilyEntryV2Schema>;

function projectedFamilySchema<
  const Family extends string,
  EntrySchema extends z.ZodType,
>(
  family: Family,
  entrySchema: EntrySchema,
) {
  return z.object({
    family: z.literal(family),
    entriesById: z.record(z.string(), entrySchema).default({}),
  }).strict();
}

const PluginProjectedProvidersFamilyV2Schema = projectedFamilySchema('providers', PluginProjectedDefinitionEntryV2Schema);
const PluginProjectedConnectedAccountsFamilyV2Schema = projectedFamilySchema('connectedAccounts', ConnectedAccountUiProjectionEntryV1Schema);
const PluginProjectedScmHostingProvidersFamilyV2Schema = projectedFamilySchema('scmHostingProviders', PluginProjectedScmHostingProviderEntryV2Schema);
const PluginProjectedScmBackendsFamilyV2Schema = projectedFamilySchema('scmBackends', PluginProjectedScmBackendEntryV2Schema);
const PluginProjectedManagedDependenciesFamilyV2Schema = projectedFamilySchema('managedDependencies', PluginProjectedManagedDependencyEntryV2Schema);
const PluginProjectedMcpFamilyV2Schema = projectedFamilySchema('mcp', PluginProjectedMcpEntryV2Schema);
const PluginProjectedUiFamilyV2Schema = projectedFamilySchema('pluginUi', PluginProjectedUiEntryV2Schema);
const PluginProjectedBrowserFamilyV2Schema = projectedFamilySchema('pluginBrowser', PluginProjectedBrowserEntryV2Schema);
const PluginProjectedVoiceModelPacksFamilyV2Schema = projectedFamilySchema('voiceModelPacks', PluginProjectedDefinitionEntryV2Schema);
const PluginProjectedVoiceProvidersFamilyV2Schema = projectedFamilySchema('voiceProviders', PluginProjectedVoiceProviderEntryV2Schema);

const PluginProjectedFamiliesByIdV2Schema = z.object({
  providers: PluginProjectedProvidersFamilyV2Schema.optional(),
  connectedAccounts: PluginProjectedConnectedAccountsFamilyV2Schema.optional(),
  scmHostingProviders: PluginProjectedScmHostingProvidersFamilyV2Schema.optional(),
  scmBackends: PluginProjectedScmBackendsFamilyV2Schema.optional(),
  managedDependencies: PluginProjectedManagedDependenciesFamilyV2Schema.optional(),
  mcp: PluginProjectedMcpFamilyV2Schema.optional(),
  pluginUi: PluginProjectedUiFamilyV2Schema.optional(),
  pluginBrowser: PluginProjectedBrowserFamilyV2Schema.optional(),
  voiceModelPacks: PluginProjectedVoiceModelPacksFamilyV2Schema.optional(),
  voiceProviders: PluginProjectedVoiceProvidersFamilyV2Schema.optional(),
}).strict().default({});
assertPluginProjectionFamilyIdsV2(Object.keys(PluginProjectedFamiliesByIdV2Schema.unwrap().shape));

export const PluginProjectedFamilyV2Schema = z.union([
  PluginProjectedProvidersFamilyV2Schema,
  PluginProjectedConnectedAccountsFamilyV2Schema,
  PluginProjectedScmHostingProvidersFamilyV2Schema,
  PluginProjectedScmBackendsFamilyV2Schema,
  PluginProjectedManagedDependenciesFamilyV2Schema,
  PluginProjectedMcpFamilyV2Schema,
  PluginProjectedUiFamilyV2Schema,
  PluginProjectedBrowserFamilyV2Schema,
  PluginProjectedVoiceModelPacksFamilyV2Schema,
  PluginProjectedVoiceProvidersFamilyV2Schema,
]);
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
    resourcesById: z.record(z.string(), PluginProjectedResourceV2Schema).default({}),
    settingsById: z.record(z.string(), PluginProjectedSettingsV2Schema).default({}),
    familiesById: PluginProjectedFamiliesByIdV2Schema,
    contributionIntrospection: PluginContributionIntrospectionProjectionV1Schema.optional(),
    diagnostics: z.array(PluginDiagnosticRecordV1Schema).default([]),
  }).strict(),
);
export type PluginProjectionV2 = z.infer<typeof PluginProjectionV2Schema>;

export type DaemonContributionRegistryProjection =
  | DaemonContributionRegistryProjectionV1
  | PluginProjectionV2;
