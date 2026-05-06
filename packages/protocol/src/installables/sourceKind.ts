import { z } from 'zod';

export const InstallableSourceKindSchema = z.enum([
  'github_release_binary',
  'managed_package',
  'vendor_recipe',
  'manual_only',
]);
export type InstallableSourceKind = z.infer<typeof InstallableSourceKindSchema>;

export const GitHubReleaseBinaryInstallableSourceSchema = z.object({
  kind: z.literal('github_release_binary'),
  repo: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/),
  distTag: z.string().trim().min(1).optional(),
}).strict();

export const ManagedPackageInstallableSourceSchema = z.object({
  kind: z.literal('managed_package'),
  packageName: z.string().trim().min(1),
  packageManager: z.literal('managed_js_runtime'),
  version: z.string().trim().min(1).optional(),
}).strict();

export const VendorRecipeInstallableSourceSchema = z.object({
  kind: z.literal('vendor_recipe'),
  recipeId: z.string().trim().min(1),
  commandsPreview: z.array(z.string().trim().min(1)).min(1),
}).strict();

export const ManualOnlyInstallableSourceSchema = z.object({
  kind: z.literal('manual_only'),
  setupUrl: z.string().trim().url().optional(),
  instructionsKey: z.string().trim().min(1).optional(),
}).strict();

export const InstallableSourceSchema = z.discriminatedUnion('kind', [
  GitHubReleaseBinaryInstallableSourceSchema,
  ManagedPackageInstallableSourceSchema,
  VendorRecipeInstallableSourceSchema,
  ManualOnlyInstallableSourceSchema,
]);
export type InstallableSource = z.infer<typeof InstallableSourceSchema>;
