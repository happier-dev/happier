import { z } from 'zod';

import { OptionalStringSchema, StringArraySchema } from './_shared.js';

export const ProviderCliSourcePreferenceV1Schema = z.enum(['system-first', 'managed-first']);
export type ProviderCliSourcePreferenceV1 = z.infer<typeof ProviderCliSourcePreferenceV1Schema>;

export const ProviderCliManualInstallKindV1Schema = z.enum(['command', 'vendor_recipe', 'none']);
export type ProviderCliManualInstallKindV1 = z.infer<typeof ProviderCliManualInstallKindV1Schema>;

export const ProviderCliInstallPlatformV1Schema = z.enum(['darwin', 'linux', 'win32']);
export type ProviderCliInstallPlatformV1 = z.infer<typeof ProviderCliInstallPlatformV1Schema>;

export const ProviderCliInstallCommandV1Schema = z.object({
  cmd: z.string().trim().min(1),
  args: StringArraySchema,
  requiresAdmin: z.boolean().optional(),
  note: OptionalStringSchema.nullable().optional(),
}).passthrough();
export type ProviderCliInstallCommandV1 = z.infer<typeof ProviderCliInstallCommandV1Schema>;

export const ProviderCliManualInstallRecipesV1Schema = z.object({
  darwin: z.array(ProviderCliInstallCommandV1Schema).optional(),
  linux: z.array(ProviderCliInstallCommandV1Schema).optional(),
  win32: z.array(ProviderCliInstallCommandV1Schema).optional(),
}).partial().nullable();
export type ProviderCliManualInstallRecipesV1 = z.infer<typeof ProviderCliManualInstallRecipesV1Schema>;

export const ProviderCliManagedInstallSpecV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github_release_binary'),
    githubRepo: z.string().trim().min(1),
    binaryName: z.string().trim().min(1),
  }).passthrough(),
  z.object({
    kind: z.literal('managed_package'),
    packageName: z.string().trim().min(1),
    binaryName: z.string().trim().min(1),
  }).passthrough(),
]);
export type ProviderCliManagedInstallSpecV1 = z.infer<typeof ProviderCliManagedInstallSpecV1Schema>;

export const ProviderCliRuntimeV1Schema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  binaryName: z.string().trim().min(1),
  knownUserBinDirSuffixes: StringArraySchema.nullable().optional(),
  sourcePreferenceDefault: ProviderCliSourcePreferenceV1Schema,
  managedInstall: ProviderCliManagedInstallSpecV1Schema.nullable(),
  manualInstallKind: ProviderCliManualInstallKindV1Schema,
  manualInstallRecipes: ProviderCliManualInstallRecipesV1Schema,
  acceptsJavaScriptFileOverride: z.boolean(),
  installGuideUrl: OptionalStringSchema.nullable().optional(),
  docsUrl: OptionalStringSchema.nullable().optional(),
}).passthrough();
export type ProviderCliRuntimeV1 = z.infer<typeof ProviderCliRuntimeV1Schema>;
