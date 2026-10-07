import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { pathExists } from '../fs/fs.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { coerceHappyMonorepoRootFromPath, getHappyStacksHomeDir } from '../paths/paths.mjs';
import { isJsonOwnerFileLockActive, withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';
import { collectWorkspacePackageJsonPaths } from './workspace_package_manifests.mjs';
import { stopExpoDependencyConsumers } from '../expo/dependency_barrier.mjs';
import { inspectUiPostinstallOutputs } from './ui_postinstall.mjs';

// v5 could publish an --ignore-scripts bootstrap as a complete install.
const REFRESH_STATE_VERSION = 6;
const REFRESH_MARKER = '.happier-stack-dependencies-ready';
// Earlier full admission relied on Yarn's lifecycle reuse and could omit UI
// patches/assets. Only an explicitly completed UI postinstall proves this mode.
const DEPENDENCY_INSTALL_MODE = 'development-full-ui-postinstall-v1';
// Scriptless workspace lifecycle admission still completes mandatory UI outputs.
export const SCRIPTLESS_DEPENDENCY_INSTALL_MODE = 'development-scriptless-ui-postinstall-v1';

export function resolveDependencyInstallRoot(componentDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  return monorepoRoot && existsSync(join(monorepoRoot, 'package.json')) ? monorepoRoot : componentDir;
}

function installDirLockKey(installDir) {
  return createHash('sha256').update(resolve(installDir), 'utf-8').digest('hex');
}

function resolveDependencyRefreshLockPath(installDir, env = process.env) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(installDir);
  if (monorepoRoot && resolve(monorepoRoot) === resolve(installDir)) {
    return join(monorepoRoot, '.project', 'tmp', 'dependency-install.lock');
  }
  return join(getHappyStacksHomeDir(env), 'cache', 'dependencies', `${installDirLockKey(installDir)}.lock`);
}

export async function withDependencyRefreshLock({ installDir, env = process.env }, action) {
  return await withJsonOwnerFileLock(action, {
    lockPath: resolveDependencyRefreshLockPath(installDir, env),
    errorLabel: 'dependency refresh lock',
    allowLiveOwnerStaleReclaim: true,
  });
}

export function isDependencyRefreshLockActive({ installDir, env = process.env }) {
  return isJsonOwnerFileLockActive(resolveDependencyRefreshLockPath(installDir, env), {
    allowLiveOwnerStaleReclaim: true,
  });
}

async function collectPatchPaths(installDir) {
  const patchesDir = join(installDir, 'patches');
  if (!(await pathExists(patchesDir))) return [];
  try {
    const entries = await readdir(patchesDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.patch')).map((entry) => join(patchesDir, entry.name));
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
      if (isAbsolute(entry)) throw new Error(`Invalid happier.installFreshnessInputs entry in ${manifestPath}: paths must be package-relative`);
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

async function resolveDependencyIdentity({ installDir, runtimeIdentity, installMode = DEPENDENCY_INSTALL_MODE }) {
  if (runtimeIdentity) return runtimeIdentity;
  let packageManager = 'unknown';
  try {
    const packageJson = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    const declaredPackageManager = String(packageJson?.packageManager ?? '').trim();
    if (declaredPackageManager) packageManager = declaredPackageManager;
  } catch {
    // A missing or malformed manifest is already represented in the input
    // snapshot. Keep the toolchain identity explicit and deterministic too.
  }
  return {
    packageManager,
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules ?? 'unknown',
    platform: process.platform,
    architecture: process.arch,
    installMode,
  };
}

function dependencyIdentitySatisfies(before, after) {
  // Runtime-ready installs also admit source tests. Bootstrap completes UI
  // outputs but cannot prove the other runtime lifecycle prerequisites.
  return before?.packageManager === after?.packageManager
    && before?.nodeVersion === after?.nodeVersion
    && before?.nodeAbi === after?.nodeAbi
    && before?.platform === after?.platform
    && before?.architecture === after?.architecture
    && (before?.installMode === after?.installMode
      || (before?.installMode === DEPENDENCY_INSTALL_MODE
        && after?.installMode === SCRIPTLESS_DEPENDENCY_INSTALL_MODE));
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

async function inspectSelfReferentialNodeModulesLink(installDir) {
  const nodeModules = join(installDir, 'node_modules');
  const candidatePath = join(nodeModules, 'node_modules');
  try {
    const stats = await lstat(candidatePath);
    if (!stats.isSymbolicLink()) return null;
    const [nodeModulesRealPath, candidateRealPath] = await Promise.all([
      realpath(nodeModules),
      realpath(candidatePath),
    ]);
    return nodeModulesRealPath === candidateRealPath ? candidatePath : null;
  } catch {
    return null;
  }
}

async function repairSelfReferentialNodeModulesLink(installDir) {
  const candidatePath = await inspectSelfReferentialNodeModulesLink(installDir);
  if (!candidatePath) return false;
  // Remove only the exact self-referential link. `unlink` never traverses its
  // target, so the admitted dependency tree and every package below it remain
  // untouched.
  await unlink(candidatePath);
  return true;
}

export async function inspectDependencyRefresh({ installDir, componentDir = installDir, runtimeIdentity, installMode }) {
  const nodeModules = join(installDir, 'node_modules');
  const inputPaths = await collectDependencyInputPaths({ installDir, componentDir });
  const inputSnapshot = await readInputSnapshot({ inputPaths, installDir, componentDir });
  const dependencyIdentity = await resolveDependencyIdentity({ installDir, runtimeIdentity, installMode });
  // This is the admission record for the installed tree, so keep it with that
  // tree. Warm readers can prove freshness without touching mutation-lock paths,
  // and replacing node_modules naturally invalidates the old publication.
  const markerPath = join(nodeModules, REFRESH_MARKER);
  const markerState = await readJsonIfExists(markerPath).catch(() => null);
  const nodeModulesPresent = await pathExists(nodeModules);
  const selfReferentialNodeModulesLinkPath = nodeModulesPresent
    ? await inspectSelfReferentialNodeModulesLink(installDir)
    : null;
  if (
    markerState?.version === REFRESH_STATE_VERSION
    && dependencyIdentitySatisfies(markerState.identity, dependencyIdentity)
    && Array.isArray(markerState.inputs)
  ) {
    return {
      admitted: nodeModulesPresent && selfReferentialNodeModulesLinkPath === null && markerState.superseded !== true,
      admittedState: nodeModulesPresent && selfReferentialNodeModulesLinkPath === null && markerState.superseded !== true
        ? markerState : null,
      required: !nodeModulesPresent
        || selfReferentialNodeModulesLinkPath !== null
        || markerState.superseded === true
        || !snapshotsMatch(markerState.inputs, inputSnapshot),
      inputPaths,
      inputSnapshot,
      dependencyIdentity,
      markerPath,
      selfReferentialNodeModulesLinkPath,
    };
  }
  return {
    admitted: false,
    admittedState: null,
    required: true,
    inputPaths,
    inputSnapshot,
    dependencyIdentity,
    markerPath,
    selfReferentialNodeModulesLinkPath,
  };
}

export async function withDependencyRefresh({
  installDir,
  componentDir = installDir,
  env = process.env,
  onDependenciesReady = null,
  runtimeIdentity,
  installMode,
  refreshExisting = true,
}, refresh) {
  if (typeof refresh !== 'function') throw new TypeError('withDependencyRefresh requires a refresh callback');
  if (onDependenciesReady != null && typeof onDependenciesReady !== 'function') {
    throw new TypeError('withDependencyRefresh requires onDependenciesReady to be a function when provided');
  }
  const shouldRunDependencyReadyAction = onDependenciesReady !== null;
  const beforeLock = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode });
  if (!beforeLock.required && !shouldRunDependencyReadyAction) return { refreshed: false, reason: 'up-to-date' };

  return await withDependencyRefreshLock({ installDir, env }, async () => {
    const afterDependencyLock = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode });
    if (!afterDependencyLock.required && !shouldRunDependencyReadyAction) return { refreshed: false, reason: 'up-to-date' };
    const mutate = async () => {
      let beforeMutation = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode });
      let result = { refreshed: false, reason: 'up-to-date' };
      if (beforeMutation.selfReferentialNodeModulesLinkPath !== null) {
        const repaired = await repairSelfReferentialNodeModulesLink(installDir);
        if (repaired) {
          beforeMutation = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode });
          result = {
            refreshed: false,
            reason: 'repaired-self-referential-node-modules-link',
          };
        }
      }
      if (beforeMutation.required || onDependenciesReady) {
        // A ready action can repair generated/patch outputs even on a warm
        // install. Withdraw admission before either mutation, and publish only
        // after every prerequisite succeeds under the same writer lock.
        await unlink(beforeMutation.markerPath).catch(error => {
          if (error?.code !== 'ENOENT') throw error;
        });
        const didRefresh = beforeMutation.required && refreshExisting;
        if (didRefresh) await refresh({});
        if (onDependenciesReady) await onDependenciesReady();
        // Ready-only repairs preserve callers' explicit no-install policy.
        // They cannot certify stale dependency inputs as newly installed.
        if (beforeMutation.required && !didRefresh) {
          // Last-green consumers may repair mandatory outputs without
          // installing newer source inputs. Restore only the prior coherent
          // admission: the normal installer must still see those inputs stale.
          if (beforeMutation.admittedState) {
            await writeJsonAtomic(beforeMutation.markerPath, beforeMutation.admittedState);
          }
          return { ...result, reason: 'refresh-disabled' };
        }
        const refreshedInputPaths = await collectDependencyInputPaths({ installDir, componentDir });
        const refreshedInputSnapshot = await readInputSnapshot({
          inputPaths: refreshedInputPaths,
          installDir,
          componentDir,
        });
        const refreshedDependencyIdentity = await resolveDependencyIdentity({ installDir, runtimeIdentity, installMode });
        const superseded = !snapshotsMatch(beforeMutation.inputSnapshot, refreshedInputSnapshot)
          || !dependencyIdentitySatisfies(beforeMutation.dependencyIdentity, refreshedDependencyIdentity);
        await writeJsonAtomic(beforeMutation.markerPath, {
          version: REFRESH_STATE_VERSION,
          identity: superseded ? beforeMutation.dependencyIdentity : refreshedDependencyIdentity,
          // If inputs advanced during the refresh, publish the admitted generation
          // as superseded. The next owner schedules exactly one successor instead
          // of treating the install as an unknown/unpublished attempt forever.
          inputs: superseded ? beforeMutation.inputSnapshot : refreshedInputSnapshot,
          superseded,
        });
        if (didRefresh) result = { refreshed: true, reason: 'stale-inputs' };
      }
      return result;
    };
    const uiPrerequisites = onDependenciesReady
      ? await inspectUiPostinstallOutputs(join(installDir, 'apps', 'ui'), installDir)
      : [];
    const componentPrerequisites = onDependenciesReady && resolve(componentDir) !== resolve(join(installDir, 'apps', 'ui'))
      ? await inspectUiPostinstallOutputs(componentDir, installDir)
      : [];
    if ((afterDependencyLock.required && refreshExisting)
      || afterDependencyLock.selfReferentialNodeModulesLinkPath !== null
      || uiPrerequisites.length > 0 || componentPrerequisites.length > 0) {
      await stopExpoDependencyConsumers({ installDir, env });
    }
    return await mutate();
  });
}
