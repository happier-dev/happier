import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { pathExists } from '../fs/fs.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { coerceHappyMonorepoRootFromPath, getHappyStacksHomeDir } from '../paths/paths.mjs';
import { withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';
import { collectWorkspacePackageJsonPaths } from './workspace_package_manifests.mjs';
import { resolveCliDistBuildLockPath, withCliDistBuildLock } from './cliDistBuildLock.mjs';

const REFRESH_STATE_VERSION = 5;
const REFRESH_MARKER = '.happier-stack-dependencies-ready';
const DEPENDENCY_INSTALL_MODE = 'development-full-v1';

function installDirLockKey(installDir) {
  return createHash('sha256').update(resolve(installDir), 'utf-8').digest('hex');
}

function resolveDependencyRefreshLockPath(installDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(installDir);
  if (monorepoRoot && resolve(monorepoRoot) === resolve(installDir)) {
    return join(monorepoRoot, '.project', 'tmp', 'dependency-install.lock');
  }
  return join(getHappyStacksHomeDir(), 'cache', 'dependencies', `${installDirLockKey(installDir)}.lock`);
}

async function collectPatchPaths(installDir) {
  const patchesDir = join(installDir, 'patches');
  if (!(await pathExists(patchesDir))) return [];
  try {
    const entries = await readdir(patchesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.patch'))
      .map((entry) => join(patchesDir, entry.name));
  } catch {
    return [];
  }
}

async function collectDependencyInputPaths({ installDir, componentDir }) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  const workspaceManifests = monorepoRoot && resolve(installDir) === resolve(monorepoRoot)
    ? await collectWorkspacePackageJsonPaths(monorepoRoot)
    : resolve(installDir) === resolve(componentDir)
      ? []
      : [join(componentDir, 'package.json')];
  const manifestPaths = Array.from(new Set([
    join(installDir, 'package.json'),
    ...(resolve(installDir) === resolve(componentDir) ? [join(componentDir, 'package.json')] : []),
    ...workspaceManifests,
  ].map((path) => resolve(path))));
  const declaredInputs = [];
  for (const manifestPath of manifestPaths) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(manifestPath, 'utf-8'));
    } catch {
      continue;
    }
    const entries = pkg?.happier?.installFreshnessInputs;
    if (entries == null) continue;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new Error(`Invalid happier.installFreshnessInputs in ${manifestPath}: expected non-empty relative path strings`);
    }
    const packageDir = dirname(manifestPath);
    for (const entry of entries) {
      if (isAbsolute(entry)) {
        throw new Error(`Invalid happier.installFreshnessInputs entry in ${manifestPath}: paths must be package-relative`);
      }
      const inputPath = resolve(packageDir, entry);
      const outside = relative(packageDir, inputPath);
      if (outside === '..' || outside.startsWith(`..${sep}`)) {
        throw new Error(`Invalid happier.installFreshnessInputs entry in ${manifestPath}: paths must stay inside the package`);
      }
      declaredInputs.push(inputPath);
    }
  }
  return Array.from(new Set([
    join(installDir, 'yarn.lock'),
    join(installDir, 'package.json'),
    ...workspaceManifests,
    ...await collectPatchPaths(installDir),
    ...declaredInputs,
  ].map((path) => resolve(path)))).sort();
}

function isPathInside(rootPath, candidatePath) {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function portableRelativePath(rootPath, candidatePath) {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath ? relativePath.split(sep).join('/') : '.';
}

function dependencyInputIdentityPath({ installDir, componentDir, inputPath }) {
  if (isPathInside(installDir, inputPath)) {
    return `install:${portableRelativePath(installDir, inputPath)}`;
  }
  if (isPathInside(componentDir, inputPath)) {
    return `component:${portableRelativePath(componentDir, inputPath)}`;
  }
  throw new Error(`Dependency freshness input is outside its installation and component roots: ${inputPath}`);
}

async function readInputSnapshot({ inputPaths, installDir, componentDir }) {
  const snapshot = [];
  const visit = async (inputPath) => {
    try {
      const stats = await lstat(inputPath);
      const identityPath = dependencyInputIdentityPath({ installDir, componentDir, inputPath });
      if (stats.isFile()) {
        snapshot.push({
          path: identityPath,
          kind: 'file',
          digest: createHash('sha256').update(await readFile(inputPath)).digest('hex'),
        });
      } else if (stats.isDirectory()) {
        snapshot.push({ path: identityPath, kind: 'directory' });
      } else if (stats.isSymbolicLink()) {
        snapshot.push({
          path: identityPath,
          kind: 'symlink',
          targetDigest: createHash('sha256').update(await readlink(inputPath), 'utf8').digest('hex'),
        });
      } else {
        snapshot.push({ path: identityPath, kind: 'other', size: Number(stats.size) });
      }
      if (stats.isDirectory()) {
        const entries = await readdir(inputPath);
        for (const entry of entries.sort()) await visit(join(inputPath, entry));
      }
    } catch {
      snapshot.push({
        path: dependencyInputIdentityPath({ installDir, componentDir, inputPath }),
        kind: 'missing',
      });
    }
  };
  for (const inputPath of inputPaths) await visit(inputPath);
  return snapshot.sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveDependencyIdentity({ installDir, runtimeIdentity }) {
  if (runtimeIdentity) return runtimeIdentity;
  let packageManager = 'unknown';
  try {
    const packageJson = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    const declaredPackageManager = String(packageJson?.packageManager ?? '').trim();
    if (declaredPackageManager) packageManager = declaredPackageManager;
  } catch {
    // The manifest is already represented in the input snapshot. Keep the
    // package-manager identity explicit and deterministic as well.
  }
  return {
    packageManager,
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules ?? 'unknown',
    platform: process.platform,
    architecture: process.arch,
    installMode: DEPENDENCY_INSTALL_MODE,
  };
}

function dependencyIdentitiesMatch(before, after) {
  return before?.packageManager === after?.packageManager
    && before?.nodeVersion === after?.nodeVersion
    && before?.nodeAbi === after?.nodeAbi
    && before?.platform === after?.platform
    && before?.architecture === after?.architecture
    && before?.installMode === after?.installMode;
}

function snapshotsMatch(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  return before.every((entry, index) => {
    const candidate = after[index];
    return entry.path === candidate?.path
      && entry.kind === candidate.kind
      && entry.digest === candidate.digest
      && entry.targetDigest === candidate.targetDigest
      && entry.size === candidate.size;
  });
}

export async function inspectDependencyRefresh({ installDir, componentDir = installDir, runtimeIdentity }) {
  const nodeModules = join(installDir, 'node_modules');
  const inputPaths = await collectDependencyInputPaths({ installDir, componentDir });
  const inputSnapshot = await readInputSnapshot({ inputPaths, installDir, componentDir });
  const dependencyIdentity = await resolveDependencyIdentity({ installDir, runtimeIdentity });
  const markerPath = join(nodeModules, REFRESH_MARKER);
  const markerState = await readJsonIfExists(markerPath).catch(() => null);
  const hasCanonicalMarker = markerState?.version === REFRESH_STATE_VERSION
    && dependencyIdentitiesMatch(markerState.identity, dependencyIdentity)
    && Array.isArray(markerState.inputs);
  if (hasCanonicalMarker) {
    return {
      required: markerState.superseded === true || !snapshotsMatch(markerState.inputs, inputSnapshot),
      inputPaths,
      inputSnapshot,
      dependencyIdentity,
      markerPath,
    };
  }

  // Legacy timestamp/absolute-path markers cannot prove a relocated input
  // closure. Refresh once to establish the canonical portable snapshot.
  return { required: true, inputPaths, inputSnapshot, dependencyIdentity, markerPath };
}

export async function withDependencyRefresh({ installDir, componentDir = installDir, env = process.env, runtimeIdentity }, refresh) {
  if (typeof refresh !== 'function') {
    throw new TypeError('withDependencyRefresh requires a refresh callback');
  }
  const beforeLock = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity });
  if (!beforeLock.required) return { refreshed: false, reason: 'up-to-date' };

  return await withJsonOwnerFileLock(async () => {
    const afterDependencyLock = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity });
    if (!afterDependencyLock.required) return { refreshed: false, reason: 'up-to-date' };

    const mutate = async (heldCliLockValue = null) => {
      const beforeMutation = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity });
      if (!beforeMutation.required) return { refreshed: false, reason: 'up-to-date' };

      await refresh({ heldCliLockValue });

      const refreshedInputPaths = await collectDependencyInputPaths({ installDir, componentDir });
      const refreshedInputSnapshot = await readInputSnapshot({
        inputPaths: refreshedInputPaths,
        installDir,
        componentDir,
      });
      const refreshedDependencyIdentity = await resolveDependencyIdentity({ installDir, runtimeIdentity });
      const superseded = !snapshotsMatch(beforeMutation.inputSnapshot, refreshedInputSnapshot)
        || !dependencyIdentitiesMatch(beforeMutation.dependencyIdentity, refreshedDependencyIdentity);
      await writeJsonAtomic(beforeMutation.markerPath, {
        version: REFRESH_STATE_VERSION,
        identity: superseded ? beforeMutation.dependencyIdentity : refreshedDependencyIdentity,
        // Inputs can advance during a refresh. Publish the admitted generation
        // as superseded so exactly one successor owns the next reconciliation.
        inputs: superseded ? beforeMutation.inputSnapshot : refreshedInputSnapshot,
        superseded,
      });
      return { refreshed: true, reason: 'stale-inputs' };
    };

    const monorepoRoot = coerceHappyMonorepoRootFromPath(installDir);
    if (!monorepoRoot || resolve(monorepoRoot) !== resolve(installDir)) return await mutate();
    return await withCliDistBuildLock(
      ({ heldLockValue }) => mutate(heldLockValue),
      {
        lockPath: resolveCliDistBuildLockPath(monorepoRoot),
        env,
      },
    );
  }, {
    lockPath: resolveDependencyRefreshLockPath(installDir),
    errorLabel: 'dependency refresh lock',
  });
}
