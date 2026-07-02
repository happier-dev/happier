import { z } from 'zod';

import { BrowserPermissionKindV1Schema } from '../../../browser/permissions/v1.js';
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

export const BrowserCapabilitiesSchema = z
  .object({
    viewTargets: BrowserViewTargetCapabilitiesSchema.optional().default(DEFAULT_BROWSER_VIEW_TARGET_CAPABILITIES),
    internal: BrowserInternalCapabilitiesSchema.optional().default(DEFAULT_BROWSER_INTERNAL_CAPABILITIES),
    sidecar: BrowserSidecarCapabilitiesSchema.optional().default(DEFAULT_BROWSER_SIDECAR_CAPABILITIES),
  })
  .strict();
export type BrowserCapabilities = z.infer<typeof BrowserCapabilitiesSchema>;

export const DEFAULT_BROWSER_CAPABILITIES: BrowserCapabilities = {
  viewTargets: DEFAULT_BROWSER_VIEW_TARGET_CAPABILITIES,
  internal: DEFAULT_BROWSER_INTERNAL_CAPABILITIES,
  sidecar: DEFAULT_BROWSER_SIDECAR_CAPABILITIES,
};
