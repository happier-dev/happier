import { z } from 'zod';

import { BrowserSemanticAdapterKindV1Schema } from '../../../browser/adapters/kinds.js';
import {
  BrowserAutomationActionKindV1Schema,
  BrowserAutomationFidelityV1Schema,
} from '../../../browser/automation/v1.js';
import {
  BrowserDiagnosticFamilyV1Schema,
  BrowserDiagnosticFidelityV1Schema,
} from '../../../browser/diagnostics/v1.js';
import { BrowserContextKindV1Schema } from '../../../browser/context/v1.js';
import { BrowserPermissionKindV1Schema } from '../../../browser/permissions/v1.js';
import {
  BrowserRecordingCaptureKindV1Schema,
  BrowserRecordingRetentionClassV1Schema,
} from '../../../browser/recording/v1.js';
import { BrowserViewTargetKindV1Schema } from '../../../browser/target/v1.js';

export const BrowserViewTargetCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    supportedTargetKinds: z.array(BrowserViewTargetKindV1Schema).optional().default([]),
    iframeAvailable: z.boolean().optional().default(false),
    webViewAvailable: z.boolean().optional().default(false),
    streamedSurfaceAvailable: z.boolean().optional().default(false),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserViewTargetCapabilities = z.infer<typeof BrowserViewTargetCapabilitiesSchema>;

export const DEFAULT_BROWSER_VIEW_TARGET_CAPABILITIES: BrowserViewTargetCapabilities = {
  enabled: false,
  supportedTargetKinds: [],
  iframeAvailable: false,
  webViewAvailable: false,
  streamedSurfaceAvailable: false,
  disabledReasons: [],
};

export const BrowserInternalCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    supportedStorageModes: z.array(z.enum(['ephemeral', 'session', 'user', 'plugin'])).optional().default([]),
    supportedPermissionKinds: z.array(BrowserPermissionKindV1Schema).optional().default([]),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserInternalCapabilities = z.infer<typeof BrowserInternalCapabilitiesSchema>;

export const DEFAULT_BROWSER_INTERNAL_CAPABILITIES: BrowserInternalCapabilities = {
  enabled: false,
  supportedStorageModes: [],
  supportedPermissionKinds: [],
  disabledReasons: [],
};

export const BrowserSidecarCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserSidecarCapabilities = z.infer<typeof BrowserSidecarCapabilitiesSchema>;

export const DEFAULT_BROWSER_SIDECAR_CAPABILITIES: BrowserSidecarCapabilities = {
  enabled: false,
  available: false,
  disabledReasons: [],
};

export const BrowserDiagnosticsRetentionCapabilitiesSchema = z
  .object({
    consoleEntriesPerView: z.number().int().positive().optional().default(1000),
    networkEntriesPerView: z.number().int().positive().optional().default(500),
    maxBytesPerView: z.number().int().positive().optional().default(8_388_608),
    maxBatchIntervalMs: z.number().int().positive().optional().default(100),
  })
  .strict();
export type BrowserDiagnosticsRetentionCapabilities = z.infer<
  typeof BrowserDiagnosticsRetentionCapabilitiesSchema
>;

export const DEFAULT_BROWSER_DIAGNOSTICS_RETENTION_CAPABILITIES: BrowserDiagnosticsRetentionCapabilities = {
  consoleEntriesPerView: 1000,
  networkEntriesPerView: 500,
  maxBytesPerView: 8_388_608,
  maxBatchIntervalMs: 100,
};

const BrowserCaptureAvailabilitySchema = z.enum(['unavailable', 'off', 'metadataOnly']);

export const BrowserDiagnosticsCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    supportedFamilies: z.array(BrowserDiagnosticFamilyV1Schema).optional().default([]),
    supportedFidelities: z.array(BrowserDiagnosticFidelityV1Schema).optional().default([]),
    supportedAdapterKinds: z.array(BrowserSemanticAdapterKindV1Schema).optional().default([]),
    retention: BrowserDiagnosticsRetentionCapabilitiesSchema.optional().default(
      DEFAULT_BROWSER_DIAGNOSTICS_RETENTION_CAPABILITIES,
    ),
    bodyCapture: BrowserCaptureAvailabilitySchema.optional().default('unavailable'),
    payloadCapture: BrowserCaptureAvailabilitySchema.optional().default('unavailable'),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserDiagnosticsCapabilities = z.infer<typeof BrowserDiagnosticsCapabilitiesSchema>;

export const DEFAULT_BROWSER_DIAGNOSTICS_CAPABILITIES: BrowserDiagnosticsCapabilities = {
  enabled: false,
  available: false,
  supportedFamilies: [],
  supportedFidelities: [],
  supportedAdapterKinds: [],
  retention: DEFAULT_BROWSER_DIAGNOSTICS_RETENTION_CAPABILITIES,
  bodyCapture: 'unavailable',
  payloadCapture: 'unavailable',
  disabledReasons: [],
};

export const BrowserContextScreenshotCapabilitiesSchema = z
  .object({
    supported: z.boolean().optional().default(false),
    requiresAttachmentUploads: z.boolean().optional().default(true),
    maxWidth: z.number().int().positive().optional(),
    maxHeight: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();
export type BrowserContextScreenshotCapabilities = z.infer<typeof BrowserContextScreenshotCapabilitiesSchema>;

export const BrowserContextTextCapabilitiesSchema = z
  .object({
    maxSelectionChars: z.number().int().positive().optional().default(2048),
    maxSummaryChars: z.number().int().positive().optional().default(8192),
  })
  .strict();
export type BrowserContextTextCapabilities = z.infer<typeof BrowserContextTextCapabilitiesSchema>;

export const DEFAULT_BROWSER_CONTEXT_SCREENSHOT_CAPABILITIES: BrowserContextScreenshotCapabilities = {
  supported: false,
  requiresAttachmentUploads: true,
};

export const DEFAULT_BROWSER_CONTEXT_TEXT_CAPABILITIES: BrowserContextTextCapabilities = {
  maxSelectionChars: 2048,
  maxSummaryChars: 8192,
};

export const BrowserContextCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    supportedContextKinds: z.array(BrowserContextKindV1Schema).optional().default([]),
    supportedAdapterKinds: z.array(BrowserSemanticAdapterKindV1Schema).optional().default([]),
    screenshot: BrowserContextScreenshotCapabilitiesSchema.optional().default(
      DEFAULT_BROWSER_CONTEXT_SCREENSHOT_CAPABILITIES,
    ),
    text: BrowserContextTextCapabilitiesSchema.optional().default(DEFAULT_BROWSER_CONTEXT_TEXT_CAPABILITIES),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
    policyDeniedReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserContextCapabilities = z.infer<typeof BrowserContextCapabilitiesSchema>;

export const DEFAULT_BROWSER_CONTEXT_CAPABILITIES: BrowserContextCapabilities = {
  enabled: false,
  available: false,
  supportedContextKinds: [],
  supportedAdapterKinds: [],
  screenshot: DEFAULT_BROWSER_CONTEXT_SCREENSHOT_CAPABILITIES,
  text: DEFAULT_BROWSER_CONTEXT_TEXT_CAPABILITIES,
  disabledReasons: [],
  policyDeniedReasons: [],
};

export const BrowserAutomationActionKindCapabilitiesSchema = BrowserAutomationActionKindV1Schema;
export type BrowserAutomationActionKindCapabilities = z.infer<
  typeof BrowserAutomationActionKindCapabilitiesSchema
>;

export const BrowserAutomationFidelityCapabilitiesSchema = BrowserAutomationFidelityV1Schema;
export type BrowserAutomationFidelityCapabilities = z.infer<
  typeof BrowserAutomationFidelityCapabilitiesSchema
>;

export const BrowserAutomationTimelineCapabilitiesSchema = z
  .object({
    maxEntriesPerView: z.number().int().positive().optional().default(500),
    retentionMs: z.number().int().positive().optional().default(300_000),
  })
  .strict();
export type BrowserAutomationTimelineCapabilities = z.infer<
  typeof BrowserAutomationTimelineCapabilitiesSchema
>;

export const DEFAULT_BROWSER_AUTOMATION_TIMELINE_CAPABILITIES: BrowserAutomationTimelineCapabilities = {
  maxEntriesPerView: 500,
  retentionMs: 300_000,
};

export const BrowserAutomationInjectedPageCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    capabilityVersion: z.string().trim().min(1).max(64).optional(),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserAutomationInjectedPageCapabilities = z.infer<
  typeof BrowserAutomationInjectedPageCapabilitiesSchema
>;

export const DEFAULT_BROWSER_AUTOMATION_INJECTED_PAGE_CAPABILITIES: BrowserAutomationInjectedPageCapabilities = {
  enabled: false,
  available: false,
  disabledReasons: [],
};

export const BrowserAutomationEvalCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    requiresDiagnosticsInteraction: z.boolean().optional().default(true),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserAutomationEvalCapabilities = z.infer<typeof BrowserAutomationEvalCapabilitiesSchema>;

export const DEFAULT_BROWSER_AUTOMATION_EVAL_CAPABILITIES: BrowserAutomationEvalCapabilities = {
  enabled: false,
  available: false,
  requiresDiagnosticsInteraction: true,
  disabledReasons: [],
};

export const BrowserAutomationCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    supportedActions: z.array(BrowserAutomationActionKindCapabilitiesSchema).optional().default([]),
    supportedFidelities: z.array(BrowserAutomationFidelityCapabilitiesSchema).optional().default([]),
    supportedAdapterKinds: z.array(BrowserSemanticAdapterKindV1Schema).optional().default([]),
    maxActionTimeoutMs: z.number().int().positive().optional().default(15_000),
    timeline: BrowserAutomationTimelineCapabilitiesSchema.optional().default(
      DEFAULT_BROWSER_AUTOMATION_TIMELINE_CAPABILITIES,
    ),
    injectedPage: BrowserAutomationInjectedPageCapabilitiesSchema.optional().default(
      DEFAULT_BROWSER_AUTOMATION_INJECTED_PAGE_CAPABILITIES,
    ),
    eval: BrowserAutomationEvalCapabilitiesSchema.optional().default(DEFAULT_BROWSER_AUTOMATION_EVAL_CAPABILITIES),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserAutomationCapabilities = z.infer<typeof BrowserAutomationCapabilitiesSchema>;

export const DEFAULT_BROWSER_AUTOMATION_CAPABILITIES: BrowserAutomationCapabilities = {
  enabled: false,
  available: false,
  supportedActions: [],
  supportedFidelities: [],
  supportedAdapterKinds: [],
  maxActionTimeoutMs: 15_000,
  timeline: DEFAULT_BROWSER_AUTOMATION_TIMELINE_CAPABILITIES,
  injectedPage: DEFAULT_BROWSER_AUTOMATION_INJECTED_PAGE_CAPABILITIES,
  eval: DEFAULT_BROWSER_AUTOMATION_EVAL_CAPABILITIES,
  disabledReasons: [],
};

export const BrowserRecordingCapabilitiesSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    attachmentsEnabled: z.boolean().optional().default(false),
    available: z.boolean().optional().default(false),
    supportedCaptureKinds: z.array(BrowserRecordingCaptureKindV1Schema).optional().default([]),
    supportedMimeTypes: z.array(z.string().trim().min(1).max(128)).optional().default([]),
    supportedAdapterKinds: z.array(BrowserSemanticAdapterKindV1Schema).optional().default([]),
    maxDurationMs: z.number().int().positive().optional().default(30_000),
    maxBytes: z.number().int().positive().optional().default(16_000_000),
    maxFps: z.number().positive().optional().default(12),
    audioSupported: z.boolean().optional().default(false),
    cursorOverlaySupported: z.boolean().optional().default(false),
    actionTimelineChaptersSupported: z.boolean().optional().default(false),
    supportedRetentionClasses: z.array(BrowserRecordingRetentionClassV1Schema).optional().default([]),
    disabledReasons: z.array(z.string().trim().min(1)).optional().default([]),
    policyDeniedReasons: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .strict();
export type BrowserRecordingCapabilities = z.infer<typeof BrowserRecordingCapabilitiesSchema>;

export const DEFAULT_BROWSER_RECORDING_CAPABILITIES: BrowserRecordingCapabilities = {
  enabled: false,
  attachmentsEnabled: false,
  available: false,
  supportedCaptureKinds: [],
  supportedMimeTypes: [],
  supportedAdapterKinds: [],
  maxDurationMs: 30_000,
  maxBytes: 16_000_000,
  maxFps: 12,
  audioSupported: false,
  cursorOverlaySupported: false,
  actionTimelineChaptersSupported: false,
  supportedRetentionClasses: [],
  disabledReasons: [],
  policyDeniedReasons: [],
};

export const BrowserCapabilitiesSchema = z
  .object({
    viewTargets: BrowserViewTargetCapabilitiesSchema.optional().default(DEFAULT_BROWSER_VIEW_TARGET_CAPABILITIES),
    internal: BrowserInternalCapabilitiesSchema.optional().default(DEFAULT_BROWSER_INTERNAL_CAPABILITIES),
    sidecar: BrowserSidecarCapabilitiesSchema.optional().default(DEFAULT_BROWSER_SIDECAR_CAPABILITIES),
    diagnostics: BrowserDiagnosticsCapabilitiesSchema.optional().default(DEFAULT_BROWSER_DIAGNOSTICS_CAPABILITIES),
    context: BrowserContextCapabilitiesSchema.optional().default(DEFAULT_BROWSER_CONTEXT_CAPABILITIES),
    automation: BrowserAutomationCapabilitiesSchema.optional().default(DEFAULT_BROWSER_AUTOMATION_CAPABILITIES),
    recording: BrowserRecordingCapabilitiesSchema.optional().default(DEFAULT_BROWSER_RECORDING_CAPABILITIES),
  })
  .strip();
export type BrowserCapabilities = z.infer<typeof BrowserCapabilitiesSchema>;

export const DEFAULT_BROWSER_CAPABILITIES: BrowserCapabilities = {
  viewTargets: DEFAULT_BROWSER_VIEW_TARGET_CAPABILITIES,
  internal: DEFAULT_BROWSER_INTERNAL_CAPABILITIES,
  sidecar: DEFAULT_BROWSER_SIDECAR_CAPABILITIES,
  diagnostics: DEFAULT_BROWSER_DIAGNOSTICS_CAPABILITIES,
  context: DEFAULT_BROWSER_CONTEXT_CAPABILITIES,
  automation: DEFAULT_BROWSER_AUTOMATION_CAPABILITIES,
  recording: DEFAULT_BROWSER_RECORDING_CAPABILITIES,
};
