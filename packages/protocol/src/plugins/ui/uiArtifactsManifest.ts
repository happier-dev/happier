import { z } from 'zod';

import { createPortablePathCollisionRegistry } from '../../filesystem/portablePathSegment.js';
import { PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';
import {
  PluginUiArtifactFileV1Schema,
  PluginUiArtifactRelativePathV1Schema,
} from '../contributions/ui/artifacts.js';
import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';

/**
 * The strict grammar version emitted by public plugin UI build tooling.
 * Keep this alongside the schema so generators consume the canonical owner
 * instead of duplicating the literal in package-local compatibility code.
 */
export const PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1 = 1 as const;

export const PluginUiArtifactsManifestTierV1Schema = z.enum([
  'hostedWeb',
  'reactNative',
]);
export type PluginUiArtifactsManifestTierV1 =
  z.infer<typeof PluginUiArtifactsManifestTierV1Schema>;

/**
 * One executable export within a signed React Native Artifact graph. This is
 * an Artifact declaration, not a contribution or activation registration.
 */
const PluginUiArtifactRepackModuleReferenceV1Schema = z.object({
  containerName: z.string().trim().min(1),
  modulePath: z.string().trim().min(1),
  exportName: z.string().trim().min(1),
}).strict();

/**
 * Native Re.Pack can address an export by federation container/module/export.
 * The RN-web loader imports the signed entry module itself, so its truthful
 * identity is only the named export; requiring fake container/path values
 * would create a second, non-executable artifact fact.
 */
const PluginUiArtifactCollectionMigrationModuleReferenceV1Schema = z.union([
  PluginUiArtifactRepackModuleReferenceV1Schema,
  z.object({
    exportName: z.string().trim().min(1),
  }).strict(),
]);

function isRepackModuleReference(value: z.infer<typeof PluginUiArtifactCollectionMigrationModuleReferenceV1Schema>): value is z.infer<typeof PluginUiArtifactRepackModuleReferenceV1Schema> {
  return 'containerName' in value && 'modulePath' in value;
}

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
  repack: PluginUiArtifactRepackModuleReferenceV1Schema.optional(),
  /**
   * Host-private candidate migration entrypoint. A renderer graph without this
   * exact signed declaration must never be treated as migration code.
   */
  collectionMigrations: PluginUiArtifactCollectionMigrationModuleReferenceV1Schema.optional(),
  hostUiApiVersion: z.string().trim().min(1),
  compat: z.object({
    react: z.string().trim().min(1).optional(),
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
  if (value.tier === 'hostedWeb' && Object.keys(value.compat).length !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['compat'],
      message: 'Hosted web artifacts must not declare React Native compatibility',
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
    if (!value.compat.react) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['compat', 'react'],
        message: 'React Native artifacts must declare React compatibility',
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
    if (
      value.collectionMigrations
      && !isWebPlatform
      && (
        !isRepackModuleReference(value.collectionMigrations)
        ||
        !value.repack
        || value.collectionMigrations.containerName !== value.repack.containerName
        || value.collectionMigrations.modulePath !== value.repack.modulePath
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collectionMigrations'],
        message: 'Native Collection migration exports must use the declared Re.Pack container and module identity',
      });
    }
    if (isWebPlatform && value.collectionMigrations && isRepackModuleReference(value.collectionMigrations)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collectionMigrations'],
        message: 'React Native web Collection migration exports must declare only their exact named export',
      });
    }
  } else if (value.repack || value.collectionMigrations) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.repack ? ['repack'] : ['collectionMigrations'],
      message: 'Only React Native artifacts may declare executable module identity',
    });
  }
});
export type PluginUiArtifactsManifestEntryV1 =
  z.infer<typeof PluginUiArtifactsManifestEntryV1Schema>;

export const PluginUiArtifactsManifestV1Schema = z.object({
  version: z.literal(PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1),
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
