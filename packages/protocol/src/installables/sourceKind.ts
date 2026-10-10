import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

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

export const GitHubReleaseBinaryInstallableSourceSchema = lazyZodSchema(() => z.object({
  kind: z.literal('github_release_binary'),
  repo: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/),
  distTag: z.string().trim().min(1).optional(),
  archiveLayout: z.enum(['bin_directory', 'single_executable']).optional(),
  assetNamePrefix: z.string().trim().min(1).optional(),
  targetByPlatform: z.record(z.string(), z.string().trim().min(1)).optional(),
  launch: z.object({
    kind: z.literal('codexAcp'),
    overrideEnvironmentKey: z.string().trim().min(1),
    configOverridesEnvironmentKey: z.string().trim().min(1),
    configOverrideArgument: z.string().trim().min(1),
  }).strict().optional(),
}).strict());

export const ManagedPackageInstallableSourceSchema = lazyZodSchema(() => z.object({
  kind: z.literal('managed_package'),
  packageName: z.string().trim().min(1),
  packageManager: z.literal('managed_js_runtime'),
  version: z.string().trim().min(1).optional(),
}).strict());

export const ManagedPypiWheelAssetInstallableSourceSchema = lazyZodSchema(() => z.object({
  kind: z.literal('managed_pypi_wheel_asset'),
  distribution: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/),
  versionSpecifier: z.string().trim().min(1),
  assetPathByPlatform: z.record(
    z.string(),
    z.string().trim().min(1).refine((value) => {
      if (value.startsWith('/') || value.startsWith('\\')) return false;
      return !value.split(/[\\/]+/).some((segment) => segment === '' || segment === '.' || segment === '..');
    }, 'Asset path must be a relative exact wheel member path'),
  ).superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one platform asset path is required',
      });
    }
    for (const key of keys) {
      if (!ManagedPypiWheelAssetPlatformSchema.safeParse(key).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Unsupported managed PyPI wheel asset platform',
        });
      }
    }
  }),
  executable: z.literal(true),
  compatibilityProbe: z.string().trim().min(1).optional(),
  installConsent: ManagedPypiWheelAssetInstallConsentSchema,
  autoUpdateMode: ManagedPypiWheelAssetAutoUpdateModeSchema,
  trustedPublisher: z.string().trim().min(1).optional(),
  maxWheelSizeBytes: z.number().int().positive().optional(),
  maxAssetSizeBytes: z.number().int().positive().optional(),
}).strict());

export const PinnedArchiveInstallableAssetSchema = lazyZodSchema(() => z.object({
  archiveUrl: z.string().url().refine((value) => value.startsWith('https://'), 'Pinned archive URL must use HTTPS'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Known download bytes for this exact pinned archive; presentation metadata, not an extraction limit. */
  sizeBytes: z.number().int().positive().optional(),
  executableSubpath: z.string().trim().min(1).refine((value) => {
    if (/^(?:[A-Za-z]:)?[\\/]/.test(value)) return false;
    return value.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  }, 'Pinned archive executable path must be a safe relative path'),
  args: z.array(z.string()).optional(),
}).strict());
export type PinnedArchiveInstallableAsset = z.infer<typeof PinnedArchiveInstallableAssetSchema>;

export const PinnedArchiveAssetsByPlatformSchema = lazyZodSchema(() => z.object({
  'darwin-arm64': PinnedArchiveInstallableAssetSchema.optional(),
  'darwin-x64': PinnedArchiveInstallableAssetSchema.optional(),
  'linux-x64': PinnedArchiveInstallableAssetSchema.optional(),
  'linux-arm64': PinnedArchiveInstallableAssetSchema.optional(),
  'win32-x64': PinnedArchiveInstallableAssetSchema.optional(),
  'win32-arm64': PinnedArchiveInstallableAssetSchema.optional(),
}).strict().refine((assets) => Object.values(assets).some(Boolean), 'Pinned archive source requires at least one platform asset'));

export const PinnedArchivePlatformSchema = lazyZodSchema(() => PinnedArchiveAssetsByPlatformSchema.keyof());

export const PinnedArchiveExtractionLimitsSchema = lazyZodSchema(() => z.object({
  maxArchiveBytes: z.number().int().positive().optional(),
  maxFileBytes: z.number().int().positive().optional(),
  maxExpandedBytes: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict().refine(
  (limits) => Object.values(limits).some((value) => value !== undefined),
  'Pinned archive extraction limits must override at least one default',
).superRefine((limits, ctx) => {
  if (
    limits.maxFileBytes !== undefined
    && limits.maxExpandedBytes !== undefined
    && limits.maxFileBytes > limits.maxExpandedBytes
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxFileBytes'],
      message: 'Per-file extraction limit must not exceed the cumulative expanded-byte limit',
    });
  }
}));
export type PinnedArchiveExtractionLimits = z.infer<typeof PinnedArchiveExtractionLimitsSchema>;

/**
 * One immutable, digest-pinned per-platform archive. The publishing artifact is
 * pinned, so there is no version discovery: the declared `version` is both the
 * installed and the available version.
 */
export const PinnedArchiveInstallableSourceSchema = lazyZodSchema(() => z.object({
  kind: z.literal('pinned_archive'),
  version: z.string().trim().min(1),
  archiveExtractionLimits: PinnedArchiveExtractionLimitsSchema.optional(),
  assetsByPlatform: PinnedArchiveAssetsByPlatformSchema,
}).strict());

export const VendorRecipeInstallableSourceSchema = lazyZodSchema(() => z.object({
  kind: z.literal('vendor_recipe'),
  recipeId: z.string().trim().min(1),
  commandsPreview: z.array(z.string().trim().min(1)).min(1),
}).strict());

export const ManualOnlyInstallableSourceSchema = lazyZodSchema(() => z.object({
  kind: z.literal('manual_only'),
  setupUrl: z.string().trim().url().optional(),
  instructionsKey: z.string().trim().min(1).optional(),
}).strict());

/** Host-owned optional runtimes use the verified release matching the running CLI. */
export const FirstPartyRuntimeInstallableSourceSchema = lazyZodSchema(() => z.object({
  kind: z.literal('first_party_runtime'),
  componentId: z.enum(['happier-memory-runtime', 'happier-voice-runtime', 'happier-difftastic']),
}).strict());

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
