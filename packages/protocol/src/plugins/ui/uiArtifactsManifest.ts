import { z } from 'zod';

import { PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';
import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';

const RelativeArtifactPathV1Schema = z.string().trim().min(1).refine(
  (value) => !value.startsWith('/') && !value.includes('..'),
  { message: 'artifact paths must be relative and must not traverse parents' },
);

export const PluginUiArtifactsManifestTierV1Schema = z.enum([
  'hostedWeb',
  'embeddedWeb',
  'reactNative',
]);
export type PluginUiArtifactsManifestTierV1 =
  z.infer<typeof PluginUiArtifactsManifestTierV1Schema>;

export const PluginUiArtifactsManifestEntryV1Schema = z.object({
  contributionId: z.string().trim().min(1),
  tier: PluginUiArtifactsManifestTierV1Schema,
  platform: PluginUiPlatformV1Schema.optional(),
  entry: RelativeArtifactPathV1Schema,
  files: z.array(RelativeArtifactPathV1Schema).min(1),
  digest: PluginUiArtifactDigestV1Schema,
  builtWith: z.object({
    bundler: z.enum(['vite', 'repack']),
    version: z.string().trim().min(1),
  }).strict(),
  hostUiApiVersion: z.string().trim().min(1),
  compat: z.object({
    react: z.string().trim().min(1),
    reactNative: z.string().trim().min(1).optional(),
    expoRuntime: z.string().trim().min(1).optional(),
    hermes: z.string().trim().min(1).optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if ((value.tier === 'hostedWeb' || value.tier === 'embeddedWeb') && value.builtWith.bundler !== 'vite') {
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
    // (mirrors hostedWeb/embeddedWeb's existing vite-required branch above),
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
  }
});
export type PluginUiArtifactsManifestEntryV1 =
  z.infer<typeof PluginUiArtifactsManifestEntryV1Schema>;

export const PluginUiArtifactsManifestV1Schema = z.object({
  version: z.literal(1),
  entries: z.array(PluginUiArtifactsManifestEntryV1Schema).default([]),
}).strict();
export type PluginUiArtifactsManifestV1 =
  z.infer<typeof PluginUiArtifactsManifestV1Schema>;
