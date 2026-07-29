import { spawnSync } from 'node:child_process';
import fs, { cpSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveWindowsCommandInvocation } from '../../../scripts/pipeline/lib/windows/resolveWindowsCommandInvocation.mjs';
import { sanitizePackageArtifactEnv } from '../../../scripts/pipeline/npm/sanitize-package-artifact-env.mjs';
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { readHappyCliRuntimeInputFreshness } from '../../stack/scripts/utils/proc/cli_runtime_inputs.mjs';
import {
  bundleWorkspaceDeps as runCanonicalBundleWorkspaceDeps,
  loadCliCommonWorkspacesModule,
} from './bundleWorkspaceDeps.mjs';
import { readCliDistBuildManifest } from './finalizeDist.mjs';
import { withOptionalCliSharedDepsBuildLock } from './optionalWorkspaceBundleLock.mjs';
import { resolveCliPackageRoot, syncPackageDist } from './syncPackageDist.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO_ROOT = resolve(__dirname, '..', '..', '..');

const MAX_CAPTURED_OUTPUT_CHARS = 4000;
const DEFAULT_PACK_TARBALL_TIMEOUT_MS = 600_000;
const NPM_CACHE_ENV_KEY = 'npm_config_cache';
const IMPLICIT_NPM_PACKAGE_FILE_PATTERN = /^(?:changes|changelog|history|licen[cs]e|notice|readme)(?:[.-].*)?$/iu;

function resolvePackTarballTimeoutMs(env, explicitTimeoutMs) {
  if (typeof explicitTimeoutMs === 'number' && Number.isFinite(explicitTimeoutMs)) {
    return Math.min(1_800_000, Math.max(30_000, Math.trunc(explicitTimeoutMs)));
  }
  const raw = String(env?.HAPPIER_CLI_PACK_TARBALL_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_PACK_TARBALL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PACK_TARBALL_TIMEOUT_MS;
  return Math.min(1_800_000, Math.max(30_000, parsed));
}

function resolveNpmInvocation(
  platform = process.platform,
  processExecPath = process.execPath,
  exists = fs.existsSync,
) {
  const nodeExecPath = String(processExecPath ?? '').trim();
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (!nodeExecPath || !platformPath.isAbsolute(nodeExecPath)) {
    throw new Error('[pack-tarball] active Node executable path must be absolute');
  }

  const nodeBinDir = platformPath.dirname(nodeExecPath);
  const homebrewPrefix = nodeExecPath.match(
    /^(.*)\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin\/node$/u,
  )?.[1];
  const npmCliCandidates = platform === 'win32'
    ? [platformPath.join(nodeBinDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [
        platformPath.resolve(nodeBinDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ...(homebrewPrefix
          ? [
              platformPath.resolve(
                homebrewPrefix,
                'lib',
                'node_modules',
                'npm',
                'bin',
                'npm-cli.js',
              ),
            ]
          : []),
      ];
  const npmCliFromNode = npmCliCandidates.find((candidatePath) => exists(candidatePath));
  if (!npmCliFromNode) {
    throw new Error(
      `[pack-tarball] npm CLI owned by the active Node runtime is unavailable: ${npmCliCandidates.join(', ')}`,
    );
  }

  return {
    command: nodeExecPath,
    args: [npmCliFromNode],
  };
}

function parseTarballName(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return '';

  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return '';
  const candidate = lines[0];
  const isAbsolutePath = path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
  if (/\s/u.test(candidate) && !isAbsolutePath) return '';
  if (/[\u0000-\u001f\u007f-\u009f"'{}[\]]/u.test(candidate)) return '';
  if (!candidate.toLowerCase().endsWith('.tgz')) return '';
  return candidate;
}

function truncate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.length <= MAX_CAPTURED_OUTPUT_CHARS) return raw;
  return `${raw.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n…(truncated ${raw.length - MAX_CAPTURED_OUTPUT_CHARS} chars)`;
}

function formatSpawnFailure({ packageRoot, npmInvocation, packArgs, result }) {
  const stdout = truncate(result?.stdout);
  const stderr = truncate(result?.stderr);
  const status = typeof result?.status === 'number' ? result.status : 'null';
  const signal = result?.signal ?? 'null';
  const errorMessage = result?.error ? String(result.error?.message ?? result.error) : '';
  const invocationPrintable = [npmInvocation.command, ...packArgs]
    .map((arg) => (String(arg).includes(' ') ? JSON.stringify(String(arg)) : String(arg)))
    .join(' ');

  return [
    `[pack-tarball] npm pack failed`,
    `cwd: ${packageRoot}`,
    `invocation: ${invocationPrintable}`,
    `status: ${status}`,
    `signal: ${signal}`,
    ...(errorMessage ? [`error: ${errorMessage}`] : []),
    ...(stdout ? [`stdout:\n${stdout}`] : []),
    ...(stderr ? [`stderr:\n${stderr}`] : []),
  ].join('\n');
}

function setCanonicalEnvValue(env, canonicalKey, value) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === canonicalKey.toLowerCase()) {
      delete env[key];
    }
  }
  env[canonicalKey] = value;
}

function isDescendantPath(parentPath, candidatePath) {
  const relativeToParent = path.relative(parentPath, candidatePath);
  return relativeToParent !== ''
    && relativeToParent !== '..'
    && !relativeToParent.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeToParent);
}

function resolveOwnedCacheTempRoot({ packageRoot, destDir, tmpdir }) {
  const canonicalTempRoot = fs.realpathSync(resolve(String(tmpdir())));
  const canonicalSourceRoots = new Set([
    fs.realpathSync(packageRoot),
    fs.realpathSync(destDir),
  ]);
  for (const canonicalSourceRoot of canonicalSourceRoots) {
    if (canonicalTempRoot === canonicalSourceRoot || isDescendantPath(canonicalSourceRoot, canonicalTempRoot)) {
      throw new Error(
        `[pack-tarball] npm cache temporary directory must be outside the package and destination source trees: ${canonicalTempRoot}`,
      );
    }
  }
  return canonicalTempRoot;
}

function resolveOwnedTarballPath(destDir, tarballName) {
  const destination = resolve(destDir);
  const rawTarballPath = String(tarballName ?? '').trim();
  const usesForeignAbsolutePathSyntax = path.sep === '/'
    && path.win32.isAbsolute(rawTarballPath)
    && !path.isAbsolute(rawTarballPath);
  if (usesForeignAbsolutePathSyntax) {
    throw new Error(
      `[pack-tarball] npm pack reported a tarball outside the requested destination: ${JSON.stringify(rawTarballPath)} (destination: ${destination})`,
    );
  }

  const alternateSeparator = path.sep === '/' ? '\\' : '/';
  const separatorNormalizedPath = rawTarballPath.replaceAll(alternateSeparator, path.sep);
  const tarballPath = path.isAbsolute(separatorNormalizedPath)
    ? path.normalize(separatorNormalizedPath)
    : resolve(destination, separatorNormalizedPath);
  if (!isDescendantPath(destination, tarballPath)) {
    throw new Error(
      `[pack-tarball] npm pack reported a tarball outside the requested destination: ${JSON.stringify(rawTarballPath)} (destination: ${destination})`,
    );
  }

  return tarballPath;
}

function assertOwnedTarballArtifact(destDir, tarballName, tarballPath) {
  const destination = resolve(destDir);
  const canonicalDestination = fs.realpathSync(destination);
  const canonicalTarballPath = fs.realpathSync(tarballPath);
  if (!isDescendantPath(canonicalDestination, canonicalTarballPath)) {
    throw new Error(
      `[pack-tarball] npm pack reported a tarball outside the requested destination: ${JSON.stringify(tarballName)} (destination: ${destination})`,
    );
  }

  const relativeTarballPath = path.relative(destination, tarballPath);
  let currentPath = destination;
  let tarballStat = null;
  for (const pathSegment of relativeTarballPath.split(path.sep)) {
    currentPath = path.join(currentPath, pathSegment);
    tarballStat = fs.lstatSync(currentPath);
    if (tarballStat.isSymbolicLink()) {
      throw new Error(
        `[pack-tarball] tarball output must be a direct regular file without symbolic links: ${tarballPath}`,
      );
    }
  }
  if (!tarballStat?.isFile()) {
    throw new Error(`[pack-tarball] tarball output is not a regular file: ${tarballPath}`);
  }
}

function setFunctionOption(target, key, value) {
  if (typeof value === 'function') {
    target[key] = value;
  }
}

async function bundleWorkspaceDepsForPack({ packageRoot, publicationMode, env, lockPath, repoRoot: explicitRepoRoot }) {
  const repoRoot = explicitRepoRoot ?? resolve(packageRoot, '..', '..');
  await runCanonicalBundleWorkspaceDeps({
    repoRoot,
    happyCliDir: packageRoot,
    publicationMode,
    env,
    lockPath,
  });
}

function readDeclaredBundledDependencyNames(rawPackageJson) {
  const bundledDependencies = Array.isArray(rawPackageJson?.bundledDependencies)
    ? rawPackageJson.bundledDependencies
    : Array.isArray(rawPackageJson?.bundleDependencies)
      ? rawPackageJson.bundleDependencies
      : [];
  return bundledDependencies.map((rawPackageName) => {
    const packageName = String(rawPackageName ?? '').trim();
    const packageSegments = packageName.split('/');
    const validSegmentCount = packageName.startsWith('@')
      ? packageSegments.length === 2
      : packageSegments.length === 1;
    if (
      !packageName
      || !validSegmentCount
      || packageSegments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\*?[\]{}]/u.test(segment))
    ) {
      throw new Error(`[pack-tarball] invalid declared bundled dependency: ${JSON.stringify(rawPackageName)}`);
    }
    return packageName;
  });
}

export async function assertCliPackInputCurrentness({
  packageRoot,
  readRuntimeInputFreshness = readHappyCliRuntimeInputFreshness,
}) {
  const distEntrypoint = resolve(packageRoot, 'dist', 'index.mjs');
  const distManifest = readCliDistBuildManifest(distEntrypoint);
  if (!distManifest.ok) {
    throw new Error(
      `[pack-tarball] CLI dist input currentness is unavailable: ${distManifest.reason}`,
    );
  }
  const recordedInputFingerprint = String(
    distManifest.manifest?.inputFingerprint ?? '',
  ).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(recordedInputFingerprint)) {
    throw new Error('[pack-tarball] CLI dist manifest is missing a canonical runtime input fingerprint');
  }
  const currentInputFreshness = await readRuntimeInputFreshness(packageRoot);
  const currentInputFingerprint = String(
    currentInputFreshness?.fingerprint ?? '',
  ).trim().toLowerCase();
  if (!currentInputFingerprint) {
    throw new Error('[pack-tarball] unable to read the current CLI runtime input fingerprint');
  }
  if (currentInputFingerprint !== recordedInputFingerprint) {
    throw new Error(
      `[pack-tarball] CLI dist runtime input fingerprint does not match current inputs `
      + `(recorded ${recordedInputFingerprint}, current ${currentInputFingerprint})`,
    );
  }
  return recordedInputFingerprint;
}

function resolvePackSnapshotEntries(packageRoot, { includeBundledDependencies = true } = {}) {
  const packageJsonPath = resolve(packageRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return [];

  const rawPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const entries = new Set(['package.json']);
  const requiredBundledEntries = new Map();
  for (const rawEntry of Array.isArray(rawPackageJson?.files) ? rawPackageJson.files : []) {
    const normalizedEntry = String(rawEntry ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '');
    const firstWildcardIndex = normalizedEntry.search(/[*?[\]{}]/u);
    const selectedPrefix = (firstWildcardIndex < 0
      ? normalizedEntry
      : normalizedEntry.slice(0, firstWildcardIndex)).replace(/\/+$/u, '');
    const segments = selectedPrefix.split('/');
    if (
      !selectedPrefix
      || path.isAbsolute(selectedPrefix)
      || path.win32.isAbsolute(selectedPrefix)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || selectedPrefix === 'node_modules'
      || selectedPrefix.startsWith('node_modules/')
    ) continue;
    entries.add(selectedPrefix);
  }
  for (const packageName of readDeclaredBundledDependencyNames(rawPackageJson)) {
    requiredBundledEntries.set(`node_modules/${packageName}`, packageName);
  }
  for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
    if (entry.isFile() && IMPLICIT_NPM_PACKAGE_FILE_PATTERN.test(entry.name)) {
      entries.add(entry.name);
    }
  }
  const selectedEntries = [];
  for (const entry of [...entries].sort((a, b) => {
    const depthDelta = a.split('/').length - b.split('/').length;
    return depthDelta || a.localeCompare(b);
  })) {
    if (selectedEntries.some((parent) => entry === parent || entry.startsWith(`${parent}/`))) continue;
    selectedEntries.push(entry);
  }
  return [
    ...selectedEntries.map((relativePath) => ({ relativePath, requiredBundledDependency: null })),
    ...(includeBundledDependencies
      ? [...requiredBundledEntries].map(([relativePath, requiredBundledDependency]) => ({
          relativePath,
          requiredBundledDependency,
        }))
      : []),
  ];
}

function createPackSnapshot({ packageRoot, ownedTempRoot, includeBundledDependencies = true }) {
  const snapshotContainer = fs.mkdtempSync(path.join(ownedTempRoot, 'happier-cli-pack-snapshot-'));
  const snapshotRoot = resolve(snapshotContainer, 'package');
  try {
    mkdirSync(snapshotRoot, { recursive: true });
    for (const { relativePath, requiredBundledDependency } of resolvePackSnapshotEntries(
      packageRoot,
      { includeBundledDependencies },
    )) {
      const sourcePath = resolve(packageRoot, relativePath);
      if (!fs.existsSync(sourcePath)) {
        if (requiredBundledDependency) {
          throw new Error(
            `[pack-tarball] missing declared bundled dependency: ${requiredBundledDependency} (${sourcePath})`,
          );
        }
        continue;
      }
      const targetPath = resolve(snapshotRoot, relativePath);
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath, {
        recursive: lstatSync(sourcePath).isDirectory(),
      });
    }
  } catch (error) {
    rmSync(snapshotContainer, { recursive: true, force: true });
    throw error;
  }
  return { snapshotContainer, snapshotRoot };
}

async function bundleNonWorkspaceBundledDependencies({
  packageRoot,
  snapshotRoot,
  sourceRepoRoot,
  env,
  loadCliCommonWorkspacesModuleImpl,
  ensureWorkspacePackagesBuiltByName,
}) {
  const packageJsonPath = resolve(packageRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return;
  const rawPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const bundledDependencies = readDeclaredBundledDependencyNames(rawPackageJson);
  const nonWorkspaceBundledDependencies = bundledDependencies.filter(
    (packageName) => !packageName.startsWith('@happier-dev/'),
  );
  let bundleInstalledPackageWithRuntimeDependencies;
  if (nonWorkspaceBundledDependencies.length > 0) {
    const cliCommonWorkspaces = await loadCliCommonWorkspacesModuleImpl(
      SCRIPT_REPO_ROOT,
      env,
      ensureWorkspacePackagesBuiltByName,
      { includeDevDependencies: false },
    );
    bundleInstalledPackageWithRuntimeDependencies =
      cliCommonWorkspaces?.bundleInstalledPackageWithRuntimeDependencies;
    if (typeof bundleInstalledPackageWithRuntimeDependencies !== 'function') {
      throw new Error(
        '[pack-tarball] cli-common workspaces module is missing bundleInstalledPackageWithRuntimeDependencies()',
      );
    }
  }
  const physicalSourceRepoRoot = fs.realpathSync(sourceRepoRoot);
  const assertPhysicalSourceContained = ({ errorPrefix, sourcePath }) => {
    const physicalSourcePath = fs.realpathSync(sourcePath);
    const relativeSourcePath = path.relative(physicalSourceRepoRoot, physicalSourcePath);
    if (
      relativeSourcePath === '..'
      || relativeSourcePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeSourcePath)
    ) {
      throw new Error(`${errorPrefix} (${physicalSourcePath})`);
    }
  };
  const validateResolvedPackage = ({ packageName, packageDir }) => {
    assertPhysicalSourceContained({
      errorPrefix:
        `[pack-tarball] bundled dependency resolved outside the source repository: ${packageName}`,
      sourcePath: packageDir,
    });
  };
  for (const rawPackageName of bundledDependencies) {
    const packageName = String(rawPackageName ?? '').trim();
    const relativePath = `node_modules/${packageName}`;
    const snapshotPackagePath = resolve(snapshotRoot, relativePath);
    if (packageName.startsWith('@happier-dev/')) {
      if (!fs.existsSync(snapshotPackagePath)) {
        throw new Error(
          `[pack-tarball] missing declared bundled dependency from artifact workspace publication: ${packageName} (${snapshotPackagePath})`,
        );
      }
      assertArtifactWorkspaceManifestSanitized({
        packageName,
        packagePath: snapshotPackagePath,
      });
      continue;
    }

    const declaredSpec = rawPackageJson?.dependencies?.[packageName]
      ?? rawPackageJson?.optionalDependencies?.[packageName];
    if (typeof declaredSpec !== 'string' || !declaredSpec.trim()) {
      throw new Error(
        `[pack-tarball] missing dependency declaration for bundled dependency: ${packageName}`,
      );
    }
    try {
      bundleInstalledPackageWithRuntimeDependencies({
        packageName,
        declaredSpec: declaredSpec.trim(),
        resolveFromPackageJsonPath: packageJsonPath,
        destNodeModulesDir: resolve(snapshotRoot, 'node_modules'),
        validateResolvedPackage,
        dereferenceRootDir: physicalSourceRepoRoot,
      });
    } catch (error) {
      if (
        error instanceof Error
        && error.message.startsWith('[pack-tarball] bundled dependency ')
      ) {
        throw error;
      }
      if (
        error instanceof Error
        && error.message.includes('outside the caller-approved root')
      ) {
        throw new Error(
          `[pack-tarball] bundled dependency resolved outside the source repository: ${error.message}`,
          { cause: error },
        );
      }
      if (
        error instanceof Error
        && error.message.startsWith('Resolved runtime dependency ')
      ) {
        throw new Error(
          `[pack-tarball] bundled dependency identity mismatch for ${packageName}: ${error.message}`,
          { cause: error },
        );
      }
      if (
        error instanceof Error
        && error.message.startsWith('Dereferenced symlink target escapes copy source root:')
      ) {
        throw new Error(`[pack-tarball] bundled dependency ${error.message}`, { cause: error });
      }
      throw new Error(
        `[pack-tarball] missing or invalid declared bundled dependency: ${packageName}`,
        { cause: error },
      );
    }
  }
}

function assertArtifactWorkspaceManifestSanitized({ packageName, packagePath }) {
  const packageJsonPath = resolve(packagePath, 'package.json');
  let rawPackageJson;
  try {
    rawPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `[pack-tarball] unsanitized artifact workspace publication for ${packageName}: unreadable package manifest (${packageJsonPath})`,
      { cause: error },
    );
  }

  const violations = [];
  if (rawPackageJson?.name !== packageName) {
    violations.push(`name=${JSON.stringify(rawPackageJson?.name)}`);
  }
  for (const forbiddenField of [
    'scripts',
    'devDependencies',
    'files',
    'bundledDependencies',
    'bundleDependencies',
  ]) {
    if (Object.prototype.hasOwnProperty.call(rawPackageJson ?? {}, forbiddenField)) {
      violations.push(forbiddenField);
    }
  }
  for (const dependencyField of ['dependencies', 'optionalDependencies']) {
    const dependencyNames = Object.keys(rawPackageJson?.[dependencyField] ?? {});
    const internalDependencyNames = dependencyNames.filter((dependencyName) =>
      dependencyName.startsWith('@happier-dev/'));
    if (internalDependencyNames.length > 0) {
      violations.push(`${dependencyField}=${internalDependencyNames.join(',')}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `[pack-tarball] unsanitized artifact workspace publication for ${packageName}: ${violations.join('; ')} (${packageJsonPath})`,
    );
  }
}

export async function packTarball(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const sourceRepoRoot = resolve(String(options.repoRoot ?? resolve(packageRoot, '..', '..')));
  const spawn = options.spawnSync ?? spawnSync;
  const exists = options.existsSync ?? fs.existsSync;
  const bundleWorkspaceDeps = options.bundleWorkspaceDeps ?? bundleWorkspaceDepsForPack;
  const loadCliCommonWorkspacesModuleImpl =
    options.loadCliCommonWorkspacesModuleImpl ?? loadCliCommonWorkspacesModule;
  const assertInputCurrentness =
    options.assertInputCurrentnessImpl ?? assertCliPackInputCurrentness;
  const npmInvocation = options.npmInvocation ??
    resolveNpmInvocation(
      options.platform,
      options.processExecPath,
      options.npmCliExistsSync ?? fs.existsSync,
    );
  const destDirRaw = String(options.destDir ?? '').trim();
  const destDir = destDirRaw ? resolve(destDirRaw) : packageRoot;
  const env = sanitizePackageArtifactEnv({ ...process.env, ...(options.env ?? {}) });
  fs.mkdirSync(destDir, { recursive: true });
  const ownedTempRoot = resolveOwnedCacheTempRoot({
    packageRoot,
    destDir,
    tmpdir: options.tmpdir ?? os.tmpdir,
  });

  const syncPackageDistOptions = {
    packageRoot,
    repoRoot: sourceRepoRoot,
    lockPath: options.lockPath,
    distDir: options.distDir,
    packageDistDir: options.packageDistDir,
    existsSync: exists,
  };
  setFunctionOption(syncPackageDistOptions, 'cpSync', options.cpSync);
  setFunctionOption(syncPackageDistOptions, 'mkdirSync', options.mkdirSync);
  setFunctionOption(syncPackageDistOptions, 'renameSync', options.renameSync);
  setFunctionOption(syncPackageDistOptions, 'rmSync', options.rmSync);

  const timeoutMs = resolvePackTarballTimeoutMs(env, options.timeoutMs);
  const explicitNpmCacheDirInput = String(options.npmCacheDir ?? '').trim();
  const explicitNpmCacheDir = explicitNpmCacheDirInput ? resolve(explicitNpmCacheDirInput) : '';
  const ownsNpmCacheDir = !explicitNpmCacheDir;
  const npmCacheDir = explicitNpmCacheDir || fs.mkdtempSync(path.join(ownedTempRoot, 'happier-npm-cache-'));

  let packError;
  let snapshotContainer = '';
  let snapshotRoot = '';
  try {
    // Source-dev publication and artifact sanitization share this canonical lock. Copy the complete
    // npm-visible tree while it is held, then release it before the slower compression subprocess.
    await withOptionalCliSharedDepsBuildLock(async ({ heldLockValue } = {}) => {
      const heldLockEnv = createWorkspaceChildBuildEnv({ env, heldLockValue });
      await assertInputCurrentness({ packageRoot });
      syncPackageDist({
        ...syncPackageDistOptions,
        env: heldLockEnv,
        heldLockValue,
      });
      ({ snapshotContainer, snapshotRoot } = createPackSnapshot({
        packageRoot,
        ownedTempRoot,
        includeBundledDependencies: false,
      }));
      await bundleWorkspaceDeps({
        packageRoot: snapshotRoot,
        publicationMode: 'artifact',
        env: heldLockEnv,
        repoRoot: sourceRepoRoot,
        lockPath: options.lockPath,
      });
      await bundleNonWorkspaceBundledDependencies({
        packageRoot,
        snapshotRoot,
        sourceRepoRoot,
        env: heldLockEnv,
        loadCliCommonWorkspacesModuleImpl,
        ensureWorkspacePackagesBuiltByName: options.ensureWorkspacePackagesBuiltByName,
      });
      await assertInputCurrentness({ packageRoot });
    }, {
      startDir: packageRoot,
      repoRoot: sourceRepoRoot,
      lockPath: options.lockPath,
      env,
      lockTimeoutMs: options.lockTimeoutMs,
      lockPollIntervalMs: options.lockPollIntervalMs,
      lockStaleAfterMs: options.lockStaleAfterMs,
    });

    setCanonicalEnvValue(env, NPM_CACHE_ENV_KEY, npmCacheDir);
    fs.mkdirSync(npmCacheDir, { recursive: true });

    // `npm pack --json` includes the complete file inventory in stdout. The CLI artifact contains
    // tens of thousands of intentional bundled files, so spawnSync can hit its fixed capture limit
    // after npm has successfully written the tarball. Silent mode reports only the exact filename.
    const packArgs = [...npmInvocation.args, 'pack', '--silent', '--ignore-scripts', '--pack-destination', destDir];
    const resolveCommandInvocation = options.resolveCommandInvocation ?? resolveWindowsCommandInvocation;
    const commandInvocation = resolveCommandInvocation({
      command: npmInvocation.command,
      args: packArgs,
      env,
      resolveCommandOnPath: false,
    });
    const result = spawn(commandInvocation.command, commandInvocation.args, {
      cwd: snapshotRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsVerbatimArguments: commandInvocation.windowsVerbatimArguments,
    });

    if (result.status !== 0 || result.signal != null || result.error) {
      throw new Error(formatSpawnFailure({ packageRoot, npmInvocation, packArgs, result }));
    }

    const tarballName = parseTarballName(result.stdout);
    if (!tarballName) {
      throw new Error('[pack-tarball] npm pack did not report a tarball filename');
    }

    const tarballPath = resolveOwnedTarballPath(destDir, tarballName);
    if (path.extname(tarballPath).toLowerCase() !== '.tgz') {
      throw new Error(`[pack-tarball] npm pack reported a non-tarball output: ${tarballName}`);
    }
    if (!exists(tarballPath)) {
      throw new Error(`[pack-tarball] missing tarball output: ${tarballPath}`);
    }
    assertOwnedTarballArtifact(destDir, tarballName, tarballPath);

    return {
      packageRoot,
      tarballName,
      tarballPath,
    };
  } catch (error) {
    packError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (ownsNpmCacheDir) {
      try {
        fs.rmSync(npmCacheDir, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(new Error(
          `[pack-tarball] npm cache cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: cleanupError },
        ));
      }
    }
    if (snapshotContainer) {
      try {
        rmSync(snapshotContainer, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(new Error(
          `[pack-tarball] snapshot cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: cleanupError },
        ));
      }
    }
    if (cleanupErrors.length > 0) {
      if (packError !== undefined) {
        const primaryMessage = packError instanceof Error ? packError.message : String(packError);
        throw new AggregateError(
          [packError, ...cleanupErrors],
          `${primaryMessage}\n${cleanupErrors.map((error) => error.message).join('\n')}`,
          { cause: packError },
        );
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(cleanupErrors, cleanupErrors.map((error) => error.message).join('\n'));
    }
  }
}

function parseCliOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dest-dir': { type: 'string' },
      'npm-cache-dir': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    destDir: values['dest-dir'],
    npmCacheDir: values['npm-cache-dir'],
  };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    const { destDir, npmCacheDir } = parseCliOptions(process.argv.slice(2));
    const result = await packTarball({ destDir, npmCacheDir });
    console.log(result.tarballPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
