import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  GitHubReleaseBinaryInstallableSourceSchema,
  ManagedPypiWheelAssetInstallableSourceSchema,
  PinnedArchiveInstallableSourceSchema,
} from '../../installables/sourceKind.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const PluginManagedPypiWheelAssetSourceV2Schema = lazyZodSchema(() => ManagedPypiWheelAssetInstallableSourceSchema
  .omit({
    kind: true,
    maxWheelSizeBytes: true,
    maxAssetSizeBytes: true,
  })
  .extend({
    kind: z.literal('managedPypiWheelAsset'),
    installId: z.string().trim().regex(/^dep\.[A-Za-z0-9._-]+$/),
  })
  .strict());

const PluginPinnedArchiveSourceV2Schema = lazyZodSchema(() => PinnedArchiveInstallableSourceSchema
  .omit({ kind: true })
  .extend({
    kind: z.literal('pinnedArchive'),
    installId: z.string().trim().regex(/^dep\.[A-Za-z0-9._-]+$/),
  })
  .strict());

const PluginManagedDependencySourceV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  GitHubReleaseBinaryInstallableSourceSchema.omit({ kind: true }).extend({
    kind: z.literal('githubReleaseBinary'),
    installId: z.string().trim().regex(/^dep\.[A-Za-z0-9._-]+$/),
  }).strict(),
  PluginManagedPypiWheelAssetSourceV2Schema,
  PluginPinnedArchiveSourceV2Schema,
  z.object({ kind: z.literal('system'), executableNames: z.array(z.string().trim().min(1)).min(1), versionArguments: z.array(z.string()).optional() }).strict(),
  z.object({ kind: z.literal('vendorRecipe'), recipeId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('manual'), instructions: PluginLocalizedStringV2Schema }).strict(),
]));
export const PluginManagedDependencyContributionV2Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  sources: z.array(PluginManagedDependencySourceV2Schema).min(1),
  platforms: z.array(z.enum(['macos', 'linux', 'windows'])).optional(),
  architectures: z.array(z.string().trim().min(1)).optional(),
  executable: z.string().trim().min(1).optional(),
  health: PluginJsonValueV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.sources.some((source) => source.kind === 'managedPypiWheelAsset' || source.kind === 'pinnedArchive' || source.kind === 'githubReleaseBinary') && !value.executable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executable'],
      message: 'Managed executable dependencies require an executable',
    });
  }
}));
export type PluginManagedDependencyContributionV2 = z.infer<typeof PluginManagedDependencyContributionV2Schema>;
