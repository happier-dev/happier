import { z } from 'zod';

import { createPortablePathCollisionRegistry } from '../../filesystem/portablePathSegment.js';
import { PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';
import {
  PluginUiArtifactFileV1Schema,
  PluginUiArtifactRelativePathV1Schema,
} from '../contributions/ui/artifacts.js';
import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';

export const PluginUiArtifactsManifestTierV1Schema = z.enum([
  'hostedWeb',
  'reactNative',
]);
export type PluginUiArtifactsManifestTierV1 =
  z.infer<typeof PluginUiArtifactsManifestTierV1Schema>;

export const PluginUiArtifactsManifestEntryV1Schema = z.object({
  contributionId: z.string().trim().min(1),
  tier: PluginUiArtifactsManifestTierV1Schema,
  platform: PluginUiPlatformV1Schema.optional(),
  entry: PluginUiArtifactRelativePathV1Schema,
  files: z.array(PluginUiArtifactFileV1Schema).min(1),
  digest: PluginUiArtifactDigestV1Schema,
  builtWith: z.object({
    bundler: z.enum(['vite', 'repack']),
    version: z.string().trim().min(1),
  }).strict(),
  repack: z.object({
    containerName: z.string().trim().min(1),
    modulePath: z.string().trim().min(1),
    exportName: z.string().trim().min(1),
  }).strict().optional(),
  hostUiApiVersion: z.string().trim().min(1),
  compat: z.object({
    react: z.string().trim().min(1),
    reactNative: z.string().trim().min(1).optional(),
    expoRuntime: z.string().trim().min(1).optional(),
    hermes: z.string().trim().min(1).optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (!value.files.some((file) => file.relativePath === value.entry)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entry'],
      message: 'Generated artifact entry must be present in its verified file set',
    });
  }

  if (value.tier === 'hostedWeb' && value.builtWith.bundler !== 'vite') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['builtWith', 'bundler'],
      message: `${value.tier} artifacts must be built with Vite`,
    });
  }
  if (value.tier === 'reactNative') {
    // LEDGER DEC-6 (RN-WEB-LOADER): a `reactNative`-mode plugin ships one
    // manifest entry per platform, same pattern already used for ios/android
    // — native (ios/android) entries stay Re.Pack-built; a `platform:'web'`
    // entry is the react-native-web federation target and must be Vite-built
    // (mirrors hostedWeb's existing Vite-required branch above),
    // never Re.Pack (there is no Re.Pack-on-web backend).
    const isWebPlatform = value.platform === 'web';
    const requiredBundler = isWebPlatform ? 'vite' : 'repack';
    if (value.builtWith.bundler !== requiredBundler) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['builtWith', 'bundler'],
        message: isWebPlatform
          ? 'React Native artifacts targeting web must be built with Vite'
          : 'React Native artifacts must be built with Re.Pack',
      });
    }
    if (value.platform !== 'ios' && value.platform !== 'android' && value.platform !== 'web') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['platform'],
        message: 'React Native artifacts must declare ios, android, or web platform',
      });
    }
    if (!value.compat.reactNative) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['compat', 'reactNative'],
        message: 'React Native artifacts must declare React Native compatibility',
      });
    }
    if (!isWebPlatform && !value.repack) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repack'],
        message: 'Native React Native artifacts must declare exact Re.Pack container, module, and export identity',
      });
    }
    if (isWebPlatform && value.repack) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repack'],
        message: 'React Native web artifacts must not declare Re.Pack module identity',
      });
    }
  } else if (value.repack) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repack'],
      message: 'Only native React Native artifacts may declare Re.Pack module identity',
    });
  }
});
export type PluginUiArtifactsManifestEntryV1 =
  z.infer<typeof PluginUiArtifactsManifestEntryV1Schema>;

export const PluginUiArtifactsManifestV1Schema = z.object({
  version: z.literal(1),
  entries: z.array(PluginUiArtifactsManifestEntryV1Schema).default([]),
}).strict().superRefine((value, ctx) => {
  const pathRegistry = createPortablePathCollisionRegistry();
  value.entries.forEach((entry, entryIndex) => {
    entry.files.forEach((file, fileIndex) => {
      const collision = pathRegistry.add(file.relativePath, 'file');
      if (collision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', entryIndex, 'files', fileIndex, 'relativePath'],
          message: collision.kind === 'duplicate_or_case_alias'
            ? 'Generated artifact file paths must be unique across the complete tree on case-insensitive filesystems'
            : 'Generated artifact file paths must not overlap file and directory identities',
        });
      }
    });
  });
});
export type PluginUiArtifactsManifestV1 =
  z.infer<typeof PluginUiArtifactsManifestV1Schema>;
