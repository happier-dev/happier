import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const RELEASE_CHANNELS = new Set(['stable', 'preview']);

export const CLI_STACK_TARGETS = [
  { bunTarget: 'bun-linux-x64', os: 'linux', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
  { bunTarget: 'bun-darwin-x64', os: 'darwin', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64', exeExt: '' },
  { bunTarget: 'bun-windows-x64', os: 'windows', arch: 'x64', exeExt: '.exe' },
];

export const SERVER_TARGETS = [
  { bunTarget: 'bun-linux-x64', os: 'linux', arch: 'x64', exeExt: '' },
  { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
];

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

export function execOrThrow(cmd, args, { cwd = process.cwd(), env = process.env, stdio = 'inherit', input } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    stdio,
    encoding: 'utf-8',
    input,
  });
  if (result.error) {
    throw new Error(`[release] failed to run ${cmd}: ${String(result.error.message || result.error)}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`[release] ${cmd} exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }
  return result;
}

export function commandExists(cmd) {
  const result = spawnSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' });
  return (result.status ?? 1) === 0;
}

export function resolveYarnCommand({ commandProbe } = {}) {
  const probe = typeof commandProbe === 'function' ? commandProbe : commandExists;
  if (probe('yarn')) {
    return { cmd: 'yarn', args: [] };
  }
  if (probe('corepack')) {
    return { cmd: 'corepack', args: ['yarn'] };
  }
  throw new Error('[release] building CLI binaries requires yarn or corepack (corepack yarn)');
}

export async function ensureCleanDir(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

export async function fileSha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function ensureFileExists(path) {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) {
    throw new Error(`[release] expected file to exist: ${path}`);
  }
}

export async function createDeterministicArchive({ artifactPath, sourcePath, sourceName }) {
  await mkdir(dirname(artifactPath), { recursive: true });
  if (_isGnuTar == null) {
    const version = spawnSync('tar', ['--version'], { encoding: 'utf-8' });
    const stdout = String(version.stdout ?? '');
    _isGnuTar = stdout.includes('GNU tar');
  }
  if (_isGnuTar) {
    execOrThrow('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', artifactPath, '-C', sourcePath, sourceName]);
    return;
  }
  execOrThrow('tar', ['-czf', artifactPath, '-C', sourcePath, sourceName]);
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
  const passphrase = String(process.env.MINISIGN_PASSPHRASE ?? '');
  const keyPath = preparedKey.path;
  const args = ['-S', '-s', keyPath, '-m', path, '-x', sigPath];
  if (trustedComment) {
    args.push('-t', trustedComment);
  }
  try {
    execOrThrow('minisign', args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      input: passphrase ? `${passphrase}\n` : undefined,
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
  const looksLikePath = !value.includes('\n') && !value.includes('\r');
  if (looksLikePath) {
    const info = await stat(value).catch(() => null);
    if (info?.isFile()) {
      return { path: value, temp: false, cleanupPath: null };
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

export async function compileBunBinary({ entrypoint, bunTarget, outfile, cwd = process.cwd(), externals = [] }) {
  const args = ['build', '--compile', `--target=${bunTarget}`, entrypoint, '--outfile', outfile];
  for (const ext of externals) {
    const e = String(ext ?? '').trim();
    if (!e) continue;
    args.push('--external', e);
  }
  execOrThrow('bun', args, { cwd });
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
  if (!RELEASE_CHANNELS.has(value)) {
    throw new Error(`[release] invalid channel: ${value} (expected stable|preview)`);
  }
  return value;
}

export function resolveRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}
