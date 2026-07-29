import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { pathExists } from '../fs/fs.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { coerceHappyMonorepoRootFromPath, getHappyStacksHomeDir } from '../paths/paths.mjs';
import { resolveCliDistBuildLockPath, withCliDistBuildLock } from './cliDistBuildLock.mjs';
import { withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';
import { collectWorkspacePackageJsonPaths } from './workspace_package_manifests.mjs';

const REFRESH_MARKER = '.happier-stack-dependencies-ready';

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

async function readInputSnapshot(inputPaths) {
  const snapshot = [];
  const visit = async (inputPath) => {
    try {
      const stats = await lstat(inputPath);
      snapshot.push({ path: resolve(inputPath), kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other', size: Number(stats.size), mtimeMs: stats.mtimeMs ?? 0 });
      if (stats.isDirectory()) {
        const entries = await readdir(inputPath);
        for (const entry of entries.sort()) await visit(join(inputPath, entry));
      }
    } catch {
      snapshot.push({ path: resolve(inputPath), kind: 'missing', size: 0, mtimeMs: 0 });
    }
  };
  for (const inputPath of inputPaths) await visit(inputPath);
  return snapshot.sort((a, b) => a.path.localeCompare(b.path));
}

function snapshotsMatch(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  return before.every((entry, index) => {
    const candidate = after[index];
    return entry.path === candidate?.path && entry.kind === candidate.kind && entry.size === candidate.size && entry.mtimeMs === candidate.mtimeMs;
  });
}

export async function inspectDependencyRefresh({ installDir, componentDir = installDir }) {
  const nodeModules = join(installDir, 'node_modules');
  const inputPaths = await collectDependencyInputPaths({ installDir, componentDir });
  const inputSnapshot = await readInputSnapshot(inputPaths);
  const markerPath = join(nodeModules, REFRESH_MARKER);
  const markerState = await readJsonIfExists(markerPath).catch(() => null);
  if (markerState?.version === 2 && Array.isArray(markerState.inputs)) {
    return { required: !snapshotsMatch(markerState.inputs, inputSnapshot), inputPaths, inputSnapshot, markerPath };
  }
  return { required: true, inputPaths, inputSnapshot, markerPath };
}

export async function withDependencyRefresh({ installDir, componentDir = installDir, env = process.env }, refresh) {
  if (typeof refresh !== 'function') throw new TypeError('withDependencyRefresh requires a refresh callback');
  const beforeLock = await inspectDependencyRefresh({ installDir, componentDir });
  if (!beforeLock.required) return { refreshed: false, reason: 'up-to-date' };

  return await withJsonOwnerFileLock(async () => {
    const afterDependencyLock = await inspectDependencyRefresh({ installDir, componentDir });
    if (!afterDependencyLock.required) return { refreshed: false, reason: 'up-to-date' };
    const mutate = async (heldCliLockValue = null) => {
      const beforeMutation = await inspectDependencyRefresh({ installDir, componentDir });
      if (!beforeMutation.required) return { refreshed: false, reason: 'up-to-date' };
      await refresh({ heldCliLockValue });
      const refreshedInputPaths = await collectDependencyInputPaths({ installDir, componentDir });
      const refreshedInputSnapshot = await readInputSnapshot(refreshedInputPaths);
      if (snapshotsMatch(beforeMutation.inputSnapshot, refreshedInputSnapshot)) {
        await writeJsonAtomic(beforeMutation.markerPath, { version: 2, installDir: resolve(installDir), inputs: refreshedInputSnapshot });
      }
      return { refreshed: true, reason: 'stale-inputs' };
    };
    const monorepoRoot = coerceHappyMonorepoRootFromPath(installDir);
    if (!monorepoRoot || resolve(monorepoRoot) !== resolve(installDir)) return await mutate();
    return await withCliDistBuildLock(({ heldLockValue }) => mutate(heldLockValue), {
      lockPath: resolveCliDistBuildLockPath(monorepoRoot),
      env,
    });
  }, {
    lockPath: resolveDependencyRefreshLockPath(installDir),
    errorLabel: 'dependency refresh lock',
  });
}
