import { join } from 'node:path';

import { readArtifactManifest, writeArtifactManifest, artifactPayloadDir } from '../runtime/shared/artifact_manifest.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import {
  buildServerBinaryArtifactPayload,
  SERVER_BINARY_TARGETS,
  resolveCurrentBinaryTarget,
} from '@happier-dev/cli-common/componentArtifacts';

export async function buildServerArtifact({
  rootDir,
  artifactDir,
  artifactFingerprint,
  sourceMetadata,
  forceRebuild = false,
}) {
  void rootDir;
  const existing = await readArtifactManifest({ artifactDir });
  if (!forceRebuild && existing?.artifactFingerprint === artifactFingerprint) {
    return { artifactDir, manifest: existing };
  }

  const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
  const externals = String(process.env.HAPPIER_SERVER_BUN_EXTERNALS ?? 'redis')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const serverEntrypoint = join(
    sourceMetadata.repoDir,
    'apps',
    'server',
    'sources',
    sourceMetadata.serverComponent === 'happier-server' ? 'main.ts' : 'main.light.ts',
  );

  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);
    const built = await buildServerBinaryArtifactPayload({
      repoRoot: sourceMetadata.repoDir,
      payloadDir,
      target,
      entrypoint: serverEntrypoint,
      externals,
    });

    await writeArtifactManifest({
      artifactDir: tmpArtifactDir,
      manifest: {
        version: 1,
        component: 'server',
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
