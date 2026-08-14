import { readArtifactManifest, readReusableArtifactManifest, writeArtifactManifest, artifactPayloadDir } from '../runtime/shared/artifact_manifest.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { buildCliBinaryArtifactPayload, CLI_BINARY_TARGETS, resolveCurrentBinaryTarget } from '@happier-dev/cli-common/componentArtifacts';

export async function buildDaemonArtifact({
  rootDir,
  artifactDir,
  artifactFingerprint,
  sourceMetadata,
  forceRebuild = false,
  env = process.env,
}) {
  void rootDir;
  void forceRebuild;
  const existing = await readReusableArtifactManifest({ artifactDir, artifactFingerprint });
  if (existing) {
    return { artifactDir, manifest: existing };
  }

  const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
  const externals = String(env.HAPPIER_CLI_BUN_EXTERNALS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);
    const built = await buildCliBinaryArtifactPayload({
      repoRoot: sourceMetadata.repoDir,
      payloadDir,
      target,
      externals,
      env,
    });

    await writeArtifactManifest({
      artifactDir: tmpArtifactDir,
      manifest: {
        version: 1,
        component: 'daemon',
        artifactFingerprint,
        sourceFingerprint: sourceMetadata.sourceFingerprint,
        createdAt: sourceMetadata.builtAt,
        source: sourceMetadata,
        payloadDir: 'payload',
        entrypoint: built.entrypoint,
      },
    });
  });

  const manifest = await readArtifactManifest({ artifactDir });
  return { artifactDir, manifest };
}
