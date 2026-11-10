import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { LocalServiceActionKindV1Schema } from '../../../local/services/actions/v1.js';
import { LocalServiceLaunchTargetSourceV1Schema } from '../../../local/services/launcher/v1.js';
import { LocalServicePreviewDiagnosticReasonCodeV1Schema } from '../../../local/services/preview/diagnostics/v1.js';
import { LocalServicePublicExposureModeV1Schema } from '../../../local/services/public/v1.js';

export const DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_LOCAL_SERVICE_INVENTORY_REFRESH_INTERVAL_MS = 10_000;
export const DEFAULT_LOCAL_SERVICE_INVENTORY_STALE_AFTER_MS = 30_000;
export const DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS = 650;
export const DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES = 128 * 1024;
export const DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY = 4;
export const DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS = 30_000;
export const DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS = 10_000;
export const DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_START = 49_152;
export const DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_END = 65_535;
export const DEFAULT_LOCAL_SERVICE_MANAGED_MAX_SERVICES_PER_OWNER = 8;
export const DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_DEPTH = 4;
export const DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_SCRIPTS = 50;
export const DEFAULT_LOCAL_SERVICE_LAUNCHER_RECENT_HISTORY_MAX_ENTRIES = 20;
export const DEFAULT_LOCAL_SERVICE_ACTION_GRACEFUL_TIMEOUT_MS = 5_000;
export const DEFAULT_LOCAL_SERVICE_ACTION_VERIFICATION_TIMEOUT_MS = 10_000;

export const LocalServicePreviewDiagnosticsCapabilitiesSchema = lazyZodSchema(() => z.object({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    supportedReasonCodes: z._default(z.optional(z.array(LocalServicePreviewDiagnosticReasonCodeV1Schema)), []),
    pmsProjection: z._default(z.optional(z.boolean()), false),
    publicPreviewProjection: z._default(z.optional(z.boolean()), false),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), ['observability_unavailable']),
  }));
export type LocalServicePreviewDiagnosticsCapabilities = z.infer<
  typeof LocalServicePreviewDiagnosticsCapabilitiesSchema
>;

export const DEFAULT_LOCAL_SERVICE_PREVIEW_DIAGNOSTICS_CAPABILITIES: LocalServicePreviewDiagnosticsCapabilities = {
  enabled: false,
  available: false,
  supportedReasonCodes: [],
  pmsProjection: false,
  publicPreviewProjection: false,
  disabledReasons: ['observability_unavailable'],
};

function normalizePositiveInt(raw: unknown, fallback: number): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

export const LocalServicePreviewCapabilitiesSchema = lazyZodSchema(() => z.object({
    enabled: z._default(z.optional(z.boolean()), false),
    hostOriginAvailable: z._default(z.optional(z.boolean()), false),
    pathModeAvailable: z._default(z.optional(z.boolean()), false),
    pmsRelayReady: z._default(z.optional(z.boolean()), false),
    pmsStreamingReady: z._default(z.optional(z.boolean()), false),
    webSocketSupport: z._default(z.optional(z.boolean()), false),
    streamingSseSupport: z._default(z.optional(z.boolean()), false),
    compressionPolicy: z._default(z.optional(z.enum(['identity', 'decode_reencode'])), 'identity'),
    cookiePolicy: z._default(z.optional(z.enum(['drop', 'isolate', 'rewrite'])), 'drop'),
    maxRequestBodyBytes: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_REQUEST_BODY_BYTES)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_REQUEST_BODY_BYTES),
    maxResponseBodyBytes: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_RESPONSE_BODY_BYTES)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_RESPONSE_BODY_BYTES),
    tokenTtlMs: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS),
    diagnostics: z._default(z.optional(LocalServicePreviewDiagnosticsCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_PREVIEW_DIAGNOSTICS_CAPABILITIES),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
export type LocalServicePreviewCapabilities = z.infer<typeof LocalServicePreviewCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_PREVIEW_CAPABILITIES: LocalServicePreviewCapabilities = {
  enabled: false,
  hostOriginAvailable: false,
  pathModeAvailable: false,
  pmsRelayReady: false,
  pmsStreamingReady: false,
  webSocketSupport: false,
  streamingSseSupport: false,
  compressionPolicy: 'identity',
  cookiePolicy: 'drop',
  maxRequestBodyBytes: DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_REQUEST_BODY_BYTES,
  maxResponseBodyBytes: DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_RESPONSE_BODY_BYTES,
  tokenTtlMs: DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS,
  diagnostics: DEFAULT_LOCAL_SERVICE_PREVIEW_DIAGNOSTICS_CAPABILITIES,
  disabledReasons: [],
};

export const LocalServicePublicCapabilitiesSchema = lazyZodSchema(() => z.object({
    enabled: z._default(z.optional(z.boolean()), false),
    allowedModes: z._default(z.optional(z.array(LocalServicePublicExposureModeV1Schema)), []),
    maxTtlMs: z.optional(z.number().check(z.int(), z.positive())),
    maxConcurrentExposures: z.optional(z.number().check(z.int(), z.positive())),
    dnsTlsHostModeAvailable: z._default(z.optional(z.boolean()), false),
    webSocketSupport: z._default(z.optional(z.boolean()), false),
    auditEnabled: z._default(z.optional(z.boolean()), false),
    abuseControlsEnabled: z._default(z.optional(z.boolean()), false),
    rateLimitProfileIds: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(128)))), []),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), ['disabled_by_server_policy']),
  }));
export type LocalServicePublicCapabilities = z.infer<typeof LocalServicePublicCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_PUBLIC_CAPABILITIES: LocalServicePublicCapabilities = {
  enabled: false,
  allowedModes: [],
  dnsTlsHostModeAvailable: false,
  webSocketSupport: false,
  auditEnabled: false,
  abuseControlsEnabled: false,
  rateLimitProfileIds: [],
  disabledReasons: ['disabled_by_server_policy'],
};

export const LocalServicePageTitleCapabilitiesSchema = lazyZodSchema(() => z.object({
    enabled: z._default(z.optional(z.boolean()), false),
    timeoutMs: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS),
    maxBodyBytes: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES),
    concurrency: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY),
    successTtlMs: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS),
    failureTtlMs: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS),
  }));
export type LocalServicePageTitleCapabilities = z.infer<typeof LocalServicePageTitleCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CAPABILITIES: LocalServicePageTitleCapabilities = {
  enabled: false,
  timeoutMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS,
  maxBodyBytes: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES,
  concurrency: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY,
  successTtlMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS,
  failureTtlMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS,
};

export const LocalServiceInventoryCapabilitiesSchema = lazyZodSchema(() => z.object({
    supportedPlatforms: z._default(z.optional(z.array(z.enum(['darwin', 'linux', 'windows']))), []),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
    refreshIntervalMs: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_INVENTORY_REFRESH_INTERVAL_MS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_INVENTORY_REFRESH_INTERVAL_MS),
    staleAfterMs: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_INVENTORY_STALE_AFTER_MS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_INVENTORY_STALE_AFTER_MS),
    processProvenance: z._default(z.optional(z.boolean()), false),
    workspaceProvenance: z._default(z.optional(z.boolean()), false),
    classifier: z._default(z.optional(z.boolean()), false),
    pageTitleEnrichment: z._default(z.optional(LocalServicePageTitleCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CAPABILITIES),
    redactsProcessArgs: z._default(z.optional(z.boolean()), true),
  }));
export type LocalServiceInventoryCapabilities = z.infer<typeof LocalServiceInventoryCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_INVENTORY_CAPABILITIES: LocalServiceInventoryCapabilities = {
  supportedPlatforms: [],
  disabledReasons: [],
  refreshIntervalMs: DEFAULT_LOCAL_SERVICE_INVENTORY_REFRESH_INTERVAL_MS,
  staleAfterMs: DEFAULT_LOCAL_SERVICE_INVENTORY_STALE_AFTER_MS,
  processProvenance: false,
  workspaceProvenance: false,
  classifier: false,
  pageTitleEnrichment: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CAPABILITIES,
  redactsProcessArgs: true,
};

export const LocalServiceManagedCapabilitiesSchema = lazyZodSchema(() => z.object({
    enabled: z._default(z.optional(z.boolean()), false),
    supportedRestartPolicies: z._default(z.optional(z.array(z.enum(['never']))), ['never']),
    portRange: z._default(z.optional(z
      .object({
        start: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_START)), z.number().check(z.int(), z.minimum(1), z.maximum(65_535)))), DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_START),
        end: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_END)), z.number().check(z.int(), z.minimum(1), z.maximum(65_535)))), DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_END),
      })), {
        start: DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_START,
        end: DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_END,
      }),
    maxServicesPerOwner: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_MANAGED_MAX_SERVICES_PER_OWNER)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_MANAGED_MAX_SERVICES_PER_OWNER),
    localNameDomain: z._default(z.optional(z.string().check(z.trim(), z.minLength(1))), 'localhost'),
    previewRegistrationAvailable: z._default(z.optional(z.boolean()), false),
  }));
export type LocalServiceManagedCapabilities = z.infer<typeof LocalServiceManagedCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_MANAGED_CAPABILITIES: LocalServiceManagedCapabilities = {
  enabled: false,
  supportedRestartPolicies: ['never'],
  portRange: {
    start: DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_START,
    end: DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_END,
  },
  maxServicesPerOwner: DEFAULT_LOCAL_SERVICE_MANAGED_MAX_SERVICES_PER_OWNER,
  localNameDomain: 'localhost',
  previewRegistrationAvailable: false,
};

export const LocalServiceLauncherCapabilitiesSchema = lazyZodSchema(() => z.object({
    supportedSources: z._default(z.optional(z.array(LocalServiceLaunchTargetSourceV1Schema)), []),
    scriptDiscovery: z._default(z.optional(z.object({
        enabled: z._default(z.optional(z.boolean()), false),
        maxDepth: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_DEPTH)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_DEPTH),
        maxScripts: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_SCRIPTS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_SCRIPTS),
      })), {
        enabled: false,
        maxDepth: DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_DEPTH,
        maxScripts: DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_SCRIPTS,
      }),
    recentHistory: z._default(z.optional(z.object({
        enabled: z._default(z.optional(z.boolean()), false),
        maxEntries: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_LAUNCHER_RECENT_HISTORY_MAX_ENTRIES)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_LAUNCHER_RECENT_HISTORY_MAX_ENTRIES),
      })), {
        enabled: false,
        maxEntries: DEFAULT_LOCAL_SERVICE_LAUNCHER_RECENT_HISTORY_MAX_ENTRIES,
      }),
    launchActionsEnabled: z._default(z.optional(z.boolean()), false),
  }));
export type LocalServiceLauncherCapabilities = z.infer<typeof LocalServiceLauncherCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_LAUNCHER_CAPABILITIES: LocalServiceLauncherCapabilities = {
  supportedSources: [],
  scriptDiscovery: {
    enabled: false,
    maxDepth: DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_DEPTH,
    maxScripts: DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_SCRIPTS,
  },
  recentHistory: {
    enabled: false,
    maxEntries: DEFAULT_LOCAL_SERVICE_LAUNCHER_RECENT_HISTORY_MAX_ENTRIES,
  },
  launchActionsEnabled: false,
};

export const LocalServiceActionCapabilitiesSchema = lazyZodSchema(() => z.object({
    supportedKinds: z._default(z.optional(z
      .array(LocalServiceActionKindV1Schema)), ['copy_url', 'open_preview', 'forget']),
    terminate: z._default(z.optional(z.object({
        enabled: z._default(z.optional(z.boolean()), false),
        gracefulTimeoutMs: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_ACTION_GRACEFUL_TIMEOUT_MS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_ACTION_GRACEFUL_TIMEOUT_MS),
        verificationTimeoutMs: z._default(z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_ACTION_VERIFICATION_TIMEOUT_MS)), z.number().check(z.int(), z.positive()))), DEFAULT_LOCAL_SERVICE_ACTION_VERIFICATION_TIMEOUT_MS),
        forceAllowed: z._default(z.optional(z.boolean()), false),
      })), {
        enabled: false,
        gracefulTimeoutMs: DEFAULT_LOCAL_SERVICE_ACTION_GRACEFUL_TIMEOUT_MS,
        verificationTimeoutMs: DEFAULT_LOCAL_SERVICE_ACTION_VERIFICATION_TIMEOUT_MS,
        forceAllowed: false,
      }),
  }));
export type LocalServiceActionCapabilities = z.infer<typeof LocalServiceActionCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_ACTION_CAPABILITIES: LocalServiceActionCapabilities = {
  supportedKinds: ['copy_url', 'open_preview', 'forget'],
  terminate: {
    enabled: false,
    gracefulTimeoutMs: DEFAULT_LOCAL_SERVICE_ACTION_GRACEFUL_TIMEOUT_MS,
    verificationTimeoutMs: DEFAULT_LOCAL_SERVICE_ACTION_VERIFICATION_TIMEOUT_MS,
    forceAllowed: false,
  },
};

export const LocalServiceCapabilitiesSchema = lazyZodSchema(() => z.object({
    inventory: z._default(z.optional(LocalServiceInventoryCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_INVENTORY_CAPABILITIES),
    managed: z._default(z.optional(LocalServiceManagedCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_MANAGED_CAPABILITIES),
    launcher: z._default(z.optional(LocalServiceLauncherCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_LAUNCHER_CAPABILITIES),
    actions: z._default(z.optional(LocalServiceActionCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_ACTION_CAPABILITIES),
    preview: z._default(z.optional(LocalServicePreviewCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_PREVIEW_CAPABILITIES),
    publicPreview: z._default(z.optional(LocalServicePublicCapabilitiesSchema), DEFAULT_LOCAL_SERVICE_PUBLIC_CAPABILITIES),
  }));
export type LocalServiceCapabilities = z.infer<typeof LocalServiceCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_CAPABILITIES: LocalServiceCapabilities = {
  inventory: DEFAULT_LOCAL_SERVICE_INVENTORY_CAPABILITIES,
  managed: DEFAULT_LOCAL_SERVICE_MANAGED_CAPABILITIES,
  launcher: DEFAULT_LOCAL_SERVICE_LAUNCHER_CAPABILITIES,
  actions: DEFAULT_LOCAL_SERVICE_ACTION_CAPABILITIES,
  preview: DEFAULT_LOCAL_SERVICE_PREVIEW_CAPABILITIES,
  publicPreview: DEFAULT_LOCAL_SERVICE_PUBLIC_CAPABILITIES,
};
