import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  GitHubReleaseBinaryInstallableSourceSchema,
  ManagedPypiWheelAssetInstallableSourceSchema,
  PinnedArchiveInstallableSourceSchema,
} from '../../installables/sourceKind.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const PluginManagedPypiWheelAssetSourceV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(ManagedPypiWheelAssetInstallableSourceSchema, {
    kind: true,
    maxWheelSizeBytes: true,
    maxAssetSizeBytes: true,
  }), {
    kind: z.literal('managedPypiWheelAsset'),
    installId: z.string().check(z.trim(), z.regex(/^dep\.[A-Za-z0-9._-]+$/)),
  })));

const PluginPinnedArchiveSourceV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PinnedArchiveInstallableSourceSchema, { kind: true }), {
    kind: z.literal('pinnedArchive'),
    installId: z.string().check(z.trim(), z.regex(/^dep\.[A-Za-z0-9._-]+$/)),
  })));

const PluginManagedDependencySourceV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(GitHubReleaseBinaryInstallableSourceSchema, { kind: true }), {
    kind: z.literal('githubReleaseBinary'),
    installId: z.string().check(z.trim(), z.regex(/^dep\.[A-Za-z0-9._-]+$/)),
  })),
  PluginManagedPypiWheelAssetSourceV2Schema,
  PluginPinnedArchiveSourceV2Schema,
  z.strictObject({
    kind: z.literal('managedJavaScriptPackage'),
    installId: z.string().check(z.regex(/^dep\.[A-Za-z0-9._-]+$/)),
    packageName: z.string().check(z.regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)),
    version: z.string().check(z.regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)),
  }),
  z.strictObject({ kind: z.literal('system'), executableNames: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)), versionArguments: z.optional(z.array(z.string())) }),
  z.strictObject({ kind: z.literal('vendorRecipe'), recipeId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ kind: z.literal('manual'), instructions: PluginLocalizedStringV2Schema }),
]));
export const PluginManagedDependencyContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  sources: z.array(PluginManagedDependencySourceV2Schema).check(z.minLength(1)),
  platforms: z.optional(z.array(z.enum(['macos', 'linux', 'windows']))),
  architectures: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  executable: z.optional(z.string().check(z.trim(), z.minLength(1))),
  health: z.optional(PluginJsonValueV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}).check(z.superRefine((value, ctx) => {
  value.sources.forEach((source, sourceIndex) => {
    if (source.kind !== 'pinnedArchive') return;
    for (const [platform, asset] of Object.entries(source.assetsByPlatform)) {
      if (asset && !asset.sha256) {
        ctx.addIssue({
          code: "custom",
          path: ['sources', sourceIndex, 'assetsByPlatform', platform, 'sha256'],
          message: 'Manifest-declared pinned archive assets require a SHA-256 checksum',
        });
      }
    }
  });
  if (value.sources.some((source) => source.kind === 'managedPypiWheelAsset' || source.kind === 'pinnedArchive' || source.kind === 'githubReleaseBinary' || source.kind === 'managedJavaScriptPackage') && !value.executable) {
    ctx.addIssue({
      code: "custom",
      path: ['executable'],
      message: 'Managed executable dependencies require an executable',
    });
  }
  if (value.sources.some(source => source.kind === 'managedJavaScriptPackage')
    && value.executable && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.executable)) {
    ctx.addIssue({ code: 'custom', path: ['executable'], message: 'Managed JavaScript executables name an installed package bin' });
  }
})));
export type PluginManagedDependencyContributionV2 = z.infer<typeof PluginManagedDependencyContributionV2Schema>;
