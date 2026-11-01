import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';

import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import { ensureDepsInstalled, requireDir } from '../utils/proc/pm.mjs';
import { withBuildInputDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import { getComponentDir } from '../utils/paths/paths.mjs';
import { getDefaultAutostartPaths } from '../utils/paths/paths.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, resolveExpoTmpDir, wantsExpoClearCache } from '../utils/expo/expo.mjs';
import { resolveExpoBin, applyExpoExportMaxWorkersArgs } from '../utils/expo/command.mjs';
import { applyExpoNodeHeapEnv } from '../utils/expo/expoNodeHeapEnv.mjs';
import { runSourceBuildCommand } from '../utils/proc/runSourceBuildCommand.mjs';
import { SOURCE_WEB_EXPORT_ADMISSION_CLASS } from '../utils/dev_targets/remote_commands.mjs';
import { withSourceWebUiInputs } from './build_source_web_ui.mjs';
import { precompressUiWebAssets } from './precompress_ui_web_assets.mjs';
import { pathExists } from '../utils/fs/fs.mjs';
import { buildStackWebExportEnv } from '../utils/ui/ui_export_env.mjs';
import { artifactPayloadDir, readArtifactManifest, readReusableArtifactManifest, writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { assertWebArtifactPayload } from '../runtime/shared/web_payload.mjs';

async function runPreparedWebExport({ dir, args, env, repoDir = join(dir, '../..') }) {
  const exportEnv = applyExpoNodeHeapEnv({ ...env, CI: '1', EXPO_UNSTABLE_WEB_MODAL: '1' });
  await runSourceBuildCommand({ repoDir, cwd: dir,
    command: await resolveExpoBin(dir), args: applyExpoExportMaxWorkersArgs(args, exportEnv),
    env: exportEnv, admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, captureStdout: false, stdoutStream: process.stderr });
}

export async function ensureWebUiDependencies({
  uiDir,
  env = process.env,
  ensureDepsInstalledImpl = ensureDepsInstalled,
}) {
  // Declare full web preparation before PM inspects shared UI outputs, so
  // every phase consumes the same task/input identity and repair owner.
  await ensureDepsInstalledImpl(uiDir, 'happier-ui', {
    env: { ...env, HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY: '0' },
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
  repoDir,
  payloadDir,
  env,
  artifactFingerprint,
  expoExecImpl = runPreparedWebExport,
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
      repoDir,
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

    await assertWebArtifactPayload({ payloadDir: stagingDir, entrypoint: 'index.html' });
    await precompressUiWebAssets({ dir: stagingDir });
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
  target = { platform: process.platform, arch: process.arch },
  stalePackages = [],
  forceRebuild = false,
  env = process.env,
  ensureDepsInstalledImpl = ensureDepsInstalled,
  expoExecImpl = runPreparedWebExport,
}) {
  void forceRebuild;
  const existing = await readReusableArtifactManifest({ artifactDir, artifactFingerprint });
  if (existing) {
    return { artifactDir, manifest: existing };
  }

  const uiDir = getComponentDir(rootDir, 'happier-ui', env);
  await requireDir('happier-ui', uiDir);
  await ensureWebUiDependencies({ uiDir, env, ensureDepsInstalledImpl });

  await buildIntoTempThenReplace(artifactDir, async (tmpArtifactDir) => {
    const payloadDir = artifactPayloadDir(tmpArtifactDir);
    const repoDir = join(uiDir, '../..');
    const entrypoint = expoExecImpl === runPreparedWebExport
      ? JSON.parse(await runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
        args: [JSON.stringify({ uiDir, payloadDir, artifactFingerprint })], env,
        admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, captureStderr: true }))
      : await consumeWebArtifactInputs({ uiDir, payloadDir, artifactFingerprint, env, expoExecImpl });

    await writeArtifactManifest({
      artifactDir: tmpArtifactDir,
      manifest: {
        version: 1,
        component: 'web',
        target,
        artifactFingerprint,
        sourceFingerprint: sourceMetadata.sourceFingerprint,
        createdAt: sourceMetadata.builtAt,
        source: sourceMetadata,
        ...(stalePackages.length ? { stalePackages } : {}),
        payloadDir: 'payload',
        entrypoint,
      },
    });
  });

  const manifest = await readArtifactManifest({ artifactDir });
  return { artifactDir, manifest };
}

async function consumeWebArtifactInputs({ uiDir, payloadDir, artifactFingerprint, env, expoExecImpl = runPreparedWebExport }) {
  const repoDir = join(uiDir, '../..');
  const paths = getExpoStatePaths({
    baseDir: getDefaultAutostartPaths(env).baseDir,
    kind: 'ui-export-runtime-artifact',
    projectDir: uiDir,
    stateFileName: 'ui.export.runtime.state.json',
  });
  return await withBuildInputDependencies({ sourceDir: repoDir, env }, env =>
    withSourceWebUiInputs({ repoDir, baseDir: paths.stateDir, env, stdoutStream: process.stderr }, async ({ inventoryPath, uiProjectDir }) => {
      const exportEnv = buildStackWebExportEnv({ baseEnv: {
        ...env, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath,
      } });
      const tmpDir = resolveExpoTmpDir({ env: exportEnv, defaultTmpDir: paths.tmpDir, kind: 'ui-export-runtime-artifact', projectDir: uiDir });
      await ensureExpoIsolationEnv({ env: exportEnv, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir });
      return await exportWebPayloadToArtifactPayloadDir({ uiDir: uiProjectDir, repoDir, payloadDir, env: exportEnv, artifactFingerprint, expoExecImpl });
    }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = JSON.parse(process.argv[2]);
  console.log = (...values) => console.error(...values);
  const entrypoint = await consumeWebArtifactInputs({ ...options, env: process.env });
  process.stdout.write(JSON.stringify(entrypoint));
}
