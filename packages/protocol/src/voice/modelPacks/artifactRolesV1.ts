import { z } from 'zod';

import { assertManifestPathsSafe, assertModelPackFilePathPortable } from './pathSafety.js';

const ArtifactPathV1Schema = z.string().min(1).max(512).superRefine((path, ctx) => {
  try {
    assertModelPackFilePathPortable(path);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Artifact paths must be canonical portable relative POSIX paths.' });
  }
});

export const VoiceModelPackFileArtifactV1Schema = z.object({
  type: z.literal('file'),
  path: ArtifactPathV1Schema,
}).strict();
export type VoiceModelPackFileArtifactV1 = z.infer<typeof VoiceModelPackFileArtifactV1Schema>;

export const VoiceModelPackDirectoryArtifactV1Schema = z.object({
  type: z.literal('directory_prefix'),
  path: ArtifactPathV1Schema,
}).strict();
export type VoiceModelPackDirectoryArtifactV1 = z.infer<typeof VoiceModelPackDirectoryArtifactV1Schema>;

export const VoiceModelPackSupportArtifactKindV1Schema = z.enum([
  'license',
  'notice',
  'provenance',
]);
export type VoiceModelPackSupportArtifactKindV1 = z.infer<typeof VoiceModelPackSupportArtifactKindV1Schema>;

/** Exact non-runtime bytes retained with an installed model pack. */
export const VoiceModelPackSupportArtifactV1Schema = z.object({
  type: z.literal('file'),
  kind: VoiceModelPackSupportArtifactKindV1Schema,
  path: ArtifactPathV1Schema,
}).strict();
export type VoiceModelPackSupportArtifactV1 = z.infer<typeof VoiceModelPackSupportArtifactV1Schema>;

export const VoiceModelPackTransducerArtifactsV1Schema = z.object({
  encoder: VoiceModelPackFileArtifactV1Schema,
  decoder: VoiceModelPackFileArtifactV1Schema,
  joiner: VoiceModelPackFileArtifactV1Schema,
  tokens: VoiceModelPackFileArtifactV1Schema,
}).strict();
export type VoiceModelPackTransducerArtifactsV1 = z.infer<typeof VoiceModelPackTransducerArtifactsV1Schema>;

export const VoiceModelPackKokoroArtifactsV1Schema = z.object({
  model: VoiceModelPackFileArtifactV1Schema,
  voices: VoiceModelPackFileArtifactV1Schema,
  tokens: VoiceModelPackFileArtifactV1Schema,
  data: VoiceModelPackDirectoryArtifactV1Schema,
}).strict();
export type VoiceModelPackKokoroArtifactsV1 = z.infer<typeof VoiceModelPackKokoroArtifactsV1Schema>;

export const VoiceModelPackTransducerArtifactContractV1Schema = z.object({
  family: z.enum(['sherpa_zipformer_streaming', 'sherpa_parakeet_offline']),
  artifacts: VoiceModelPackTransducerArtifactsV1Schema,
}).strict();

export const VoiceModelPackKokoroArtifactContractV1Schema = z.object({
  family: z.literal('sherpa_kokoro_offline'),
  artifacts: VoiceModelPackKokoroArtifactsV1Schema,
}).strict();

export const VoiceModelPackArtifactContractV1Schema = z.discriminatedUnion('family', [
  VoiceModelPackTransducerArtifactContractV1Schema,
  VoiceModelPackKokoroArtifactContractV1Schema,
]);

export type VoiceModelPackArtifactContractV1 = z.infer<typeof VoiceModelPackArtifactContractV1Schema>;

export type ResolvedVoiceModelPackArtifactsV1 =
  | Readonly<{
      family: 'sherpa_zipformer_streaming' | 'sherpa_parakeet_offline';
      files: Readonly<{ encoder: string; decoder: string; joiner: string; tokens: string }>;
    }>
  | Readonly<{
      family: 'sherpa_kokoro_offline';
      files: Readonly<{ model: string; voices: string; tokens: string; dataDir: string }>;
    }>;

type ManifestFilePath = Readonly<{ path: string }>;

/** Read the family-owned semantic paths without inferring from filenames/order. */
function readVoiceModelPackArtifactRolePathsV1(
  runtime: VoiceModelPackArtifactContractV1,
): ResolvedVoiceModelPackArtifactsV1 {
  if (runtime.family === 'sherpa_kokoro_offline') {
    const kokoro = runtime.artifacts;
    return {
      family: runtime.family,
      files: {
        model: kokoro.model.path,
        voices: kokoro.voices.path,
        tokens: kokoro.tokens.path,
        dataDir: kokoro.data.path,
      },
    };
  }

  const transducer = runtime.artifacts;
  return {
    family: runtime.family,
    files: {
      encoder: transducer.encoder.path,
      decoder: transducer.decoder.path,
      joiner: transducer.joiner.path,
      tokens: transducer.tokens.path,
    },
  };
}

/**
 * Resolve semantic artifact roles and prove that every manifest path has one
 * owner. This is the only V1 role/path mapping used by schema admission,
 * installer compatibility checks, and host runtime loading.
 */
export function resolveVoiceModelPackArtifactsV1(
  runtime: VoiceModelPackArtifactContractV1,
  files: readonly ManifestFilePath[],
  supportArtifacts: readonly VoiceModelPackSupportArtifactV1[] = [],
): ResolvedVoiceModelPackArtifactsV1 {
  const parsedRuntime = VoiceModelPackArtifactContractV1Schema.parse({
    family: runtime?.family,
    artifacts: runtime?.artifacts,
  });
  const parsedSupportArtifacts = z.array(VoiceModelPackSupportArtifactV1Schema).max(32).parse(supportArtifacts);
  const manifestPaths = files.map((file) => file.path);
  assertManifestPathsSafe({ files });

  const artifacts = parsedRuntime.artifacts;
  const runtimeRoles = Object.entries(artifacts) as readonly [string, VoiceModelPackFileArtifactV1 | VoiceModelPackDirectoryArtifactV1][];
  const supportRoles = parsedSupportArtifacts.map((artifact, index) => [`support:${index}`, artifact] as const);
  const roles: readonly (readonly [string, VoiceModelPackFileArtifactV1 | VoiceModelPackDirectoryArtifactV1])[] = [
    ...runtimeRoles,
    ...supportRoles,
  ];
  for (const [, artifact] of roles) {
    assertModelPackFilePathPortable(artifact.path);
  }
  const rolePaths = roles.map(([, artifact]) => artifact.path);
  if (new Set(rolePaths).size !== rolePaths.length) {
    throw new Error('voice_model_pack_artifact_duplicate_role_path');
  }

  for (const [, artifact] of roles) {
    if (artifact.type === 'file' && !manifestPaths.includes(artifact.path)) {
      throw new Error('voice_model_pack_artifact_file_missing');
    }
    if (
      artifact.type === 'directory_prefix'
      && !manifestPaths.some((path) => path.startsWith(`${artifact.path}/`))
    ) {
      throw new Error('voice_model_pack_artifact_directory_empty');
    }
  }

  for (const path of manifestPaths) {
    const owners = roles.filter(([, artifact]) => (
      artifact.type === 'file'
        ? artifact.path === path
        : path.startsWith(`${artifact.path}/`)
    ));
    if (owners.length !== 1) {
      throw new Error(owners.length === 0
        ? 'voice_model_pack_artifact_path_unowned'
        : 'voice_model_pack_artifact_path_ambiguous');
    }
  }

  return readVoiceModelPackArtifactRolePathsV1(parsedRuntime);
}
