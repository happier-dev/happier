import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const NonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const UniqueNonEmptyStringsSchema = lazyZodSchema(() => z.array(NonEmptyStringSchema).check(z.minLength(1), z.refine((values) => new Set(values).size === values.length, 'Entries must be unique.')));

export const PluginAgentCliSourcePreferenceSchema = lazyZodSchema(() => z.enum(['system-first', 'managed-first']));
export type PluginAgentCliSourcePreference = z.infer<typeof PluginAgentCliSourcePreferenceSchema>;

export const PluginAgentCliExecutableMetadataSchema = lazyZodSchema(() => z.strictObject({
  binaryName: NonEmptyStringSchema,
  alternativeBinaryNames: z.optional(UniqueNonEmptyStringsSchema),
  alternativeBinaryFallbackEnabledEnvVar: z.optional(NonEmptyStringSchema),
  knownUserBinDirSuffixes: z.optional(z.nullable(UniqueNonEmptyStringsSchema)),
  knownEnvironmentBinDirs: z.optional(z.array(z.strictObject({
    envVar: NonEmptyStringSchema,
    relativeDir: NonEmptyStringSchema,
  })).check(z.minLength(1))),
  sourcePreference: PluginAgentCliSourcePreferenceSchema,
  acceptsJavaScriptFileOverride: z.optional(z.boolean()),
  systemCommandResolutionStrategy: z.optional(z.enum(['path-first', 'known-user-first-runnable'])),
}).check(z.superRefine((value, ctx) => {
  if (value.alternativeBinaryNames?.includes(value.binaryName)) {
    ctx.addIssue({
      code: "custom",
      path: ['alternativeBinaryNames'],
      message: 'Alternative binary names must not duplicate the primary binary name.',
    });
  }
})));
export type PluginAgentCliExecutableMetadata = z.infer<typeof PluginAgentCliExecutableMetadataSchema>;

export const PluginAgentCliInstallCommandSchema = lazyZodSchema(() => z.strictObject({
  cmd: NonEmptyStringSchema,
  args: z.array(z.string()),
  requiresAdmin: z.optional(z.boolean()),
  note: z.optional(z.nullable(NonEmptyStringSchema)),
}));
export type PluginAgentCliInstallCommand = z.infer<typeof PluginAgentCliInstallCommandSchema>;

export const PluginAgentCliManualInstallRecipesSchema = lazyZodSchema(() => z.strictObject({
  darwin: z.optional(z.array(PluginAgentCliInstallCommandSchema).check(z.minLength(1))),
  linux: z.optional(z.array(PluginAgentCliInstallCommandSchema).check(z.minLength(1))),
  win32: z.optional(z.array(PluginAgentCliInstallCommandSchema).check(z.minLength(1))),
}).check(z.refine((value) => value.darwin !== undefined || value.linux !== undefined || value.win32 !== undefined, 'At least one platform recipe is required.')));
export type PluginAgentCliManualInstallRecipes = z.infer<typeof PluginAgentCliManualInstallRecipesSchema>;

const MAX_PLUGIN_ARCHIVE_EXTRACTION_BYTES = 512 * 1024 * 1024;

export const PluginAgentCliArchiveExtractionLimitsSchema = lazyZodSchema(() => z.strictObject({
  maxFileBytes: z.number().check(z.int(), z.positive(), z.maximum(MAX_PLUGIN_ARCHIVE_EXTRACTION_BYTES)),
  maxExpandedBytes: z.number().check(z.int(), z.positive(), z.maximum(MAX_PLUGIN_ARCHIVE_EXTRACTION_BYTES)),
}).check(z.superRefine((value, ctx) => {
  if (value.maxFileBytes > value.maxExpandedBytes) {
    ctx.addIssue({
      code: "custom",
      path: ['maxFileBytes'],
      message: 'Per-file extraction limit must not exceed the cumulative expanded-byte limit.',
    });
  }
})));
export type PluginAgentCliArchiveExtractionLimits = z.infer<typeof PluginAgentCliArchiveExtractionLimitsSchema>;

export const PluginAgentCliManagedArchiveEntrySchema = lazyZodSchema(() => z.strictObject({
  archivePath: NonEmptyStringSchema,
  destinationPath: NonEmptyStringSchema,
}));
export type PluginAgentCliManagedArchiveEntry = z.infer<typeof PluginAgentCliManagedArchiveEntrySchema>;

const PluginAgentCliAssetNameByArchSchema = lazyZodSchema(() => z.strictObject({
  arm64: NonEmptyStringSchema,
  x64: NonEmptyStringSchema,
}));

const PluginAgentCliAssetNameByPlatformSchema = lazyZodSchema(() => z.strictObject({
  darwin: PluginAgentCliAssetNameByArchSchema,
  linux: PluginAgentCliAssetNameByArchSchema,
  win32: PluginAgentCliAssetNameByArchSchema,
}));

const PluginAgentCliArchiveEntriesByPlatformSchema = lazyZodSchema(() => z.strictObject({
  darwin: z.array(PluginAgentCliManagedArchiveEntrySchema).check(z.minLength(1)),
  linux: z.array(PluginAgentCliManagedArchiveEntrySchema).check(z.minLength(1)),
  win32: z.array(PluginAgentCliManagedArchiveEntrySchema).check(z.minLength(1)),
}));

export const PluginAgentCliManagedInstallSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('github_release_binary'),
    githubRepo: NonEmptyStringSchema,
    /** Omit to track latest; a declared tag is required and never falls back to latest. */
    releaseTag: z.optional(NonEmptyStringSchema),
    binaryName: NonEmptyStringSchema,
    assetNameByPlatform: z.optional(PluginAgentCliAssetNameByPlatformSchema),
    archiveEntriesByPlatform: z.optional(PluginAgentCliArchiveEntriesByPlatformSchema),
    archiveExtractionLimits: z.optional(PluginAgentCliArchiveExtractionLimitsSchema),
  }),
  z.strictObject({
    kind: z.literal('managed_package'),
    packageName: NonEmptyStringSchema,
    binaryName: NonEmptyStringSchema,
    /** Approve this package's vendor build during managed installation. */
    allowBuild: z.optional(z.boolean()),
  }),
]));
export type PluginAgentCliManagedInstall = z.infer<typeof PluginAgentCliManagedInstallSchema>;

/**
 * The vendor's own updater, verified from vendor documentation or source. The host runs it against
 * the executable it resolved only when that executable (or its real path) equals or sits under one
 * of `installPaths` (home-relative, `/`-separated), so a vendor updater is never asked to replace
 * an install a package manager owns. It never names a command: the host owns executable resolution.
 */
export const PluginAgentCliNativeUpdateSchema = lazyZodSchema(() => z.strictObject({
  args: z.array(NonEmptyStringSchema).check(z.minLength(1)),
  installPaths: UniqueNonEmptyStringsSchema,
}));
export type PluginAgentCliNativeUpdate = z.infer<typeof PluginAgentCliNativeUpdateSchema>;

export const PluginAgentCliInstallMetadataSchema = lazyZodSchema(() => z.strictObject({
  managed: z.optional(z.nullable(PluginAgentCliManagedInstallSchema)),
  /**
   * The vendor's npm package when the CLI is also published there and it is not already the
   * managed package. It attributes an npm/pnpm/bun install and names the latest-version source.
   */
  npmPackageName: z.optional(z.nullable(NonEmptyStringSchema)),
  nativeUpdate: z.optional(z.nullable(PluginAgentCliNativeUpdateSchema)),
  manual: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.enum(['command', 'vendor_recipe']),
      recipes: z.optional(PluginAgentCliManualInstallRecipesSchema),
    }),
  ]),
  recommendationOrder: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(1_000_000))),
  guideUrl: z.optional(z.nullable(z.url())),
  docsUrl: z.optional(z.nullable(z.url())),
}));
export type PluginAgentCliInstallMetadata = z.infer<typeof PluginAgentCliInstallMetadataSchema>;

export const PluginAgentCliLoginLaunchSchema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['primary', 'device_code']),
  target: z.optional(z.enum(['provider_cli', 'agent_acp'])),
  args: z.array(z.string()),
  initialInput: z.optional(z.nullable(z.string())),
}).check(z.superRefine((value, ctx) => {
  if (value.target === 'agent_acp' && value.args.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ['args'],
      message: 'ACP login arguments are host-owned.',
    });
  }
})));
export type PluginAgentCliLoginLaunch = z.infer<typeof PluginAgentCliLoginLaunchSchema>;

export const PluginAgentCliAuthMetadataSchema = lazyZodSchema(() => z.strictObject({
  support: z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']),
  machineLoginKey: z.optional(NonEmptyStringSchema),
  /**
   * Host-owned credential presence facts. These never select an Agent parser
   * or execute a command: the host only checks declared environment keys.
   */
  environmentVariables: z.optional(UniqueNonEmptyStringsSchema),
  /** Host-owned JSON credential-file presence facts. */
  credentialPaths: z.optional(UniqueNonEmptyStringsSchema),
  /**
   * The declared status command is a bounded, noninteractive system-tool
   * probe. This is a scheduling fact only: the host still owns executable
   * resolution, environment, process lifetime, cancellation, and bounds.
   */
  nonInteractiveStatusProbe: z.optional(z.literal(true)),
  /**
   * Existing status-only Agents that intentionally cannot infer a signed-out
   * state retain that distinction when no declared credential is present.
   */
  missingCredentialState: z.optional(z.enum(['logged_out', 'unknown'])),
  loginLaunches: z.array(PluginAgentCliLoginLaunchSchema).check(z.maxLength(2), z.refine((launches) => new Set(launches.map((launch) => launch.kind)).size === launches.length, 'Login launch kinds must be unique.')),
}).check(z.superRefine((value, ctx) => {
  if (value.support === 'login_terminal' && !value.loginLaunches.some((launch) => launch.kind === 'primary')) {
    ctx.addIssue({
      code: "custom",
      path: ['loginLaunches'],
      message: 'Login-terminal support requires a primary login launch.',
    });
  }
  if (value.support !== 'login_terminal' && value.loginLaunches.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ['loginLaunches'],
      message: 'Only login-terminal support may declare login launches.',
    });
  }
})));
export type PluginAgentCliAuthMetadata = z.infer<typeof PluginAgentCliAuthMetadataSchema>;

/**
 * Background auth checks are allowed only when the manifest provides a
 * host-owned static credential fact or explicitly declares its bounded status
 * tool as noninteractive. Keeping this derivation beside the wire shape stops
 * UI scheduling and CLI projection from maintaining separate safety policies.
 */
export function isPluginAgentCliAuthBackgroundCheckSafe(
  cli: Readonly<{
    auth: Readonly<{
      environmentVariables?: readonly string[];
      credentialPaths?: readonly string[];
      nonInteractiveStatusProbe?: boolean;
    }>;
  }>,
): boolean {
  const hasNonEmptyString = (value: unknown): boolean => Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
  return hasNonEmptyString(cli.auth.environmentVariables)
    || hasNonEmptyString(cli.auth.credentialPaths)
    || cli.auth.nonInteractiveStatusProbe === true;
}

export const PluginAgentCliMetadataSchema = lazyZodSchema(() => z.strictObject({
  displayName: z.optional(NonEmptyStringSchema),
  commandPolicy: z.optional(z.strictObject({
    daemonAutostartDefault: z.optional(z.literal('preferLocalTui')),
  })),
  executable: PluginAgentCliExecutableMetadataSchema,
  install: PluginAgentCliInstallMetadataSchema,
  auth: PluginAgentCliAuthMetadataSchema,
}));
export type PluginAgentCliMetadata = z.infer<typeof PluginAgentCliMetadataSchema>;
