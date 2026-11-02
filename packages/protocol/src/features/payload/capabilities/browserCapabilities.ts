import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

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

export const BrowserViewTargetCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    supportedTargetKinds: z._default(z.optional(z.array(BrowserViewTargetKindV1Schema)), []),
    iframeAvailable: z._default(z.optional(z.boolean()), false),
    webViewAvailable: z._default(z.optional(z.boolean()), false),
    streamedSurfaceAvailable: z._default(z.optional(z.boolean()), false),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
export type BrowserViewTargetCapabilities = z.infer<typeof BrowserViewTargetCapabilitiesSchema>;

export const DEFAULT_BROWSER_VIEW_TARGET_CAPABILITIES: BrowserViewTargetCapabilities = {
  enabled: false,
  supportedTargetKinds: [],
  iframeAvailable: false,
  webViewAvailable: false,
  streamedSurfaceAvailable: false,
  disabledReasons: [],
};

export const BrowserInternalCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    supportedStorageModes: z._default(z.optional(z.array(z.enum(['ephemeral', 'session', 'user', 'plugin']))), []),
    supportedPermissionKinds: z._default(z.optional(z.array(BrowserPermissionKindV1Schema)), []),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
export type BrowserInternalCapabilities = z.infer<typeof BrowserInternalCapabilitiesSchema>;

export const DEFAULT_BROWSER_INTERNAL_CAPABILITIES: BrowserInternalCapabilities = {
  enabled: false,
  supportedStorageModes: [],
  supportedPermissionKinds: [],
  disabledReasons: [],
};

export const BrowserSidecarCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
export type BrowserSidecarCapabilities = z.infer<typeof BrowserSidecarCapabilitiesSchema>;

export const DEFAULT_BROWSER_SIDECAR_CAPABILITIES: BrowserSidecarCapabilities = {
  enabled: false,
  available: false,
  disabledReasons: [],
};

export const BrowserDiagnosticsRetentionCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    consoleEntriesPerView: z._default(z.optional(z.number().check(z.int(), z.positive())), 1000),
    networkEntriesPerView: z._default(z.optional(z.number().check(z.int(), z.positive())), 500),
    maxBytesPerView: z._default(z.optional(z.number().check(z.int(), z.positive())), 8_388_608),
    maxBatchIntervalMs: z._default(z.optional(z.number().check(z.int(), z.positive())), 100),
  }));
export type BrowserDiagnosticsRetentionCapabilities = z.infer<
  typeof BrowserDiagnosticsRetentionCapabilitiesSchema
>;

export const DEFAULT_BROWSER_DIAGNOSTICS_RETENTION_CAPABILITIES: BrowserDiagnosticsRetentionCapabilities = {
  consoleEntriesPerView: 1000,
  networkEntriesPerView: 500,
  maxBytesPerView: 8_388_608,
  maxBatchIntervalMs: 100,
};

const BrowserCaptureAvailabilitySchema = lazyZodSchema(() => z.enum(['unavailable', 'off', 'metadataOnly']));

export const BrowserDiagnosticsCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    supportedFamilies: z._default(z.optional(z.array(BrowserDiagnosticFamilyV1Schema)), []),
    supportedFidelities: z._default(z.optional(z.array(BrowserDiagnosticFidelityV1Schema)), []),
    supportedAdapterKinds: z._default(z.optional(z.array(BrowserSemanticAdapterKindV1Schema)), []),
    retention: z._default(z.optional(BrowserDiagnosticsRetentionCapabilitiesSchema), DEFAULT_BROWSER_DIAGNOSTICS_RETENTION_CAPABILITIES),
    bodyCapture: z._default(z.optional(BrowserCaptureAvailabilitySchema), 'unavailable'),
    payloadCapture: z._default(z.optional(BrowserCaptureAvailabilitySchema), 'unavailable'),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
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

export const BrowserContextScreenshotCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    supported: z._default(z.optional(z.boolean()), false),
    requiresAttachmentUploads: z._default(z.optional(z.boolean()), true),
    maxWidth: z.optional(z.number().check(z.int(), z.positive())),
    maxHeight: z.optional(z.number().check(z.int(), z.positive())),
    maxBytes: z.optional(z.number().check(z.int(), z.positive())),
  }));
export type BrowserContextScreenshotCapabilities = z.infer<typeof BrowserContextScreenshotCapabilitiesSchema>;

export const BrowserContextTextCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    maxSelectionChars: z._default(z.optional(z.number().check(z.int(), z.positive())), 2048),
    maxSummaryChars: z._default(z.optional(z.number().check(z.int(), z.positive())), 8192),
  }));
export type BrowserContextTextCapabilities = z.infer<typeof BrowserContextTextCapabilitiesSchema>;

export const DEFAULT_BROWSER_CONTEXT_SCREENSHOT_CAPABILITIES: BrowserContextScreenshotCapabilities = {
  supported: false,
  requiresAttachmentUploads: true,
};

export const DEFAULT_BROWSER_CONTEXT_TEXT_CAPABILITIES: BrowserContextTextCapabilities = {
  maxSelectionChars: 2048,
  maxSummaryChars: 8192,
};

export const BrowserContextCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    supportedContextKinds: z._default(z.optional(z.array(BrowserContextKindV1Schema)), []),
    supportedAdapterKinds: z._default(z.optional(z.array(BrowserSemanticAdapterKindV1Schema)), []),
    screenshot: z._default(z.optional(BrowserContextScreenshotCapabilitiesSchema), DEFAULT_BROWSER_CONTEXT_SCREENSHOT_CAPABILITIES),
    text: z._default(z.optional(BrowserContextTextCapabilitiesSchema), DEFAULT_BROWSER_CONTEXT_TEXT_CAPABILITIES),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
    policyDeniedReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
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

export const BrowserAutomationTimelineCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    maxEntriesPerView: z._default(z.optional(z.number().check(z.int(), z.positive())), 500),
    retentionMs: z._default(z.optional(z.number().check(z.int(), z.positive())), 300_000),
  }));
export type BrowserAutomationTimelineCapabilities = z.infer<
  typeof BrowserAutomationTimelineCapabilitiesSchema
>;

export const DEFAULT_BROWSER_AUTOMATION_TIMELINE_CAPABILITIES: BrowserAutomationTimelineCapabilities = {
  maxEntriesPerView: 500,
  retentionMs: 300_000,
};

export const BrowserAutomationInjectedPageCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    capabilityVersion: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
export type BrowserAutomationInjectedPageCapabilities = z.infer<
  typeof BrowserAutomationInjectedPageCapabilitiesSchema
>;

export const DEFAULT_BROWSER_AUTOMATION_INJECTED_PAGE_CAPABILITIES: BrowserAutomationInjectedPageCapabilities = {
  enabled: false,
  available: false,
  disabledReasons: [],
};

export const BrowserAutomationEvalCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    requiresDiagnosticsInteraction: z._default(z.optional(z.boolean()), true),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
export type BrowserAutomationEvalCapabilities = z.infer<typeof BrowserAutomationEvalCapabilitiesSchema>;

export const DEFAULT_BROWSER_AUTOMATION_EVAL_CAPABILITIES: BrowserAutomationEvalCapabilities = {
  enabled: false,
  available: false,
  requiresDiagnosticsInteraction: true,
  disabledReasons: [],
};

export const BrowserAutomationCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    supportedActions: z._default(z.optional(z.array(BrowserAutomationActionKindCapabilitiesSchema)), []),
    supportedFidelities: z._default(z.optional(z.array(BrowserAutomationFidelityCapabilitiesSchema)), []),
    supportedAdapterKinds: z._default(z.optional(z.array(BrowserSemanticAdapterKindV1Schema)), []),
    maxActionTimeoutMs: z._default(z.optional(z.number().check(z.int(), z.positive())), 15_000),
    timeline: z._default(z.optional(BrowserAutomationTimelineCapabilitiesSchema), DEFAULT_BROWSER_AUTOMATION_TIMELINE_CAPABILITIES),
    injectedPage: z._default(z.optional(BrowserAutomationInjectedPageCapabilitiesSchema), DEFAULT_BROWSER_AUTOMATION_INJECTED_PAGE_CAPABILITIES),
    eval: z._default(z.optional(BrowserAutomationEvalCapabilitiesSchema), DEFAULT_BROWSER_AUTOMATION_EVAL_CAPABILITIES),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
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

export const BrowserRecordingCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    enabled: z._default(z.optional(z.boolean()), false),
    attachmentsEnabled: z._default(z.optional(z.boolean()), false),
    available: z._default(z.optional(z.boolean()), false),
    supportedCaptureKinds: z._default(z.optional(z.array(BrowserRecordingCaptureKindV1Schema)), []),
    supportedMimeTypes: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(128)))), []),
    supportedAdapterKinds: z._default(z.optional(z.array(BrowserSemanticAdapterKindV1Schema)), []),
    maxFps: z._default(z.optional(z.number().check(z.positive())), 12),
    audioSupported: z._default(z.optional(z.boolean()), false),
    cursorOverlaySupported: z._default(z.optional(z.boolean()), false),
    actionTimelineChaptersSupported: z._default(z.optional(z.boolean()), false),
    supportedRetentionClasses: z._default(z.optional(z.array(BrowserRecordingRetentionClassV1Schema)), []),
    disabledReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
    policyDeniedReasons: z._default(z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))), []),
  }));
export type BrowserRecordingCapabilities = z.infer<typeof BrowserRecordingCapabilitiesSchema>;

export const DEFAULT_BROWSER_RECORDING_CAPABILITIES: BrowserRecordingCapabilities = {
  enabled: false,
  attachmentsEnabled: false,
  available: false,
  supportedCaptureKinds: [],
  supportedMimeTypes: [],
  supportedAdapterKinds: [],
  maxFps: 12,
  audioSupported: false,
  cursorOverlaySupported: false,
  actionTimelineChaptersSupported: false,
  supportedRetentionClasses: [],
  disabledReasons: [],
  policyDeniedReasons: [],
};

export const BrowserCapabilitiesSchema = lazyZodSchema(() => z
  .object({
    viewTargets: z._default(z.optional(BrowserViewTargetCapabilitiesSchema), DEFAULT_BROWSER_VIEW_TARGET_CAPABILITIES),
    internal: z._default(z.optional(BrowserInternalCapabilitiesSchema), DEFAULT_BROWSER_INTERNAL_CAPABILITIES),
    sidecar: z._default(z.optional(BrowserSidecarCapabilitiesSchema), DEFAULT_BROWSER_SIDECAR_CAPABILITIES),
    diagnostics: z._default(z.optional(BrowserDiagnosticsCapabilitiesSchema), DEFAULT_BROWSER_DIAGNOSTICS_CAPABILITIES),
    context: z._default(z.optional(BrowserContextCapabilitiesSchema), DEFAULT_BROWSER_CONTEXT_CAPABILITIES),
    automation: z._default(z.optional(BrowserAutomationCapabilitiesSchema), DEFAULT_BROWSER_AUTOMATION_CAPABILITIES),
    recording: z._default(z.optional(BrowserRecordingCapabilitiesSchema), DEFAULT_BROWSER_RECORDING_CAPABILITIES),
  }));
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
