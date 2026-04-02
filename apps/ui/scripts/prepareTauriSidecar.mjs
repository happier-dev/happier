import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault } from '../../stack/scripts/utils/proc/pm.mjs';

function normalizeTargetTriple(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  return value.length > 0 ? value : null;
}

export function resolveBunTargetForTauriBuildEnv(env = process.env) {
  const targetTriple = normalizeTargetTriple(env.TAURI_ENV_TARGET_TRIPLE ?? env.TARGET);
  if (!targetTriple) {
    return null;
  }

  if (targetTriple.includes('apple-darwin')) {
    if (targetTriple.startsWith('aarch64-')) return 'bun-darwin-arm64';
    if (targetTriple.startsWith('x86_64-')) return 'bun-darwin-x64';
  }

  if (targetTriple.includes('windows')) {
    if (targetTriple.startsWith('x86_64-')) return 'bun-windows-x64';
    return null;
  }

  if (targetTriple.includes('linux')) {
    if (targetTriple.startsWith('aarch64-')) return 'bun-linux-arm64';
    if (targetTriple.startsWith('x86_64-')) return 'bun-linux-x64-baseline';
  }

  return null;
}

const tauriWatcherIgnoreEntry = 'binaries/';

export function resolveTauriWatcherIgnoreContent(existingContent = '') {
  const lines = String(existingContent ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd());

  if (lines.some((line) => line.trim() === tauriWatcherIgnoreEntry)) {
    return null;
  }

  const nextContent = lines.filter((line) => line.length > 0).join('\n');
  return `${nextContent ? `${nextContent}\n` : ''}${tauriWatcherIgnoreEntry}\n`;
}

export async function ensureTauriWatcherIgnoreFile({
  srcTauriDir = join(uiDir, 'src-tauri'),
  readFileImpl = readFile,
  writeFileImpl = writeFile,
} = {}) {
  const ignoreFilePath = join(srcTauriDir, '.taurignore');
  let currentContent = '';

  try {
    currentContent = await readFileImpl(ignoreFilePath, 'utf8');
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const nextContent = resolveTauriWatcherIgnoreContent(currentContent);
  if (nextContent == null) {
    return ignoreFilePath;
  }

  await writeFileImpl(ignoreFilePath, nextContent, 'utf8');
  return ignoreFilePath;
}

export async function ensureTauriSidecarEntrypointFile({
  srcTauriDir = join(uiDir, 'src-tauri'),
  bootstrapDistBinDir = join(bootstrapDir, 'dist', 'bin'),
  readFileImpl = readFile,
  writeFileImpl = writeFile,
} = {}) {
  const sourcePath = join(bootstrapDistBinDir, 'hsetup.js');
  const targetPath = join(srcTauriDir, 'binaries', 'hsetup.js');
  const targetDir = dirname(targetPath);

  await mkdir(targetDir, { recursive: true });
  const sourceContent = await readFileImpl(sourcePath, 'utf8');
  await writeFileImpl(targetPath, sourceContent, 'utf8');
  return targetPath;
}

export async function ensureTauriSidecarRuntimeFiles({
  srcTauriDir = join(uiDir, 'src-tauri'),
  bootstrapDistDir = join(bootstrapDir, 'dist'),
  cpImpl = cp,
} = {}) {
  await mkdir(srcTauriDir, { recursive: true });

  const copiedTargets = [];
  for (const relativeDir of ['systemTasks', 'ssh', join('integrations', 'tailscale')]) {
    const sourcePath = join(bootstrapDistDir, relativeDir);
    const targetPath = join(srcTauriDir, relativeDir);
    await cpImpl(sourcePath, targetPath, { recursive: true, force: true });
    copiedTargets.push(targetPath);
  }

  return copiedTargets;
}

const uiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(uiDir));
const bootstrapDir = join(repoRoot, 'apps', 'bootstrap');

export async function prepareTauriSidecar({
  env = process.env,
  platform = process.platform,
  ensureWorkspacePackagesBuiltForComponent = ensureWorkspacePackagesBuiltForComponentDefault,
  ensureTauriSidecarEntrypointFileImpl = ensureTauriSidecarEntrypointFile,
  ensureTauriSidecarRuntimeFilesImpl = ensureTauriSidecarRuntimeFiles,
  spawnSyncImpl = spawnSync,
} = {}) {
  await ensureWorkspacePackagesBuiltForComponent(uiDir, { quiet: false, env });
  await ensureWorkspacePackagesBuiltForComponent(bootstrapDir, { quiet: false, env });
  await ensureTauriWatcherIgnoreFile();

  const bunTarget = resolveBunTargetForTauriBuildEnv(env);
  const nextEnv = {
    ...env,
    ...(bunTarget ? { HAPPIER_BUN_TARGET: bunTarget } : {}),
  };

  const result = spawnSyncImpl(
    'yarn',
    ['-s', 'workspace', '@happier-dev/bootstrap', 'build:binary'],
    {
      stdio: 'inherit',
      env: nextEnv,
      cwd: repoRoot,
      ...(platform === 'win32' ? { shell: true } : {}),
    },
  );

  if (result.error) {
    throw result.error;
  }

  await ensureTauriSidecarRuntimeFilesImpl({
    srcTauriDir: join(uiDir, 'src-tauri'),
    bootstrapDistDir: join(bootstrapDir, 'dist'),
  });
  await ensureTauriSidecarEntrypointFileImpl({
    srcTauriDir: join(uiDir, 'src-tauri'),
    bootstrapDistBinDir: join(bootstrapDir, 'dist', 'bin'),
  });
  return result.status ?? 1;
}

async function run() {
  process.exit(await prepareTauriSidecar());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    throw error;
  });
}
