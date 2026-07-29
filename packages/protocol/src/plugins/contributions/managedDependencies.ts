import { z } from 'zod';

import { ManagedPypiWheelAssetInstallableSourceSchema } from '../../installables/sourceKind.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';

const PluginManagedPypiWheelAssetSourceV2Schema = ManagedPypiWheelAssetInstallableSourceSchema
  .omit({
    kind: true,
    maxWheelSizeBytes: true,
    maxAssetSizeBytes: true,
  })
  .extend({
    kind: z.literal('managedPypiWheelAsset'),
    installId: z.string().trim().regex(/^dep\.[A-Za-z0-9._-]+$/),
  })
  .strict();

const PluginManagedDependencySourceV2Schema = z.discriminatedUnion('kind', [
  PluginManagedPypiWheelAssetSourceV2Schema,
  z.object({ kind: z.literal('system'), executableNames: z.array(z.string().trim().min(1)).min(1), versionArguments: z.array(z.string()).optional() }).strict(),
  z.object({ kind: z.literal('vendorRecipe'), recipeId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('manual'), instructions: PluginLocalizedStringV2Schema }).strict(),
]);
export const PluginManagedDependencyContributionV2Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  sources: z.array(PluginManagedDependencySourceV2Schema).min(1),
  platforms: z.array(z.enum(['macos', 'linux', 'windows'])).optional(),
  architectures: z.array(z.string().trim().min(1)).optional(),
  executable: z.string().trim().min(1).optional(),
  health: PluginJsonValueV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.sources.some((source) => source.kind === 'managedPypiWheelAsset') && !value.executable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executable'],
      message: 'Managed PyPI wheel asset dependencies require an executable',
    });
  }
});
export type PluginManagedDependencyContributionV2 = z.infer<typeof PluginManagedDependencyContributionV2Schema>;
