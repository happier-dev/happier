import { z } from 'zod';

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

export const LocalServicePreviewDiagnosticsCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    supportedReasonCodes: z.array(LocalServicePreviewDiagnosticReasonCodeV1Schema).optional().default([]),
    pmsProjection: z.boolean().optional().default(false),
    publicPreviewProjection: z.boolean().optional().default(false),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default(['observability_unavailable']),
  })
  .strict();
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

export const LocalServicePreviewCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    hostOriginAvailable: z.boolean().optional().default(false),
    pathModeAvailable: z.boolean().optional().default(false),
    pmsRelayReady: z.boolean().optional().default(false),
    pmsStreamingReady: z.boolean().optional().default(false),
    webSocketSupport: z.boolean().optional().default(false),
    streamingSseSupport: z.boolean().optional().default(false),
    compressionPolicy: z.enum(['identity', 'decode_reencode']).optional().default('identity'),
    cookiePolicy: z.enum(['drop', 'isolate', 'rewrite']).optional().default('drop'),
    maxRequestBodyBytes: z
      .preprocess(
        (raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_REQUEST_BODY_BYTES),
        z.number().int().positive(),
      )
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_REQUEST_BODY_BYTES),
    maxResponseBodyBytes: z
      .preprocess(
        (raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_RESPONSE_BODY_BYTES),
        z.number().int().positive(),
      )
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_PREVIEW_MAX_RESPONSE_BODY_BYTES),
    tokenTtlMs: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_PREVIEW_TOKEN_TTL_MS),
    diagnostics: LocalServicePreviewDiagnosticsCapabilitiesSchema.optional().default(
      DEFAULT_LOCAL_SERVICE_PREVIEW_DIAGNOSTICS_CAPABILITIES,
    ),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
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

export const LocalServicePublicCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    allowedModes: z.array(LocalServicePublicExposureModeV1Schema).optional().default([]),
    maxTtlMs: z.number().int().positive().optional(),
    maxConcurrentExposures: z.number().int().positive().optional(),
    dnsTlsHostModeAvailable: z.boolean().optional().default(false),
    webSocketSupport: z.boolean().optional().default(false),
    auditEnabled: z.boolean().optional().default(false),
    abuseControlsEnabled: z.boolean().optional().default(false),
    rateLimitProfileIds: z.array(z.string().trim().min(1).max(128)).optional().default([]),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default(['disabled_by_server_policy']),
  })
  .strict();
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

export const LocalServicePageTitleCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    timeoutMs: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS),
    maxBodyBytes: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES),
    concurrency: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY),
    successTtlMs: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS),
    failureTtlMs: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS),
  })
  .strict();
export type LocalServicePageTitleCapabilities = z.infer<typeof LocalServicePageTitleCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CAPABILITIES: LocalServicePageTitleCapabilities = {
  enabled: false,
  timeoutMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS,
  maxBodyBytes: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES,
  concurrency: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY,
  successTtlMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS,
  failureTtlMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS,
};

export const LocalServiceInventoryCapabilitiesSchema = z
  .object({
    supportedPlatforms: z.array(z.enum(['darwin', 'linux', 'windows'])).optional().default([]),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
    refreshIntervalMs: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_INVENTORY_REFRESH_INTERVAL_MS), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_INVENTORY_REFRESH_INTERVAL_MS),
    staleAfterMs: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_INVENTORY_STALE_AFTER_MS), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_INVENTORY_STALE_AFTER_MS),
    processProvenance: z.boolean().optional().default(false),
    workspaceProvenance: z.boolean().optional().default(false),
    classifier: z.boolean().optional().default(false),
    pageTitleEnrichment: LocalServicePageTitleCapabilitiesSchema.optional().default(DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CAPABILITIES),
    redactsProcessArgs: z.boolean().optional().default(true),
  })
  .strict();
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

export const LocalServiceManagedCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    supportedRestartPolicies: z.array(z.enum(['never'])).optional().default(['never']),
    portRange: z
      .object({
        start: z
          .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_START), z.number().int().min(1).max(65_535))
          .optional()
          .default(DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_START),
        end: z
          .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_END), z.number().int().min(1).max(65_535))
          .optional()
          .default(DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_END),
      })
      .optional()
      .default({
        start: DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_START,
        end: DEFAULT_LOCAL_SERVICE_MANAGED_PORT_RANGE_END,
      }),
    maxServicesPerOwner: z
      .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_MANAGED_MAX_SERVICES_PER_OWNER), z.number().int().positive())
      .optional()
      .default(DEFAULT_LOCAL_SERVICE_MANAGED_MAX_SERVICES_PER_OWNER),
    localNameDomain: z.string().trim().min(1).optional().default('localhost'),
    previewRegistrationAvailable: z.boolean().optional().default(false),
  })
  .strict();
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

export const LocalServiceLauncherCapabilitiesSchema = z
  .object({
    supportedSources: z.array(LocalServiceLaunchTargetSourceV1Schema).optional().default([]),
    scriptDiscovery: z
      .object({
        enabled: z.boolean().optional().default(false),
        maxDepth: z
          .preprocess(
            (raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_DEPTH),
            z.number().int().positive(),
          )
          .optional()
          .default(DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_DEPTH),
        maxScripts: z
          .preprocess(
            (raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_SCRIPTS),
            z.number().int().positive(),
          )
          .optional()
          .default(DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_SCRIPTS),
      })
      .strict()
      .optional()
      .default({
        enabled: false,
        maxDepth: DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_DEPTH,
        maxScripts: DEFAULT_LOCAL_SERVICE_LAUNCHER_SCRIPT_DISCOVERY_MAX_SCRIPTS,
      }),
    recentHistory: z
      .object({
        enabled: z.boolean().optional().default(false),
        maxEntries: z
          .preprocess(
            (raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_LAUNCHER_RECENT_HISTORY_MAX_ENTRIES),
            z.number().int().positive(),
          )
          .optional()
          .default(DEFAULT_LOCAL_SERVICE_LAUNCHER_RECENT_HISTORY_MAX_ENTRIES),
      })
      .strict()
      .optional()
      .default({
        enabled: false,
        maxEntries: DEFAULT_LOCAL_SERVICE_LAUNCHER_RECENT_HISTORY_MAX_ENTRIES,
      }),
    launchActionsEnabled: z.boolean().optional().default(false),
  })
  .strict();
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

export const LocalServiceActionCapabilitiesSchema = z
  .object({
    supportedKinds: z
      .array(LocalServiceActionKindV1Schema)
      .optional()
      .default(['copy_url', 'open_preview', 'forget']),
    terminate: z
      .object({
        enabled: z.boolean().optional().default(false),
        gracefulTimeoutMs: z
          .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_ACTION_GRACEFUL_TIMEOUT_MS), z.number().int().positive())
          .optional()
          .default(DEFAULT_LOCAL_SERVICE_ACTION_GRACEFUL_TIMEOUT_MS),
        verificationTimeoutMs: z
          .preprocess((raw) => normalizePositiveInt(raw, DEFAULT_LOCAL_SERVICE_ACTION_VERIFICATION_TIMEOUT_MS), z.number().int().positive())
          .optional()
          .default(DEFAULT_LOCAL_SERVICE_ACTION_VERIFICATION_TIMEOUT_MS),
        forceAllowed: z.boolean().optional().default(false),
      })
      .strict()
      .optional()
      .default({
        enabled: false,
        gracefulTimeoutMs: DEFAULT_LOCAL_SERVICE_ACTION_GRACEFUL_TIMEOUT_MS,
        verificationTimeoutMs: DEFAULT_LOCAL_SERVICE_ACTION_VERIFICATION_TIMEOUT_MS,
        forceAllowed: false,
      }),
  })
  .strict();
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

export const LocalServiceCapabilitiesSchema = z
  .object({
    inventory: LocalServiceInventoryCapabilitiesSchema.optional().default(DEFAULT_LOCAL_SERVICE_INVENTORY_CAPABILITIES),
    managed: LocalServiceManagedCapabilitiesSchema.optional().default(DEFAULT_LOCAL_SERVICE_MANAGED_CAPABILITIES),
    launcher: LocalServiceLauncherCapabilitiesSchema.optional().default(DEFAULT_LOCAL_SERVICE_LAUNCHER_CAPABILITIES),
    actions: LocalServiceActionCapabilitiesSchema.optional().default(DEFAULT_LOCAL_SERVICE_ACTION_CAPABILITIES),
    preview: LocalServicePreviewCapabilitiesSchema.optional().default(DEFAULT_LOCAL_SERVICE_PREVIEW_CAPABILITIES),
    publicPreview: LocalServicePublicCapabilitiesSchema.optional().default(DEFAULT_LOCAL_SERVICE_PUBLIC_CAPABILITIES),
  })
  .strict();
export type LocalServiceCapabilities = z.infer<typeof LocalServiceCapabilitiesSchema>;

export const DEFAULT_LOCAL_SERVICE_CAPABILITIES: LocalServiceCapabilities = {
  inventory: DEFAULT_LOCAL_SERVICE_INVENTORY_CAPABILITIES,
  managed: DEFAULT_LOCAL_SERVICE_MANAGED_CAPABILITIES,
  launcher: DEFAULT_LOCAL_SERVICE_LAUNCHER_CAPABILITIES,
  actions: DEFAULT_LOCAL_SERVICE_ACTION_CAPABILITIES,
  preview: DEFAULT_LOCAL_SERVICE_PREVIEW_CAPABILITIES,
  publicPreview: DEFAULT_LOCAL_SERVICE_PUBLIC_CAPABILITIES,
};
