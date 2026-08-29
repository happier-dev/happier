import { spawnSync } from 'node:child_process';
import fs, { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

import { resolveWindowsCommandInvocation } from '../../../scripts/pipeline/lib/windows/resolveWindowsCommandInvocation.mjs';
import { sanitizePackageArtifactEnv } from '../../../scripts/pipeline/npm/sanitize-package-artifact-env.mjs';
import { assertCliManagedRuntimeTarballPublication } from '../../../scripts/pipeline/npm/cli-managed-runtime-tarball.mjs';
import { createWorkspaceChildBuildEnv } from '../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { readHappyCliRuntimeInputFreshness } from '../../stack/scripts/utils/proc/cli_runtime_inputs.mjs';
import {
  bundleWorkspaceDeps as runCanonicalBundleWorkspaceDeps,
  loadCliCommonWorkspacesModule,
} from './bundleWorkspaceDeps.mjs';
import { readCliDistBuildManifest } from './finalizeDist.mjs';
import { withOptionalCliSharedDepsBuildLock } from './optionalWorkspaceBundleLock.mjs';
import { resolveCliPackageRoot, syncPackageDist } from './syncPackageDist.mjs';

const require = createRequire(import.meta.url);
const { getCliRuntimeAssetArchiveManifest, RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME } = require('./unpack-tools.cjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO_ROOT = resolve(__dirname, '..', '..', '..');

const MAX_CAPTURED_OUTPUT_CHARS = 4000;
const DEFAULT_PACK_TARBALL_TIMEOUT_MS = 600_000;
const NPM_CACHE_ENV_KEY = 'npm_config_cache';
const IMPLICIT_NPM_PACKAGE_FILE_PATTERN = /^(?:changes|changelog|history|licen[cs]e|notice|readme)(?:[.-].*)?$/iu;
const MANAGED_RUNTIME_ARCHIVE_PREFIX = 'happier-cliproxyapi-managed-';
const MANAGED_RUNTIME_PUBLICATION_METADATA_VERSION = 1;

/**
 * Classifies the managed CLIProxyAPI runtime staging this pack will ship, from the
 * one runtime-asset manifest owner (`unpack-tools.cjs`). A complete-installable pack
 * binds the exact manifest set: every platform archive plus the runtime-asset
 * checksum manifest, with no unknown managed archive. Partial staging fails closed
 * here instead of advertising a managed launch path an install cannot satisfy; a
 * source checkout with no runtime-asset staging at all stays a legitimate developer
 * (source-only) pack and ships no managed runtime bytes or checksum manifest.
 */
export function resolveCliPackManagedRuntimeStaging({
  archivesDir,
  archiveManifest = getCliRuntimeAssetArchiveManifest(),
  checksumManifestName = RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME,
  exists = (candidatePath) => fs.existsSync(candidatePath),
  readdir = (candidatePath) => fs.readdirSync(candidatePath),
} = {}) {
  const manifestArchiveNames = archiveManifest.map((entry) => String(entry.archiveName));
  const stagedNames = exists(archivesDir) ? readdir(archivesDir) : [];
  const stagedArchiveNames = new Set(stagedNames);
  const stagedManagedArchiveNames = manifestArchiveNames.filter((archiveName) => stagedArchiveNames.has(archiveName));
  const missingArchiveNames = manifestArchiveNames.filter((archiveName) => !stagedArchiveNames.has(archiveName));
  const extraArchiveNames = stagedNames
    .filter((name) => name.startsWith(MANAGED_RUNTIME_ARCHIVE_PREFIX) && !manifestArchiveNames.includes(name))
    .sort();
  const checksumManifestPresent = stagedArchiveNames.has(checksumManifestName);
  const publicationClaimed = checksumManifestPresent
    || stagedManagedArchiveNames.length > 0
    || extraArchiveNames.length > 0;
  if (!publicationClaimed) {
    return {
      mode: 'source-only',
      missingArchiveNames: [...manifestArchiveNames],
      extraArchiveNames,
      checksumManifestPresent,
    };
  }
  if (
    missingArchiveNames.length > 0
    || !checksumManifestPresent
    || extraArchiveNames.length > 0
  ) {
    return {
      mode: 'incomplete',
      missingArchiveNames,
      extraArchiveNames,
      checksumManifestPresent,
    };
  }
  return {
    mode: 'complete',
    missingArchiveNames: [],
    extraArchiveNames: [],
    checksumManifestPresent,
  };
}

/**
 * Binds the packer's classification into the artifact itself. Runtime manifest
 * ingestion consumes this exact metadata, so a source-only developer tarball
 * cannot retain a managed provider facet whose packaged executable is absent.
 * Provider identity comes from the same runtime-asset manifest as the archive
 * set; this packer is the only producer.
 */
export function writeCliPackManagedRuntimePublicationMetadata({
  packageRoot,
  mode,
  archiveManifest = getCliRuntimeAssetArchiveManifest(),
} = {}) {
  if (mode !== 'source-only' && mode !== 'complete') {
    throw new Error(`[pack-tarball] Cannot publish unknown managed runtime mode: ${String(mode)}`);
  }
  const unavailableProviderRefs = [];
  if (mode === 'source-only') {
    const seen = new Set();
    for (const entry of archiveManifest) {
      const pluginId = String(entry?.managedProviderRef?.pluginId ?? '').trim();
      const providerId = String(entry?.managedProviderRef?.providerId ?? '').trim();
      if (!pluginId || !providerId) {
        throw new Error(
          `[pack-tarball] Runtime asset '${String(entry?.asset ?? entry?.archiveName ?? '')}' has no managed provider reference`,
        );
      }
      const key = `${pluginId}\u0000${providerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unavailableProviderRefs.push(Object.freeze({ pluginId, providerId }));
    }
  }
  const packageJsonPath = resolve(packageRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const happier = packageJson?.happier && typeof packageJson.happier === 'object' && !Array.isArray(packageJson.happier)
    ? packageJson.happier
    : {};
  const metadata = Object.freeze({
    v: MANAGED_RUNTIME_PUBLICATION_METADATA_VERSION,
    mode,
    unavailableProviderRefs: Object.freeze(unavailableProviderRefs),
  });
  fs.writeFileSync(packageJsonPath, `${JSON.stringify({
    ...packageJson,
    happier: { ...happier, managedRuntimePublication: metadata },
  }, null, 2)}\n`, 'utf8');
  return metadata;
}

function formatCliPackManagedRuntimeStagingFailure(archivesDir, staging) {
  return [
    `[pack-tarball] Incomplete managed CLI runtime staging in ${archivesDir}: the package claims a managed `,
    'CLIProxyAPI runtime, so the pack must bind the exact applicable archives and checksums.',
    ...(staging.missingArchiveNames.length > 0
      ? [`missing archives: ${staging.missingArchiveNames.join(', ')}`]
      : []),
    ...(staging.extraArchiveNames.length > 0
      ? [`unexpected managed archives: ${staging.extraArchiveNames.join(', ')}`]
      : []),
    ...(!staging.checksumManifestPresent ? ['missing checksum manifest: checksums.runtime-assets.sha256'] : []),
    '',
    'Fix: stage the complete managed runtime through node scripts/stageManagedRuntimeArchives.mjs, or',
    'remove the partial staging to produce a source-only developer pack without managed runtime bytes.',
  ].join('\n');
}

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

/**
 * A CLI tarball ships the build twice: `dist/` (what the compiler wrote, and what
 * `assertCliPackInputCurrentness` proves current against source) and `package-dist/`
 * (the published runtime closure `syncPackageDist` promotes from it). Only `dist` was
 * ever checked, so a skipped or failed promotion published one tarball carrying two
 * different source states — `HAPPIER_CLI_SKIP_PACKAGE_DIST_SYNC` survives artifact env
 * sanitization and returns from the sync silently.
 *
 * Both directories carry the same `.build-manifest.json` the one build-manifest producer
 * wrote, so requiring the two recorded identities to agree settles the publication on one
 * closure using the fingerprints that already exist. This is not a second registry: it
 * reads the canonical manifest through the canonical reader and records nothing.
 */
export function assertCliPublicationClosureIdentity({
  packageRoot,
  readBuildManifest = readCliDistBuildManifest,
}) {
  const readClosureIdentity = (directoryName) => {
    const result = readBuildManifest(resolve(packageRoot, directoryName, 'index.mjs'));
    if (!result?.ok) {
      throw new Error(
        `[pack-tarball] CLI ${directoryName} publication closure is unavailable: ${result?.reason ?? 'unknown'}`,
      );
    }
    return {
      fingerprint: String(result.manifest?.fingerprint ?? '').trim().toLowerCase(),
      inputFingerprint: String(result.manifest?.inputFingerprint ?? '').trim().toLowerCase(),
    };
  };

  const distIdentity = readClosureIdentity('dist');
  const packageDistIdentity = readClosureIdentity('package-dist');
  for (const field of ['fingerprint', 'inputFingerprint']) {
    if (distIdentity[field] === packageDistIdentity[field]) continue;
    throw new Error(
      `[pack-tarball] CLI publication closure is split: dist and package-dist disagree on ${field} `
      + `(dist ${distIdentity[field] || '<missing>'}, package-dist ${packageDistIdentity[field] || '<missing>'}); `
      + 'the package closure was not promoted from this build',
    );
  }
  return distIdentity;
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
        artifactNodeModulesRoot: resolve(snapshotRoot, 'node_modules'),
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

function assertArtifactWorkspaceManifestSanitized({
  packageName,
  packagePath,
  artifactNodeModulesRoot,
}) {
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

  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isInternalWorkspacePackageName = (value) => {
    if (typeof value !== 'string' || value.trim() !== value || !value.startsWith('@happier-dev/')) {
      return false;
    }
    const packageSegments = value.split('/');
    return (
      packageSegments.length === 2
      && packageSegments[1] !== ''
      && packageSegments[1] !== '.'
      && packageSegments[1] !== '..'
      && !/[\\*?[\]{}]/u.test(packageSegments[1])
    );
  };
  const hasPrepublicationAuthoringMarker = (rawManifest) => {
    const publicSdkRelease = rawManifest?.happier?.publicSdkRelease;
    return (
      isRecord(rawManifest?.happier)
      && Object.keys(rawManifest.happier).length === 1
      && Object.prototype.hasOwnProperty.call(rawManifest.happier, 'publicSdkRelease')
      && isRecord(publicSdkRelease)
      && publicSdkRelease.posture === 'prepublish_hold'
    );
  };
  const readFlatArtifactWorkspaceSiblingManifest = (dependencyName) => {
    const siblingPackagePath = resolve(artifactNodeModulesRoot, ...dependencyName.split('/'));
    const siblingPackageJsonPath = resolve(siblingPackagePath, 'package.json');
    try {
      const siblingPackageStats = lstatSync(siblingPackagePath);
      if (!siblingPackageStats.isDirectory() || siblingPackageStats.isSymbolicLink()) return null;
      const siblingManifest = JSON.parse(readFileSync(siblingPackageJsonPath, 'utf8'));
      return isRecord(siblingManifest) && siblingManifest.name === dependencyName
        ? siblingManifest
        : null;
    } catch {
      return null;
    }
  };
  const preservesPrepublicationAuthoringMetadata = hasPrepublicationAuthoringMarker(rawPackageJson);
  const violations = [];
  if (rawPackageJson?.name !== packageName) {
    violations.push(`name=${JSON.stringify(rawPackageJson?.name)}`);
  }
  for (const forbiddenField of [
    'scripts',
    'devDependencies',
    'bundleDependencies',
    ...(preservesPrepublicationAuthoringMetadata ? [] : ['files']),
    ...(preservesPrepublicationAuthoringMetadata ? [] : ['bundledDependencies']),
  ]) {
    if (Object.prototype.hasOwnProperty.call(rawPackageJson ?? {}, forbiddenField)) {
      violations.push(forbiddenField);
    }
  }
  if (preservesPrepublicationAuthoringMetadata && rawPackageJson?.files !== undefined) {
    const declaredFiles = rawPackageJson.files;
    const declaredFileNames = new Set();
    let physicalPackagePath = '';
    try {
      physicalPackagePath = fs.realpathSync(packagePath);
    } catch {
      violations.push('files=unresolvable_package_root');
    }

    if (!Array.isArray(declaredFiles)) {
      violations.push('files=invalid');
    } else {
      for (const rawDeclaredFile of declaredFiles) {
        const declaredFile = typeof rawDeclaredFile === 'string' ? rawDeclaredFile : '';
        const segments = declaredFile.split('/');
        if (
          typeof rawDeclaredFile !== 'string'
          || !declaredFile
          || declaredFile.trim() !== declaredFile
          || declaredFile.includes('\\')
          || path.isAbsolute(declaredFile)
          || path.win32.isAbsolute(declaredFile)
          || segments.some((segment) => !segment || segment === '.' || segment === '..')
          || /[*?{}[\]]/u.test(declaredFile)
          || declaredFileNames.has(declaredFile)
        ) {
          violations.push(`files=${JSON.stringify(rawDeclaredFile)}`);
          continue;
        }
        declaredFileNames.add(declaredFile);
        if (!physicalPackagePath) continue;

        const declaredFilePath = resolve(packagePath, ...segments);
        const lexicalRelativePath = path.relative(packagePath, declaredFilePath);
        if (
          lexicalRelativePath === '..'
          || lexicalRelativePath.startsWith(`..${path.sep}`)
          || path.isAbsolute(lexicalRelativePath)
        ) {
          violations.push(`files=${JSON.stringify(rawDeclaredFile)}`);
          continue;
        }
        try {
          const declaredFileStats = lstatSync(declaredFilePath);
          if (declaredFileStats.isSymbolicLink() || (!declaredFileStats.isFile() && !declaredFileStats.isDirectory())) {
            throw new Error('not a physical regular file or directory');
          }
          const physicalDeclaredFilePath = fs.realpathSync(declaredFilePath);
          const physicalRelativePath = path.relative(physicalPackagePath, physicalDeclaredFilePath);
          if (
            physicalRelativePath === '..'
            || physicalRelativePath.startsWith(`..${path.sep}`)
            || path.isAbsolute(physicalRelativePath)
          ) {
            throw new Error('escapes the package root');
          }
        } catch {
          violations.push(`files=${JSON.stringify(rawDeclaredFile)}=missing_or_uncontained`);
        }
      }
    }
  }
  const declaredInternalDependencyNames = new Set();
  for (const dependencyField of ['dependencies', 'optionalDependencies']) {
    const declaredDependencies = rawPackageJson?.[dependencyField];
    if (preservesPrepublicationAuthoringMetadata && declaredDependencies !== undefined) {
      if (!isRecord(declaredDependencies)) {
        violations.push(`${dependencyField}=invalid`);
        continue;
      }
      for (const [dependencyName, dependencyVersion] of Object.entries(declaredDependencies)) {
        if (typeof dependencyVersion !== 'string' || !dependencyVersion.trim()) {
          violations.push(`${dependencyField}.${dependencyName}=invalid`);
        }
        if (dependencyName.startsWith('@happier-dev/')) {
          if (!isInternalWorkspacePackageName(dependencyName)) {
            violations.push(`${dependencyField}.${dependencyName}=invalid`);
          } else {
            declaredInternalDependencyNames.add(dependencyName);
          }
        }
      }
      continue;
    }
    const internalDependencyNames = Object.keys(declaredDependencies ?? {}).filter((dependencyName) =>
      dependencyName.startsWith('@happier-dev/'));
    if (internalDependencyNames.length > 0) {
      violations.push(`${dependencyField}=${internalDependencyNames.join(',')}`);
    }
  }
  if (preservesPrepublicationAuthoringMetadata) {
    const bundledDependencies = rawPackageJson?.bundledDependencies;
    const declaredBundledDependencyNames = new Set();
    if (!Array.isArray(bundledDependencies)) {
      violations.push('bundledDependencies=invalid');
    } else {
      for (const rawDependencyName of bundledDependencies) {
        const dependencyName = typeof rawDependencyName === 'string' ? rawDependencyName : '';
        if (
          !isInternalWorkspacePackageName(dependencyName)
          || declaredBundledDependencyNames.has(dependencyName)
          || !declaredInternalDependencyNames.has(dependencyName)
        ) {
          violations.push(`bundledDependencies=${JSON.stringify(rawDependencyName)}`);
          continue;
        }
        declaredBundledDependencyNames.add(dependencyName);
      }
    }
    for (const dependencyName of declaredInternalDependencyNames) {
      const siblingManifest = readFlatArtifactWorkspaceSiblingManifest(dependencyName);
      if (declaredBundledDependencyNames.has(dependencyName)) {
        if (!siblingManifest) {
          violations.push(`bundledDependencies.${dependencyName}=missing_flat_sibling`);
        }
      } else if (!siblingManifest || !hasPrepublicationAuthoringMarker(siblingManifest)) {
        violations.push(`internalDependency.${dependencyName}=unclassified`);
      }
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
  const assertPublicationClosureIdentity =
    options.assertPublicationClosureIdentityImpl ?? assertCliPublicationClosureIdentity;
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

  const assertManagedRuntimePublication =
    options.assertCliManagedRuntimePublicationImpl ?? assertCliManagedRuntimeTarballPublication;
  const resolveManagedRuntimeStaging = options.resolveCliPackManagedRuntimeStagingImpl ?? resolveCliPackManagedRuntimeStaging;
  const timeoutMs = resolvePackTarballTimeoutMs(env, options.timeoutMs);
  const explicitNpmCacheDirInput = String(options.npmCacheDir ?? '').trim();
  const explicitNpmCacheDir = explicitNpmCacheDirInput ? resolve(explicitNpmCacheDirInput) : '';
  const ownsNpmCacheDir = !explicitNpmCacheDir;
  const npmCacheDir = explicitNpmCacheDir || fs.mkdtempSync(path.join(ownedTempRoot, 'happier-npm-cache-'));

  let packError;
  let snapshotContainer = '';
  let snapshotRoot = '';
  let managedRuntimePublicationBound = false;
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
      assertPublicationClosureIdentity({ packageRoot });
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
      const staging = resolveManagedRuntimeStaging({
        archivesDir: resolve(snapshotRoot, 'tools', 'archives'),
      });
      if (staging.mode === 'incomplete') {
        throw new Error(formatCliPackManagedRuntimeStagingFailure(resolve(packageRoot, 'tools', 'archives'), staging));
      }
      // A source-only developer pack stays available: it ships no managed runtime
      // bytes and no runtime-asset checksum manifest, so the installed CLI never
      // advertises staged managed archives it does not carry.
      if (staging.mode === 'complete') {
        managedRuntimePublicationBound = true;
      }
      writeCliPackManagedRuntimePublicationMetadata({
        packageRoot: snapshotRoot,
        mode: staging.mode,
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

    // The complete-installable claim is bound here, from the real packed bytes, by
    // the one publication assertion release preparation and admission also consume:
    // exact archives, exact checksums, no extra managed runtime bytes. There is no
    // caller flag that skips it; the only way out is to not stage managed runtime.
    if (managedRuntimePublicationBound) {
      assertManagedRuntimePublication(tarballPath);
    }

    return {
      packageRoot,
      tarballName,
      tarballPath,
      managedRuntimePublication: managedRuntimePublicationBound ? 'complete' : 'source-only',
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
