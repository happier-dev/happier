import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent as ensureWorkspacePackagesBuiltForComponentDefault } from '../../stack/scripts/utils/proc/pm.mjs';

function normalizeTargetTriple(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  return value.length > 0 ? value : null;
}

export function resolveHostTauriTargetTriple({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    if (arch === 'x64') return 'x86_64-apple-darwin';
    return null;
  }

  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
    return null;
  }

  if (platform === 'linux') {
    if (arch === 'arm64') return 'aarch64-unknown-linux-gnu';
    if (arch === 'x64') return 'x86_64-unknown-linux-gnu';
    return null;
  }

  return null;
}

export function resolveTauriSidecarBinaryFilename(env = process.env) {
  const targetTriple = normalizeTargetTriple(env.TAURI_ENV_TARGET_TRIPLE ?? env.TARGET)
    ?? resolveHostTauriTargetTriple();
  if (!targetTriple) {
    return process.platform === 'win32' ? 'hsetup.exe' : 'hsetup';
  }
  return targetTriple.includes('windows')
    ? `hsetup-${targetTriple}.exe`
    : `hsetup-${targetTriple}`;
}

function resolveBootstrapBinaryFilename(env = process.env) {
  const targetTriple = normalizeTargetTriple(env.TAURI_ENV_TARGET_TRIPLE ?? env.TARGET);
  return targetTriple?.includes('windows') ? 'hsetup.exe' : 'hsetup';
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

export async function ensureTauriSidecarBinaryFile({
  env = process.env,
  srcTauriDir = join(uiDir, 'src-tauri'),
  bootstrapDistBinDir = join(bootstrapDir, 'dist', 'bin'),
  cpImpl = cp,
} = {}) {
  const sourcePath = join(bootstrapDistBinDir, resolveBootstrapBinaryFilename(env));
  const targetPath = join(srcTauriDir, 'binaries', resolveTauriSidecarBinaryFilename(env));
  const targetDir = dirname(targetPath);

  await mkdir(targetDir, { recursive: true });
  await cpImpl(sourcePath, targetPath, { force: true });
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
  ensureTauriSidecarBinaryFileImpl = ensureTauriSidecarBinaryFile,
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

  await ensureTauriSidecarBinaryFileImpl({
    env: nextEnv,
    srcTauriDir: join(uiDir, 'src-tauri'),
    bootstrapDistBinDir: join(bootstrapDir, 'dist', 'bin'),
  });
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
