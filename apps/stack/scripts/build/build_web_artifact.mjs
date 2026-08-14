import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';

import { execYarn } from '../../../../scripts/workspaces/execYarnCommand.mjs';
import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { ensureDepsInstalled, requireDir } from '../utils/proc/pm.mjs';
import { getComponentDir } from '../utils/paths/paths.mjs';
import { getDefaultAutostartPaths } from '../utils/paths/paths.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, resolveExpoTmpDir, wantsExpoClearCache } from '../utils/expo/expo.mjs';
import { expoExec } from '../utils/expo/command.mjs';
import { pathExists } from '../utils/fs/fs.mjs';
import { buildStackWebExportEnv } from '../utils/ui/ui_export_env.mjs';
import { artifactPayloadDir, readArtifactManifest, readReusableArtifactManifest, writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';

function runCanonicalUiPostinstall({ uiDir, env }) {
  execYarn(['-s', 'postinstall:real'], {
    cwd: uiDir,
    env,
    stdio: 'inherit',
  });
}

export async function ensureWebUiDependencies({
  uiDir,
  env = process.env,
  ensureDepsInstalledImpl = ensureDepsInstalled,
  runUiPostinstallImpl = runCanonicalUiPostinstall,
}) {
  await ensureDepsInstalledImpl(uiDir, 'happier-ui', {
    env,
    onDependenciesReady: () => runUiPostinstallImpl({ uiDir, env }),
  });
}

export function resolveWebExportStagingRootDir(uiDir) {
  return join(uiDir, '.expo', 'hstack', 'web-artifact-export');
}

function resolveWebExportStagingDir(uiDir, artifactFingerprint) {
  const root = resolveWebExportStagingRootDir(uiDir);
  const token = `${String(artifactFingerprint ?? '').slice(0, 12) || 'artifact'}-${process.pid}-${randomUUID()}`;
  return join(root, token);
}

function joinManifestPath(...parts) {
  return parts
    .flatMap((part) => String(part ?? '').split(/[\\/]+/g))
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
}

async function listDirPreview(dir, { limit = 32 } = {}) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .slice(0, limit)
      .map((ent) => (ent.isDirectory() ? `${ent.name}/` : ent.name))
      .sort();
  } catch {
    return [];
  }
}

async function findNestedIndexHtmlPaths(rootDir, { maxDepth = 2, limit = 5 } = {}) {
  const found = [];
  const queue = [{ rel: '', depth: 0 }];
  while (queue.length && found.length < limit) {
    const current = queue.shift();
    if (!current) break;
    const abs = current.rel ? join(rootDir, current.rel) : rootDir;
    const indexPath = join(abs, 'index.html');
    // eslint-disable-next-line no-await-in-loop
    if (await pathExists(indexPath)) {
      found.push(joinManifestPath(current.rel, 'index.html'));
    }
    if (current.depth >= maxDepth) continue;
    let entries = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const nextRel = joinManifestPath(current.rel, ent.name);
      queue.push({ rel: nextRel, depth: current.depth + 1 });
      if (queue.length > 1_000) break;
    }
  }
  return found;
}

async function moveDir({ fromDir, toDir }) {
  await rm(toDir, { recursive: true, force: true });
  await mkdir(dirname(toDir), { recursive: true });
  try {
    await rename(fromDir, toDir);
    return;
  } catch (err) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
  }
  await cp(fromDir, toDir, { recursive: true });
  await rm(fromDir, { recursive: true, force: true });
}

export async function exportWebPayloadToArtifactPayloadDir({
  uiDir,
  payloadDir,
  env,
  artifactFingerprint,
  expoExecImpl = expoExec,
}) {
  const stagingRoot = resolveWebExportStagingRootDir(uiDir);
  const stagingDir = resolveWebExportStagingDir(uiDir, artifactFingerprint);
  const preserveStaging = String(env?.HAPPIER_STACK_EXPO_EXPORT_PRESERVE_STAGING ?? '').trim() === '1';

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  let ok = false;
  try {
    await expoExecImpl({
      dir: uiDir,
      args: [
        'export',
        '--platform',
        'web',
        '--output-dir',
        stagingDir,
        ...(wantsExpoClearCache({ env }) ? ['-c'] : []),
      ],
      env,
      ensureDepsLabel: 'happier-ui',
    });

    const indexPath = join(stagingDir, 'index.html');
    if (!(await pathExists(indexPath))) {
      const preview = await listDirPreview(stagingDir);
      const nested = await findNestedIndexHtmlPaths(stagingDir);
      const nestedHint = nested.length
        ? `\nFound nested index.html candidates:\n${nested.map((p) => `- ${p}`).join('\n')}`
        : '';
      throw new Error(
        `[build] web export is incomplete: missing ${indexPath}\n` +
          `Staging dir: ${stagingDir}\n` +
          (preview.length ? `Staging contents:\n${preview.map((e) => `- ${e}`).join('\n')}\n` : 'Staging contents: (empty)\n') +
          nestedHint +
          `\n\n` +
          `Notes:\n` +
          `- Expo may ignore --output-dir when it points outside the project; exporting into apps/ui/.expo avoids that.\n` +
          `- Set HAPPIER_STACK_EXPO_EXPORT_PRESERVE_STAGING=1 to keep the staging dir for debugging.`,
      );
    }

    await moveDir({ fromDir: stagingDir, toDir: payloadDir });
    ok = true;
    return 'index.html';
  } finally {
    if (!ok && !preserveStaging) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!preserveStaging) {
      // Best-effort cleanup of empty staging root.
      try {
        const remaining = await readdir(stagingRoot);
        if (remaining.length === 0) await rm(stagingRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

export async function buildWebArtifact({
  rootDir,
  artifactDir,
  artifactFingerprint,
  sourceMetadata,
  forceRebuild = false,
  env = process.env,
}) {
  void forceRebuild;
  const existing = await readReusableArtifactManifest({ artifactDir, artifactFingerprint });
  if (existing) {
    return { artifactDir, manifest: existing };
  }

  const uiDir = getComponentDir(rootDir, 'happier-ui');
  await requireDir('happier-ui', uiDir);
  await ensureWebUiDependencies({ uiDir, env });

  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);

    const exportEnv = buildStackWebExportEnv({ baseEnv: env });
    const paths = getExpoStatePaths({
      baseDir: getDefaultAutostartPaths(env).baseDir,
      kind: 'ui-export-runtime-artifact',
      projectDir: uiDir,
      stateFileName: 'ui.export.runtime.state.json',
    });
    const tmpDir = resolveExpoTmpDir({ env: exportEnv, defaultTmpDir: paths.tmpDir, kind: 'ui-export-runtime-artifact', projectDir: uiDir });
    await ensureExpoIsolationEnv({ env: exportEnv, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir });
    const entrypoint = await exportWebPayloadToArtifactPayloadDir({ uiDir, payloadDir, env: exportEnv, artifactFingerprint });

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
        entrypoint,
      },
    });
  });

  const manifest = await readArtifactManifest({ artifactDir });
  return { artifactDir, manifest };
}
