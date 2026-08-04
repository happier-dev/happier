// @ts-check

import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { loadCliCommonDistModule } from '../../../../scripts/ensureCliCommonDistModule.mjs';
import { listPublicReleaseRingCatalogEntries } from '@happier-dev/release-runtime/releaseRings';
import { fileSha256 } from './release-files.mjs';
import { maybeSignFile } from './minisign-signing.mjs';
import { normalizeChannel, parseArgs } from './release-arguments.mjs';

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
export { prepareMinisignSecretKeyFile } from './minisign-secret-key.mjs';
export { fileSha256 } from './release-files.mjs';
export { maybeSignFile } from './minisign-signing.mjs';
export { normalizeChannel, parseArgs } from './release-arguments.mjs';

export const RELEASE_CHANNELS = new Set(listPublicReleaseRingCatalogEntries().map((entry) => entry.id));

export const CLI_STACK_TARGETS = CLI_BINARY_TARGETS;
export const SERVER_TARGETS = SERVER_BINARY_TARGETS;

let _isGnuTar = null;

function resolveArchiveTarEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    COPYFILE_DISABLE: '1',
    COPY_EXTENDED_ATTRIBUTES_DISABLE: '1',
  };
}

const ARCHIVE_TIMEOUT_BASE_MS = 300_000;
const ARCHIVE_STATS_BYTES_BUCKET = 200 * 1024 * 1024;
const ARCHIVE_STATS_FILES_BUCKET = 10_000;
const ARCHIVE_TIMEOUT_MAX_MS = 1_800_000;
const ARCHIVE_TIMEOUT_MIN_MS = 60_000;
const GZIP_TIMEOUT_MIN_MS = 60_000;
const WINDOWS_SPLIT_ARCHIVE_BYTES_THRESHOLD = 512 * 1024 * 1024;
const WINDOWS_SPLIT_ARCHIVE_FILES_THRESHOLD = 20_000;
const ARCHIVE_BACKEND_TAR = 'tar';
const ARCHIVE_BACKEND_SPLIT = 'split-tar-gzip';
const ARCHIVE_BACKEND_NODE = 'node';

function clampMs(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

function resolveParentArchiveTimeoutBudgetMs(env = process.env) {
  const raw = String(env.HAPPIER_RELEASE_PARENT_TIMEOUT_MS ?? '').trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function shouldCollectArchiveStats({
  platform = process.platform,
  env = process.env,
} = {}) {
  const forcedRaw = String(env.HAPPIER_RELEASE_COLLECT_ARCHIVE_STATS ?? '').trim().toLowerCase();
  if (forcedRaw) {
    if (forcedRaw === '1' || forcedRaw === 'true' || forcedRaw === 'yes' || forcedRaw === 'on') {
      return true;
    }
    if (forcedRaw === '0' || forcedRaw === 'false' || forcedRaw === 'no' || forcedRaw === 'off') {
      return false;
    }
  }
  // Windows file providers/AV can make deep per-file stat walks very slow.
  // Skip adaptive stats collection by default there and rely on bounded budgets.
  return platform !== 'win32';
}

export async function ensureCleanDir(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

function resolveTarArchiveInvocation({ artifactPath, sourcePath, sourceName }) {
  const cwd = sourcePath;
  let artifactArg = relative(sourcePath, artifactPath);
  if (!artifactArg || artifactArg.trim().length === 0) {
    artifactArg = basename(artifactPath);
  }
  return {
    cwd,
    artifactArg: artifactArg.replaceAll('\\', '/'),
    sourceDirArg: '.',
    sourceNameArg: sourceName,
  };
}

async function collectArchiveStats(sourceRootPath) {
  const stack = [sourceRootPath];
  let fileCount = 0;
  let totalBytes = 0;

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) continue;
    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      fileCount += 1;
      const fileStats = await stat(entryPath).catch(() => null);
      if (fileStats?.isFile()) {
        totalBytes += Number(fileStats.size ?? 0);
      }
    }
  }

  return { fileCount, totalBytes };
}

function resolveAdaptiveArchiveTimeoutMs(archiveStats) {
  const totalBytes = Number(archiveStats?.totalBytes ?? 0);
  const fileCount = Number(archiveStats?.fileCount ?? 0);
  const byteBuckets = totalBytes > 0 ? Math.ceil(totalBytes / ARCHIVE_STATS_BYTES_BUCKET) : 0;
  const fileBuckets = fileCount > 0 ? Math.ceil(fileCount / ARCHIVE_STATS_FILES_BUCKET) : 0;
  const timeoutMs = ARCHIVE_TIMEOUT_BASE_MS
    + Math.min(12, byteBuckets) * 60_000
    + Math.min(12, fileBuckets) * 30_000;
  return clampMs(timeoutMs, { min: ARCHIVE_TIMEOUT_MIN_MS, max: ARCHIVE_TIMEOUT_MAX_MS });
}

function resolveTarTimeoutParentCapMs(env = process.env) {
  const parentBudgetMs = resolveParentArchiveTimeoutBudgetMs(env);
  if (!Number.isFinite(parentBudgetMs) || parentBudgetMs == null) {
    return null;
  }
  return clampMs(Math.floor(parentBudgetMs * 0.5), {
    min: ARCHIVE_TIMEOUT_MIN_MS,
    max: ARCHIVE_TIMEOUT_MAX_MS,
  });
}

function resolveGzipTimeoutParentCapMs(env = process.env) {
  const parentBudgetMs = resolveParentArchiveTimeoutBudgetMs(env);
  if (!Number.isFinite(parentBudgetMs) || parentBudgetMs == null) {
    return null;
  }
  return clampMs(Math.floor(parentBudgetMs * 0.25), {
    min: GZIP_TIMEOUT_MIN_MS,
    max: ARCHIVE_TIMEOUT_MAX_MS,
  });
}

function isTarTimeoutError(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
  if (code === 'ETIMEDOUT') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('ETIMEDOUT');
}

function resolveTarCreateArgs({ isGnuTar, excludeArgs, artifactArg, sourceDirArg, sourceNameArg, compressed }) {
  const modeArg = compressed ? '-czf' : '-cf';
  if (isGnuTar) {
    return [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      ...excludeArgs,
      modeArg,
      artifactArg,
      '-C',
      sourceDirArg,
      sourceNameArg,
    ];
  }
  return ['--no-mac-metadata', ...excludeArgs, modeArg, artifactArg, '-C', sourceDirArg, sourceNameArg];
}

export function resolveGzipExecutionTimeoutMs(env = process.env, archiveStats = null) {
  const raw = String(env.HAPPIER_RELEASE_GZIP_TIMEOUT_MS ?? '').trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return clampMs(parsed, { min: GZIP_TIMEOUT_MIN_MS, max: ARCHIVE_TIMEOUT_MAX_MS });
    }
  }
  const tarTimeoutMs = resolveTarExecutionTimeoutMs(env, archiveStats);
  const derived = clampMs(Math.floor(tarTimeoutMs * 0.75), { min: GZIP_TIMEOUT_MIN_MS, max: ARCHIVE_TIMEOUT_MAX_MS });
  const parentCapMs = resolveGzipTimeoutParentCapMs(env);
  if (parentCapMs == null) {
    return derived;
  }
  return Math.min(derived, parentCapMs);
}

async function createDeterministicGzipFromTar({
  uncompressedTarPath,
  compressedArtifactPath,
  timeoutMs,
}) {
  const sourceStream = createReadStream(uncompressedTarPath);
  const gzipStream = createGzip({ level: 6, mtime: 0 });
  const destinationStream = createWriteStream(compressedArtifactPath);
  let timedOut = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    const timeoutError = Object.assign(new Error(`[release] gzip archive step timed out after ${timeoutMs}ms`), {
      code: 'ETIMEDOUT',
    });
    sourceStream.destroy(timeoutError);
    gzipStream.destroy(timeoutError);
    destinationStream.destroy(timeoutError);
  }, timeoutMs);

  try {
    await pipeline(sourceStream, gzipStream, destinationStream);
  } catch (error) {
    if (timedOut || (error && typeof error === 'object' && 'code' in error && String(error.code ?? '') === 'ETIMEDOUT')) {
      const timeoutError = Object.assign(
        new Error(`[release] gzip archive step timed out after ${timeoutMs}ms`),
        { code: 'ETIMEDOUT' },
      );
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function shouldForceWindowsSplitArchive(env = process.env) {
  const raw = String(env.HAPPIER_RELEASE_WINDOWS_SPLIT_ARCHIVE ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return null;
}

function normalizeArchiveBackendOverride(raw) {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'tar') {
    return ARCHIVE_BACKEND_TAR;
  }
  if (normalized === 'split' || normalized === 'split-tar-gzip') {
    return ARCHIVE_BACKEND_SPLIT;
  }
  if (normalized === 'node' || normalized === 'node-tar') {
    return ARCHIVE_BACKEND_NODE;
  }
  return null;
}

export function resolveArchiveBackend({
  platform = process.platform,
  archiveStats = null,
  env = process.env,
} = {}) {
  const explicit = normalizeArchiveBackendOverride(env.HAPPIER_RELEASE_ARCHIVE_BACKEND);
  if (explicit) {
    return explicit;
  }
  if (platform === 'win32') {
    const forcedSplit = shouldForceWindowsSplitArchive(env);
    if (forcedSplit === true) {
      return ARCHIVE_BACKEND_SPLIT;
    }
    return ARCHIVE_BACKEND_NODE;
  }
  void archiveStats;
  return ARCHIVE_BACKEND_TAR;
}

export function shouldUseWindowsSplitTarGzip({
  platform = process.platform,
  archiveStats = null,
  env = process.env,
} = {}) {
  if (platform !== 'win32') {
    return false;
  }
  const forced = shouldForceWindowsSplitArchive(env);
  if (forced != null) {
    return forced;
  }
  const totalBytes = Number(archiveStats?.totalBytes ?? 0);
  const fileCount = Number(archiveStats?.fileCount ?? 0);
  if (totalBytes >= WINDOWS_SPLIT_ARCHIVE_BYTES_THRESHOLD
    || fileCount >= WINDOWS_SPLIT_ARCHIVE_FILES_THRESHOLD) {
    return true;
  }
  // Default to split mode on Windows because native tar.exe compression is the dominant
  // timeout source in installer-smoke and local-build packaging.
  return true;
}

export function resolveNodeArchiveExecutionTimeoutMs(env = process.env, archiveStats = null) {
  const raw = String(env.HAPPIER_RELEASE_NODE_ARCHIVE_TIMEOUT_MS ?? '').trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return clampMs(parsed, { min: ARCHIVE_TIMEOUT_MIN_MS, max: ARCHIVE_TIMEOUT_MAX_MS });
    }
  }
  return resolveTarExecutionTimeoutMs(env, archiveStats);
}

const NODE_ARCHIVE_HELPER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node-archive.mjs');

async function createArchiveViaNodeBackend({
  artifactPath,
  sourcePath,
  sourceName,
  archiveStats,
}) {
  const timeoutMs = resolveNodeArchiveExecutionTimeoutMs(process.env, archiveStats);
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      execOrThrow(
        process.execPath,
        [
          NODE_ARCHIVE_HELPER_PATH,
          '--source-path',
          sourcePath,
          '--source-name',
          sourceName,
          '--artifact-path',
          artifactPath,
        ],
        {
          env: process.env,
          timeoutMs,
        },
      );
      return;
    } catch (error) {
      if (attempt >= maxAttempts - 1 || !isTarTimeoutError(error)) {
        throw error;
      }
      await delay(500 * (attempt + 1));
    }
  }
}

async function createArchiveViaSplitTarGzip({
  artifactPath,
  sourcePath,
  sourceName,
  excludeArgs,
  archiveStats,
}) {
  const uncompressedTarPath = `${artifactPath}.tmp.tar`;
  const uncompressedInvocation = resolveTarArchiveInvocation({
    artifactPath: uncompressedTarPath,
    sourcePath,
    sourceName,
  });
  const uncompressedTarArgs = resolveTarCreateArgs({
    isGnuTar: _isGnuTar,
    excludeArgs,
    artifactArg: uncompressedInvocation.artifactArg,
    sourceDirArg: uncompressedInvocation.sourceDirArg,
    sourceNameArg: uncompressedInvocation.sourceNameArg,
    compressed: false,
  });

  await rm(uncompressedTarPath, { force: true }).catch(() => {});
  await execTarWithRetry(uncompressedTarArgs, {
    cwd: uncompressedInvocation.cwd,
    archiveStats,
    maxAttempts: 3,
    retryOnTimeout: false,
  });

  try {
    await createDeterministicGzipFromTar({
      uncompressedTarPath,
      compressedArtifactPath: artifactPath,
      timeoutMs: resolveGzipExecutionTimeoutMs(process.env, archiveStats),
    });
  } finally {
    await rm(uncompressedTarPath, { force: true }).catch(() => {});
  }
}

export async function createDeterministicArchive({ artifactPath, sourcePath, sourceName }) {
  await mkdir(dirname(artifactPath), { recursive: true });
  const tarInvocation = resolveTarArchiveInvocation({ artifactPath, sourcePath, sourceName });
  const archiveStats = shouldCollectArchiveStats({
    platform: process.platform,
    env: process.env,
  })
    ? await collectArchiveStats(join(tarInvocation.cwd, tarInvocation.sourceNameArg))
    : null;
  const archiveBackend = resolveArchiveBackend({
    platform: process.platform,
    archiveStats,
    env: process.env,
  });

  if (archiveBackend === ARCHIVE_BACKEND_NODE) {
    await createArchiveViaNodeBackend({
      artifactPath,
      sourcePath,
      sourceName,
      archiveStats,
    });
    return;
  }

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

  const compressedTarArgs = resolveTarCreateArgs({
    isGnuTar: _isGnuTar,
    excludeArgs,
    artifactArg: tarInvocation.artifactArg,
    sourceDirArg: tarInvocation.sourceDirArg,
    sourceNameArg: tarInvocation.sourceNameArg,
    compressed: true,
  });

  const shouldUseSplitBackend = archiveBackend === ARCHIVE_BACKEND_SPLIT
    || (archiveBackend === ARCHIVE_BACKEND_TAR && shouldUseWindowsSplitTarGzip({
      platform: process.platform,
      archiveStats,
      env: process.env,
    }));

  if (shouldUseSplitBackend) {
    await createArchiveViaSplitTarGzip({
      artifactPath,
      sourcePath,
      sourceName,
      excludeArgs,
      archiveStats,
    });
    return;
  }

  try {
    await execTarWithRetry(compressedTarArgs, {
      cwd: tarInvocation.cwd,
      archiveStats,
      maxAttempts: 3,
      retryOnTimeout: false,
    });
    return;
  } catch (error) {
    if (process.platform !== 'win32' || !isTarTimeoutError(error)) {
      throw error;
    }
  }
  await createArchiveViaSplitTarGzip({
    artifactPath,
    sourcePath,
    sourceName,
    excludeArgs,
    archiveStats,
  });
}

function resolveTargetNodePlatform(target) {
  return target?.os === 'windows' ? 'win32' : String(target?.os ?? '').trim().toLowerCase();
}

function normalizePackageConstraintList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? '').trim().toLowerCase())
    .filter(Boolean);
}

function matchesPackageConstraintList(value, constraints) {
  if (constraints.length === 0) return true;

  const negative = new Set(constraints.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1)));
  if (negative.has(value)) {
    return false;
  }

  const positive = constraints.filter((entry) => !entry.startsWith('!'));
  if (positive.length === 0) {
    return true;
  }

  return positive.includes(value);
}

function packageDirMatchesTarget(packageJson, target) {
  const nodePlatform = resolveTargetNodePlatform(target);
  const targetArch = String(target?.arch ?? '').trim().toLowerCase();

  const osConstraints = normalizePackageConstraintList(packageJson?.os);
  if (!matchesPackageConstraintList(nodePlatform, osConstraints)) {
    return false;
  }

  const cpuConstraints = normalizePackageConstraintList(packageJson?.cpu);
  if (!matchesPackageConstraintList(targetArch, cpuConstraints)) {
    return false;
  }

  return true;
}

export async function sanitizePackagedNodeModulesTree(params) {
  const stageDir = String(params?.stageDir ?? '').trim();
  if (!stageDir) return;

  await prunePackagedTreeDirectory({
    directoryPath: stageDir,
    target: params.target,
    inNodeModulesTree: false,
  });
}

function isNestedNodeModulesBinDir(path) {
  return path.includes('/node_modules/.bin') || path.includes('\\node_modules\\.bin');
}

// Some packages bundle prebuilt native binaries for every supported platform/arch
// inside their own tree instead of splitting them into per-target
// optionalDependencies, so package.json os/cpu constraints alone can't prune them.
// Match known bundle root directories and drop the platform/arch combinations that
// don't match the packaging target.
//
// Two layouts are recognized:
//  - nested:  <root>/<platform>/<arch>/...            (e.g. onnxruntime-node)
//  - flat:    <root>/<platform>-<arch>/...             (e.g. node-pty, node-pty-prebuilt-multiarch)
const NESTED_BUNDLED_NATIVE_PLATFORM_ROOT_DIR_PATTERNS = [
  // onnxruntime-node: bin/napi-v<N>/<platform>/<arch>/...
  /\/node_modules\/onnxruntime-node\/bin\/napi-v\d+$/,
];

const FLAT_BUNDLED_NATIVE_PLATFORM_ROOT_DIR_PATTERNS = [
  // node-pty, @homebridge/node-pty-prebuilt-multiarch: prebuilds/<platform>-<arch>/...
  /\/node_modules\/(?:node-pty|@homebridge\/node-pty-prebuilt-multiarch)\/prebuilds$/,
  // bare-fs, bare-url, bare-os (nested under archiver -> tar-stream): prebuilds/<platform>-<arch>/...
  /\/node_modules\/bare-(?:fs|url|os)\/prebuilds$/,
];

// The independent per-package vendoring entry points (vendorBundledPackageRuntimeDependencies
// for apps/cli's own deps vs. bundleInstalledPackageWithRuntimeDependencies for each
// CLI_RUNTIME_EXTERNAL_PACKAGES package) don't share a "visited" set with each other, so a
// transitive dependency already present at the top-level node_modules can also get copied again
// into a nested package's own node_modules. These nested copies are confirmed exact duplicates
// (same version, byte-identical trees) of a package already present at the payload's top-level
// node_modules, so ordinary upward-walking Node/Bun module resolution finds the top-level copy
// once the nested duplicate is removed. Delete the whole nested directory outright.
const DUPLICATE_VENDORED_PACKAGE_DIR_PATTERNS = [
  // tar duplicated inside onnxruntime-node's own node_modules (only used by onnxruntime-node's
  // postinstall script, which never runs against the shipped prebuilt payload).
  /\/node_modules\/@huggingface\/transformers\/node_modules\/onnxruntime-node\/node_modules\/tar$/,
  // @modelcontextprotocol/sdk duplicated inside claude-agent-sdk's own node_modules.
  /\/node_modules\/@anthropic-ai\/claude-agent-sdk\/node_modules\/@modelcontextprotocol\/sdk$/,
];

function matchesAnyPattern(path, patterns) {
  const normalized = path.replaceAll('\\', '/');
  return patterns.some((pattern) => pattern.test(normalized));
}

async function pruneNestedBundledNativePlatformRootDir(params) {
  const targetNodePlatform = resolveTargetNodePlatform(params.target);
  const targetArch = String(params.target?.arch ?? '').trim().toLowerCase();
  const entries = await readdir(params.directoryPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const childPath = join(params.directoryPath, entry.name);

    if (!entry.isDirectory() || entry.name.toLowerCase() !== targetNodePlatform) {
      await rm(childPath, { recursive: true, force: true });
      continue;
    }

    const archEntries = await readdir(childPath, { withFileTypes: true }).catch(() => []);
    for (const archEntry of archEntries) {
      if (archEntry.isDirectory() && archEntry.name.toLowerCase() !== targetArch) {
        await rm(join(childPath, archEntry.name), { recursive: true, force: true });
      }
    }
  }
}

async function pruneFlatBundledNativePlatformRootDir(params) {
  const targetNodePlatform = resolveTargetNodePlatform(params.target);
  const targetArch = String(params.target?.arch ?? '').trim().toLowerCase();
  const targetDirName = `${targetNodePlatform}-${targetArch}`;
  const entries = await readdir(params.directoryPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.toLowerCase() !== targetDirName) {
      await rm(join(params.directoryPath, entry.name), { recursive: true, force: true });
    }
  }
}

async function prunePackageDistDualFormatDir(params) {
  const entries = await readdir(params.directoryPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const childPath = join(params.directoryPath, entry.name);
    if (entry.isDirectory()) {
      await prunePackageDistDualFormatDir({ directoryPath: childPath });
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.cjs')) {
      await rm(childPath, { force: true });
    }
  }
}

// ps-list bundles Windows-only fastlist helper binaries unconditionally (no os/cpu
// package.json gating), so they should be stripped whenever the packaging target
// isn't Windows.
const WINDOWS_ONLY_VENDOR_EXECUTABLE_PATTERNS = [
  /\/node_modules\/ps-list\/vendor\/.*\.exe$/i,
];

async function prunePackagedTreeDirectory(params) {
  const entries = await readdir(params.directoryPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      const childPath = join(params.directoryPath, entry.name);
      if (
        params.target?.os !== 'windows' &&
        matchesAnyPattern(childPath, WINDOWS_ONLY_VENDOR_EXECUTABLE_PATTERNS)
      ) {
        await rm(childPath, { force: true });
      }
      continue;
    }

    const childPath = join(params.directoryPath, entry.name);
    const childInNodeModulesTree = params.inNodeModulesTree || entry.name === 'node_modules';

    if (entry.name === '.bin' && childInNodeModulesTree && isNestedNodeModulesBinDir(childPath)) {
      await rm(childPath, { recursive: true, force: true });
      continue;
    }

    if (entry.name === 'package-dist') {
      await prunePackageDistDualFormatDir({ directoryPath: childPath });
      continue;
    }

    if (childInNodeModulesTree) {
      const packageJsonPath = join(childPath, 'package.json');
      const packageJson = await readFile(packageJsonPath, 'utf-8')
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      if (packageJson && !packageDirMatchesTarget(packageJson, params.target)) {
        await rm(childPath, { recursive: true, force: true });
        continue;
      }
    }

    if (matchesAnyPattern(childPath, NESTED_BUNDLED_NATIVE_PLATFORM_ROOT_DIR_PATTERNS)) {
      await pruneNestedBundledNativePlatformRootDir({ directoryPath: childPath, target: params.target });
      continue;
    }

    if (matchesAnyPattern(childPath, FLAT_BUNDLED_NATIVE_PLATFORM_ROOT_DIR_PATTERNS)) {
      await pruneFlatBundledNativePlatformRootDir({ directoryPath: childPath, target: params.target });
      continue;
    }

    if (matchesAnyPattern(childPath, DUPLICATE_VENDORED_PACKAGE_DIR_PATTERNS)) {
      await rm(childPath, { recursive: true, force: true });
      continue;
    }

    await prunePackagedTreeDirectory({
      directoryPath: childPath,
      target: params.target,
      inNodeModulesTree: childInNodeModulesTree,
    });
  }
}

export function resolveTarExecutionTimeoutMs(env = process.env, archiveStats = null) {
  const raw = String(env.HAPPIER_RELEASE_TAR_TIMEOUT_MS ?? '').trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return clampMs(parsed, { min: ARCHIVE_TIMEOUT_MIN_MS, max: ARCHIVE_TIMEOUT_MAX_MS });
    }
  }
  const adaptive = resolveAdaptiveArchiveTimeoutMs(archiveStats);
  const parentCapMs = resolveTarTimeoutParentCapMs(env);
  if (parentCapMs == null) {
    return adaptive;
  }
  return Math.min(adaptive, parentCapMs);
}

async function execTarWithRetry(args, options = {}) {
  const timeoutMs = resolveTarExecutionTimeoutMs(options.env ?? process.env, options.archiveStats ?? null);
  const maxAttempts = Number.isFinite(Number(options.maxAttempts)) ? Math.max(1, Number(options.maxAttempts)) : 3;
  const retryOnTimeout = options.retryOnTimeout !== false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      execOrThrow('tar', args, {
        ...options,
        env: resolveArchiveTarEnv(options.env ?? process.env),
        timeoutMs,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const timeoutError = isTarTimeoutError(error);
      const shouldRetryTimeout = retryOnTimeout && timeoutError;
      if (attempt < maxAttempts - 1 && (message.includes('tar exited with status') || shouldRetryTimeout)) {
        const backoffMs = timeoutError ? 500 * (attempt + 1) : 100 * (attempt + 1);
        await delay(backoffMs);
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
  await sanitizePackagedNodeModulesTree({ stageDir, target });
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
  await sanitizePackagedNodeModulesTree({ stageDir, target });
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

export function resolveRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..');
}
