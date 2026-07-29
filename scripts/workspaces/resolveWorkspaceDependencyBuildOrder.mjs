import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXTENSIONS_WORKSPACE_PREFIX = 'plugins-';

function normalizeWorkspacePackageName(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.startsWith('@happier-dev/')) {
    return value.slice('@happier-dev/'.length).trim();
  }
  return value;
}

function readJson(path, { readFileSync = defaultReadFileSync } = {}) {
  return JSON.parse(String(readFileSync(path, 'utf8')));
}

function collectInternalDependencyNames(
  pkgJson,
  currentPackageName,
  { includeDevDependencies = true } = {},
) {
  const dependencies = new Set();
  const dependencyFields = [pkgJson?.dependencies, pkgJson?.optionalDependencies];
  if (includeDevDependencies) dependencyFields.push(pkgJson?.devDependencies);
  for (const field of dependencyFields) {
    if (!field || typeof field !== 'object') continue;
    for (const dependencyName of Object.keys(field)) {
      if (!dependencyName.startsWith('@happier-dev/')) continue;
      if (dependencyName === currentPackageName) continue;
      const normalized = normalizeWorkspacePackageName(dependencyName);
      if (normalized) {
        dependencies.add(normalized);
      }
    }
  }
  return [...dependencies];
}

function resolveWorkspacePackageJsonPath({ repoRoot, workspaceName, existsSync }) {
  const standard = resolve(repoRoot, 'packages', workspaceName, 'package.json');
  if (existsSync(standard)) return standard;

  if (workspaceName.startsWith(EXTENSIONS_WORKSPACE_PREFIX)) {
    const extensionId = workspaceName.slice(EXTENSIONS_WORKSPACE_PREFIX.length);
    if (extensionId) {
      const extensionCandidate = resolve(repoRoot, 'packages', 'plugins', extensionId, 'package.json');
      if (existsSync(extensionCandidate)) return extensionCandidate;
    }
  }

  return null;
}

export function resolveWorkspaceDependencyBuildOrder({
  repoRoot,
  seedPackageNames,
  includeDevDependencies = true,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
} = {}) {
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();

  const visit = (rawName) => {
    const workspaceName = normalizeWorkspacePackageName(rawName);
    if (!workspaceName || visited.has(workspaceName)) {
      return;
    }

    const packageJsonPath = resolveWorkspacePackageJsonPath({ repoRoot, workspaceName, existsSync });
    if (!packageJsonPath) {
      return;
    }

    if (visiting.has(workspaceName)) {
      return;
    }

    visiting.add(workspaceName);
    let packageJson;
    try {
      packageJson = readJson(packageJsonPath, { readFileSync });
    } catch {
      visiting.delete(workspaceName);
      return;
    }

    const currentPackageName = typeof packageJson?.name === 'string' ? packageJson.name : '';
    for (const dependencyName of collectInternalDependencyNames(
      packageJson,
      currentPackageName,
      { includeDevDependencies },
    )) {
      visit(dependencyName);
    }

    visiting.delete(workspaceName);
    visited.add(workspaceName);
    ordered.push(workspaceName);
  };

  for (const seedName of Array.isArray(seedPackageNames) ? seedPackageNames : []) {
    visit(seedName);
  }

  return ordered;
}

export function resolveBundledWorkspaceDependencyBuildOrder({
  repoRoot,
  hostPackageDir,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
} = {}) {
  const hostPackageJsonPath = resolve(hostPackageDir, 'package.json');
  if (!existsSync(hostPackageJsonPath)) {
    return [];
  }

  let hostPackageJson;
  try {
    hostPackageJson = readJson(hostPackageJsonPath, { readFileSync });
  } catch {
    return [];
  }

  const bundledDependencies = Array.isArray(hostPackageJson?.bundledDependencies)
    ? hostPackageJson.bundledDependencies
    : Array.isArray(hostPackageJson?.bundleDependencies)
      ? hostPackageJson.bundleDependencies
      : [];

  return resolveWorkspaceDependencyBuildOrder({
    repoRoot,
    seedPackageNames: bundledDependencies,
    includeDevDependencies: false,
    existsSync,
    readFileSync,
  });
}
