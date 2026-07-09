import { z } from 'zod';

import { PluginOptionalStringSchema, PluginStringArraySchema } from './_shared.js';

export const AgentCliSourcePreferenceV1Schema = z.enum(['system-first', 'managed-first']);
export type AgentCliSourcePreferenceV1 = z.infer<typeof AgentCliSourcePreferenceV1Schema>;

export const AgentCliManualInstallKindV1Schema = z.enum(['command', 'vendor_recipe', 'none']);
export type AgentCliManualInstallKindV1 = z.infer<typeof AgentCliManualInstallKindV1Schema>;

export const AgentCliInstallPlatformV1Schema = z.enum(['darwin', 'linux', 'win32']);
export type AgentCliInstallPlatformV1 = z.infer<typeof AgentCliInstallPlatformV1Schema>;

export const AgentCliInstallCommandV1Schema = z.object({
  cmd: z.string().trim().min(1),
  args: PluginStringArraySchema,
  requiresAdmin: z.boolean().optional(),
  note: PluginOptionalStringSchema.nullable().optional(),
}).passthrough();
export type AgentCliInstallCommandV1 = z.infer<typeof AgentCliInstallCommandV1Schema>;

export const AgentCliManualInstallRecipesV1Schema = z.object({
  darwin: z.array(AgentCliInstallCommandV1Schema).optional(),
  linux: z.array(AgentCliInstallCommandV1Schema).optional(),
  win32: z.array(AgentCliInstallCommandV1Schema).optional(),
}).partial().nullable();
export type AgentCliManualInstallRecipesV1 = z.infer<typeof AgentCliManualInstallRecipesV1Schema>;

export const AgentCliManagedInstallSpecV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github_release_binary'),
    githubRepo: z.string().trim().min(1),
    binaryName: z.string().trim().min(1),
  }).passthrough(),
  z.object({
    kind: z.literal('managed_package'),
    packageName: z.string().trim().min(1),
    binaryName: z.string().trim().min(1),
    packageBinarySetup: z.object({
      kind: z.literal('opencode_platform_binary'),
    }).passthrough().nullable().optional(),
  }).passthrough(),
]);
export type AgentCliManagedInstallSpecV1 = z.infer<typeof AgentCliManagedInstallSpecV1Schema>;

export const AgentCliRuntimeV1Schema = z.object({
  kindVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  binaryName: z.string().trim().min(1),
  knownUserBinDirSuffixes: PluginStringArraySchema.nullable().optional(),
  sourcePreferenceDefault: AgentCliSourcePreferenceV1Schema,
  managedInstall: AgentCliManagedInstallSpecV1Schema.nullable(),
  manualInstallKind: AgentCliManualInstallKindV1Schema,
  manualInstallRecipes: AgentCliManualInstallRecipesV1Schema,
  acceptsJavaScriptFileOverride: z.boolean(),
  installGuideUrl: PluginOptionalStringSchema.nullable().optional(),
  docsUrl: PluginOptionalStringSchema.nullable().optional(),
}).passthrough();
export type AgentCliRuntimeV1 = z.infer<typeof AgentCliRuntimeV1Schema>;
