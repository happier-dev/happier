import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema, PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema, PluginContributionReferenceV2Schema } from './publicTypes.js';
import { ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposeIdentity.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const ProcessArgSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256), z.refine((value) => !value.includes('\0'), 'Process values cannot contain null bytes')));

const CapabilityNameSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(128)));

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Observed ACP `initialize` capability expectations for one runtime generation.
 * Every field is matched against already-observed probe output; version strings
 * are never read, so a superseded release with a higher semver cannot win.
 */
export const PluginSystemToolAcpFingerprintV1Schema = lazyZodSchema(() => z.strictObject({
  loadSession: z.boolean(),
  sessionCapabilities: z.array(CapabilityNameSchema).check(z.minLength(1), z.refine(uniqueStrings, 'Entries must be unique.')),
  absentSessionCapabilities: z.array(CapabilityNameSchema).check(z.maxLength(32), z.refine(uniqueStrings, 'Entries must be unique.')),
  mcpHttp: z.boolean(),
  mcpSse: z.boolean(),
}));
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
export const PluginSystemToolReadinessV1Schema = lazyZodSchema(() => z.strictObject({
  acpProbeArgs: z.array(ProcessArgSchema).check(z.minLength(1), z.maxLength(8)),
  currentFingerprint: PluginSystemToolAcpFingerprintV1Schema,
  legacyFingerprint: PluginSystemToolAcpFingerprintV1Schema,
  commandSurfaceArgs: z.array(ProcessArgSchema).check(z.minLength(1), z.maxLength(8)),
  legacyExecutableNames: z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))).check(z.minLength(1), z.maxLength(8), z.refine(uniqueStrings, 'Entries must be unique.')),
  legacyGuidance: z.string().check(z.trim(), z.minLength(1), z.maxLength(2000)),
  unidentifiedGuidance: z.string().check(z.trim(), z.minLength(1), z.maxLength(2000)),
}));
export type PluginSystemToolReadinessV1 = z.infer<typeof PluginSystemToolReadinessV1Schema>;

const EnvironmentKeySchema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)));
const AuthenticationSchema = lazyZodSchema(() => z.strictObject({
  status: z.strictObject({ args: z.array(ProcessArgSchema), signedOutExitCodes: z.array(z.int()) }),
  loginLaunches: z.array(z.strictObject({ kind: z.enum(['primary', 'device_code']), args: z.array(ProcessArgSchema) }))
    .check(z.refine(launches => new Set(launches.map(launch => launch.kind)).size === launches.length, 'Login launch kinds must be unique.')),
  connectedServices: z.array(asProtocolZod(PluginContributionIdentityV1Schema)),
  environment: z.optional(z.record(EnvironmentKeySchema, z.string())),
  unsetEnvironmentKeys: z.optional(z.array(EnvironmentKeySchema)),
  unsetEnvironmentKeyPrefixes: z.optional(z.array(EnvironmentKeySchema)),
}));
const ConnectedAccountLaunchSchema = lazyZodSchema(() => z.strictObject({
  purpose: ConnectedAccountPurposeIdSchema,
  service: asProtocolZod(PluginContributionReferenceV2Schema),
  environmentKey: EnvironmentKeySchema,
  unsetEnvironmentKeys: z.optional(z.array(EnvironmentKeySchema)),
  brokeredUnavailableCode: z.optional(z.string().check(z.trim(), z.minLength(1))),
  gitCredentialHelper: z.optional(z.strictObject({ host: z.string().check(z.trim(), z.minLength(1)), args: z.array(ProcessArgSchema) })),
}));

export const PluginSystemToolContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  executableNames: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
  allowedArguments: z.optional(z.array(z.string())),
  platforms: z.optional(z.array(z.enum(['macos', 'linux', 'windows']))),
  readiness: z.optional(PluginSystemToolReadinessV1Schema),
  authentication: z.optional(AuthenticationSchema),
  connectedAccountLaunch: z.optional(ConnectedAccountLaunchSchema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginSystemToolContributionV1 = z.infer<typeof PluginSystemToolContributionV1Schema>;
