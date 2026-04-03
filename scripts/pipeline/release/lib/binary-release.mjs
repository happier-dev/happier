// @ts-check

import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadCliCommonDistModule } from '../../../../scripts/ensureCliCommonDistModule.mjs';
import { listPublicReleaseRingCatalogEntries, normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

const {
  CLI_BINARY_TARGETS,
  SERVER_BINARY_TARGETS,
  buildCliBinaryArtifactPayload,
  buildServerBinaryArtifactPayload,
  commandExists,
  compileBunBinary,
  ensureFileExists,
  execOrThrow,
  resolveYarnCommand,
} = await loadCliCommonDistModule({
  repoRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
  subpath: 'componentArtifacts',
});

export {
  buildCliBinaryArtifactPayload,
  buildServerBinaryArtifactPayload,
  commandExists,
  compileBunBinary,
  ensureFileExists,
  execOrThrow,
  resolveYarnCommand,
};

export const RELEASE_CHANNELS = new Set(listPublicReleaseRingCatalogEntries().map((entry) => entry.id));

export const CLI_STACK_TARGETS = CLI_BINARY_TARGETS;
export const SERVER_TARGETS = SERVER_BINARY_TARGETS;

let _isGnuTar = null;

export function parseArgs(argv) {
  const kv = new Map();
  const flags = new Set();
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (arg.includes('=')) {
      const idx = arg.indexOf('=');
      kv.set(arg.slice(0, idx), arg.slice(idx + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      kv.set(arg, next);
      i += 1;
      continue;
    }
    flags.add(arg);
  }
  return { kv, flags, positionals };
}

export async function ensureCleanDir(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

export async function fileSha256(path) {
  const targetPath = String(path ?? '').trim();
  // Release packaging often runs on developer machines where file providers (or aggressive AV) can
  // briefly delay visibility of newly created archives. Treat ENOENT as a short, retryable condition.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const bytes = await readFile(targetPath);
      return createHash('sha256').update(bytes).digest('hex');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
      if (code === 'ENOENT' && attempt < 9) {
        await delay(50);
        continue;
      }
      throw error;
    }
  }
  // unreachable: loop always returns or throws
}

export async function createDeterministicArchive({ artifactPath, sourcePath, sourceName }) {
  await mkdir(dirname(artifactPath), { recursive: true });
  if (_isGnuTar == null) {
    const version = spawnSync('tar', ['--version'], { encoding: 'utf-8' });
    const stdout = String(version.stdout ?? '');
    _isGnuTar = stdout.includes('GNU tar');
  }
  // AppleDouble metadata (files prefixed with `._`) can appear in staging directories (and can even be
  // checked into repos). Always exclude them to keep archives deterministic and avoid shipping junk.
  const excludeArgs = [
    '--exclude=._*',
    '--exclude=*/._*',
    // @prisma/client includes a nested node_modules used for tooling shims. It is not required at runtime,
    // and excluding it avoids flaky tar walks when file providers or tooling mutate it during packaging.
    '--exclude=*/node_modules/@prisma/client/node_modules',
    '--exclude=*/node_modules/@prisma/client/node_modules/*',
  ];
  if (_isGnuTar) {
    await execTarWithRetry([
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      ...excludeArgs,
      '-czf',
      artifactPath,
      '-C',
      sourcePath,
      sourceName,
    ]);
    return;
  }
  await execTarWithRetry([...excludeArgs, '-czf', artifactPath, '-C', sourcePath, sourceName]);
}

async function execTarWithRetry(args) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      execOrThrow('tar', args);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 2 && message.includes('tar exited with status')) {
        await delay(100 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

export async function writeChecksumsFile({ product, version, artifacts, outDir }) {
  const checksumsPath = join(outDir, `checksums-${product}-v${version}.txt`);
  const lines = [];
  for (const artifact of artifacts) {
    const hash = await fileSha256(artifact.path);
    lines.push(`${hash}  ${artifact.name}`);
  }
  await writeFile(checksumsPath, `${lines.join('\n')}\n`, 'utf-8');
  return checksumsPath;
}

export async function maybeSignFile({ path, trustedComment = '' }) {
  const keyRaw = String(process.env.MINISIGN_SECRET_KEY ?? '').trim();
  if (!keyRaw) return null;
  if (!commandExists('minisign')) {
    throw new Error('[release] MINISIGN_SECRET_KEY is set but minisign is not installed');
  }
  const preparedKey = await prepareMinisignSecretKeyFile(keyRaw);
  const sigPath = `${path}.minisig`;
  const hasPassphrase = Object.prototype.hasOwnProperty.call(process.env, 'MINISIGN_PASSPHRASE');
  const passphrase = String(process.env.MINISIGN_PASSPHRASE ?? '');
  const keyPath = preparedKey.path;
  const args = ['-S', '-s', keyPath, '-m', path, '-x', sigPath];
  if (trustedComment) {
    args.push('-t', trustedComment);
  }
  try {
    execOrThrow('minisign', args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      // Support empty passphrases (operators sometimes intentionally leave the key unencrypted).
      // If the env var is present, always feed a newline to avoid minisign prompting/hanging.
      input: hasPassphrase ? `${passphrase}\n` : undefined,
    });
  } finally {
    if (preparedKey.temp) {
      await rm(preparedKey.cleanupPath ?? keyPath, { recursive: true, force: true });
    }
  }
  return sigPath;
}

export async function prepareMinisignSecretKeyFile(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new Error('[release] MINISIGN_SECRET_KEY is empty');
  }

  // minisign secret keys are multi-line. When operators try to paste them into dotenv files,
  // only the first line often survives, leading to confusing minisign errors later.
  if (value.startsWith('untrusted comment:') && !/[\r\n]/.test(value)) {
    throw new Error(
      '[release] MINISIGN_SECRET_KEY looks truncated (dotenv files cannot reliably store multiline minisign keys). ' +
        'Set MINISIGN_SECRET_KEY to a file path containing the full secret key, or load it via Keychain secrets.',
    );
  }
  const looksLikePath = !value.includes('\n') && !value.includes('\r');
  if (looksLikePath) {
    const info = await stat(value).catch(() => null);
    if (info?.isFile()) {
      return { path: value, temp: false, cleanupPath: null };
    }

    // If this looks like a path but doesn't exist, fail fast with guidance instead of writing
    // an invalid one-line key file and letting minisign error later.
    if (value.includes('/') || value.includes('\\') || value.endsWith('.key')) {
      throw new Error(`[release] MINISIGN_SECRET_KEY points to a missing file: ${value}`);
    }
    if (value.length < 128) {
      throw new Error(
        '[release] MINISIGN_SECRET_KEY looks truncated (dotenv files cannot reliably store multiline minisign keys). ' +
          'Set MINISIGN_SECRET_KEY to a file path containing the full secret key, or load it via Keychain secrets.',
      );
    }
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'happier-minisign-key-'));
  const keyPath = join(tempDir, 'release.key');
  await writeFile(keyPath, `${value.endsWith('\n') ? value : `${value}\n`}`, 'utf-8');
  await chmodBestEffort600(keyPath);
  return { path: keyPath, temp: true, cleanupPath: tempDir };
}

async function chmodBestEffort600(path) {
  try {
    execOrThrow('chmod', ['600', path], { stdio: 'ignore' });
  } catch {
    // ignore on platforms where chmod is unavailable
  }
}

export function readVersionFromPackageJson(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const version = String(raw?.version ?? '').trim();
  if (!version) {
    throw new Error(`[release] package version missing in ${path}`);
  }
  return version;
}

export async function packageTargetBinary({
  product,
  version,
  target,
  executableName,
  buildTempDir,
  outDir,
  compiledPath,
  additionalStageEntries = [],
}) {
  const exeName = `${executableName}${target.exeExt}`;
  const artifactStem = `${product}-v${version}-${target.os}-${target.arch}`;
  const stageDir = join(buildTempDir, artifactStem);
  await ensureCleanDir(stageDir);
  await cp(compiledPath, join(stageDir, exeName));
  for (const entry of additionalStageEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const sourcePath = String(entry.sourcePath ?? '').trim();
    const targetPath = String(entry.targetPath ?? '').trim();
    if (!sourcePath || !targetPath) continue;
    await cp(sourcePath, join(stageDir, targetPath), { recursive: true });
  }
  const archiveName = `${artifactStem}.tar.gz`;
  const archivePath = join(outDir, archiveName);
  await createDeterministicArchive({
    artifactPath: archivePath,
    sourcePath: buildTempDir,
    sourceName: artifactStem,
  });
  return { name: archiveName, path: archivePath, os: target.os, arch: target.arch };
}

export async function packagePreparedTargetBinary({
  product,
  version,
  target,
  stageDir,
  outDir,
}) {
  const artifactStem = `${product}-v${version}-${target.os}-${target.arch}`;
  const archiveName = `${artifactStem}.tar.gz`;
  const archivePath = join(outDir, archiveName);
  await createDeterministicArchive({
    artifactPath: archivePath,
    sourcePath: dirname(stageDir),
    sourceName: artifactStem,
  });
  return { name: archiveName, path: archivePath, os: target.os, arch: target.arch };
}

export function parseCsv(raw) {
  return String(raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function resolveTargets({ availableTargets, requested }) {
  const allTargets = Array.isArray(availableTargets) ? availableTargets : [];
  const requestedRaw = String(requested ?? '').trim();
  if (!requestedRaw) return allTargets;

  const requestedSet = new Set(
    requestedRaw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const selected = allTargets.filter((target) => requestedSet.has(`${target.os}-${target.arch}`));
  if (selected.length !== requestedSet.size) {
    const known = new Set(allTargets.map((target) => `${target.os}-${target.arch}`));
    const unknown = [...requestedSet].filter((target) => !known.has(target));
    throw new Error(`[release] unknown target(s): ${unknown.join(', ')}. Expected one of: ${[...known].join(', ')}`);
  }
  return selected;
}

export function normalizeChannel(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'stable';
  const normalized = normalizePublicReleaseRingId(value);
  if (!normalized || !RELEASE_CHANNELS.has(normalized)) {
    throw new Error(`[release] invalid channel: ${value} (expected stable|preview|dev)`);
  }
  return normalized;
}

export function resolveRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..');
}
