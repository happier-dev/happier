import { join } from 'node:path';

import { readArtifactManifest, readReusableArtifactManifest, writeArtifactManifest, artifactPayloadDir } from '../runtime/shared/artifact_manifest.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import {
  buildServerBinaryArtifactPayload,
  SERVER_BINARY_DEFAULT_EXTERNALS,
  SERVER_BINARY_TARGETS,
  resolveCurrentBinaryTarget,
} from '@happier-dev/cli-common/componentArtifacts';
import { pathExists } from '../utils/fs/fs.mjs';

export async function resolveRuntimeServerUiWebDistPath({
  uiWebDistPath,
  pathExistsImpl = pathExists,
}) {
  const resolved = String(uiWebDistPath ?? '').trim();
  if (!resolved || !(await pathExistsImpl(join(resolved, 'index.html')))) {
    throw new Error('[build] server runtime artifact requires a complete canonical web artifact payload.');
  }
  return resolved;
}

export function resolveRuntimeServerWebArtifactFingerprint({ webArtifactFingerprint }) {
  const resolved = String(webArtifactFingerprint ?? '').trim();
  if (!resolved) {
    const error = new Error('[build] server runtime artifact requires a canonical web artifact identity.');
    error.code = 'HAPPIER_RUNTIME_WEB_ARTIFACT_UNAVAILABLE';
    throw error;
  }
  return resolved;
}

export async function buildServerArtifact({
  rootDir,
  artifactDir,
  artifactFingerprint,
  sourceMetadata,
  forceRebuild = false,
  env = process.env,
  uiWebDistPath,
  webArtifactFingerprint,
  buildServerBinaryArtifactPayloadImpl = buildServerBinaryArtifactPayload,
}) {
  void rootDir;
  void forceRebuild;
  const resolvedWebArtifactFingerprint = resolveRuntimeServerWebArtifactFingerprint({ webArtifactFingerprint });
  const existing = await readReusableArtifactManifest({ artifactDir, artifactFingerprint });
  if (existing?.webArtifactFingerprint === resolvedWebArtifactFingerprint) {
    return { artifactDir, manifest: existing };
  }

  const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
  const externals = String(
    env.HAPPIER_SERVER_BUN_EXTERNALS ?? SERVER_BINARY_DEFAULT_EXTERNALS.join(','),
  )
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
  const resolvedUiWebDistPath = await resolveRuntimeServerUiWebDistPath({ uiWebDistPath });

  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);
    const built = await buildServerBinaryArtifactPayloadImpl({
      repoRoot: sourceMetadata.repoDir,
      payloadDir,
      uiWebDistPath: resolvedUiWebDistPath,
      target,
      serverComponent: sourceMetadata.serverComponent,
      entrypoint: serverEntrypoint,
      externals,
      env,
    });

    await writeArtifactManifest({
      artifactDir: tmpArtifactDir,
      manifest: {
        version: 1,
        component: 'server',
        artifactFingerprint,
        webArtifactFingerprint: resolvedWebArtifactFingerprint,
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
