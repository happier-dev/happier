import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectExternalRuntimeDepNamesFromPackageJson(rawPackageJson) {
  const dependencies = rawPackageJson?.dependencies && typeof rawPackageJson.dependencies === 'object'
    ? rawPackageJson.dependencies
    : {};
  const optionalDependencies = rawPackageJson?.optionalDependencies && typeof rawPackageJson.optionalDependencies === 'object'
    ? rawPackageJson.optionalDependencies
    : {};

  const required = Object.keys(dependencies)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: false }));
  const optional = Object.keys(optionalDependencies)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: true }));

  return [...required, ...optional];
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function isRetryableFsError(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EINTR';
}

function rmDirSafeSync(targetDir, { retries = 5, delayMs = 25 } = {}) {
  const path = String(targetDir ?? '').trim();
  if (!path) return;

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableFsError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function isVendoredSwapDirName(name, targetBaseName) {
  return name.startsWith(`${targetBaseName}.__sync_tmp__.`) || name.startsWith(`${targetBaseName}.__sync_backup__.`);
}

function removeStaleVendoredSwapDirs(parentDir, targetBaseName) {
  if (!existsSync(parentDir)) return;

  for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isVendoredSwapDirName(entry.name, targetBaseName)) continue;
    rmDirSafeSync(resolve(parentDir, entry.name));
  }
}

function atomicReplaceBuiltDirSync(targetDir, buildInto) {
  const outDir = String(targetDir ?? '').trim();
  if (!outDir) return;

  const parentDir = dirname(outDir);
  const baseName = basename(outDir);
  removeStaleVendoredSwapDirs(parentDir, baseName);

  const syncSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const stagingDir = `${outDir}.__sync_tmp__.${syncSuffix}`;
  const backupDir = `${outDir}.__sync_backup__.${syncSuffix}`;

  mkdirSync(parentDir, { recursive: true });
  rmDirSafeSync(stagingDir);
  rmDirSafeSync(backupDir);
  buildInto(stagingDir);

  let movedExistingDir = false;
  try {
    if (existsSync(outDir)) {
      renameSync(outDir, backupDir);
      movedExistingDir = true;
    }

    renameSync(stagingDir, outDir);
    if (movedExistingDir) {
      rmDirSafeSync(backupDir);
    }
  } catch (error) {
    rmDirSafeSync(stagingDir);
    if (movedExistingDir && existsSync(backupDir) && !existsSync(outDir)) {
      renameSync(backupDir, outDir);
    }
    throw error;
  }
}

function resolveInstalledPackage({ require, packageName }) {
  const searchPaths = require.resolve.paths(packageName) ?? [];
  let aliasInstalledPackage = null;

  for (const searchPath of searchPaths) {
    const packageJsonPath = resolve(searchPath, ...packageName.split('/'), 'package.json');
    if (!existsSync(packageJsonPath)) continue;

    const packageJson = readJson(packageJsonPath);
    if (packageJson?.name === packageName) {
      return {
        packageDir: dirname(packageJsonPath),
        packageJsonPath,
      };
    }

    if (!aliasInstalledPackage) {
      aliasInstalledPackage = {
        packageDir: dirname(packageJsonPath),
        packageJsonPath,
      };
    }
  }

  if (aliasInstalledPackage) {
    return aliasInstalledPackage;
  }

  let resolvedEntry = '';
  try {
    resolvedEntry = require.resolve(`${packageName}/package.json`);
  } catch {
    resolvedEntry = require.resolve(packageName);
  }

  let dir = dirname(resolvedEntry);
  for (let i = 0; i < 50; i += 1) {
    const packageJsonPath = resolve(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = readJson(packageJsonPath);
      if (packageJson?.name === packageName) {
        return {
          packageDir: dir,
          packageJsonPath,
        };
      }
    }

    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Failed to locate installed package.json for ${packageName} (resolved: ${resolvedEntry})`);
}

function vendorRuntimeDependencyTreeFallback({
  packageJsonPath,
  resolveFromPackageJsonPath = packageJsonPath,
  destNodeModulesDir,
  visited = new Set(),
}) {
  const pkgJson = readJson(packageJsonPath);
  const roots = collectExternalRuntimeDepNamesFromPackageJson(pkgJson);
  const require = createRequire(pathToFileURL(resolveFromPackageJsonPath).href);

  mkdirSync(destNodeModulesDir, { recursive: true });

  for (const dep of roots) {
    let resolved;
    try {
      resolved = resolveInstalledPackage({ require, packageName: dep.name });
    } catch (error) {
      if (dep.optional) continue;
      throw error;
    }

    const depDestDir = resolve(destNodeModulesDir, ...dep.name.split('/'));
    if (visited.has(depDestDir)) continue;
    visited.add(depDestDir);

    rmDirSafeSync(depDestDir);
    cpSync(resolved.packageDir, depDestDir, { recursive: true, dereference: true });

    vendorRuntimeDependencyTreeFallback({
      packageJsonPath: resolved.packageJsonPath,
      resolveFromPackageJsonPath: resolved.packageJsonPath,
      destNodeModulesDir: resolve(depDestDir, 'node_modules'),
      visited,
    });
  }
}

export function vendorBundledPackageRuntimeDependenciesFallback({
  srcPackageJsonPath,
  resolveFromPackageJsonPath = srcPackageJsonPath,
  destPackageDir,
}) {
  if (!existsSync(srcPackageJsonPath)) {
    throw new Error(`Missing package.json: ${srcPackageJsonPath}`);
  }

  const destNodeModulesDir = resolve(destPackageDir, 'node_modules');
  atomicReplaceBuiltDirSync(destNodeModulesDir, (tempNodeModulesDir) => {
    vendorRuntimeDependencyTreeFallback({
      packageJsonPath: srcPackageJsonPath,
      resolveFromPackageJsonPath,
      destNodeModulesDir: tempNodeModulesDir,
    });
  });
}
