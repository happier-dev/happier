import { z } from 'zod';

import { BrowserProfileStorageModeV1Schema } from '../profile/v1.js';

const IdSchema = z.string().trim().min(1).max(256);
const NonNegativeIntSchema = z.number().int().nonnegative();

export const BrowserSidecarRuntimeStateV1Schema = z.enum([
  'unavailable',
  'installing',
  'ready',
  'launching',
  'running',
  'stopping',
  'crashed',
]);
export type BrowserSidecarRuntimeStateV1 = z.infer<typeof BrowserSidecarRuntimeStateV1Schema>;

export const BrowserSidecarBinarySourceV1Schema = z.enum([
  'managedBrowserPackage',
  'chromeForTesting',
  'playwrightChromium',
  'systemChrome',
  'electronChromium',
  'unsupported',
]);
export type BrowserSidecarBinarySourceV1 = z.infer<typeof BrowserSidecarBinarySourceV1Schema>;

const Sha256IntegrityDigestSchema = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/, 'Integrity digest must be a lowercase sha256:<hex64> string');

/**
 * Provenance metadata for a managed Browser sidecar binary. This is the BRW-7 acceptance shape:
 * a product source is only trustworthy when it carries a pinned version/channel AND a verified
 * integrity digest. The control plane derives these locally from the artifact + the pinned
 * descriptor — it never trusts a caller-asserted `verifiedDigest`/signature (see FP-BRW-SOURCE-1
 * §7). A source that cannot present pinned-version + verified digest must fail closed.
 */
export const BrowserSidecarBinaryProvenanceV1Schema = z
  .object({
    /** Where the artifact provenance originates. Only managed_package is product-eligible. */
    origin: z.enum(['managed_package']),
    /** Exact pinned upstream build (e.g. a Chrome-for-Testing version like `127.0.6533.88`). */
    pinnedVersion: z.string().trim().min(1).max(64),
    /** Pinned release channel of the upstream distribution. */
    channel: z.enum(['stable', 'beta', 'dev', 'canary']),
    /** Locally-computed sha256 digest of the downloaded archive, verified before unpack. */
    integrityDigest: Sha256IntegrityDigestSchema,
    /** Optional detached signature reference if the upstream distribution provides one. */
    signature: z.string().trim().min(1).max(2048).optional(),
    /** SPDX-style license identifier of the managed distribution. */
    license: z.string().trim().min(1).max(128),
  })
  .strict();
export type BrowserSidecarBinaryProvenanceV1 = z.infer<typeof BrowserSidecarBinaryProvenanceV1Schema>;

export const BrowserSidecarErrorCodeV1Schema = z.enum([
  'feature_disabled',
  'browser_policy_denied',
  'managed_package_missing',
  'unsupported_platform',
  'system_browser_unavailable',
  'binary_resolution_failed',
  'profile_policy_denied',
  'permission_policy_denied',
  'input_target_denied',
  'launch_failed',
  'process_crashed',
  'resource_limit_exceeded',
  'capture_unavailable',
  'cdp_unavailable',
]);
export type BrowserSidecarErrorCodeV1 = z.infer<typeof BrowserSidecarErrorCodeV1Schema>;

export const BrowserSidecarProfileBindingV1Schema = z
  .object({
    profileId: IdSchema,
    storageMode: BrowserProfileStorageModeV1Schema,
    ownerKind: z.enum(['session', 'user', 'plugin']),
    ownerId: IdSchema,
  })
  .strict();
export type BrowserSidecarProfileBindingV1 = z.infer<typeof BrowserSidecarProfileBindingV1Schema>;

export const BrowserSidecarResourcePressureV1Schema = z
  .object({
    memoryRssBytes: NonNegativeIntSchema.optional(),
    cpuPercent: z.number().min(0).max(100).optional(),
  })
  .strict();
export type BrowserSidecarResourcePressureV1 = z.infer<typeof BrowserSidecarResourcePressureV1Schema>;

export const BrowserSidecarRuntimeStatusV1Schema = z
  .object({
    v: z.literal(1),
    sidecarId: IdSchema,
    state: BrowserSidecarRuntimeStateV1Schema,
    source: BrowserSidecarBinarySourceV1Schema,
    profileId: IdSchema.optional(),
    boundViewIds: z.array(IdSchema).optional().default([]),
    resourcePressure: BrowserSidecarResourcePressureV1Schema.optional(),
    errorCode: BrowserSidecarErrorCodeV1Schema.optional(),
    updatedAtMs: NonNegativeIntSchema,
  })
  .strict();
export type BrowserSidecarRuntimeStatusV1 = z.infer<typeof BrowserSidecarRuntimeStatusV1Schema>;

export const BrowserSidecarLaunchResultV1Schema = z.discriminatedUnion('accepted', [
  z
    .object({
      v: z.literal(1),
      accepted: z.literal(true),
      sidecarId: IdSchema,
      state: z.enum(['ready', 'launching', 'running']),
      profileBinding: BrowserSidecarProfileBindingV1Schema,
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      accepted: z.literal(false),
      state: BrowserSidecarRuntimeStateV1Schema,
      errorCode: BrowserSidecarErrorCodeV1Schema,
      disabledReason: z.string().trim().min(1).max(512),
    })
    .strict(),
]);
export type BrowserSidecarLaunchResultV1 = z.infer<typeof BrowserSidecarLaunchResultV1Schema>;
