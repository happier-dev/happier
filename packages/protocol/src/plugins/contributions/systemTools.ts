import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const ProcessArgSchema = lazyZodSchema(() => z.string().trim().min(1).max(256)
  .refine((value) => !value.includes('\0'), 'Process values cannot contain null bytes'));

const CapabilityNameSchema = lazyZodSchema(() => z.string().trim().min(1).max(128));

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Observed ACP `initialize` capability expectations for one runtime generation.
 * Every field is matched against already-observed probe output; version strings
 * are never read, so a superseded release with a higher semver cannot win.
 */
export const PluginSystemToolAcpFingerprintV1Schema = lazyZodSchema(() => z.object({
  loadSession: z.boolean(),
  sessionCapabilities: z.array(CapabilityNameSchema).min(1).refine(uniqueStrings, 'Entries must be unique.'),
  absentSessionCapabilities: z.array(CapabilityNameSchema).max(32).refine(uniqueStrings, 'Entries must be unique.'),
  mcpHttp: z.boolean(),
  mcpSse: z.boolean(),
}).strict());
export type PluginSystemToolAcpFingerprintV1 = z.infer<typeof PluginSystemToolAcpFingerprintV1Schema>;

/**
 * Generic capability-based readiness probe for a system tool whose current and
 * superseded generations share an executable name or subcommand surface.
 * The host enumerates runnable candidates, probes observed command behavior
 * (`acpProbeArgs` initialize fingerprint plus one `commandSurfaceArgs` exit
 * code), and selects the first current candidate. Superseded executables are
 * never launched: they only inform the legacy diagnostic. There is deliberately
 * no version field anywhere in this shape.
 */
export const PluginSystemToolReadinessV1Schema = lazyZodSchema(() => z.object({
  acpProbeArgs: z.array(ProcessArgSchema).min(1).max(8),
  currentFingerprint: PluginSystemToolAcpFingerprintV1Schema,
  legacyFingerprint: PluginSystemToolAcpFingerprintV1Schema,
  commandSurfaceArgs: z.array(ProcessArgSchema).min(1).max(8),
  legacyExecutableNames: z.array(z.string().trim().min(1).max(128)).min(1).max(8)
    .refine(uniqueStrings, 'Entries must be unique.'),
  legacyGuidance: z.string().trim().min(1).max(2000),
  unidentifiedGuidance: z.string().trim().min(1).max(2000),
}).strict());
export type PluginSystemToolReadinessV1 = z.infer<typeof PluginSystemToolReadinessV1Schema>;

export const PluginSystemToolContributionV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  executableNames: z.array(z.string().trim().min(1)).min(1),
  allowedArguments: z.array(z.string()).optional(),
  platforms: z.array(z.enum(['macos', 'linux', 'windows'])).optional(),
  readiness: PluginSystemToolReadinessV1Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict());
export type PluginSystemToolContributionV1 = z.infer<typeof PluginSystemToolContributionV1Schema>;
