import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { createPortablePathCollisionRegistry } from '../../filesystem/portablePathSegment.js';
import { PluginUiArtifactFileV1Schema, PluginUiArtifactRelativePathV1Schema } from '../contributions/ui/artifacts.js';
import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';

/** Canonical universal CommonJS executable / hosted-static artifact grammar. */
export const PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V2 = 2 as const;

export const PluginUiArtifactIdV2Schema = lazyZodSchema(() => z.string().trim().min(1).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
  'Plugin UI artifact ids must be portable path segments',
));
const PluginUiExecutableExportsV2Schema = lazyZodSchema(() => z.array(z.string().trim().min(1)).min(1)
  .superRefine((exports, ctx) => {
    if (new Set(exports).size !== exports.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Executable exports must be unique' });
    }
    const sorted = [...exports].sort();
    if (exports.some((name, index) => name !== sorted[index])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Executable exports must be sorted' });
    }
  }));

export const PluginUiExecutableArtifactV2Schema = lazyZodSchema(() => z.object({
  artifactId: PluginUiArtifactIdV2Schema,
  tier: z.literal('reactNative'),
  entry: PluginUiArtifactRelativePathV1Schema,
  files: z.tuple([PluginUiArtifactFileV1Schema]),
  digest: PluginUiArtifactDigestV1Schema,
  builtWith: z.object({ bundler: z.literal('esbuild'), version: z.string().trim().min(1) }).strict(),
  executable: z.object({ exports: PluginUiExecutableExportsV2Schema }).strict(),
  hostUiApiRange: z.string().trim().min(1),
}).strict().superRefine((value, ctx) => {
  const expectedEntry = `react-native/${value.artifactId}/entry.cjs.bundle`;
  if (value.entry !== expectedEntry) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entry'], message: `Executable artifact entry must be ${expectedEntry}` });
  }
  if (value.files[0]?.relativePath !== value.entry) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', 0, 'relativePath'], message: 'Executable artifact file must be its declared entry' });
  }
}));
export type PluginUiExecutableArtifactV2 = z.infer<typeof PluginUiExecutableArtifactV2Schema>;

export const PluginUiHostedStaticArtifactV2Schema = lazyZodSchema(() => z.object({
  artifactId: PluginUiArtifactIdV2Schema,
  tier: z.literal('hostedWeb'),
  entry: PluginUiArtifactRelativePathV1Schema,
  files: z.array(PluginUiArtifactFileV1Schema).min(1),
  digest: PluginUiArtifactDigestV1Schema,
  builtWith: z.object({ staging: z.literal('staticDirectory') }).strict(),
  hostUiApiRange: z.string().trim().min(1),
}).strict().superRefine((value, ctx) => {
  const expectedEntry = `hosted-web/${value.artifactId}/index.html`;
  if (value.entry !== expectedEntry) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entry'], message: `Hosted-static artifact entry must be ${expectedEntry}` });
  }
  if (!value.files.some((file) => file.relativePath === value.entry)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'Hosted-static artifact files must contain their root index.html' });
  }
}));
export type PluginUiHostedStaticArtifactV2 = z.infer<typeof PluginUiHostedStaticArtifactV2Schema>;

export const PluginUiArtifactsManifestEntryV2Schema = lazyZodSchema(() => z.discriminatedUnion('tier', [
  PluginUiExecutableArtifactV2Schema,
  PluginUiHostedStaticArtifactV2Schema,
]));
export type PluginUiArtifactsManifestEntryV2 = z.infer<typeof PluginUiArtifactsManifestEntryV2Schema>;

export const PluginUiArtifactsManifestV2Schema = lazyZodSchema(() => z.object({
  version: z.literal(PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V2),
  entries: z.array(PluginUiArtifactsManifestEntryV2Schema).default([]),
}).strict().superRefine((value, ctx) => {
  const artifactIds = new Set<string>();
  const pathRegistry = createPortablePathCollisionRegistry();
  value.entries.forEach((entry, entryIndex) => {
    if (artifactIds.has(entry.artifactId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', entryIndex, 'artifactId'], message: 'Plugin UI artifact ids must be unique' });
    }
    artifactIds.add(entry.artifactId);
    entry.files.forEach((file, fileIndex) => {
      const collision = pathRegistry.add(file.relativePath, 'file');
      if (collision) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', entryIndex, 'files', fileIndex, 'relativePath'], message: 'Generated artifact file paths must be portable and unique' });
      }
    });
  });
}));
export type PluginUiArtifactsManifestV2 = z.infer<typeof PluginUiArtifactsManifestV2Schema>;
