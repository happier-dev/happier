import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const InstallableSourceKindSchema = lazyZodSchema(() => z.enum([
  'github_release_binary',
  'managed_package',
  'managed_pypi_wheel_asset',
  'pinned_archive',
  'first_party_runtime',
  'vendor_recipe',
  'manual_only',
]));
export type InstallableSourceKind = z.infer<typeof InstallableSourceKindSchema>;

export const ManagedPypiWheelAssetPlatformSchema = lazyZodSchema(() => z.enum([
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  'win32-arm64',
]));

export const ManagedPypiWheelAssetInstallConsentSchema = lazyZodSchema(() => z.enum(['host_managed_required']));

export const ManagedPypiWheelAssetAutoUpdateModeSchema = lazyZodSchema(() => z.enum(['off', 'notify', 'auto']));

export const GitHubReleaseBinaryInstallableSourceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('github_release_binary'),
  repo: z.string().check(z.trim(), z.regex(/^[^/\s]+\/[^/\s]+$/)),
  distTag: z.optional(z.string().check(z.trim(), z.minLength(1))),
  archiveLayout: z.optional(z.enum(['bin_directory', 'single_executable'])),
  assetNamePrefix: z.optional(z.string().check(z.trim(), z.minLength(1))),
  targetByPlatform: z.optional(z.record(z.string(), z.string().check(z.trim(), z.minLength(1)))),
  launch: z.optional(z.strictObject({
    kind: z.literal('configured_binary'),
    overrideEnvironmentKey: z.string().check(z.trim(), z.minLength(1)),
    configOverridesEnvironmentKey: z.string().check(z.trim(), z.minLength(1)),
    configOverrideArgument: z.string().check(z.trim(), z.minLength(1)),
    legacyExecutables: z.optional(z.array(z.strictObject({
      relativePath: z.string().check(z.trim(), z.minLength(1)),
      platforms: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
      requiresManagedJavaScriptRuntime: z.optional(z.boolean()),
    }))),
  })),
}));

export const ManagedPackageInstallableSourceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managed_package'),
  packageName: z.string().check(z.trim(), z.minLength(1)),
  packageManager: z.enum(['managed_js_runtime', 'managed_uv']),
  version: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const ManagedPypiWheelAssetInstallableSourceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managed_pypi_wheel_asset'),
  distribution: z.string().check(z.trim(), z.toLowerCase(), z.regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/)),
  versionSpecifier: z.string().check(z.trim(), z.minLength(1)),
  assetPathByPlatform: z.record(
    z.string(),
    z.string().check(z.trim(), z.minLength(1), z.refine((value) => {
      if (value.startsWith('/') || value.startsWith('\\')) return false;
      return !value.split(/[\\/]+/).some((segment) => segment === '' || segment === '.' || segment === '..');
    }, 'Asset path must be a relative exact wheel member path')),
  ).check(z.superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: 'At least one platform asset path is required',
      });
    }
    for (const key of keys) {
      if (!ManagedPypiWheelAssetPlatformSchema.safeParse(key).success) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: 'Unsupported managed PyPI wheel asset platform',
        });
      }
    }
  })),
  executable: z.literal(true),
  compatibilityProbe: z.optional(z.string().check(z.trim(), z.minLength(1))),
  installConsent: ManagedPypiWheelAssetInstallConsentSchema,
  autoUpdateMode: ManagedPypiWheelAssetAutoUpdateModeSchema,
  trustedPublisher: z.optional(z.string().check(z.trim(), z.minLength(1))),
  maxWheelSizeBytes: z.optional(z.number().check(z.int(), z.positive())),
  maxAssetSizeBytes: z.optional(z.number().check(z.int(), z.positive())),
}));

export const PinnedArchiveInstallableAssetSchema = lazyZodSchema(() => z.strictObject({
  archiveUrl: z.string().check(z.url(), z.refine((value) => value.startsWith('https://'), 'Pinned archive URL must use HTTPS')),
  sha256: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
  kind: z.optional(z.enum(['archive', 'executable'])),
  /** Known download bytes for this exact pinned archive; presentation metadata, not an extraction limit. */
  sizeBytes: z.optional(z.number().check(z.int(), z.positive())),
  executableSubpath: z.string().check(z.trim(), z.minLength(1), z.refine((value) => {
    if (/^(?:[A-Za-z]:)?[\\/]/.test(value)) return false;
    return value.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  }, 'Pinned archive executable path must be a safe relative path')),
  args: z.optional(z.array(z.string())),
}));
export type PinnedArchiveInstallableAsset = z.infer<typeof PinnedArchiveInstallableAssetSchema>;
export type InstallChecksumStateV1 = 'verified' | 'not_published';

export const PinnedArchiveAssetsByPlatformSchema = lazyZodSchema(() => z.strictObject({
  'darwin-arm64': z.optional(PinnedArchiveInstallableAssetSchema),
  'darwin-x64': z.optional(PinnedArchiveInstallableAssetSchema),
  'linux-x64': z.optional(PinnedArchiveInstallableAssetSchema),
  'linux-arm64': z.optional(PinnedArchiveInstallableAssetSchema),
  'win32-x64': z.optional(PinnedArchiveInstallableAssetSchema),
  'win32-arm64': z.optional(PinnedArchiveInstallableAssetSchema),
}).check(z.refine((assets) => Object.values(assets).some(Boolean), 'Pinned archive source requires at least one platform asset')));

export const PinnedArchivePlatformSchema = lazyZodSchema(() => z.keyof(PinnedArchiveAssetsByPlatformSchema));

export const PinnedArchiveExtractionLimitsSchema = lazyZodSchema(() => z.strictObject({
  maxArchiveBytes: z.optional(z.number().check(z.int(), z.positive())),
  maxFileBytes: z.optional(z.number().check(z.int(), z.positive())),
  maxExpandedBytes: z.optional(z.number().check(z.int(), z.positive())),
  timeoutMs: z.optional(z.number().check(z.int(), z.positive())),
}).check(z.refine((limits) => Object.values(limits).some((value) => value !== undefined), 'Pinned archive extraction limits must override at least one default'), z.superRefine((limits, ctx) => {
  if (
    limits.maxFileBytes !== undefined
    && limits.maxExpandedBytes !== undefined
    && limits.maxFileBytes > limits.maxExpandedBytes
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['maxFileBytes'],
      message: 'Per-file extraction limit must not exceed the cumulative expanded-byte limit',
    });
  }
})));
export type PinnedArchiveExtractionLimits = z.infer<typeof PinnedArchiveExtractionLimitsSchema>;

/**
 * One immutable per-platform artifact, verified against its digest when published.
 * The artifact is pinned, so there is no version discovery: the declared `version` is both the
 * installed and the available version.
 */
export const PinnedArchiveInstallableSourceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pinned_archive'),
  version: z.string().check(z.trim(), z.minLength(1)),
  archiveExtractionLimits: z.optional(PinnedArchiveExtractionLimitsSchema),
  assetsByPlatform: PinnedArchiveAssetsByPlatformSchema,
}));

export const VendorRecipeInstallableSourceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('vendor_recipe'),
  recipeId: z.string().check(z.trim(), z.minLength(1)),
  commandsPreview: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
}));

export const ManualOnlyInstallableSourceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('manual_only'),
  setupUrl: z.optional(z.string().check(z.trim(), z.url())),
  instructionsKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

/** Host-owned optional runtimes use the verified release matching the running CLI. */
export const FirstPartyRuntimeInstallableSourceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('first_party_runtime'),
  componentId: z.enum(['happier-memory-runtime', 'happier-voice-runtime', 'happier-difftastic']),
}));

export const InstallableSourceSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  FirstPartyRuntimeInstallableSourceSchema,
  GitHubReleaseBinaryInstallableSourceSchema,
  ManagedPackageInstallableSourceSchema,
  ManagedPypiWheelAssetInstallableSourceSchema,
  PinnedArchiveInstallableSourceSchema,
  VendorRecipeInstallableSourceSchema,
  ManualOnlyInstallableSourceSchema,
]));
export type InstallableSource = z.infer<typeof InstallableSourceSchema>;
