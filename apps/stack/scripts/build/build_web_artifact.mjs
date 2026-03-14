import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { ensureDepsInstalled, requireDir } from '../utils/proc/pm.mjs';
import { getComponentDir } from '../utils/paths/paths.mjs';
import { getDefaultAutostartPaths } from '../utils/paths/paths.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, resolveExpoTmpDir, wantsExpoClearCache } from '../utils/expo/expo.mjs';
import { expoExec } from '../utils/expo/command.mjs';
import { pathExists } from '../utils/fs/fs.mjs';
import { buildStackWebExportEnv } from '../utils/ui/ui_export_env.mjs';
import { artifactPayloadDir, readArtifactManifest, writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';

export async function buildWebArtifact({
  rootDir,
  artifactDir,
  artifactFingerprint,
  sourceMetadata,
  forceRebuild = false,
}) {
  const existing = await readArtifactManifest({ artifactDir });
  if (!forceRebuild && existing?.artifactFingerprint === artifactFingerprint) {
    return { artifactDir, manifest: existing };
  }

  const uiDir = getComponentDir(rootDir, 'happier-ui');
  await requireDir('happier-ui', uiDir);
  await ensureDepsInstalled(uiDir, 'happier-ui');

  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);
    await rm(payloadDir, { recursive: true, force: true });
    await mkdir(payloadDir, { recursive: true });

    const env = buildStackWebExportEnv({ baseEnv: process.env });
    const paths = getExpoStatePaths({
      baseDir: getDefaultAutostartPaths().baseDir,
      kind: 'ui-export-runtime-artifact',
      projectDir: uiDir,
      stateFileName: 'ui.export.runtime.state.json',
    });
    const tmpDir = resolveExpoTmpDir({ env, defaultTmpDir: paths.tmpDir, kind: 'ui-export-runtime-artifact', projectDir: uiDir });
    await ensureExpoIsolationEnv({ env, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir });
    await expoExec({
      dir: uiDir,
      args: ['export', '--platform', 'web', '--output-dir', payloadDir, ...(wantsExpoClearCache({ env }) ? ['-c'] : [])],
      env,
      ensureDepsLabel: 'happier-ui',
    });

    const indexPath = join(payloadDir, 'index.html');
    if (!(await pathExists(indexPath))) {
      throw new Error(`[build] web artifact is incomplete: missing ${indexPath}`);
    }

    await writeArtifactManifest({
      artifactDir: tmpArtifactDir,
      manifest: {
        version: 1,
        component: 'web',
        artifactFingerprint,
        sourceFingerprint: sourceMetadata.sourceFingerprint,
        createdAt: sourceMetadata.builtAt,
        source: sourceMetadata,
        payloadDir: 'payload',
        entrypoint: 'index.html',
      },
    });
  });

  const manifest = await readArtifactManifest({ artifactDir });
  return { artifactDir, manifest };
}
